/**
 * 配置加载：把「Schemastery 校验后的配置」和「可选 YAML 覆盖层」合成一份运行时配置，
 * 补默认值、展开路径、解析邮箱来源。提示词同样从磁盘读，改了立即生效。
 *
 * 设计要点（对齐 dsh-plugin-guide）：
 * - 这里**不 import 任何 DSH 框架模块**，保持纯函数，方便用 node 直接跑测试。
 * - 这里**不读别的插件的私有面**：凭据只走 `ctx.credentials`（见 credentials.js），
 *   来源的 host/user/密码都来自本插件配置或凭据缝。
 * - **没有模块级缓存**：配置很小，一次解析可忽略；缓存键漏掉「凭据变了」会表现成
 *   「密码改了不生效、必须重启」（旧实现就踩过），所以直接每次读、每次算。
 * - 字段名两种写法都认：cordis.yml / Schema 是 camelCase，用户手写的 YAML 是 snake_case；
 *   覆盖层只覆盖它写到的字段，其余沿用 schema 的值。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { DEFAULT_MAIL_PROMPT, DEFAULT_HTML_PROMPT, DEFAULT_OPENER_PROMPT, DEFAULT_DIGEST_PROMPT } from './defaults.js';
import { normalizeMailTools, unresolvedMailTools } from './preset.js';
import { normalizeSchedule } from './schedule.js';

export { DEFAULT_MAIL_PROMPT, DEFAULT_HTML_PROMPT, DEFAULT_OPENER_PROMPT, DEFAULT_DIGEST_PROMPT };

/**
 * 把任意标识压成 id / 目录名安全的短串。
 *
 * 保留 `@ . + -`（邮箱地址与文件夹名要点可读性），其余一律折成 `-`；
 * **一旦发生过折叠就追加 4 位 sha1** —— 否则 `müller@x.com` 与 `m-ller@x.com`
 * 会折成同一个 id，把两个邮箱的游标混在一起（C6 的同类事故）。
 */
export function slug(value) {
  const text = String(value ?? '').normalize('NFKC').trim().toLowerCase();
  if (!text) return 'x';
  const folded = text.replace(/[^a-z0-9@.+-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'x';
  const tail = /[^a-z0-9@.+-]/.test(text) ? `-${createHash('sha1').update(text).digest('hex').slice(0, 4)}` : '';
  // 上限 48：archive 目录名 = <sourceId>-v<validity>-u<uid>，`safeName()` 还会截到 80，
  // 太长的 id 会让两个不同来源在磁盘上共享同一个前缀
  return `${folded.slice(0, 48 - tail.length)}${tail}`;
}

/** 文件名片段：保留 id 里的下划线等可读字符，只挡路径分隔符/Windows 非法字符 */
function fileComponent(value) {
  const text = String(value ?? '').trim();
  const safe = text.replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').replace(/^\.+$/, '');
  return (safe || 'x').slice(0, 96);
}

/**
 * 缺省来源 id：由**邮箱身份**派生，与数组下标无关（B-N2）。
 *
 * 之前是 `${type}-${index + 1}`：在 sources 开头插入一个来源，后面所有自动 id 全都平移，
 * 游标键跟着变 → 每个邮箱都"第一次运行" → 重建基线 → 停机期间到的邮件被当基线跳过。
 *
 * 冲突一律交给唯一性校验报错（不自动编号，那会把下标语义带回来）。
 */
export function derivedSourceId(type, raw, home) {
  if (type === 'graph') {
    const configured = String(raw?.tokenFile ?? raw?.token_file ?? '').trim();
    if (configured) {
      const tokenFile = resolveFrom(configured, home, home);
      const base = path.basename(tokenFile).replace(/\.[^.]+$/, '');
      return `graph-${slug(base)}`;
    }
    const clientId = String(raw?.clientId ?? raw?.client_id ?? '').trim();
    return `graph-${slug(clientId || 'mailbox')}`;
  }
  if (type === 'gmail') {
    // Gmail 的身份就是账号地址；令牌文件跟着 id 走，所以 user 必须稳定
    const account = String(raw?.user ?? '').trim() || 'mailbox';
    return `gmail-${slug(account)}`;
  }
  if (type === 'oauth2') {
    const account = String(raw?.user ?? '').trim() || 'mailbox';
    return `oauth2-${slug(account)}`;
  }
  if (type === 'pop3') {
    const provider = String(raw?.provider ?? '').trim().toLowerCase();
    const account =
      String(raw?.user ?? '').trim()
      || String(raw?.host ?? '').trim()
      || POP3_PRESETS[provider]?.host
      || provider
      || 'mailbox';
    return `pop3-${slug(account)}`;
  }
  const provider = String(raw?.provider ?? '').trim().toLowerCase();
  const account =
    String(raw?.user ?? '').trim()
    || String(raw?.host ?? '').trim()
    || IMAP_PRESETS[provider]?.host
    || provider
    || 'mailbox';
  const mailbox = String(raw?.mailbox ?? 'INBOX').trim() || 'INBOX';
  return `imap-${slug(account)}-${slug(mailbox)}`;
}

/** 常见邮箱的 IMAP 预设（source 没写 host 时按 provider 或邮箱域名补全） */
const IMAP_PRESETS = {
  qq: { host: 'imap.qq.com', port: 993, secure: true },
  '163': { host: 'imap.163.com', port: 993, secure: true },
  '126': { host: 'imap.126.com', port: 993, secure: true },
  gmail: { host: 'imap.gmail.com', port: 993, secure: true },
  outlook: { host: 'outlook.office365.com', port: 993, secure: true },
  icloud: { host: 'imap.mail.me.com', port: 993, secure: true },
  foxmail: { host: 'imap.qq.com', port: 993, secure: true },
};

/** 常见邮箱的 POP3 预设（端口 995 = 隐式 TLS；110 只在 secure:false 时用） */
const POP3_PRESETS = {
  qq: { host: 'pop.qq.com', port: 995, secure: true },
  '163': { host: 'pop.163.com', port: 995, secure: true },
  '126': { host: 'pop.126.com', port: 995, secure: true },
  gmail: { host: 'pop.gmail.com', port: 995, secure: true },
  outlook: { host: 'outlook.office365.com', port: 995, secure: true },
  icloud: { host: 'pop.mail.me.com', port: 995, secure: true },
  foxmail: { host: 'pop.qq.com', port: 995, secure: true },
};

/** 支持的协议（`sources[].type` 的合法值；与 src/sources/index.js 同源） */
export const SOURCE_TYPES = Object.freeze(['imap', 'pop3', 'oauth2', 'gmail', 'graph']);

const DOMAIN_PRESETS = [
  [/qq\.com$|foxmail\.com$/i, 'qq'],
  [/163\.com$/i, '163'],
  [/126\.com$/i, '126'],
  [/gmail\.com$/i, 'gmail'],
  [/outlook\.com$|hotmail\.com$|live\.com$|office365\.com$/i, 'outlook'],
  [/icloud\.com$|me\.com$/i, 'icloud'],
];

/**
 * 解析 DSH 主目录。
 *
 * **不能只信 process.env.DSH_HOME**：Electron 宿主进程里它可能指向 profile 目录
 * （实测 graph-mail 的附件默认目录落到 profiles\desktop\attachments），那样
 * .credentials.yaml / storages / profiles 全都会找错，表现成「凭据明明配好了却读不到」。
 * 这里按候选顺序取第一个**看起来像 DSH 主目录**的：含 .credentials.yaml 或 profiles 子目录。
 */
export function resolveDshHome(explicit) {
  if (explicit) return path.resolve(explicit);
  const candidates = [];
  if (process.env.DSH_HOME) candidates.push(path.resolve(process.env.DSH_HOME));
  if (process.env.DSH_PROFILE_DIR) candidates.push(path.dirname(path.dirname(path.resolve(process.env.DSH_PROFILE_DIR))));
  candidates.push(path.join(os.homedir(), '.dsh'));
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(path.join(candidate, '.credentials.yaml')) || fs.existsSync(path.join(candidate, 'profiles'))) {
        return candidate;
      }
    } catch {
      // 继续看下一个
    }
  }
  return candidates[candidates.length - 1];
}

