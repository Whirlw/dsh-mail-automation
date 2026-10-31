/**
 * Gmail API 来源（只读）。
 *
 * 增量用 `users.history.list`（historyId），并遵守两条已知教训（docs/multi-source.md §3.3）：
 *   1. historyId 会过期（404 `historyId is too old`）→ **回落到 messages.list 重建基线**，
 *      不把整窗历史当新邮件重放（Graph 2026-10-29 事故的同款护栏）；
 *   2. `seenIds` 同时作为去重兜底：history 返回的 id 再过滤一遍已见集合。
 *
 * id 用 **message id**（不是 threadId）：Gmail 一个 thread 可能有多条消息，
 * 用 thread 会把两封不同的信当成同一封。
 */
import { simpleParser } from 'mailparser';
import fs from 'node:fs';
import { gmailRequest, gmailTokenFile } from './oauth.js';

const MAX_NEW_PER_POLL = 50;
const MAX_HEADERS = 50;
const SEEN_CAP = 400;
/** 一次 history 拉多少条变更（Gmail 上限 500；100 足够一轮，剩下的下一轮继续） */
const HISTORY_MAX = 100;

/** 令牌文件是否存在：不存在 = 还没绑定，轮询应跳过而不是每拍报错 */
function tokenExists(source) {
  try {
    return fs.existsSync(gmailTokenFile(source));
  } catch {
    return false;
  }
}

function requireBound(source) {
  if (tokenExists(source)) return;
  throw new Error(
    `还没有绑定 Gmail（缺少令牌文件 ${gmailTokenFile(source)}）：` +
      '请先在设置页「邮箱」里点「绑定」完成 OAuth 授权',
  );
}
/** 单轮最多翻几页 history（防止异常账号把一轮拖死；只提交已完整交付的记录） */
const MAX_HISTORY_PAGES = 5;
const METADATA_HEADERS = ['Subject', 'From', 'To', 'Cc', 'Date', 'Message-ID'];

/** 该协议的初始游标（字段必须出现在 state-domain.js 的白名单里） */
export function emptyState() {
  return { initialized: false, historyId: 0, seenIds: [], email: '' };
}

export function describeCursor(state) {
  if (!state?.initialized) return '尚未建立基线（首轮拉取后自动建立）';
  const seen = Array.isArray(state.seenIds) ? state.seenIds.length : 0;
  const history = Number(state.historyId ?? 0);
  // 邮箱地址已经在来源身份行里显示，这里不再重复
  return `historyId=${history || '-'}，已见 ${seen} 个 id`;
}

function headerValue(payload, name) {
  const list = Array.isArray(payload?.headers) ? payload.headers : [];
  const found = list.find((header) => String(header?.name ?? '').toLowerCase() === String(name).toLowerCase());
  return found ? String(found.value ?? '') : '';
}

