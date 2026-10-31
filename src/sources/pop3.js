/**
 * POP3 来源（只读）。
 *
 * 与 IMAP 的根本差异（见 docs/multi-source.md §3.2）：
 *   - **没有 UIDVALIDITY / UIDNEXT**，会话里的 `LIST` 序号不稳定 —— 唯一稳定的邮件身份是
 *     `UIDL`，所以游标是「已见 UIDL 集合」（`seenIds`），不是服务端位置；
 *   - 读到即视为取走（很多服务器配置成"下载后删除"），**服务器上已经消失的邮件永久错过**，
 *     这是协议限制，不是 bug（日志会明确写一句）；
 *   - 没有未读概念：`unread` 恒 false。
 *
 * 语义与其它来源保持一致：
 *   - 首次 / 游标为空 → 基线：只记录已见，不归档历史；
 *   - 有新邮件 → 返回 `{ mode:'new', headers, state }`，游标由调用方在**整批落盘之后**提交；
 *   - 失败一律抛（不把"查询失败"伪装成"没有新邮件"）。
 */
import { simpleParser } from 'mailparser';
import { Pop3Client } from './pop3client.js';

const MAX_NEW_PER_POLL = 50;
const MAX_HEADERS = 50;
/** 已见 UIDL 上限：POP3 常见几千封，全量保留会让状态文件无限膨胀 */
const SEEN_CAP = 400;
const SOCKET_TIMEOUT_MS = 60_000;

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

async function clientOf(source, entry) {
  if (entry.client && !entry.client.closed) return entry.client;
  try {
    entry.client?.close();
  } catch {
    // ignore
  }
  const client = new Pop3Client({
    host: source.host,
    port: source.port,
    secure: source.secure,
    timeoutMs: SOCKET_TIMEOUT_MS,
  });
  try {
    await client.connect();
    await client.login(source.user, source.password);
  } catch (err) {
    // 握手/认证失败：必须关掉半连接，否则每轮轮询都会泄漏一条 TCP/TLS
    try {
      client.close();
    } catch {
      // ignore
    }
    throw err;
  }
  entry.client = client;
  return client;
}

/** 同一来源串行（POP3 单通道状态机，不能并发） */
function withSource(source, task) {
  const entry = entryOf(source);
  const run = entry.chain.then(async () => {
    const client = await clientOf(source, entry);
    try {
      return await task(client);
    } catch (err) {
      // 连接层面的失败：丢掉连接，下一轮重连（认证失败也走这里，下次仍会响亮地报）
      try {
        client.close();
      } catch {
        // ignore
      }
      entry.client = null;
      throw err;
    }
  });
  entry.chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** 该协议的初始游标（`state-domain.js` 的白名单字段） */
export function emptyState() {
  return { initialized: false, seenIds: [] };
}

/** 设置页 / `mail_automation_status` 用的一行人话 */
export function describeCursor(state) {
  const seen = Array.isArray(state?.seenIds) ? state.seenIds.length : 0;
  if (!state?.initialized) return '尚未建立基线（首轮拉取后自动建立）';
  return `已见 ${seen} 个 UIDL${seen >= SEEN_CAP ? `（上限 ${SEEN_CAP}，更老的会重新判为新）` : ''}`;
}

/**
 * 从整箱 UIDL 里挑出"比最后一个已见 UIDL 更新"的邮件。
 *
 * 为什么不能直接 `all.filter(!seen)`：`seenIds` 只保留最近 `SEEN_CAP` 个，服务器留了 1000 封时
 * 最老的 600 封永远"未见"——每轮都会把最老的 50 封当新邮件重新归档，且永远不收敛。
 * 用**位置判据**（最近一个已见 UIDL 之后的才算新）就不会回看历史；一个已见都找不到时返回
 * `anchor: -1`，调用方重建基线（不归档）。
 */
export function freshUidls(all, seenIds) {
  const list = Array.isArray(all) ? all : [];
  const seen = seenIds instanceof Set ? seenIds : new Set(seenIds ?? []);
  let anchor = -1;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (seen.has(list[index].uidl)) {
      anchor = index;
      break;
    }
  }
  return { anchor, fresh: anchor < 0 ? [] : list.slice(anchor + 1) };
}