/** 默认的 YAML 覆盖层位置：跟着 $DSH_HOME 走，不含任何机器绝对路径。 */
export const DEFAULT_CONFIG_FILE = path.join(resolveDshHome(), 'mail-automation', 'mail-automation.yaml');

/**
 * 邮件 agent 会话的默认落点：沿用 DSH 的"默认工作区"约定（`$DSH_HOME/workspace/default`）。
 * 写的是**模板**而不是展开后的绝对路径，所以换机器、换用户都不用改；运行时由 expandPath() 展开。
 */
export const DEFAULT_AGENT_WORKSPACE = '$DSH_HOME/workspace/default';

/** 启动快照/基线一次最多取多少封：IMAP 与 Graph 的单次取数上限都是 50（G5） */
export const MAX_INITIAL_HEADERS = 50;

/** 展开配置里的路径写法：$DSH_HOME / ${DSH_HOME} / %VAR% / 开头的 ~；相对路径按 DSH 主目录解析 */
export function expandPath(value, dshHome) {  const home = dshHome ?? resolveDshHome();
  let text = String(value ?? '').trim();
  if (!text) return '';
  text = text.replace(/\$\{?DSH_HOME\}?/gi, home).replace(/%DSH_HOME%/gi, home);
  text = text.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (all, name) => process.env[name] ?? all);
  if (text === '~' || text.startsWith('~/') || text.startsWith('~\\')) {
    text = path.join(os.homedir(), text.slice(1).replace(/^[\\/]/, ''));
  }
  return path.isAbsolute(text) ? path.normalize(text) : path.resolve(home, text);
}

/** profile 目录（供 schema.js 从 profile 载入 schemastery、host.js 报错时提示路径） */
export function resolveProfileDir() {
  if (process.env.DSH_PROFILE_DIR) return path.resolve(process.env.DSH_PROFILE_DIR);
  const name = process.env.DSH_PROFILE || 'desktop';
  const candidate = path.join(resolveDshHome(), 'profiles', name);
  if (fs.existsSync(candidate)) return candidate;
  if (process.env.DSH_HOME) {
    const asProfile = path.resolve(process.env.DSH_HOME);
    if (fs.existsSync(path.join(asProfile, 'package.json'))) return asProfile;
  }
  return candidate;
}

/**
 * 取第一个有值的候选（兼容 camelCase / snake_case 两种写法）。
 * 顺手解开 Schemastery 的 volatile 包装（`{ get() }`）——config.pollSeconds 这类字段
 * 在运行时就是这种形态，不拆会把数字读成 NaN 而静默退回默认值。
 */
