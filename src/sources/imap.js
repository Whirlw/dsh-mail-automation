/**
 * IMAP 来源（imapflow）：
 * - listHeaders：取最近 N 封的邮件头
 * - poll：按 UIDVALIDITY / UIDNEXT 增量找出新邮件（新到即算，不管有没有被读过）
 * - fetchBody：取单封全文（mailparser 解析）
 *
 * 连接策略：**每个来源保持一条长连接**，失败才重连。
 * 30 秒一次轮询如果每次新建 TLS + 登录，一天要登录近三千次，容易被邮箱服务端风控。
 */
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { getFreshAccessToken, hasToken as hasOAuth2Token } from './oauth2.js';

const SOCKET_TIMEOUT_MS = 60_000;
const MAX_NEW_PER_POLL = 50;
// 与 config.js 的 MAX_INITIAL_HEADERS 保持一致：界面显示的上限就是实际取数上限
const MAX_HEADERS = 50;

/*
 * QQ 网页版的「转发/回复」会把纯文本正文按 HTML 转义后再塞进 text/plain：
 * 空格变 `&nbsp;`、尖括号变 `&lt;`/`&gt;`（实测转发 DeepSeek 的通知就是这样）。
 * 存档的 body.html / raw.eml 都保留原样，这里只把给 agent 读的纯文本解开一层，
 * 免得它看到 `&gt;` 这种噪音。`&amp;` 放最后解，避免把 `&amp;lt;` 解成 `<`。
 */
const ENTITY_HINT = /&(nbsp|lt|gt|amp|quot|#\d+|#x[0-9a-f]+);/i;

export function decodeEscapedText(text) {
  const value = String(text ?? '');
  if (!ENTITY_HINT.test(value)) return value;
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (all, dec) => {
      try {
        return String.fromCodePoint(Number(dec));
      } catch {
        return all;
      }
    })
    .replace(/&#x([0-9a-f]+);/gi, (all, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return all;
      }
    })
    .replace(/&amp;/gi, '&');
}

/** source.id → { client, chain } */
const entries = new Map();

function entryOf(source) {
  const key = source.id || `${source.host}:${source.user}`;
  let entry = entries.get(key);
  if (!entry) {
    entry = { client: null, chain: Promise.resolve() };
    entries.set(key, entry);
  }
  return entry;
}

async function connect(source, entry) {
  // oauth2 来源用 XOAUTH2（imapflow 的 accessToken），普通 IMAP 仍用账号密码
  const auth = source.oauth2
    ? { user: source.user, accessToken: await getFreshAccessToken(source) }
    : { user: source.user, pass: source.password };
  const client = new ImapFlow({
    host: source.host,
    port: source.port,
    secure: source.secure,
    auth,
    logger: false,
    socketTimeout: SOCKET_TIMEOUT_MS,
    greetingTimeout: 20_000,
  });
  // 没有监听器时 imapflow 的 error 会把进程带崩
  client.on('error', () => undefined);
  client.on('close', () => {
    if (entry.client === client) entry.client = null;
  });
  await client.connect();
  entry.client = client;
  return client;
}

async function clientOf(source, entry) {
  if (entry.client?.usable) return entry.client;
  if (entry.client) {
    try {
      entry.client.close();
    } catch {
      // ignore
    }
    entry.client = null;
  }
  return connect(source, entry);
}