/** 邮件地址头可能有多个人：'a@x, b@y' 原样保留，空值给空串 */
function addressOf(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** 元数据响应 → 统一 Header 形状 */
export function headerOf(message, sourceId) {
  const internal = Number(message?.internalDate ?? 0);
  return {
    id: `gmail:${sourceId}:${message.id}`,
    gmailId: message.id,
    threadId: message.threadId,
    subject: headerValue(message.payload, 'Subject') || '(无主题)',
    from: addressOf(headerValue(message.payload, 'From')),
    to: addressOf(headerValue(message.payload, 'To')),
    date: internal > 0 ? new Date(internal).toISOString() : new Date().toISOString(),
    unread: Array.isArray(message.labelIds) ? message.labelIds.includes('UNREAD') : false,
    labelIds: Array.isArray(message.labelIds) ? message.labelIds : [],
    preview: String(message.snippet ?? '').slice(0, 240),
    webLink: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(String(message.id ?? ''))}`,
  };
}

/** 取一封的元数据（format=metadata 比 raw 便宜得多） */
async function metadataOf(source, id) {
  const message = await gmailRequest(source, `/users/me/messages/${encodeURIComponent(id)}`, {
    format: 'metadata',
    metadataHeaders: METADATA_HEADERS,
  });
  return headerOf(message, source.id);
}

/**
 * 取一批元数据。
 *
 * `strict=true` 用于轮询：除"邮件已不存在（404）"之外，任何一封取不到就**抛**，
 * 调用方不提交游标、下一轮重试（否则 historyId 越过它，永远不再出现）。
 *
 * **404 必须单独处理**：history 列出 messageAdded 之后邮件被删除/彻底移走是正常竞态，
 * 404 是永久的；如果也抛，游标会一直停在同一段 history 上，同一封 404 把整个来源卡死。
 * 这类 id 记为 `gone`：调用方把它们写进 seenIds（不再重查），并留一条 WARN。
 */
async function metadataFor(source, ids, { strict = false } = {}) {
  const headers = [];
  const gone = [];
  for (const id of ids) {
    try {
      headers.push(await metadataOf(source, id));
    } catch (err) {
      if (err?.status === 404) {
        gone.push(id);
        continue;
      }
      if (strict) {
        throw new Error(`Gmail 取邮件元数据失败（id=${id}）：${err?.message ?? err}（本轮不推进游标，下一轮重试）`);
      }
    }
  }
  return { headers, gone };
}

export async function listHeaders(source, limit = 10) {
  if (!tokenExists(source)) return [];
  const top = Math.max(1, Math.min(limit, MAX_HEADERS));
  const data = await gmailRequest(source, '/users/me/messages', {
    maxResults: top,
    labelIds: source.folder || 'INBOX',
  });
  const ids = (data?.messages ?? []).map((message) => message.id).filter(Boolean);
  const { headers } = await metadataFor(source, ids);
  headers.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return headers;
}

export async function profile(source) {
  const data = await gmailRequest(source, '/users/me/profile');
  return {
    email: String(data?.emailAddress ?? ''),
    historyId: Number(data?.historyId ?? 0) || 0,
    messagesTotal: Number(data?.messagesTotal ?? 0) || 0,
  };
}

/** 基线：只记已见 + 当前 historyId，**不归档历史** */
async function baseline(source, warnings, initialHeaders) {
  const info = await profile(source);
  const listed = await gmailRequest(source, '/users/me/messages', {
    maxResults: Math.max(1, Math.min(Number(initialHeaders) || 10, MAX_HEADERS)),
    labelIds: source.folder || 'INBOX',
  });
  const ids = (listed?.messages ?? []).map((message) => message.id).filter(Boolean);
  if (!info.historyId) {
    warnings.push('Gmail profile 没有返回 historyId：下一轮会再次重建基线（频繁重建请检查授权范围）');
  }
  return {
    mode: 'baseline',
    headers: [],
    warnings,
    state: { initialized: true, historyId: info.historyId, seenIds: ids.slice(0, SEEN_CAP), email: info.email },
  };
}

/**
 * 增量轮询。
 * @returns {{mode:'idle'|'new'|'baseline', headers:object[], warnings:string[], state:object}}
 */
export async function poll(source, prev, { initialHeaders = 10 } = {}) {
  // 还没绑定：不报错、不推进游标，等设置页完成 OAuth
  if (!tokenExists(source)) return { mode: 'unbound', headers: [], warnings: [] };
  const seen = new Set(Array.isArray(prev?.seenIds) ? prev.seenIds : []);
  const warnings = [];
  const startHistoryId = Number(prev?.historyId ?? 0) || 0;

  if (prev?.initialized !== true || !startHistoryId) {
    return baseline(source, warnings, initialHeaders);
  }

  /*
   * 跟随 nextPageToken：Gmail 返回的 `historyId` 是**信箱当前**的游标，不是"本页最后一条"。
   * 只看第一页却提交它，会把后面几页里的邮件永久跳过（停机后一次涌入大量变更时）。
   * 页数/条数有上限；只推进到完整交付的 history 记录，下一轮从该记录之后继续。
   */
  const records = [];
  let pageToken = '';
  let nextHistoryId = startHistoryId;
  let truncated = false;
  try {
    for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
      const params = {
        startHistoryId,
        labelId: source.folder || 'INBOX',
        historyTypes: 'messageAdded',
        maxResults: HISTORY_MAX,
      };
      if (pageToken) params.pageToken = pageToken;
      const history = await gmailRequest(source, '/users/me/history', params);
      nextHistoryId = Number(history?.historyId ?? 0) || nextHistoryId;
      for (const record of Array.isArray(history?.history) ? history.history : []) {
        if (!Number(record?.id)) throw new Error('Gmail history 记录缺少有效 id，游标不推进');
        records.push(record);
      }
      pageToken = String(history?.nextPageToken ?? '');
      if (!pageToken) break;
      if (page === MAX_HISTORY_PAGES - 1) truncated = true;
    }
  } catch (err) {
    /*
     * historyId 过期（Gmail 一般保留几天到几周）→ 用 messages.list 重建基线。
     * 绝不能把 messages.list 的整窗当新邮件：那正是"批量重放历史"。
     * 注意：Gmail 的过期 404 文案通常是 "Requested entity was not found"（不含 historyId），
     * 所以按 404 + not found 判定；其它 404（label 配错等）原样抛出，不伪装成"过期"。
     */
    const message = String(err?.message ?? err);
    if (err?.status === 404 && /historyId|too old|not found/i.test(message)) {
      warnings.push(`historyId=${startHistoryId} 已失效（${message}）：已重建基线，这段时间的邮件不会被补处理`);
      return baseline(source, warnings, initialHeaders);
    }
    throw err;
  }

  const batch = [];
  const selected = new Set(seen);
  let committedHistoryId = startHistoryId;
  let partial = false;
  for (const record of records) {
    const list = Array.isArray(record.messagesAdded) ? record.messagesAdded : [];
    for (const entry of list) {
      const id = entry?.message?.id;
      if (!id || selected.has(id)) continue;
      if (batch.length >= MAX_NEW_PER_POLL) {
        partial = true;
        break;
      }
      batch.push(id);
      selected.add(id);
    }
    if (partial) break;
    committedHistoryId = Number(record.id);
  }
  // 只有所有页、所有记录都消费完时才能使用响应里的“信箱当前游标”。
  if (!partial && !truncated) committedHistoryId = nextHistoryId;
  if (partial || truncated) {
    warnings.push(`本轮处理 ${batch.length} 封，historyId 推进到完整交付的记录 ${committedHistoryId}，剩余变更下一轮继续`);
  }
  const { headers, gone } = await metadataFor(source, batch, { strict: true });
  headers.sort((a, b) => String(a.date).localeCompare(String(b.date))); // 旧的先处理（FIFO）

  if (gone.length > 0) {
    // 已不存在的邮件标记为已见：否则下一轮（尤其是 historyId 不前进时）会反复 404、永久卡住来源
    warnings.push(
      `${gone.length} 封邮件在读取前已被删除/移走（id=${gone.slice(0, 3).join('、')}${gone.length > 3 ? '…' : ''}）：` +
        '已标记为已见，不阻塞后续轮询',
    );
  }

  const merged = [];
  for (const header of headers) merged.push(header.gmailId);
  for (const id of gone) if (!merged.includes(id)) merged.push(id);
  for (const id of seen) if (!merged.includes(id)) merged.push(id);
  return {
    mode: headers.length ? 'new' : 'idle',
    headers,
    warnings,
    state: {
      ...prev,
      initialized: true,
      historyId: committedHistoryId,
      // 单条 history 可含超过 400 封邮件；该记录未完成时不能淘汰去重项。
      // 记录完成、游标前进后再恢复通常上限，避免巨型记录内部循环重放。
      seenIds: committedHistoryId === startHistoryId ? merged : merged.slice(0, SEEN_CAP),
      email: String(prev?.email ?? ''),
    },
  };
}

/** base64url（Gmail 的 raw 是 URL-safe，可能没有 padding）→ Buffer */
export function decodeBase64Url(value) {
  const text = String(value ?? '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(text, 'base64');
}

/** 兜底：没有 raw 时从 payload 里拼出 text/html（MIME 嵌套时取第一段匹配的） */
function bodyFromPayload(payload, wanted) {
  const queue = [payload];
  while (queue.length > 0) {
    const part = queue.shift();
    if (!part) continue;
    const mime = String(part.mimeType ?? '').toLowerCase();
    const data = part.body?.data;
    if (mime.includes(wanted) && data) return decodeBase64Url(data).toString('utf8');
    if (Array.isArray(part.parts)) queue.push(...part.parts);
  }
  return '';
}

function htmlToText(html) {
  return String(html ?? '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

export async function fetchBody(source, header) {
  const id = header?.gmailId;
  if (!id) throw new Error(`Gmail 读取失败：邮件头缺少 gmailId（${header?.id}）`);
  requireBound(source);
  let message;
  try {
    message = await gmailRequest(source, `/users/me/messages/${encodeURIComponent(id)}`, { format: 'raw' });
  } catch (err) {
    if (err?.status === 404) {
      // 归档前被删除/移走：永久性，标成 EGONE 让调用方立即跳过（普通错误会白重试到上限）
      const gone = new Error(`Gmail 邮件已不存在（id=${id}）：归档前被删除或移走，该封永久错过`);
      gone.code = 'EGONE';
      throw gone;
    }
    throw err;
  }
  const raw = message?.raw ? decodeBase64Url(message.raw) : null;
  if (raw) {
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
      webLink: header.webLink || '',
      attachments: (parsed.attachments || []).map((a) => ({
        name: a.filename || 'attachment',
        size: Number(a.size ?? 0),
        contentType: a.contentType || '',
      })),
    };
  }
  // 极少数情况下服务器不给 raw：退回 format=full 从 payload 拼
  const full = await gmailRequest(source, `/users/me/messages/${encodeURIComponent(id)}`, { format: 'full' });
  const html = bodyFromPayload(full?.payload, 'html');
  const text = bodyFromPayload(full?.payload, 'plain') || htmlToText(html);
  return {
    raw: full,
    rawKind: 'json',
    text,
    html,
    subject: headerValue(full?.payload, 'Subject') || header.subject || '',
    from: addressOf(headerValue(full?.payload, 'From')) || header.from || '',
    to: addressOf(headerValue(full?.payload, 'To')) || '',
    date: header.date,
    webLink: header.webLink || '',
    attachments: (Array.isArray(full?.payload?.parts) ? full.payload.parts : [])
      .filter((part) => part.filename)
      .map((part) => ({
        name: part.filename,
        size: Number(part.body?.size ?? 0) || 0,
        contentType: String(part.mimeType ?? ''),
      })),
  };
}

/** 连通性自检（设置页「测试连接」用） */
export async function verify(source) {
  requireBound(source);
  const info = await profile(source);
  return {
    ok: true,
    detail: `Gmail 登录成功：${info.email || '(未知账号)'}，共 ${info.messagesTotal} 封，historyId=${info.historyId || '-'}`,
  };
}

/** 令牌文件位置（绑定流程与来源模块共用同一份计算） */
export function tokenFileOf(source) {
  return gmailTokenFile(source);
}