function pick(...candidates) {
  for (const raw of candidates) {
    const value = unwrapVolatile(raw);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

/**
 * 解析一个路径型配置项：
 * - 绝对路径：原样（normalize）
 * - 带 $DSH_HOME / ~ / %VAR%：按 DSH 主目录展开
 * - 其余相对路径：相对 `dir`（提示词/存档相对用户手写 YAML 所在目录，令牌相对 $DSH_HOME）
 */
function resolveFrom(value, dir, dshHome) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (path.isAbsolute(text)) return path.normalize(text);
  if (text === '~' || text.startsWith('~/') || text.startsWith('~\\') || /\$DSH_HOME|%DSH_HOME%|%[A-Za-z_][A-Za-z0-9_]*%/i.test(text)) {
    return expandPath(text, dshHome);
  }
  return path.resolve(dir, text);
}

const asNumber = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const asString = (value, fallback = '') => (value === undefined || value === null ? fallback : String(value));
const asBool = (value, fallback) => (value === undefined || value === null || value === '' ? fallback : Boolean(value));

function presetFor(source, type = 'imap') {
  const byName = String(source.provider || '').toLowerCase();
  const table = type === 'pop3' ? POP3_PRESETS : IMAP_PRESETS;
  if (table[byName]) return table[byName];
  const addr = String(source.user || '').toLowerCase();
  for (const [re, key] of DOMAIN_PRESETS) {
    if (re.test(addr)) {
      // 同一份 provider 名可能在两张表里都存在；只取当前协议那张
      return (type === 'pop3' ? POP3_PRESETS : IMAP_PRESETS)[key] ?? null;
    }
  }
  return null;
}

/** Gmail 令牌文件的默认位置：按来源 id 分文件（多账号互不覆盖） */
export function defaultGmailTokenFile(id, home) {
  return path.join(home, 'mail-automation', 'tokens', `${slug(id)}.json`);
}

/**
 * Graph 令牌文件的默认位置：`tokens/graph-<id>.json`。
 * 文件夹不参与文件名（文件夹只影响轮询与状态）。
 */
export function defaultGraphTokenFile(home, id) {
  const sourceId = String(id ?? '').trim();
  if (!sourceId) throw new Error('Graph 令牌路径需要来源 id');
  return path.join(home ?? resolveDshHome(), 'mail-automation', 'tokens', `graph-${fileComponent(sourceId)}.json`);
}

/** 所有提示词的默认目录：`$DSH_HOME/mail-automation/prompt` */
export function defaultPromptDir(home) {
  return path.join(home ?? resolveDshHome(), 'mail-automation', 'prompt');
}

/**
 * 规范化一个来源。
 * 密码来源优先级（**只有非空才算数**，这条是「密码明明配了却读不到」的根治）：
 *   1. 配置里的 password（显式写明）
 *   2. secrets[sourceId] —— 由 credentials.js 从 passwordRef 经 ctx.credentials 解析
 */
function normalizeSource(raw, { secrets, dshHome: home, index }) {
  const type = String(pick(raw.type, 'imap')).toLowerCase();
  if (!SOURCE_TYPES.includes(type)) {
    throw new Error(
      `source「${String(pick(raw.name, raw.id) ?? '') || '未命名'}」的 type 不支持：${type}` +
        `（只支持 ${SOURCE_TYPES.join(' / ')}）`,
    );
  }
  // 显式 id 优先；没写就按**邮箱身份**派生（不再用数组下标，见 B-N2）
  const explicitId = asString(pick(raw.id)).trim();
  const id = explicitId || derivedSourceId(type, raw, home);
  const name = asString(pick(raw.name), id);
  const identity = { id, idSource: explicitId ? 'explicit' : 'derived', name, type };

  if (type === 'oauth2') {
    const user = asString(pick(raw.user)).trim();
    if (!user) throw new Error(`source「${name}」是 OAuth2 但没有写 user（账号邮箱地址）`);
    const preset = presetFor({ ...raw, provider: raw.provider || 'outlook' }, 'imap');
    const host = asString(pick(raw.host, preset?.host, 'outlook.office365.com'));
    const portRaw = asNumber(pick(raw.port), 0);
    const port = portRaw > 0 ? Math.trunc(portRaw) : (preset?.port ?? 993);
    const configured = asString(pick(raw.tokenFile, raw.token_file));
    return {
      ...identity,
      user,
      host,
      port: Math.max(1, port),
      secure: asBool(pick(raw.secure), preset?.secure ?? true),
      clientId: asString(pick(raw.clientId, raw.client_id)),
      tenant: asString(pick(raw.tenant), 'common'),
      tokenFile: configured
        ? resolveFrom(configured, home, home)
        : path.join(home, 'mail-automation', 'oauth2', `${slug(id)}.json`),
      tokenFileRaw: configured,
      mailbox: asString(pick(raw.mailbox, raw.folder), 'INBOX'),
      mailboxRaw: asString(pick(raw.mailbox, raw.folder)),
      oauth2: true,
    };
  }

  if (type === 'graph') {
    const configured = asString(pick(raw.tokenFile, raw.token_file));
    const tokenFile = configured
      ? resolveFrom(configured, home, home)
      : defaultGraphTokenFile(home, id);
    return {
      ...identity,
      tokenFile,
      tokenFileRaw: configured,
      folder: asString(pick(raw.folder), 'inbox'),
      folderRaw: asString(pick(raw.folder)),
      top: Math.max(1, asNumber(pick(raw.top), 20)),
      // 绑定（device code）用：公共客户端 id + 租户；留空则设置页要求填
      clientId: asString(pick(raw.clientId, raw.client_id)),
      tenant: asString(pick(raw.tenant), 'common'),
    };
  }

  if (type === 'gmail') {
    const user = asString(pick(raw.user)).trim();
    if (!user) {
      throw new Error(`source「${name}」是 Gmail 但没有写 user（Gmail 账号地址）：它是来源身份与令牌文件名的来源`);
    }
    const configured = asString(pick(raw.tokenFile, raw.token_file));
    return {
      ...identity,
      user,
      clientId: asString(pick(raw.clientId, raw.client_id)),
      // "已安装应用"的 OAuth 客户端带 secret；只写 ref 时可从凭据缝解析
      clientSecret: asString(pick(raw.clientSecret, raw.client_secret)),
      clientSecretRef: asString(pick(raw.clientSecretRef, raw.client_secret_ref)),
      tokenFile: configured ? resolveFrom(configured, home, home) : defaultGmailTokenFile(id, home),
      tokenFileRaw: configured,
      folder: asString(pick(raw.folder), 'INBOX'),
      folderRaw: asString(pick(raw.folder)),
      top: Math.max(1, asNumber(pick(raw.top), 20)),
    };
  }

  // IMAP 与 POP3 共用 host/port/secure/user/password*；邮箱文件夹只有 IMAP 有
  const preset = presetFor(raw, type);
  const host = pick(raw.host, preset?.host);
  if (!host) {
    throw new Error(
      `source「${name}」缺少 ${type.toUpperCase()} 服务器：请写 host/port，或写 provider` +
        `（qq / 163 / 126 / gmail / outlook …）让它按预设补全`,
    );
  }
  const user = pick(raw.user) ?? '';
  const password = pick(raw.password, secrets?.[id], secrets?.[name]);
  /*
   * port 的 schema 默认是 0（"按预设"）。`pick()` 只把 undefined/null/'' 当没写，
   * 所以 0 会被当成真值——不特判就会 `Math.max(1, 0) = 1`，去连 1 端口。
   */
  const portRaw = asNumber(pick(raw.port), 0);
  const port = portRaw > 0 ? Math.trunc(portRaw) : (preset?.port ?? (type === 'pop3' ? 995 : 993));
  const common = {
    ...identity,
    host: asString(host),
    port: Math.max(1, port),
    secure: asBool(pick(raw.secure), preset?.secure ?? true),
    user: asString(user),
    password: asString(password),
    passwordRef: asString(pick(raw.passwordRef, raw.password_ref)),
    provider: asString(pick(raw.provider)),
  };
  if (type === 'pop3') {
    // POP3 没有"邮箱文件夹"概念；UIDL 上限等内部常量见 sources/pop3.js
    return common;
  }
  return {
    ...common,
    mailbox: asString(pick(raw.mailbox), 'INBOX'),
    mailboxRaw: asString(pick(raw.mailbox)),
  };
}

/** 解析提示词路径：与其它路径字段同一套展开规则（相对路径按配置文件所在目录） */
function resolvePromptPath(raw, baseDir, home) {
  const text = asString(raw).trim();
  return text ? resolveFrom(text, baseDir, home) : '';
}

/**
 * 归一化定时任务列表。任务必须显式写在 `schedules` 里；没有默认任务、没有 digest.* 回落。
 * 校验失败一律抛错（由 loadConfig 变成"配置无效、沿用上一份好配置"）：静默跳过一条坏任务，
 * 用户会以为它还在跑。
 */
export function normalizeSchedules(rawSchedules, { baseDir, home } = {}) {
  const homeDir = home ?? resolveDshHome();
  const configDir = baseDir ?? path.dirname(DEFAULT_CONFIG_FILE);
  if (rawSchedules === undefined) rawSchedules = [];
  if (!Array.isArray(rawSchedules)) {
    throw new Error('schedules 必须是数组（空数组 = 不跑任何定时任务）');
  }
  const seen = new Map();
  return rawSchedules.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`schedules[${index}] 必须是对象（{ id, name, enabled, schedule, prompt_file }）`);
    }
    const explicitId = asString(pick(raw.id)).trim();
    const id = explicitId || `task-${index + 1}`;
    if (seen.has(id)) {
      throw new Error(
        `schedules id 重复：第 ${seen.get(id) + 1} 个与第 ${index + 1} 个都是「${id}」。` +
          'id 是运行记录（上次运行/下次排期）的键，重复会让两个任务共用一条记录。',
      );
    }
    seen.set(id, index);
    const name = asString(pick(raw.name), id);
    const label = `定时任务「${name}」`;
    const schedule = normalizeSchedule(raw.schedule, label);
    const fileRaw = asString(pick(raw.promptFile, raw.prompt_file)).trim();
    if (!fileRaw) throw new Error(`${label} 没有 prompt_file：每条任务都必须有提示词文件`);
    const promptFile = resolvePromptPath(fileRaw, configDir, homeDir);
    if (!promptFile) throw new Error(`${label} 的 prompt_file 无法解析`);
    const enabled = raw.enabled === undefined ? true : asBool(raw.enabled, true);
    return {
      id,
      name,
      enabled,
      schedule,
      promptFile,
      promptFileRaw: fileRaw,
    };
  });
}