/** 同一来源上的操作串行执行（IMAP 一个连接同时只能有一个选中的邮箱） */
function withSource(source, task) {
  const entry = entryOf(source);
  const run = entry.chain.then(async () => {
    const client = await clientOf(source, entry);
    const lock = await client.getMailboxLock(source.mailbox || 'INBOX');
    try {
      return await task(client);
    } catch (err) {
      // 连接层面的错误：丢掉连接，下一轮重连
      if (entry.client === client && (client.usable === false || /connection|closed|timeout|EOF/i.test(String(err?.message)))) {
        try {
          client.close();
        } catch {
          // ignore
        }
        entry.client = null;
      }
      throw err;
    } finally {
      try {
        lock.release();
      } catch {
        // ignore
      }
    }
  });
  entry.chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function personOf(envelope, key) {
  const list = envelope?.[key];
  if (!Array.isArray(list) || list.length === 0) return '';
  return list
    .map((a) => {
      const name = a?.name || '';
      const addr = a?.address || '';
      if (name && addr && name !== addr) return `${name} <${addr}>`;
      return addr || name;
    })
    .filter(Boolean)
    .join(', ');
}

function headerOf(msg, sourceId, uidValidity) {
  const flags = msg.flags instanceof Set ? [...msg.flags] : Array.isArray(msg.flags) ? msg.flags : [];
  const validity = Number(uidValidity ?? 0) || 0;
  return {
    // 身份**不**带 validity：retries 键、旧 meta.id、`cli read <id>` 都保持原样。
    // uid 只在自己的 UID 空间里指向那封信，所以 validity 单独记一个字段，
    // 由 store 决定它是否参与"这是同一封吗"（C3）。
    id: `imap:${sourceId}:${msg.uid}`,
    uid: msg.uid,
    uidValidity: validity,
    subject: msg.envelope?.subject || '(无主题)',
    from: personOf(msg.envelope, 'from'),
    to: personOf(msg.envelope, 'to'),
    date: msg.internalDate ? new Date(msg.internalDate).toISOString() : new Date().toISOString(),
    unread: !flags.includes('\\Seen'),
    size: Number(msg.size ?? 0),
  };
}

async function fetchHeaders(client, source, uids, uidValidity) {
  if (uids.length === 0) return [];
  const headers = [];
  for await (const msg of client.fetch(
    uids.join(','),
    { uid: true, envelope: true, flags: true, internalDate: true, size: true },
    { uid: true },
  )) {
    headers.push(headerOf(msg, source.id, uidValidity));
  }
  return headers;
}

/** 最近 limit 封的 uid（按 UID 升序）。uidNext 必须由调用方给新鲜值 */
function recentUids(limit, uidNext) {
  const count = Math.max(0, Math.min(limit, uidNext - 1));
  const uids = [];
  for (let i = 0; i < count; i += 1) uids.push(uidNext - count + i);
  return uids;
}

/**
 * 取「最近 limit 封」的 uid 列表。
 *
 * **不能只用 uidNext 往回数**：UID 不保证连续（删信、服务端迁移都会留空洞，QQ 邮箱实测
 * 就很常见），按 `uidNext-1 …` 猜十个只回来五封，于是「启动取前十条」变成「能取几条算几条」。
 * 先用 SEARCH ALL 拿真实 UID 表再取尾部；服务端禁 SEARCH 时退回老的猜法。
 */
export async function recentUidsFor(client, limit, info) {
  try {
    const all = await client.search({ all: true }, { uid: true });
    if (Array.isArray(all) && all.length > 0) return all.slice(-limit);
  } catch {
    // 个别服务端限制了 SEARCH：退回按 uidNext 推算
  }
  return recentUids(limit, info.uidNext);
}

/** 取最近 limit 封的邮件头（新的在前）。契约与其它协议一致：返回 Header[] */
export async function listHeaders(source, limit = 10) {
  if (source.oauth2 && !hasOAuth2Token(source)) return [];
  const top = Math.max(1, Math.min(limit, MAX_HEADERS));
  return withSource(source, async (client) => {
    const info = await freshMailboxInfo(client, source.mailbox || 'INBOX');
    const headers = await fetchHeaders(client, source, await recentUidsFor(client, top, info), info.uidValidity);
    headers.sort((a, b) => (b.uid ?? 0) - (a.uid ?? 0));
    return headers;
  });
}

/**
 * 拿一次**新鲜的**邮箱状态。
 *
 * 不能用 `client.mailbox.uidNext`：那是建连/上次 SELECT 时的快照，
 * 长连接复用时新邮件到达不会刷新它 —— 实测会一直报「无新邮件」。
 * STATUS 是权威来源；个别服务端拒绝对已选中邮箱做 STATUS，则退回 NOOP 刷新后读缓存。
 */
async function freshMailboxInfo(client, mailbox) {
  try {
    const status = await client.status(mailbox, { messages: true, uidNext: true, uidValidity: true });
    return {
      uidNext: Number(status.uidNext ?? client.mailbox?.uidNext ?? 1),
      uidValidity: Number(status.uidValidity ?? client.mailbox?.uidValidity ?? 0),
      messages: Number(status.messages ?? client.mailbox?.exists ?? 0),
    };
  } catch {
    try {
      await client.noop();
    } catch {
      // ignore
    }
    return {
      uidNext: Number(client.mailbox?.uidNext ?? 1),
      uidValidity: Number(client.mailbox?.uidValidity ?? 0),
      messages: Number(client.mailbox?.exists ?? 0),
    };
  }
}

/**
 * 搜出 uid ≥ prevNext 的邮件（服务端权威）。
 *
 * **失败必须抛**：以前 `catch { found = [] }` 把"查询失败"和"确实没有新邮件"压成同一个
 * 返回值，调用方于是把 uidNext 推到服务器最新 —— 一次网络抖动就整批跳过、永久丢信（C2）。
 * 抛错后由 `tick()` 的来源级 catch 记 lastError、**不提交游标**，下一轮重试。
 */
export async function searchNewUids(client, prevNext) {
  const from = Number(prevNext);
  if (!Number.isFinite(from) || from < 1) return [];
  let found;
  try {
    found = await client.search({ uid: `${from}:*` }, { uid: true });
  } catch (err) {
    // 保留原文案：withSource 的断连清理用 message 正则判断要不要丢连接
    throw new Error(`IMAP SEARCH 失败（uid ${from}:*）：${err instanceof Error ? err.message : String(err)}`);
  }
  return (Array.isArray(found) ? found : [])
    .map((uid) => Number(uid))
    .filter((uid) => Number.isFinite(uid) && uid >= from)
    .sort((a, b) => a - b);
}

/**
 * 增量轮询：用上一个状态里的 uidValidity/uidNext 找新邮件。
 *
 * 判定以 **UID SEARCH `<prev>:*`** 为准（服务端权威），不依赖任何本地缓存的心跳值。
 * 返回 { mode, headers, warnings, state }，state 需要被持久化。
 */
/**
 * 这份 STATUS 能不能信（本轮线上事故的护栏）。
 *
 * 服务器偶发返回 `uidValidity=0 / uidNext=1`（或 STATUS 失败后的回退默认值）时，
 * 旧逻辑会判定"游标超过服务器最新"→ 把游标重置成 1 → 下一拍从第 1 封开始，
 * 把整箱旧邮件当成新邮件归档（正好 50 封，因为 MAX_NEW_PER_POLL=50）。
 *
 * 判据：UIDVALIDITY 必须 > 0（IMAP 规范里 0 表示异常）；UIDNEXT 至少 1（空邮箱就是 1）。
 * 不满足就当"本轮不可用"：跳过、不推进/不重置游标，下一拍再试。
 */
export function imapStatusSane(info) {
  const validity = Number(info?.uidValidity ?? 0);
  const next = Number(info?.uidNext ?? 0);
  return Number.isFinite(validity) && validity > 0 && Number.isFinite(next) && next >= 1;
}

export async function poll(source, prev, { initialHeaders = 10 } = {}) {
  // 还没登录 OAuth2：跳过，不报错也不推进游标
  if (source.oauth2 && !hasOAuth2Token(source)) return { mode: 'unbound', headers: [], warnings: [] };
  return withSource(source, async (client) => {
    const mailbox = source.mailbox || 'INBOX';
    const info = await freshMailboxInfo(client, mailbox);
    if (!imapStatusSane(info)) {
      return {
        mode: 'idle',
        headers: [],
        warnings: [
          `IMAP STATUS 异常（uidValidity=${info?.uidValidity}，uidNext=${info?.uidNext}）：` +
            '本轮跳过且不推进游标（避免把整箱旧邮件当新邮件）',
        ],
        // 原样回传，不写新游标：state 不变 = 下一次还从原位置继续
        state: prev ?? {},
      };
    }
    const cursor = prev ?? {};
    const prevValidity = Number(cursor.uidValidity ?? 0);
    const prevNext = Number(cursor.uidNext ?? 0);
    const warnings = [];

    /*
     * 三种情况重建基线（这批不归档、不算新邮件）：
     *   1. 首次轮询（没有游标）；
     *   2. 服务端重建了 UID 空间（UIDVALIDITY 变化）——此时旧 uid 指向的是别的信；
     *   3. 游标越过服务器最新（恢复了一份更旧的 state.json、或服务端回退过）——
     *      不回落的话 `uid ≥ prevNext` 永远搜不到东西，来源会永久 idle。
     */
    const validityChanged = Boolean(info.uidValidity && prevValidity && info.uidValidity !== prevValidity);
    const stalled = prevNext > 0 && info.uidNext > 0 && prevNext > info.uidNext;
    if (!prevNext || validityChanged || stalled) {
      /*
       * G6：基线条数以前写死 10，无视 monitor.initial_headers；而且 recentUids 是按 uidNext
       * 连续回推，UID 有空洞时「要 30 封只回来 12 封」。改用 SEARCH ALL 取真实 UID 尾部。
       * 基线只在首启 / UIDVALIDITY 变化 / 游标越界时跑，多一次 SEARCH 可接受。
       */
      const baselineLimit = Math.max(1, Math.min(Number(initialHeaders) || 10, MAX_HEADERS));
      const headers = await fetchHeaders(client, source, await recentUidsFor(client, baselineLimit, info), info.uidValidity);
      headers.sort((a, b) => (a.uid ?? 0) - (b.uid ?? 0));
      if (validityChanged) {
        warnings.push(
          `UIDVALIDITY ${prevValidity} → ${info.uidValidity}：已重建基线` +
            '（UID 空间变化前到达、但还没拉取过的邮件不会被自动补拉）',
        );
      } else if (stalled) {
        warnings.push(`游标 uidNext=${prevNext} 超过服务器最新 ${info.uidNext}：已回落并重建基线`);
      }
      return { mode: 'baseline', headers, warnings, state: { uidValidity: info.uidValidity, uidNext: info.uidNext } };
    }

    // 权威判定：搜一次 uid >= prevNext（失败会抛，绝不伪装成"没有新邮件"）
    const found = await searchNewUids(client, prevNext);
    if (found.length === 0) {
      return {
        mode: 'idle',
        headers: [],
        warnings,
        state: { uidValidity: info.uidValidity, uidNext: Math.max(prevNext, info.uidNext) },
      };
    }

    const batch = found.slice(0, MAX_NEW_PER_POLL);
    const headers = await fetchHeaders(client, source, batch, info.uidValidity);
    headers.sort((a, b) => (a.uid ?? 0) - (b.uid ?? 0)); // 旧的先处理
    const nextUid = Math.max(batch[batch.length - 1] + 1, prevNext);
    return { mode: 'new', headers, warnings, state: { uidValidity: info.uidValidity, uidNext: nextUid } };
  });
}

/** 取单封全文：返回 { raw, rawKind, text, html, attachments, subject, from, to, date } */
export async function fetchBody(source, header) {
  if (!header?.uid) throw new Error(`IMAP 读取失败：邮件头缺少 uid（${header?.id}）`);
  if (source.oauth2 && !hasOAuth2Token(source)) {
    throw new Error('还没有登录 OAuth2：请先在设置页「邮箱」里点「登录」完成设备码登录');
  }
  return withSource(source, async (client) => {
    /*
     * uid 只在自己的 UID 空间里指向那封信。目录名虽然已经带上 validity（C3），
     * 但 header 里的 validity 可能已经过期 —— 不校验的话会把"另一封信"的正文
     * 写进一个名字看起来完全正确的目录（名字对、内容是别人的），比复用目录更隐蔽。
     */
    const want = Number(header.uidValidity ?? 0) || 0;
    if (want > 0) {
      let now = Number(client.mailbox?.uidValidity ?? 0) || 0;
      if (now > 0 && now !== want) {
        // 连接上的 mailbox 信息可能是上次 SELECT 的快照：用 STATUS 再确认一次（只在可疑时多一次往返）
        const info = await freshMailboxInfo(client, source.mailbox || 'INBOX');
        now = Number(info.uidValidity ?? 0) || 0;
      }
      if (now > 0 && now !== want) {
        const err = new Error(`UIDVALIDITY 已变化（${want} → ${now}），放弃 uid=${header.uid} 的正文`);
        err.code = 'EUIDVALIDITY';
        throw err;
      }
    }
    const msg = await client.fetchOne(String(header.uid), { uid: true, source: true }, { uid: true });
    if (!msg?.source) throw new Error(`IMAP 读取失败：uid=${header.uid} 没取到正文`);
    const parsed = await simpleParser(msg.source);
    return {
      // 原始 RFC822 报文（Buffer）：存档原样落盘，换解析器也不丢信息
      raw: msg.source,
      rawKind: 'eml',
      text: decodeEscapedText(parsed.text || ''),
      html: typeof parsed.html === 'string' ? parsed.html : '',
      subject: parsed.subject || header.subject || '',
      from: parsed.from?.text || header.from || '',
      to: parsed.to?.text || header.to || '',
      date: parsed.date ? new Date(parsed.date).toISOString() : header.date,
      attachments: (parsed.attachments || []).map((a) => ({
        name: a.filename || 'attachment',
        size: Number(a.size ?? 0),
        contentType: a.contentType || '',
      })),
    };
  });
}

/** 该协议的初始游标：IMAP 由服务端给出 uidValidity/uidNext，首轮为空对象即"未初始化" */
export function emptyState() {
  return {};
}

/** 设置页 / `mail_automation_status` 用的一行人话 */
export function describeCursor(state) {
  const next = Number(state?.uidNext ?? 0) || 0;
  if (!next) return '尚未建立基线（首轮拉取后自动建立）';
  return `已同步到 UID ${next}（UIDVALIDITY ${Number(state?.uidValidity ?? 0) || '-'}）`;
}

/** 连通性自检（设置页「测试连接」用）：真登录一次并取 1 封邮件头 */
export async function verify(source) {
  if (source.oauth2 && !hasOAuth2Token(source)) {
    throw new Error('还没有登录 OAuth2：请先在设置页「邮箱」里点「登录」完成设备码登录');
  }
  const headers = await listHeaders(source, 1);
  return { ok: true, detail: `IMAP 登录成功（${source.host}:${source.port}），最近 ${headers.length} 封可取` };
}

/** 关掉所有长连接（插件卸载时调用） */
export function closeAll() {
  for (const entry of entries.values()) {
    try {
      entry.client?.close();
    } catch {
      // ignore
    }
    entry.client = null;
  }
  entries.clear();
}

/**
 * 回收"当前配置里已经不存在"的连接（改 source id 之后旧键不会再被用到）。
 *
 * `entries` 是模块级 Map、只增不删，`closeAll` 只发生在卸载时 —— 不回收的话，
 * 每次改 id 都会留一条 TLS 长连接，直到进程退出。
 */
export function pruneSources(keepIds) {
  const keep = keepIds instanceof Set ? keepIds : new Set(keepIds ?? []);
  let closed = 0;
  for (const [key, entry] of [...entries.entries()]) {
    if (keep.has(key)) continue;
    try {
      entry.client?.close();
    } catch {
      // ignore
    }
    entry.client = null;
    entries.delete(key);
    closed += 1;
  }
  return closed;
}

/** 测试用：当前连接池里有哪些来源键 */
export function poolKeys() {
  return [...entries.keys()];
}
