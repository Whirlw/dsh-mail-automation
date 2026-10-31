/**
 * 本地存储：状态（已见邮件/会话/上次总览日期）、邮件存档、每日总览。
 *
 * 状态的**后端**有两种（见 state-domain.js）：
 *   - `ctx.storageDomain` 的域 `mail_automation_state` —— 正常路径（宿主提供时）；
 *   - 本地的 `<root>/state.json` —— 宿主没有 storage-domain 时的兜底，CLI/补档脚本也用它。
 * 两者**不互相迁移**：域存在就以域为准，磁盘上残留的 state.json 会被忽略（不是数据源）。
 * 邮件存档永远是文件（agent 要按路径读、mail_automation_archive_read 也按路径服务），与状态后端无关。
 *
 * 目录布局（可在配置里改）：
 *   <root>/state.json                状态（仅文件后端使用）
 *   <root>/startup.md                启动时的邮件头快照（每次启动覆盖）
 *   <root>/archive/<source>-<key>/   一封邮件一个目录，平铺 = 「还没总览」的队列
 *        meta.json      元数据（来源/主题/发件人/日期/附件…）
 *        raw.eml        IMAP：原始 RFC822 报文
 *        raw.json       Graph：接口返回的原始 JSON
 *        body.html      HTML 正文（有就原样存，链接/表格/样式都在）
 *        body.txt       纯文本正文（没有 text/plain 时由 HTML 转出）
 *        preview*.png   body.html 的整页渲染图与可读分片
 *        conclusion.md  agent 的处理结论
 *
 * 定时任务用 archive_list 读档、qq_notify 发送、archive_clear 清理；不写本地输出目录。
 * 总览发完就把这次覆盖到的邮件目录删掉，所以 archive/ 里就是待总览的邮件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { STATE_DOMAIN_NAME } from './state-domain.js';
import { atomicWriteFile } from './fsutil.js';

const EMPTY_STATE = { sources: {}, agent: {}, scheduleRuns: {}, retries: {} };
const META_FILE = 'meta.json';
const RAW_EML = 'raw.eml';
const RAW_JSON = 'raw.json';
const BODY_TEXT = 'body.txt';
const BODY_HTML = 'body.html';
const CONCLUSION = 'conclusion.md';
const PREVIEW_PNG = 'preview.png';

function safeName(value) {
  return String(value).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80);
}

/**
 * agent 常常把结论整段包在 ``` 里，后面还接一段补充说明。
 * 这里只拆掉**开头那个围栏块**：拆出来的内容原样保留，围栏后的补充文字接在空行后面；
 * 中间夹着别的内容时不动（避免误伤真的在讲代码的结论）。
 */
function unwrapFence(text) {
  const value = String(text ?? '').trim();
  const match = /^```[a-zA-Z0-9_+-]*\r?\n([\s\S]*?)\r?\n```[ \t]*(?:\r?\n+([\s\S]*))?$/.exec(value);
  if (!match) return value;
  const body = match[1].trim();
  const rest = String(match[2] ?? '').trim();
  return rest ? `${body}\n\n${rest}` : body;
}

export function dayString(date = new Date()) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** ISO 时间 → 本地日期字符串；没法解析时返回空串（用于按日期筛邮件） */
export function dayOf(value) {
  const d = new Date(String(value ?? ''));
  return Number.isNaN(d.getTime()) ? '' : dayString(d);
}

/** 存档目录里各文件的路径（不保证存在，调用方自己 fs.existsSync） */
export const archiveFile = {
  meta: (dir) => path.join(dir, META_FILE),
  conclusion: (dir) => path.join(dir, CONCLUSION),
  text: (dir) => path.join(dir, BODY_TEXT),
  html: (dir) => path.join(dir, BODY_HTML),
  rawEml: (dir) => path.join(dir, RAW_EML),
  rawJson: (dir) => path.join(dir, RAW_JSON),
  preview: (dir) => path.join(dir, PREVIEW_PNG),
};