/** 把「schema 配置 + YAML 覆盖层」变成插件内部使用的结构（含默认值） */
export function normalizeConfig(raw, { dshHome, configFile, secrets = {} } = {}) {  // 收口点：先把所有 volatile 引用解包成真值（`{get}` → 21:30），后面所有 `asXxx` 才安全
  const root = deepUnwrap(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {});
  const home = dshHome ?? resolveDshHome();
  const monitorRaw = root.monitor ?? {};
  const schedulerRaw = root.scheduler ?? {};
  const promptRaw = root.prompt ?? {};
  const agentRaw = root.agent ?? {};
  const storageRaw = root.storage ?? {};
  const credentialsRaw = root.credentials ?? {};
  const qqRaw = root.qq ?? {};
  const renderRaw = root.render ?? {};
  const baseDir = path.dirname(configFile || DEFAULT_CONFIG_FILE);

  const monitor = {
    pollSeconds: Math.max(5, asNumber(pick(root.pollSeconds, monitorRaw.pollSeconds, monitorRaw.poll_seconds), 30)),
    heartbeatSeconds: Math.max(1, asNumber(pick(root.heartbeatSeconds, monitorRaw.heartbeatSeconds, monitorRaw.heartbeat_seconds), 5)),
    // G5：夹到 1..50 —— 这是唯一承重层：YAML 覆盖层不经过 schemastery，只有这里能保证
    // `cfg.monitor.initialHeaders` 与实际取数一致（设置页读回才诚实）。
    initialHeaders: Math.min(
      MAX_INITIAL_HEADERS,
      Math.max(1, Math.trunc(asNumber(pick(root.initialHeaders, monitorRaw.initialHeaders, monitorRaw.initial_headers), 10))),
    ),
    archiveRetryAttempts: Math.min(
      10,
      Math.max(1, asNumber(pick(root.archiveRetryAttempts, monitorRaw.archiveRetryAttempts, monitorRaw.archive_retry_attempts), 3)),
    ),
  };

  const scheduler = {
    busyRetrySeconds: Math.min(
      300,
      Math.max(1, Math.trunc(asNumber(pick(root.busyRetrySeconds, schedulerRaw.busyRetrySeconds, schedulerRaw.busy_retry_seconds), 5))),
    ),
    busyRetryMax: Math.min(
      1000,
      Math.max(1, Math.trunc(asNumber(pick(root.busyRetryMax, schedulerRaw.busyRetryMax, schedulerRaw.busy_retry_max), 24))),
    ),
  };

  const sourcesRaw = Array.isArray(root.sources) ? root.sources : [];
  /*
   * **允许 0 个来源**：首次安装/清空测试邮箱时，插件应当用内置默认值生成一份有效配置并保持空闲
   * （设置页照常显示默认参数、可添加第一个邮箱），而不是整份配置判无效、参数区全空。
   * 真正"还没配置"的状态由调用方根据 `sources.length === 0` 标记（setupRequired）。
   */
  const sources = sourcesRaw.map((s, i) => normalizeSource(s, { secrets, dshHome: home, index: i }));
  /*
   * id 必须唯一（C6）：它同时是 `state.sources[id]` 的游标键、IMAP 连接池键
   * （`imap.js` 的 entries）与存档目录前缀。两个来源撞 id 时，第二个来源的轮询会跑在
   * 第一个来源的连接上 —— 最坏不是"重复/跳过"，而是把 A 邮箱的信存成 B 的存档。
   * 这里**加载期响亮失败**（fail loud），不自动编号（那等于把下标语义换个皮）。
   */
  const seenIds = new Map();
  for (const [i, source] of sources.entries()) {
    const previous = seenIds.get(source.id);
    if (previous !== undefined) {
      throw new Error(
        `source id 重复：第 ${previous + 1} 个与第 ${i + 1} 个都是「${source.id}」。` +
          'id 是游标键、IMAP 连接池键与存档目录前缀，重复会让两个邮箱共用同一条游标/连接。' +
          `请给其中一个显式写 id，例如 sources[${i}].id: ${source.id}-2`,
      );
    }
    seenIds.set(source.id, i);
  }

  const promptFileRaw = asString(promptRaw.file);
  const promptDir = defaultPromptDir(home);
  const defaultPromptPaths = defaultPromptFiles(home);
  const promptFile = promptFileRaw ? resolveFrom(promptFileRaw, baseDir, home) : defaultPromptPaths.mail;
  // HTML 邮件单独一套提示词（让它先看图）；没配就用默认的 prompt-html.md
  const promptHtmlRaw = asString(pick(promptRaw.htmlFile, promptRaw.html_file));
  const promptHtmlFile = promptHtmlRaw ? resolveFrom(promptHtmlRaw, baseDir, home) : defaultPromptPaths.html;
  const prompt = {
    file: promptFile,
    htmlFile: promptHtmlFile,
    dir: promptDir,
  };

  const storageRootRaw = asString(storageRaw.root);
  const storageRoot = storageRootRaw ? resolveFrom(storageRootRaw, baseDir, home) : path.join(home, 'mail-automation');
  const storage = {
    root: storageRoot,
    archiveDir: path.resolve(storageRoot, asString(pick(storageRaw.archiveSubdir, storageRaw.archive_subdir), 'archive')),
    // 启动时的邮件头快照：只保留最新一份，每次都覆盖（存档价值低，不需要按天留档）
    snapshotFile: path.resolve(storageRoot, asString(pick(storageRaw.snapshotFile, storageRaw.snapshot_file), 'startup.md')),
    stateFile: path.resolve(storageRoot, asString(pick(storageRaw.stateFile, storageRaw.state_file), 'state.json')),
    logMaxBytes: Math.max(64 * 1024, asNumber(pick(storageRaw.logMaxBytes, storageRaw.log_max_bytes), 2 * 1024 * 1024)),
  };

  const schedules = normalizeSchedules(root.schedules, { baseDir, home });

  // reasoningEffort 留空/写 inherit 表示「跟随部署默认」，其余原样交给 runner 校验
  const effortRaw = asString(pick(agentRaw.reasoningEffort, agentRaw.reasoning_effort), 'low').trim();
  // 用户写的原文（可能是模板、%VAR%、~ 或绝对路径）：运行时用展开值，设置页用原文
  const workspaceRaw = asString(pick(agentRaw.workspace)).trim() || DEFAULT_AGENT_WORKSPACE;
  const agent = {
    // 工作区：留空 = 用 $DSH_HOME/workspace/default（展开成真实路径）。
    // 不能把模板字符串原样往下传——ensureParent 会拿它当 cwd 建会话。
    // `workspaceRaw` 保留用户写的**原文**（模板 / %VAR% / ~ / 绝对路径），只给设置页显示与回写；
    // 否则设置页拿到展开后的绝对路径，一保存就把当前机器的路径固化进 YAML（G3）。
    workspace: expandPath(workspaceRaw, home),
    workspaceRaw,
    sessionMode: asString(pick(agentRaw.sessionMode, agentRaw.session_mode), 'per_mail'),
    preset: asString(agentRaw.preset).trim(),
    // 模型：provider/model 必须成对；只写一半等于"跟随部署默认"（写一半会让 {{model}} 装配失败，见 A-N1）
    provider: asString(pick(agentRaw.provider)).trim(),
    model: asString(pick(agentRaw.model)).trim(),
    // 工具集：只保留目录里认识的 id、去重、保持目录顺序；**空数组 = 不要任何宿主工具包**（只留插件自己的两个工具）
    tools: normalizeMailTools(pick(agentRaw.tools, agentRaw.toolSet, agentRaw.tool_set)),
    // 被丢弃的未知 id（只在日志里用，不参与运行；可见的降级）
    toolsUnknown: unresolvedMailTools(pick(agentRaw.tools, agentRaw.toolSet, agentRaw.tool_set)),
    reasoningEffort: /^(inherit|default|off)$/i.test(effortRaw) ? '' : effortRaw,
    turnTimeoutSeconds: Math.max(30, asNumber(pick(agentRaw.turnTimeoutSeconds, agentRaw.turn_timeout_seconds), 300)),
    retryAttempts: Math.max(1, asNumber(pick(agentRaw.retryAttempts, agentRaw.retry_attempts), 3)),
    // 开场白允许**显式设成空串**表示不写，所以不能用 pick()（它把 '' 当作"没写"）
    openerPrompt: (() => {
      const raw = agentRaw.openerPrompt !== undefined ? agentRaw.openerPrompt : agentRaw.opener_prompt;
      return raw === undefined || raw === null ? DEFAULT_OPENER_PROMPT : asString(raw);
    })(),
    // 静默模式（默认关）：邮件会话不挂工作区、每次启动新建父会话。
    // 默认挂工作区——那是实测最稳的路径（恢复父会话 + 挂工作区，子会话能正常跑）。
    silent: (() => {
      const raw = agentRaw.silent;
      return raw === undefined || raw === null || raw === '' ? false : asBool(raw, false);
    })(),
    // 会话体积预算（MB）/ 单条提示词上限（KB）：0 = 显式关闭，所以不能用 pick() 把 0 当"没写"
    sessionBudgetMb: Math.max(
      0,
      asNumber(agentRaw.sessionBudgetMb !== undefined ? agentRaw.sessionBudgetMb : agentRaw.session_budget_mb, 8),
    ),
    promptMaxKb: Math.max(
      0,
      asNumber(agentRaw.promptMaxKb !== undefined ? agentRaw.promptMaxKb : agentRaw.prompt_max_kb, 512),
    ),
  };

  const credentials = {
    secretRetrySeconds: Math.max(30, asNumber(
      pick(credentialsRaw.secretRetrySeconds, credentialsRaw.secret_retry_seconds),
      300,
    )),
  };

  const render = {
    width: Math.max(320, asNumber(renderRaw.width, 1000)),    sliceHeight: Math.max(600, asNumber(pick(renderRaw.sliceHeight, renderRaw.slice_height), 1400)),
    sliceOverlap: Math.max(0, asNumber(pick(renderRaw.sliceOverlap, renderRaw.slice_overlap), 120)),
    maxHeight: Math.max(600, asNumber(pick(renderRaw.maxHeight, renderRaw.max_height), 12000)),
    remoteImages: asBool(pick(renderRaw.remoteImages, renderRaw.remote_images), true),
    browser: asString(pick(renderRaw.browser)),
  };

  const qq = {
    enabled: asBool(qqRaw.enabled, true),
    appId: asString(pick(qqRaw.appId, qqRaw.app_id)),
    appSecret: asString(pick(qqRaw.appSecret, qqRaw.app_secret)),
    openid: asString(qqRaw.openid),
    markdown: asBool(qqRaw.markdown, true),
  };

  return { configFile, monitor, scheduler, sources, prompt, storage, schedules, agent, credentials, render, qq };
}