function personOf(address) {
  if (!address) return '';
  const list = Array.isArray(address) ? address : [address];
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

async function parseHeader(parsed, source, uidl, n) {
  return {
    // UIDL 是服务端持久身份：同一封邮件任何一次 poll 都得到同一个 id（幂等）
    id: `pop3:${source.id}:${uidl}`,
    uidl,
    // 会话序号只是"这一轮的信箱位置"，**不参与身份**，只用于 RETR
    seq: n,
    subject: parsed?.subject || '(无主题)',
    from: personOf(parsed?.from),
    to: personOf(parsed?.to),
    date: parsed?.date ? new Date(parsed.date).toISOString() : new Date().toISOString(),
    // POP3 没有未读概念
    unread: false,
    size: Number(parsed?.size ?? 0) || 0,
  };
}

/** 取头部文本：优先 TOP（省流量），服务器不支持时退回 RETR */
async function headerText(client, n) {
  try {
    return await client.top(n, 0);
  } catch {
    return (await client.retr(n)).toString('latin1');
  }
}

async function fetchHeaders(client, source, items, warnings) {
  const headers = [];
  /** 真正解析成功的 UIDL：只有这些才能进 seenIds（解析失败的那封下一轮还要重试） */
  const delivered = [];
  for (const item of items) {
    try {
      const text = await headerText(client, item.n);
      const parsed = await simpleParser(Buffer.from(text, 'latin1'));
      headers.push(await parseHeader(parsed, source, item.uidl, item.n));
      delivered.push(item.uidl);
    } catch (err) {
      // 单封头部坏掉不拖死整个来源：留痕，但**不标记已见**（否则这封永久消失）
      warnings.push(`第 ${item.n} 封（UIDL ${item.uidl}）头部解析失败（下一轮重试）：${err?.message ?? err}`);
    }
  }
  return { headers, delivered };
}

/** 取最近 limit 封的邮件头（新的在前） */
export async function listHeaders(source, limit = 10) {
  const top = Math.max(1, Math.min(limit, MAX_HEADERS));
  return withSource(source, async (client) => {
    const all = await client.uidl();
    const items = all.slice(-top);
    const { headers } = await fetchHeaders(client, source, items, []);
    headers.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return headers;
  });
}

/**
 * 增量轮询。
 * @returns {{mode:'idle'|'new'|'baseline', headers:object[], warnings:string[], state:object}}
 */
export async function poll(source, prev, { initialHeaders = 10 } = {}) {
  return withSource(source, async (client) => {
    const all = await client.uidl();
    const warnings = [];
    const seen = new Set(Array.isArray(prev?.seenIds) ? prev.seenIds : []);
    const initialized = prev?.initialized === true;

    // 服务器上一封都没有：保持游标（不要因为空箱就把已见集合清掉）
    if (all.length === 0) {
      return {
        mode: 'idle',
        headers: [],
        warnings,
        state: { initialized: true, seenIds: [...seen].slice(-SEEN_CAP) },
      };
    }

    // 首次：只记已见，不归档历史（与 IMAP/Graph 的基线语义一致）
    if (!initialized) {
      const baselineLimit = Math.max(1, Math.min(Number(initialHeaders) || 10, MAX_HEADERS));
      const { headers } = await fetchHeaders(client, source, all.slice(-baselineLimit), warnings);
      headers.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
      return {
        mode: 'baseline',
        headers,
        warnings,
        state: { initialized: true, seenIds: all.map((item) => item.uidl).slice(-SEEN_CAP) },
      };
    }

    // 增量：只看"最后一个已见 UIDL 之后"的邮件（位置判据，避免 >SEEN_CAP 的信箱每轮重报历史）
    const { anchor, fresh } = freshUidls(all, seen);
    if (anchor < 0) {
      /*
       * 一个已见 UIDL 都不在服务器上了：信箱被清空/换号/状态重建。把整箱当新邮件是最坏选择
       * （可能一次几千封），重建基线更安全——与 Graph "整窗无已见 id" 的处理一致。
       */
      const baselineLimit = Math.max(1, Math.min(Number(initialHeaders) || 10, MAX_HEADERS));
      const { headers } = await fetchHeaders(client, source, all.slice(-baselineLimit), warnings);
      headers.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
      warnings.push(`服务器上没有任何已见 UIDL（${seen.size} 个已见已全部消失）：已重建基线，不归档历史`);
      return {
        mode: 'baseline',
        headers,
        warnings,
        state: { initialized: true, seenIds: all.map((item) => item.uidl).slice(-SEEN_CAP) },
      };
    }
    if (fresh.length === 0) {
      return {
        mode: 'idle',
        headers: [],
        warnings,
        state: { initialized: true, seenIds: [...seen].slice(-SEEN_CAP) },
      };
    }

    const batch = fresh.slice(0, MAX_NEW_PER_POLL);
    if (fresh.length > batch.length) {
      warnings.push(`本轮只处理最旧的 ${batch.length} 封（共 ${fresh.length} 封新邮件，其余下一轮继续）`);
    }
    const { headers, delivered } = await fetchHeaders(client, source, batch, warnings);
    if (delivered.length !== batch.length) {
      // 位置游标不能越过失败项：即使不把它放进 seenIds，后面的成功项也会成为新锚点。
      throw new Error(`POP3 本批邮件头未全部读取成功，游标不推进，下一轮重试：${warnings.join('；')}`);
    }
    /*
     * 只有**真正解析成功**的 UIDL 进 seenIds：解析失败的那封保持"未见"，下一轮重试；
     * 没交付的（超过单轮上限）同样保持未见。超过上限时丢最老的（POP3 的 UIDL 列表
     * 按信箱顺序，尾部是最新的）。
     */
    const merged = [...seen];
    for (const uidl of delivered) if (!merged.includes(uidl)) merged.push(uidl);
    return {
      mode: 'new',
      headers,
      warnings,
      state: { initialized: true, seenIds: merged.slice(-SEEN_CAP) },
    };
  });
}

/** 取单封全文（回到服务端按 UIDL 找当前序号，找不到 = 邮件已经不在服务器上） */
export async function fetchBody(source, header) {
  const uidl = header?.uidl;
  if (!uidl) throw new Error(`POP3 读取失败：邮件头缺少 uidl（${header?.id}）`);
  return withSource(source, async (client) => {
    const all = await client.uidl();
    const found = all.find((item) => item.uidl === uidl);
    if (!found) {
      const err = new Error(`POP3 邮件已不在服务器上（UIDL ${uidl}）：可能被别的客户端取走/删除，该封永久错过`);
      err.code = 'EGONE';
      throw err;
    }
    let raw;
    try {
      raw = await client.retr(found.n);
    } catch (err) {
      /*
       * 瞬时失败（断连/超时/服务器 -ERR）**不能**标 EGONE：那会让 index 永久跳过这封。
       * 只有"UIDL 已经不在服务器上"才是真的永久错过（见上面的分支）。
       */
      throw new Error(`POP3 RETR ${found.n} 失败（UIDL ${uidl}，下一轮重试）：${err?.message ?? err}`);
    }
    const parsed = await simpleParser(raw);
    return {
      raw,
      rawKind: 'eml',
      text: parsed.text || '',
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

/** 连通性自检（设置页「测试连接」用）：连上、登录、数一下 UIDL */
export async function verify(source) {
  return withSource(source, async (client) => {
    const all = await client.uidl();
    return { ok: true, detail: `POP3 登录成功，服务器上有 ${all.length} 封邮件` };
  });
}

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

/** 测试用：连接池里有哪些来源键 */
export function poolKeys() {
  return [...entries.keys()];
}