/** 读 meta.json；读不到就返回 null */
export function readMeta(dir) {
  try {
    return JSON.parse(fs.readFileSync(archiveFile.meta(dir), 'utf8'));
  } catch {
    return null;
  }
}

const clone = (value) => JSON.parse(JSON.stringify(value ?? null));

/** 内存态 → 「已落盘的样子」，用于和上一次写成功的快照做差量 */
function snapshotOf(state) {
  return {
    sources: clone(state.sources ?? {}),
    retries: clone(state.retries ?? {}),
    agent: clone(state.agent ?? {}),
    meta: { scheduleRuns: clone(state.scheduleRuns ?? {}) },
  };
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export class Store {
  /**
   * @param cfg 运行时配置（含 storage.stateFile）
   * @param logger 日志
   * @param {{domain?: object, owned?: boolean}} [options] `openStateDomain()` 的结果；
   *        不给就走文件后端（CLI / 补档脚本 / 老宿主都是这条路）。
   */
  constructor(cfg, logger, options = {}) {
    this.cfg = cfg;
    this.logger = logger;
    this.state = structuredClone(EMPTY_STATE);
    this.domain = options.domain ?? null;
    this.domainOwned = Boolean(options.owned);
    this.backend = this.domain ? 'domain' : 'file';
    this.hydrated = false;
    this.readyPromise = null;
    this.flushChain = Promise.resolve();
    this.flushQueued = false;
    /** 这份内存状态是从哪个文件读进来的（`storage.state_file` 改了之后要能看出来） */
    this.loadedFrom = '';
    /** 读失败（IO）时置位：不许拿空状态覆盖原文件 */
    this.loadFailed = false;
    this.warnedPreHydrate = false;
    // 文件后端保持老语义：构造时就把 state.json 读进来（CLI/backfill 依赖这一点），
    // 所以**同步装载完成就算 hydrated** —— 否则 CLI/测试里的 `new Store(...)+save()` 会全部变成静默不写。
    if (!this.domain) {
      this.#applyLoaded(this.#loadFileState());
      this.hydrated = !this.loadFailed;
    }
    this.persisted = snapshotOf(this.state);
  }

  /** 状态文件路径（G4a）：每次现读配置，改 `storage.state_file` 后不用重建 Store */
  get file() {
    return this.cfg?.storage?.stateFile ?? '';
  }

  /**
   * 切换到 domain 后端。允许在**任何**时刻调用（包括已经从文件装载过之后）：
   * 会重新走一次 `ready()`，把状态原地覆盖成域里的值。之所以要容忍「已经装载过文件」：
   * boot 打开域之前，一个早到的工具调用就可能已经把兜底文件读进内存了；那时如果拒绝
   * 切换，整轮运行都会停在文件后台上（而这个宿主明明有域）。
   */
  attachDomain({ domain, owned } = {}) {
    if (!domain || this.backend === 'domain') return false;
    this.domain = domain;
    this.domainOwned = Boolean(owned);
    this.backend = 'domain';
    this.hydrated = false;
    this.readyPromise = null;
    return true;
  }

  /** 一次性从后端装载状态；重复调用返回同一个 promise */
  ready() {
    if (this.hydrated) return Promise.resolve(this.state);
    this.readyPromise ??= this.#hydrate();
    return this.readyPromise;
  }

  async #hydrate() {
    if (!this.domain) {
      this.#applyLoaded(this.#loadFileState());
      this.persisted = snapshotOf(this.state);
      this.hydrated = !this.loadFailed;
      return this.state;
    }
    try {
      const table = (name) => this.domain.table(name);
      const loaded = structuredClone(EMPTY_STATE);
      for (const [id, record] of table('sources').entries()) loaded.sources[id] = record;
      for (const [id, record] of table('retries').entries()) loaded.retries[id] = record;
      const agent = table('agent').get('main');
      if (agent) loaded.agent = { ...agent };
      const meta = table('meta').get('main');
      if (meta) {
        loaded.scheduleRuns = meta.scheduleRuns ?? {};
      }

      // 以域为准。**不再兼容旧 state.json**：迁移是一次性的历史动作，代码里不留
      // 「域空就导入文件」的分支——否则以后每次域异常（读失败、被重建）都会把一份
      // 陈旧的 JSON 悄悄灌回状态里，反而制造问题。文件后端只在没有 storage-domain 时用。
      this.#applyLoaded(loaded);
      this.hydrated = true;
      this.persisted = snapshotOf(this.state);
      this.logger?.info?.(`[mail-automation] 状态存储：domain ${STATE_DOMAIN_NAME}（${this.domain.table('sources').size} 个游标）`);
      return this.state;
    } catch (err) {
      // 域读不出来：退回文件，至少邮箱功能不受影响
      this.logger?.warn?.(`[mail-automation] 读取状态存储域失败（${err?.message ?? err}），改用 state.json`);
      this.domain = null;
      this.domainOwned = false;
      this.backend = 'file';
      this.#applyLoaded(this.#loadFileState());
      this.persisted = snapshotOf(this.state);
      this.hydrated = !this.loadFailed;
      return this.state;
    }
  }

  /** 把装载结果**原地**写进 this.state（保持对象身份，runner 持有的引用不能换掉） */
  #applyLoaded(loaded) {
    this.state.sources = loaded.sources ?? {};
    this.state.agent = loaded.agent ?? {};
    this.state.retries = loaded.retries ?? {};
    this.state.scheduleRuns = loaded.scheduleRuns ?? {};
  }

  #loadFileState() {
    const file = this.file;
    this.loadedFrom = file;
    if (!fs.existsSync(file)) return structuredClone(EMPTY_STATE);
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      /*
       * IO 错（EACCES/EBUSY/EISDIR…）：文件本身可能是**完好**的，只是这一刻读不到。
       * 不能备份、不能清空、更不能写 —— 保持空状态跑内存，写盘被 `save()` 拦住。
       */
      this.loadFailed = true;
      this.logger?.warn?.(
        `[mail-automation] 读取状态文件失败（${file}）：${err?.code ?? ''} ${err?.message ?? err}；` +
          '本次以空状态启动且不写盘，原文件保留',
      );
      return structuredClone(EMPTY_STATE);
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('顶层不是对象');
      return {
        sources: parsed.sources ?? {},
        agent: parsed.agent ?? {},
        scheduleRuns: parsed.scheduleRuns && typeof parsed.scheduleRuns === 'object' && !Array.isArray(parsed.scheduleRuns)
          ? parsed.scheduleRuns
          : {},
        retries: parsed.retries ?? {},
      };
    } catch (err) {
      // 内容坏了：先把原字节保住（rename 保留证据），再以空状态继续，绝不静默
      const backup = `${file}.bad-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      let saved = '';
      try {
        fs.renameSync(file, backup);
        saved = backup;
      } catch {
        try {
          fs.copyFileSync(file, backup);
          saved = backup;
        } catch {
          saved = '';
        }
      }
      this.logger?.warn?.(
        `[mail-automation] 状态文件损坏（${file}）：${err?.message ?? err}；` +
          (saved ? `已备份到 ${saved}，` : '备份也失败了，') +
          '本次以空状态启动（游标、重试队列、父会话会重建）',
      );
      return structuredClone(EMPTY_STATE);
    }
  }

  save() {
    if (!this.hydrated) {
      if (!this.warnedPreHydrate) {
        this.warnedPreHydrate = true;
        this.logger?.warn?.('[mail-automation] 状态尚未装载完成：save() 不写盘（避免用空状态覆盖已有文件）');
      }
      return false;
    }
    if (this.backend !== 'domain' || !this.domain) return this.#saveFile();
    this.#queueFlush();
    return true;
  }

  #saveFile() {
    if (this.loadFailed) {
      this.logger?.warn?.('状态文件此前读取失败：本次不写盘，避免用它覆盖可能完好的原文件');
      return false;
    }
    const file = this.file;
    if (this.loadedFrom && this.loadedFrom !== file) {
      /*
       * `storage.state_file` 改了（G4a）：内存里的状态是从旧文件读来的。新路径上已有文件时
       * 直接写过去会覆盖另一份状态 —— 先拒绝并提示，让用户自己决定迁移。
       */
      if (fs.existsSync(file)) {
        this.logger?.warn?.(`storage.state_file 已改为 ${file}，但该文件已存在：本次跳过写入（避免覆盖另一份状态）`);
        return false;
      }
      this.logger?.warn?.(`storage.state_file 已变更：状态将写到 ${file}（旧文件 ${this.loadedFrom} 保留在原处）`);
      this.loadedFrom = file;
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      atomicWriteFile(file, JSON.stringify(this.state, null, 2));
      return true;
    } catch (err) {
      this.logger?.warn?.(`写入状态文件失败：${err?.message ?? err}`);
      return false;
    }
  }

  /**
   * 排一次域写入。调用方（save）保持同步语义，这里把真正的 put 串到一条链上：
   * 同一时刻最多排一个任务（`flushQueued`），执行时读的是**当时**的内存态，
   * 所以高频 save() 只会合并成少量写入，且不会乱序。
   */
  #queueFlush() {
    if (this.flushQueued || !this.hydrated) return;
    this.flushQueued = true;
    this.flushChain = this.flushChain
      .then(async () => {
        this.flushQueued = false;
        await this.#flushDomain();
      })
      .catch((err) => {
        this.flushQueued = false;
        this.logger?.warn?.(`状态写入存储域失败：${err?.message ?? err}`);
      });
  }

  /** 差量写入：只碰变了的那几条，写完更新「已落盘」快照 */
  async #flushDomain() {
    const domain = this.domain;
    if (!domain) return;
    const next = snapshotOf(this.state);
    const prev = this.persisted;
    const jobs = [];

    for (const [id, record] of Object.entries(next.sources)) {
      if (!same(prev.sources[id], record)) jobs.push(() => domain.table('sources').put(id, record));
    }
    for (const id of Object.keys(prev.sources)) {
      if (!(id in next.sources)) jobs.push(() => domain.table('sources').delete(id));
    }
    for (const [id, record] of Object.entries(next.retries)) {
      if (!same(prev.retries[id], record)) jobs.push(() => domain.table('retries').put(id, record));
    }
    for (const id of Object.keys(prev.retries)) {
      if (!(id in next.retries)) jobs.push(() => domain.table('retries').delete(id));
    }
    if (!same(prev.agent, next.agent)) jobs.push(() => domain.table('agent').put('main', next.agent));
    if (!same(prev.meta, next.meta)) jobs.push(() => domain.table('meta').put('main', next.meta));

    for (const job of jobs) await job();
    if (jobs.length > 0) this.persisted = next;
  }

  /** 卸载时调用：等排队的写入落盘，再关掉**自己打开的**域 */
  async close() {
    try {
      await this.flushChain;
    } catch {
      // 已经记过日志
    }
    if (!this.domainOwned || !this.domain) return;
    try {
      await this.domain.close();
    } catch (err) {
      this.logger?.warn?.(`关闭状态存储域失败（${err?.message ?? err}）`);
    }
    this.domain = null;
    this.domainOwned = false;
  }

  sourceState(id) {
    return this.state.sources[id] ?? {};
  }

  setSourceState(id, next) {
    this.state.sources[id] = next;
  }

  // ───────────────────────── 邮件存档 ─────────────────────────

  /**
   * 邮件在存档里的身份键。
   *
   * **uid 只在同一个 UIDVALIDITY 空间里唯一**：服务端重建 UID 空间后，同一个 uid 会指向
   * 另一封信。所以 validity 必须参与目录名，否则新邮件会复用旧目录、继承旧 `conclusion.md`，
   * 被 `conclusionState()` 判成"已处理"，永远不交给 agent（C3）。
   *
   * 没有 validity（旧夹具 / `backfill-day.mjs` / Graph）时逐字节保持旧命名，
   * 避免同一个 uid 在 `u100` 与 `v0-u100` 之间抖动、造出一串 `-2/-3`。
   */
  mailKey(header = {}) {
    const hasUid = header.uid !== undefined && header.uid !== null && header.uid !== '';
    if (hasUid) {
      const validity = Number(header.uidValidity ?? 0) || 0;
      return validity > 0 ? `v${validity}-u${header.uid}` : `u${header.uid}`;
    }
    const fullId = String(header.graphId ?? header.id ?? '');
    return `${createHash('sha1').update(fullId).digest('hex').slice(0, 16)}-${fullId.slice(-8).replace(/[^A-Za-z0-9]/g, '')}`;
  }

  /**
   * 这份 `meta.json` 描述的是不是**同一封**邮件。
   *
   * 只有这四条同时成立才算：id 相同、uid 相同、`uid_validity` 相同。
   * 旧存档没有 `uid_validity` 字段 → 无法证明是同一封，就当另一封（宁可多一个目录，不串味）。
   */
  sameMail(meta, header = {}) {
    if (!meta) return false;
    if (String(meta.id ?? '') !== String(header.id ?? '')) return false;
    const uid = header.uid;
    if (uid === undefined || uid === null || uid === '') return true;
    const want = Number(header.uidValidity ?? 0) || 0;
    const got = Number(meta.uid_validity ?? 0) || 0;
    if (got <= 0) return want <= 0;
    return want === got;
  }

  archiveDirFor(mail) {
    const header = mail.header ?? {};
    const base = path.join(this.cfg.storage.archiveDir, `${safeName(mail.sourceId)}-${this.mailKey(header)}`);
    let dir = base;
    for (let i = 2; i <= 50; i += 1) {
      if (!fs.existsSync(dir)) return dir;
      const existing = readMeta(dir);
      // 同一封（重试/重处理）→ 覆盖自己没问题；
      // 没有 meta.json = 上次写到一半就被打断的半成品 → 也复用它，
      // 否则重试会一直往 base-2、base-3… 造新目录，把残骸永久留在 archive/ 里。
      if (!existing || this.sameMail(existing, header)) return dir;
      dir = `${base}-${i}`;
    }
    // 50 个候选全被别人占着：以前这里会返回"最后一个已存在目录"→ 覆盖别人的存档
    throw new Error(`存档目录名冲突无法分配：${base}（已有 49 份不同邮件的存档占用该名字）`);
  }

  /**
   * 把一封邮件落盘成目录（原始报文 + HTML + 纯文本 + 元数据）；返回目录路径。
   *
   * `meta.json` 最后写，它是"这个目录已经写完整"的标记（listArchived 只认带它的目录）。
   * 中途任何一步抛错就把半成品目录删掉，免得留下一个既读不了又列得出来的残骸。
   */
  writeMail(mail) {
    const dir = this.archiveDirFor(mail);
    const existed = fs.existsSync(dir);
    if (existed) this.#clearStaleArtifacts(dir);
    try {
      return this.#writeMailInto(dir, mail);
    } catch (err) {
      // 只删**本次新建**的半成品：复用目录里可能还有上一封的完整存档与待重试结论，
      // 一次写失败不能把它的数据一起 rm 掉（C7）
      if (!existed) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // 删不掉就留着：listArchived 因为缺 meta.json 会忽略它
        }
      }
      throw err;
    }
  }

  /**
   * 复用已有目录前清掉"上一封"的条件产物。
   *
   * `conclusion.md` 故意**不清**：同一封被重拉（上一轮没提交游标、或 backfill 重跑）时
   * 那份结论仍然有效，清了会让幂等跳过失效、同一封重跑一次 agent（重复 token + 重复 QQ）。
   * `body.html` / `preview*.png` 必须清：新邮件没有 HTML 时旧文件还在，
   * `index.js` 会因此选 HTML 提示词、`mail_automation_archive_read part=image` 也会给旧截图。
   */
  #clearStaleArtifacts(dir) {
    const drop = (name) => {
      try {
        fs.rmSync(path.join(dir, name), { force: true });
      } catch {
        // Windows 上被占用会 EBUSY/EPERM：清理失败不能中断归档
      }
    };
    drop(BODY_HTML);
    drop(PREVIEW_PNG);
    try {
      for (const name of fs.readdirSync(dir)) {
        if (/^preview-\d+\.png$/i.test(name)) drop(name);
        // 原子写失败/被 kill 留下的临时文件：不清会一直躺在每个存档目录里
        else if (/^\..*\.tmp\.\d+\.\d+$/.test(name)) drop(name);
      }
    } catch {
      // 目录读不到就跳过
    }
  }

  #writeMailInto(dir, mail) {
    fs.mkdirSync(dir, { recursive: true });
    const header = mail.header ?? {};
    const body = mail.body ?? {};
    const attachments = Array.isArray(body.attachments) ? body.attachments : [];
    const files = [];

    // 1) 原始报文：IMAP 是 RFC822 字节（base64/编码都原样），Graph 是接口 JSON
    if (body.raw !== undefined && body.raw !== null && body.raw !== '') {
      const kind = String(body.rawKind || '').toLowerCase() === 'json' ? 'json' : 'eml';
      const name = kind === 'json' ? RAW_JSON : RAW_EML;
      const data = kind === 'json'
        ? (typeof body.raw === 'string' ? body.raw : JSON.stringify(body.raw, null, 2))
        : body.raw; // Buffer 或 string，都直接写
      try {
        fs.writeFileSync(path.join(dir, name), data);
        files.push(name);
      } catch (err) {
        this.logger?.warn?.(`写原始报文失败（${name}）：${err?.message ?? err}`);
      }
    }

    // 2) HTML 正文：原样保存，不做任何「转 Markdown」的损失性处理
    const html = String(body.html || '');
    if (html.trim()) {
      fs.writeFileSync(archiveFile.html(dir), html, 'utf8');
      files.push(BODY_HTML);
    }

    // 3) 纯文本正文（给 agent 读；HTML 邮件由来源层转成文本）
    const text = String(body.text || '').trim();
    fs.writeFileSync(archiveFile.text(dir), text ? `${text}\n` : '', 'utf8');
    files.push(BODY_TEXT);

    // 4) 元数据
    const meta = {
      source: mail.sourceName ?? '',
      source_id: mail.sourceId ?? '',
      id: String(header.id ?? ''),
      uid: header.uid ?? null,
      // uid 只在同一个 UIDVALIDITY 空间里唯一：不记下来，下次就没法判断"同 uid 是不是同一封"
      uid_validity: Number(header.uidValidity ?? 0) || 0,
      subject: body.subject || header.subject || '',
      from: body.from || header.from || '',
      to: body.to || header.to || '',
      date: body.date || header.date || '',
      unread: Boolean(header.unread),
      attachments,
      web_link: body.webLink || header.webLink || '',
      body_text_chars: text.length,
      body_html_chars: html.length,
      raw_kind: files.includes(RAW_JSON) ? 'json' : files.includes(RAW_EML) ? 'eml' : '',
      saved_at: new Date().toISOString(),
      files,
    };
    atomicWriteFile(archiveFile.meta(dir), JSON.stringify(meta, null, 2));
    return dir;
  }

  /**
   * 写 agent 结论：单独一份 conclusion.md（幂等，重跑覆盖）。
   *
   * `error` 有值表示这次是**失败**（"（agent 处理失败：…）"那种占位结论）。失败/成功
   * 同时写进 meta.json 的 `agent_status` / `agent_error`，这样设置页不必去猜中文文案
   * 就能区分"已处理"和"处理失败"；重试成功后传空 error，状态会被清回 ok。
   */
  writeConclusion(dir, result, { error = '', givenUp = null } = {}) {
    try {
      /*
       * 只写**已经完整**的存档：目录可能刚被总览删掉（陈旧的并发轮次）。
       * 以前这里的 `mkdirSync(dir, {recursive:true})` 会把它复活成一个"只有 conclusion.md、
       * 没有 meta.json"的目录 —— listArchived 看不见、deleteMails 删不到、adoptOrphans
       * 也捞不回，等于永久垃圾（L1 的次生灾害）。
       */
      if (!fs.existsSync(archiveFile.meta(dir))) {
        this.logger?.warn?.(`结论未写入：${dir} 已不是完整存档（可能刚被总览清理）`);
        return false;
      }
      atomicWriteFile(archiveFile.conclusion(dir), `${unwrapFence(result)}\n`);
      // meta 是插件自己的文件：把结果状态记在这里，UI 与总览都能直接读
      const meta = readMeta(dir);
      if (meta) {
        const next = { ...meta };
        if (error) {
          next.agent_status = 'failed';
          next.agent_error = String(error).slice(0, 500);
        } else {
          next.agent_status = 'ok';
          delete next.agent_error;
          // 成功就必须清掉"已放弃"标记，否则这封会被 adoptOrphans 永远跳过（A3）
          delete next.agent_given_up;
        }
        if (givenUp) next.agent_given_up = givenUp;
        atomicWriteFile(archiveFile.meta(dir), JSON.stringify(next, null, 2));
      }
      return true;
    } catch (err) {
      this.logger?.warn?.(`写入 agent 结论失败：${err?.message ?? err}`);
      return false;
    }
  }

  /**
   * 这封邮件是不是"已经放弃自动重试"（A3）。
   *
   * 标记只能放 `meta.json`：`state-domain` 的 `retries` 记录是白名单解析，新字段会在
   * hydrate 时被静默抹掉（那正好是这个 bug 的复发形态）。除 meta 外也认结论文案——
   * 崩溃后 `writeMail` 会从零重写 meta，但 `#clearStaleArtifacts` 会保留 conclusion.md。
   */
  givenUp(dir) {
    const meta = readMeta(dir) ?? {};
    if (meta.agent_given_up) return meta.agent_given_up;
    try {
      const head = fs.readFileSync(archiveFile.conclusion(dir), 'utf8').slice(0, 200);
      return /已放弃自动重试/.test(head) ? { attempts: 0 } : null;
    } catch {
      return null;
    }
  }

  /**
   * 记录"放弃自动重试"（A3）：写失败占位结论 + meta 标记，两者都带 `（agent 处理失败` 前缀
   * 相关的契约不变。`attempts` 记下累计尝试次数，日志与 UI 能说清"第几次、何时、为什么"。
   */
  markGivenUp(dir, { attempts = 0, maxAttempts = 0, error = '' } = {}) {
    const reason = String(error || '重试耗尽').slice(0, 300);
    const text = `（agent 处理失败：已放弃自动重试（连续 ${attempts} 次失败）：${reason}）`;
    return this.writeConclusion(dir, text, {
      error: reason,
      givenUp: { attempts, maxAttempts, error: reason, at: new Date().toISOString() },
    });
  }

  /**
   * 一封存档的处理结果：`ok`（有正常结论）/ `failed`（失败占位结论）/ `pending`（还没跑）。
   *
   * 失败优先信 meta.json 的 `agent_status`/`agent_error`（新写入的），旧数据没有这两个
   * 字段时退回看结论开头是不是失败标记——与 digest.js 用同一约定，避免 UI 猜中文。
   */
  conclusionState(dir) {
    const file = archiveFile.conclusion(dir);
    let exists = false;
    try {
      exists = fs.existsSync(file);
    } catch {
      exists = false;
    }
    if (!exists) return { outcome: 'pending', error: '' };
    const meta = readMeta(dir) ?? {};
    let error = String(meta.agent_error ?? '').trim();
    if (!error) {
      try {
        const head = fs.readFileSync(file, 'utf8').slice(0, 200).trim();
        if (/^（agent 处理失败/.test(head)) error = head.slice(0, 200);
      } catch {
        // 读不到就当正常结论
      }
    }
    return { outcome: error ? 'failed' : 'ok', error };
  }

  /** 清掉结论与失败状态（重新排队重试时用）：邮件回到"还没处理"的样子 */
  clearConclusion(dir) {
    let removed = false;
    try {
      fs.rmSync(archiveFile.conclusion(dir), { force: true });
      removed = true;
    } catch {
      // ignore
    }
    try {
      const meta = readMeta(dir);
      // 已放弃标记也要一起清：手动重试 / 重新排队时必须能让 adoptOrphans 再次接管（A3）
      if (meta && (meta.agent_status || meta.agent_error || meta.agent_given_up)) {
        const next = { ...meta };
        delete next.agent_status;
        delete next.agent_error;
        delete next.agent_given_up;
        atomicWriteFile(archiveFile.meta(dir), JSON.stringify(next, null, 2));
      }
    } catch {
      // ignore
    }
    return removed;
  }

  /**
   * 预览图渲染完成后补进 meta.json（files 清单 + 尺寸 + 切片）。
   * `info.slices` 是超长页面切出来的可读分片（见 render.js），每一片都要登记，
   * 否则 `mail_automation_archive_read` 给出的 files 清单会和磁盘上的实际文件对不上。
   */
  attachPreview(dir, name = PREVIEW_PNG, info = {}) {
    try {
      const meta = readMeta(dir);
      if (!meta) return false;
      const files = Array.isArray(meta.files) ? [...meta.files] : [];
      const slices = Array.isArray(info.slices)
        ? info.slices.map((slice) => ({
            name: path.basename(String(slice.file)),
            width: slice.width ?? null,
            height: slice.height ?? null,
          }))
        : [];
      for (const entry of [name, ...slices.map((slice) => slice.name)]) {
        if (!files.includes(entry)) files.push(entry);
      }
      // U5：把"应该有几片 / 哪几片失败"也记下来，UI 与 mail_automation_archive_read 才能说清预览不完整
      const failedSlices = Array.isArray(info.failedSlices)
        ? info.failedSlices.map((item) => ({ index: item.index ?? null, error: String(item.error ?? '').slice(0, 200) }))
        : [];
      const next = {
        ...meta,
        files,
        preview: name,
        preview_width: info.width ?? null,
        preview_height: info.height ?? null,
        preview_slices: slices,
        preview_slice_expected: Number.isFinite(info.sliceExpected)
          ? info.sliceExpected
          : slices.length + failedSlices.length,
      };
      if (failedSlices.length > 0) next.preview_failed_slices = failedSlices;
      else delete next.preview_failed_slices;
      atomicWriteFile(archiveFile.meta(dir), JSON.stringify(next, null, 2));
      return true;
    } catch (err) {
      this.logger?.warn?.(`写入预览图信息失败：${err?.message ?? err}`);
      return false;
    }
  }

  /**
   * 列出「还没总览」的邮件（archive/ 下平铺的目录），按时间升序。
   * 传 day 时只挑那一天（按本地日期过滤 meta.date），用于手动补某天的总览。
   * 每项形如 { dir, name, ...meta }
   */
  listArchived(options = {}) {
    const day = typeof options === 'string' ? options : options?.day;
    const dir = this.cfg.storage.archiveDir;
    if (!fs.existsSync(dir)) return [];
    const items = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const mailDir = path.join(dir, entry.name);
        const meta = readMeta(mailDir);
        // 没有 meta.json = 上次写到一半就被打断（meta 是最后写的完成标记）：
        // 这种目录既不能读也不能汇总，直接跳过，等下次重写或人工清理。
        if (!meta) return null;
        return { dir: mailDir, file: mailDir, name: entry.name, ...meta };
      })
      .filter(Boolean)
      .filter((item) => (day ? dayOf(item.date) === day : true));
    return items.sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')));
  }

  /** 删除这几封邮件的存档目录；返回实际删掉的个数（只删传进来的，不碰总览期间新到的） */
  deleteMails(dirs) {
    let removed = 0;
    for (const target of dirs ?? []) {
      try {
        fs.rmSync(target, { recursive: true, force: true });
        removed += 1;
      } catch {
        // 删不掉就留着，下次总览再试
      }
    }
    return removed;
  }
}