/**
 * 来源的身份键：显式 id 优先，否则按身份派生（与 normalizeSource 同一份实现）。
 * 用于「base(cordis.patch.yml) 与覆盖层合并」——两层都可能有 sources，必须按身份去重/覆盖，
 * 而不是像普通数组那样整体替换（那会让覆盖层一写就把 base 里的邮箱静默顶掉）。
 */
function sourceKey(raw, home) {
  const explicit = String(raw?.id ?? '').trim();
  if (explicit) return explicit;
  return derivedSourceId(String(raw?.type ?? 'imap').toLowerCase(), raw, home);
}

/**
 * 合并两层的 sources：base 打底、overlay 按 id 覆盖/追加。
 * `overlay.sources: []` 表示"覆盖层不再声明任何来源"，base 的条目保留（删除 base 来源只能改 profile）。
 */
export function mergeSources(baseSources, overlaySources, { dshHome } = {}) {
  const home = dshHome ?? resolveDshHome();
  const base = (Array.isArray(baseSources) ? baseSources : []).filter((raw) => raw && typeof raw === 'object');
  const overlay = (Array.isArray(overlaySources) ? overlaySources : []).filter((raw) => raw && typeof raw === 'object');
  const out = [...base];
  const indexByKey = new Map();
  base.forEach((raw, index) => {
    const key = sourceKey(canonicalizeSource(raw), home);
    if (!indexByKey.has(key)) indexByKey.set(key, index);
  });
  /*
   * 覆盖层按 id 覆盖 base 的同名条目；**同一层里的重复 id 必须保留**，
   * 交给 normalizeConfig 报"source id 重复"（C6），不能在这里静默去重。
   */
  const replaced = new Set();
  for (const raw of overlay) {
    const key = sourceKey(canonicalizeSource(raw), home);
    if (indexByKey.has(key) && !replaced.has(key)) {
      out[indexByKey.get(key)] = raw;
      replaced.add(key);
    } else {
      out.push(raw);
    }
  }
  return out;
}

/**
 * 合并两层的 schedules：base 打底、overlay 按 id 覆盖/追加。
 *
 * 与 sources 同一个理由（lessons §22.11）：`mergeConfig` 对数组是整表替换，如果
 * cordis.patch.yml 里声明过任务、设置页又保存了一次，base 的任务会被静默顶掉。
 * `overlay.schedules: []` 保留 base 的任务（与 sources 语义一致：只有 profile 能删 base 项）。
 */
export function mergeSchedules(baseSchedules, overlaySchedules) {
  const base = (Array.isArray(baseSchedules) ? baseSchedules : []).filter((raw) => raw && typeof raw === 'object');
  const overlay = (Array.isArray(overlaySchedules) ? overlaySchedules : []).filter((raw) => raw && typeof raw === 'object');
  const keyOf = (raw) => String(raw?.id ?? '').trim();
  const out = [...base];
  const indexByKey = new Map();
  base.forEach((raw, index) => {
    const key = keyOf(raw);
    if (key && !indexByKey.has(key)) indexByKey.set(key, index);
  });
  const replaced = new Set();
  for (const raw of overlay) {
    /*
     * 只按**显式 id** 覆盖 base。没写 id 的条目一律追加：用"第 n 条"去对 base 的自动 id
     * 会在用户插入/删除一条任务时静默改掉另一条（与 sources 的"不要用下标身份"同一条纪律）。
     */
    const key = keyOf(raw);
    if (key && indexByKey.has(key) && !replaced.has(key)) {
      out[indexByKey.get(key)] = raw;
      replaced.add(key);
    } else {
      out.push(raw);
    }
  }
  return out;
}

/**
 * 配置合成：普通字段深合并，**sources / schedules 按身份合并**。
 * loadConfig 与设置页的整表校验都必须走这里，否则"运行时看到的来源/任务"和"保存时校验的"
 * 会不一致。
 */
export function composeConfig(base, overlay, { dshHome } = {}) {
  const merged = mergeConfig(base ?? {}, overlay ?? {});
  const baseSources = Array.isArray(base?.sources) ? base.sources : [];
  const overlaySources = Array.isArray(overlay?.sources) ? overlay.sources : [];
  if (baseSources.length > 0 || overlaySources.length > 0) {
    merged.sources = mergeSources(baseSources, overlaySources, { dshHome });
  }
  const baseSchedules = Array.isArray(base?.schedules) ? base.schedules : [];
  const overlaySchedules = Array.isArray(overlay?.schedules) ? overlay.schedules : [];
  if (baseSchedules.length > 0 || overlaySchedules.length > 0) {
    merged.schedules = mergeSchedules(baseSchedules, overlaySchedules);
  }
  return merged;
}

/** 深合并：对象递归、数组整体替换、undefined/null 不覆盖 */
export function mergeConfig(base, overlay) {
  if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)) return base ?? {};
  const out = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined || value === null) continue;
    const current = out[key];
    if (Array.isArray(value)) out[key] = value;
    else if (value && typeof value === 'object' && current && typeof current === 'object' && !Array.isArray(current)) {
      out[key] = mergeConfig(current, value);
    } else out[key] = value;
  }
  return out;
}

/**
 * 把用户手写的 snake_case 覆盖层**规范化成 schema 的 camelCase 形状**。
 *
 * 为什么必须先做这一步：`mergeConfig()` 是按 key 深合并的，`poll_seconds` 与 `pollSeconds`
 * 是**两个不同的 key** —— 不转换的话，覆盖层里的 snake_case 会被 schema 的默认值（camelCase）
 * 挡住，表现成「YAML 里改了却没生效」。转换后同 key 覆盖，语义就是文档写的那句
 * 「后层覆盖前层，只覆盖写到的字段」。
 */
/** 手写 YAML / 表单的 snake_case → 运行时 camelCase（只做字段别名，不做校验） */
export function canonicalizeSource(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const out = { ...raw };
  const aliases = {
    password_ref: 'passwordRef',
    token_file: 'tokenFile',
    client_id: 'clientId',
    client_secret: 'clientSecret',
    client_secret_ref: 'clientSecretRef',
  };
  for (const [snake, camel] of Object.entries(aliases)) {
    if (out[snake] !== undefined && out[camel] === undefined) out[camel] = out[snake];
  }
  return out;
}

export function canonicalizeConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = { ...raw };
  const monitor = raw.monitor ?? {};
  const prompt = raw.prompt ?? {};
  const storage = raw.storage ?? {};
  const agent = raw.agent ?? {};
  const qq = raw.qq ?? {};
  const render = raw.render ?? {};
  const scheduler = raw.scheduler ?? {};

  const put = (key, snakeValue, camelValue) => {
    const value = snakeValue !== undefined ? snakeValue : camelValue;
    if (value !== undefined) out[key] = value;
  };
  put('pollSeconds', monitor.poll_seconds, monitor.pollSeconds ?? raw.pollSeconds);
  put('heartbeatSeconds', monitor.heartbeat_seconds, monitor.heartbeatSeconds ?? raw.heartbeatSeconds);
  put('busyRetrySeconds', scheduler.busy_retry_seconds, scheduler.busyRetrySeconds ?? raw.busyRetrySeconds);
  put('busyRetryMax', scheduler.busy_retry_max, scheduler.busyRetryMax ?? raw.busyRetryMax);
  put('initialHeaders', monitor.initial_headers, monitor.initialHeaders ?? raw.initialHeaders);
  put('archiveRetryAttempts', monitor.archive_retry_attempts, monitor.archiveRetryAttempts ?? raw.archiveRetryAttempts);

  out.prompt = {
    ...prompt,
    ...(prompt.html_file !== undefined && prompt.htmlFile === undefined ? { htmlFile: prompt.html_file } : {}),
  };
  out.storage = {
    ...storage,
    ...(storage.archive_subdir !== undefined && storage.archiveSubdir === undefined ? { archiveSubdir: storage.archive_subdir } : {}),
    ...(storage.snapshot_file !== undefined && storage.snapshotFile === undefined ? { snapshotFile: storage.snapshot_file } : {}),
    ...(storage.state_file !== undefined && storage.stateFile === undefined ? { stateFile: storage.state_file } : {}),
    ...(storage.log_max_bytes !== undefined && storage.logMaxBytes === undefined
      ? { logMaxBytes: storage.log_max_bytes }
      : {}),
  };
  out.agent = {
    ...agent,
    ...(agent.session_mode !== undefined && agent.sessionMode === undefined ? { sessionMode: agent.session_mode } : {}),
    ...(agent.turn_timeout_seconds !== undefined && agent.turnTimeoutSeconds === undefined
      ? { turnTimeoutSeconds: agent.turn_timeout_seconds }
      : {}),
    ...(agent.reasoning_effort !== undefined && agent.reasoningEffort === undefined
      ? { reasoningEffort: agent.reasoning_effort }
      : {}),
    ...(agent.retry_attempts !== undefined && agent.retryAttempts === undefined
      ? { retryAttempts: agent.retry_attempts }
      : {}),
    ...(agent.opener_prompt !== undefined && agent.openerPrompt === undefined
      ? { openerPrompt: agent.opener_prompt }
      : {}),
    ...(agent.tool_set !== undefined && agent.tools === undefined ? { tools: agent.tool_set } : {}),
    // 体积预算两项：snake 形式在 YAML/设置页出现，camel 形式在内核；两边都要能读
    ...(agent.session_budget_mb !== undefined && agent.sessionBudgetMb === undefined
      ? { sessionBudgetMb: agent.session_budget_mb }
      : {}),
    ...(agent.prompt_max_kb !== undefined && agent.promptMaxKb === undefined
      ? { promptMaxKb: agent.prompt_max_kb }
      : {}),
  };
  out.render = {
    ...render,
    ...(render.slice_height !== undefined && render.sliceHeight === undefined ? { sliceHeight: render.slice_height } : {}),
    ...(render.slice_overlap !== undefined && render.sliceOverlap === undefined
      ? { sliceOverlap: render.slice_overlap }
      : {}),
    ...(render.max_height !== undefined && render.maxHeight === undefined ? { maxHeight: render.max_height } : {}),
    ...(render.remote_images !== undefined && render.remoteImages === undefined
      ? { remoteImages: render.remote_images }
      : {}),
  };
  out.qq = {
    ...qq,
    ...(qq.app_id !== undefined && qq.appId === undefined ? { appId: qq.app_id } : {}),
    ...(qq.app_secret !== undefined && qq.appSecret === undefined ? { appSecret: qq.app_secret } : {}),
  };
  out.credentials = {
    ...(raw.credentials ?? {}),
    ...((raw.credentials?.secret_retry_seconds !== undefined) && raw.credentials?.secretRetrySeconds === undefined
      ? { secretRetrySeconds: raw.credentials.secret_retry_seconds }
      : {}),
  };
  if (Array.isArray(raw.sources)) out.sources = raw.sources.map(canonicalizeSource);
  return out;
}

/**
 * 读配置：schema 配置打底 + YAML 覆盖层合并 → normalize。
 * 配置坏了**不抛**给调用方崩掉轮询：返回 `{ error }`，让插件继续用上一份好配置跑（并在日志里响亮地写一行）。
 */
export function loadConfig(configFile, opts = {}) {
  const file = configFile ? expandPath(configFile, opts.dshHome) : '';
  let overlay = {};
  let firstInstall = false;
  if (file) {
    try {
      if (fs.existsSync(file)) overlay = canonicalizeConfig(YAML.parse(fs.readFileSync(file, 'utf8')) || {});
      // 文件不存在有两种含义，要分开说：
      //   - schema 层（cordis.patch.yml 的 config）自己配了 sources → 这份覆盖层只是没写，正常；
      //   - schema 层也没配 sources，且路径不是默认路径 → 这一定是用错了 configFile（换机器最常见），
      //     必须指名道姓说有哪个文件没找到，否则后面只会报「配置里没有 sources」，误导排查。
      //   - 默认路径不存在 = 首次安装：按空覆盖层继续，让设置页用 defaults 引导添加第一个邮箱。
      else if (!Array.isArray(opts.base?.sources) || opts.base.sources.length === 0) {
        const defaultFile = path.join(opts.dshHome ?? resolveDshHome(), 'mail-automation', 'mail-automation.yaml');
        if (path.resolve(file) !== path.resolve(defaultFile)) {
          return {
            error:
              `配置文件不存在：${file}\n` +
              '  （这个路径来自 profile 条目 config.configFile；请检查路径，或删掉该 config 行改用默认路径）',
          };
        }
        firstInstall = true;
      }
    } catch (err) {
      return { error: `读取配置失败（${file}）：${err instanceof Error ? err.message : String(err)}` };
    }
  }
  try {
    const merged = composeConfig(opts.base ?? {}, overlay, { dshHome: opts.dshHome });
    const value = normalizeConfig(merged, {
      dshHome: opts.dshHome,
      configFile: file,
      secrets: opts.secrets,
    });
    return { config: value, firstInstall };
  } catch (err) {
    return { error: `配置无效（${file || 'cordis.yml'}）：${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * 首次安装：默认配置文件不存在时，落一份带「邮件总览」任务的最小 YAML。
 * 不写 sources（设置页仍显示首次绑定引导），只保证默认任务存在。
 */
export function ensureFirstInstallConfig(configFile, { dshHome } = {}) {
  const file = configFile ? expandPath(configFile, dshHome) : '';
  if (!file) return false;
  const defaultFile = path.join(dshHome ?? resolveDshHome(), 'mail-automation', 'mail-automation.yaml');
  if (path.resolve(file) !== path.resolve(defaultFile) || fs.existsSync(file)) return false;
  const doc = {
    schedules: [
      {
        id: 'digest',
        name: '邮件总览',
        enabled: true,
        schedule: { type: 'daily', times: ['21:30'] },
        prompt_file: 'prompt/digest-prompt.md',
      },
    ],
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, YAML.stringify(doc), { encoding: 'utf8', mode: 0o600 });
  return true;
}

/**
 * 去掉提示词文件里的注释。
 *
 * 约定（写进 prompt.md 顶部说明，避免误会）：
 * - 文件**开头**连续的 `# 说明` 行（单个 # 加空格）视为注释，整块丢弃；
 * - 正文里任意位置的 `<!-- … -->` 也视为注释；
 * - 正文标题请用 `##` 起，这样不会被当成注释。
 */
export function stripPromptComments(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  let index = 0;
  let sawComment = false;
  while (index < lines.length) {
    const line = lines[index];
    if (/^#(?:\s|$)/.test(line)) {
      sawComment = true;
      index += 1;
      continue;
    }
    if (line.trim() === '' && sawComment) {
      index += 1;
      continue;
    }
    if (line.trim() === '') {
      index += 1;
      continue;
    }
    break;
  }
  const body = (sawComment ? lines.slice(index) : lines).join('\n');
  return body.replace(/<!--[\s\S]*?-->/g, '').trim();
}

/** 默认提示词路径（与 normalizeConfig 中的默认值保持一致） */
export function defaultPromptFiles(home) {
  const dir = defaultPromptDir(home);
  return {
    dir,
    mail: path.join(dir, 'prompt.md'),
    html: path.join(dir, 'prompt-html.md'),
    digest: path.join(dir, 'digest-prompt.md'),
  };
}

/**
 * 没配提示词路径时，把内置兜底文案**落盘**成默认文件，用户可直接编辑。
 * 只对默认路径生效：用户显式写了别的路径（哪怕暂时不存在）不擅自创建。
 */
export function ensureDefaultPromptFiles(cfg) {
  /*
   * 用**默认路径本身**反推 home（`<home>/mail-automation/prompt/prompt.md`），而不是 resolveDshHome()：
   * 测试/多 profile 会把 dshHome 指到临时目录，用全局 home 会误判成"用户自定义路径"而拒绝生成。
   */
  const mailFile = cfg?.prompt?.file;
  const promptDir = cfg?.prompt?.dir || (mailFile ? path.dirname(mailFile) : defaultPromptDir());
  const home = path.dirname(path.dirname(promptDir));
  const files = defaultPromptFiles(home);
  const items = [
    [cfg?.prompt?.file, files.mail, DEFAULT_MAIL_PROMPT],
    [cfg?.prompt?.htmlFile, files.html, DEFAULT_HTML_PROMPT],
    [files.digest, files.digest, DEFAULT_DIGEST_PROMPT],
  ];
  for (const [file, def, text] of items) {
    if (!file || path.resolve(file) !== path.resolve(def)) continue;
    try {
      if (fs.existsSync(file)) continue;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
      // 生成失败不阻断：读取时还有内置兜底
      console.warn(`[mail-automation] 生成默认提示词失败（${file}）：${err?.message ?? err}`);
    }
  }
}

/** 读提示词正文（每轮都读，改了立即生效） */
export function loadPrompt(cfg) {
  ensureDefaultPromptFiles(cfg);
  if (cfg.prompt.file) {
    try {
      const text = stripPromptComments(fs.readFileSync(cfg.prompt.file, 'utf8'));
      if (text) return text;
    } catch {
      // 文件暂时读不到：退回内置默认
    }
  }
  return DEFAULT_MAIL_PROMPT;
}

/** 读「HTML 邮件」提示词：优先 prompt.htmlFile，没有就退回普通提示词。 */
export function loadHtmlPrompt(cfg) {
  ensureDefaultPromptFiles(cfg);
  const file = cfg.prompt?.htmlFile;
  if (file) {
    try {
      const text = stripPromptComments(fs.readFileSync(file, 'utf8'));
      if (text) return text;
    } catch {
      // 配了但读不到 → 退回普通提示词
    }
  }
  return loadPrompt(cfg);
}

/** 按这封邮件有没有 HTML 正文选提示词 */
export function loadMailPrompt(cfg, hasHtml) {
  return hasHtml ? loadHtmlPrompt(cfg) : loadPrompt(cfg);
}

/**
 * 读一条定时任务的提示词：`promptFile`（每轮现读，改了立即生效）。
 * 与邮件提示词共用 `stripPromptComments` 的注释规则。
 */
export function loadSchedulePrompt(task) {
  const file = task?.promptFile;
  if (!file) return '';
  try {
    return stripPromptComments(fs.readFileSync(file, 'utf8'));
  } catch {
    return '';
  }
}

/** 设置页/来源管理写路径时复用同一套路径展开规则 */
export function resolveConfigPath(value, dir, dshHome) {
  return resolveFrom(value, dir, dshHome);
}

/** 变量替换：只替换已知占位符，不碰正文里的其它花括号 */
export function fillTemplate(text, vars) {
  return String(text).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (all, key) => {
    const value = vars[key];
    return value === undefined || value === null ? all : String(value);
  });
}

/** 解析 "HH:MM" → {hour, minute}；格式不合法返回 null */
export function parseClock(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { hour: h, minute: min };
}

/**
 * Schemastery `.volatile()` 字段在运行时的形状：`{ get() }`（冻结的普通对象，
 * 另有一个 cosmokit 的 symbol 键）。
 *
 * 判别式必须是 **`Object.keys(...).length === 1`**：`Map` 也有 `.get()`，
 * 只判 `typeof get === 'function'` 会把 Map 拆成 undefined。
 */
const isVolatileRef = (value) =>
  Boolean(value) &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  typeof value.get === 'function' &&
  Object.keys(value).length === 1;

/** 解包一个 volatile 引用；不是引用就原样返回 */
export function unwrapVolatile(value) {
  if (!isVolatileRef(value)) return value;
  try {
    return value.get();
  } catch {
    // 字段被禁用 / get() 抛错：当作"没配置"，回落到默认值
    return undefined;
  }
}

/**
 * 递归解包配置里的所有 volatile 引用（G1）。
 *
 * 为什么需要：`String({get})` = `"[object Object]"`、`Number({get})` = NaN、
 * `Boolean({get})` = true。只要某个字段被标成 volatile，`normalizeConfig` 里任何
 * 直接读它的地方都会**静默**变成默认值。
 *
 * 边界：
 *   - 只重建普通对象与数组；`Date` / `Map` / `Set` / `Buffer` / 类实例原样保留；
 *   - 深度上限 6，`get()` 返回自引用也不会无限递归；
 *   - 不就地改写入参（宿主传进来的 config 是活对象，改它会冻死 get()）。
 */
export function deepUnwrap(value, depth = 6) {
  if (depth <= 0 || value === null || typeof value !== 'object') return value;
  const unwrapped = unwrapVolatile(value);
  if (unwrapped !== value) return deepUnwrap(unwrapped, depth - 1);
  if (Array.isArray(value)) return value.map((item) => deepUnwrap(item, depth - 1));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = deepUnwrap(item, depth - 1);
  return out;
}
