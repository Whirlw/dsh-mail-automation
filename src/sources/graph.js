/**
 * Microsoft Graph 来源（只读，复用 dsh-graph-mail 的令牌文件）：
 * - listHeaders：取收件箱最近 N 封
 * - poll：比对已见 id，找出新邮件
 * - fetchBody：取单封全文（HTML → 纯文本）
 *
 * 令牌文件由 dsh-graph-mail（或 graph_mail.py auth）生成，本模块只读它，
 * 并在 access_token 过期时用 refresh_token 换新、把轮换后的 refresh_token 写回。
 */
import fs from 'node:fs';
import lockfile from 'proper-lockfile';
import { atomicWriteFile } from '../fsutil.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const AUTHORITY = 'https://login.microsoftonline.com';
const LIST_SELECT = 'id,subject,from,receivedDateTime,isRead,hasAttachments,bodyPreview,webLink';
const MAX_NEW_PER_POLL = 50;
/** 分页预算：每页 50 封、最多 6 页（= 最近 300 封），足够覆盖一晚的停机积压 */
const PAGE_TOP = 50;
const MAX_PAGES = 6;
/** 已见 id 的保存上限；窗口 300 + 100 余量，避免把窗口内的 id 挤掉后重复发现 */
const SEEN_CAP = 400;

/** 令牌文件：配置归一化时已经展开成绝对路径；缺失说明调用方传错了来源 */
function tokenFileOf(configured) {
  const wanted = String(configured ?? '').trim();
  if (!wanted) throw new Error('Graph 来源缺少 tokenFile：配置未归一化或来源不完整');
  return wanted;
}

function readToken(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`读不到 Graph 令牌文件（${file}）：${err?.message ?? err}`);
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch (err) {
    // 截断的令牌文件不让它变成一句 "Unexpected end of JSON input"（C10）
    throw new Error(`Graph 令牌文件损坏/截断（${file}）：${err?.message ?? err} → 重新运行 graph_mail.py auth`);
  }
  if (!state?.refresh_token || !state?.client_id) {
    throw new Error(`Graph 令牌文件缺少 refresh_token/client_id（${file}）：重新运行 graph_mail.py auth`);
  }
  return state;
}

function writeToken(file, state) {
  try {
    // 原子写 + 0600：截断的令牌文件会让整个 Graph 来源挂掉，权限也不该是 umask 默认
    atomicWriteFile(file, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch (err) {
    // 写回失败最坏情况是下次用旧 refresh token（可能 invalid_grant），但至少要留一条痕迹
    console.warn(`[mail-automation] 写入 Graph 令牌失败（${file}）：${err?.message ?? err}`);
  }
}

/**
 * 令牌文件的跨模块互斥：dsh-graph-mail 插件也会刷新**同一个**文件并整文件覆写，
 * 两边同时刷新会把对方轮换后的 refresh_token 写旧，下一次就是 invalid_grant。
 */
async function withTokenLock(file, fn) {
  let release;
  try {
    release = await lockfile.lock(file, {
      realpath: false,
      retries: { retries: 8, minTimeout: 150, maxTimeout: 800 },
      stale: 15_000,
    });
  } catch {
    release = undefined; // 拿不到锁也不阻断，退化为无锁（最坏情况见上）
  }
  try {
    return await fn();
  } finally {
    if (release) {
      try {
        await release();
      } catch {
        // ignore
      }
    }
  }
}

function tokenUsable(state) {
  return Boolean(state?.access_token) && Number(state.expires_at || 0) > Date.now() / 1000 + 60;
}

async function refresh(file, state) {
  const tenant = state.tenant || 'common';
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: state.client_id,
    refresh_token: state.refresh_token,
  });
  if (state.scope) form.set('scope', state.scope);
  const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(30_000) : undefined;
  const res = await fetch(`${AUTHORITY}/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form.toString(),
    ...(signal ? { signal } : {}),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) {
    const detail = data?.error_description || data?.error || res.statusText;
    throw new Error(`刷新 Microsoft Graph 令牌失败（HTTP ${res.status}）：${detail}`);
  }
  state.access_token = data.access_token;
  state.expires_at = Date.now() / 1000 + Number(data.expires_in || 3600);
  if (data.refresh_token) state.refresh_token = data.refresh_token;
  writeToken(file, state);
  return state.access_token;
}

async function accessToken(rawFile) {
  const file = tokenFileOf(rawFile);
  const state = readToken(file);
  if (tokenUsable(state)) return state.access_token;
  return withTokenLock(file, async () => {
    // 锁内重读：可能别的模块刚刷新过
    const fresh = readToken(file);
    if (tokenUsable(fresh)) return fresh.access_token;
    return refresh(file, fresh);
  });
}

async function graphRequest(configuredFile, pathname, params) {
  const tokenFile = tokenFileOf(configuredFile);
  /*
   * 支持 `@odata.nextLink` 的**绝对 URL**：分页链接自带 `$skiptoken`（以及 $select/$top），
   * 拼在 `GRAPH + pathname` 后面会 400，所以绝对地址必须原样请求。
   * 只允许 graph.microsoft.com，否则一个畸形/被篡改的 nextLink 就能把 Bearer 发到外域。
   */
  const absolute = /^https?:\/\//i.test(String(pathname));
  let url = absolute ? String(pathname) : GRAPH + pathname;
  if (absolute) {
    const origin = (() => {
      try {
        return new URL(url).origin;
      } catch {
        return '';
      }
    })();
    if (origin !== new URL(GRAPH).origin) throw new Error('Graph 分页链接异常：域名不属于 graph.microsoft.com');
  }
  if (params && !absolute) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) qs.set(k, String(v));
    const q = qs.toString();
    if (q) url += `?${q}`;
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await accessToken(tokenFile);
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(30_000) : undefined;
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      ...(signal ? { signal } : {}),
    });
    if (res.status === 401 && attempt === 0) {
      await withTokenLock(tokenFile, async () => {
        const state = readToken(tokenFile);
        state.expires_at = 0;
        writeToken(tokenFile, state);
      });
      continue;
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = data?.error?.message || (data ? JSON.stringify(data).slice(0, 300) : res.statusText);
      const hint = res.status === 403 ? '（缺少 Mail.Read 委托权限或未获同意）' : '';
      throw new Error(`Graph 请求失败 ${res.status}${hint}：${detail}`);
    }
    return data;
  }
  throw new Error('Graph 请求失败：重新认证后仍未通过');
}

function person(p) {
  if (!p) return '';
  const ea = p.emailAddress || p;
  const addr = ea.address || '';
  const name = ea.name || '';
  if (name && addr && name !== addr) return `${name} <${addr}>`;
  return addr || name;
}

function headerOf(m, sourceId) {
  return {
    id: `graph:${sourceId}:${m.id}`,
    graphId: m.id,
    subject: m.subject || '(无主题)',
    from: person(m.from),
    to: person(m.toRecipients),
    date: m.receivedDateTime || new Date().toISOString(),
    unread: m.isRead === false,
    hasAttachments: Boolean(m.hasAttachments),
    preview: String(m.bodyPreview || '').slice(0, 240),
    webLink: m.webLink || '',
  };
}

/** 令牌文件是否存在：不存在 = 还没绑定，调用方应跳过而不是报错 */
function tokenExists(source) {
  try {
    return fs.existsSync(source.tokenFile);
  } catch {
    return false;
  }
}

function requireBound(source) {
  if (tokenExists(source)) return;
  throw new Error(
    `还没有绑定 Microsoft Graph（缺少令牌文件 ${source.tokenFile}）：` +
      '请先在设置页「邮箱」里点「绑定」完成设备码登录',
  );
}

export async function listHeaders(source, limit = 10) {
  // 还没绑定：静默返回空列表（启动快照/自检之外都不该因此报错）
  if (!tokenExists(source)) return [];
  const data = await graphRequest(source.tokenFile, `/me/mailFolders/${encodeURIComponent(source.folder || 'inbox')}/messages`, {
    $top: Math.max(1, Math.min(limit, 50)),
    $select: LIST_SELECT,
    $orderby: 'receivedDateTime desc',
  });
  const headers = (data?.value ?? []).map((m) => headerOf(m, source.id));
  headers.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return headers;
}

/**
 * 轮询：分页扫最近若干封，用「已见 id 集合」判断哪些是新到的（C4）。
 *
 * 以前只取一页 `max(20, top)`：停机期间到的邮件一旦滑出这一页，就既不在 `seenIds`、
 * 也不会再被列出来 —— 永远不会被当成新邮件。现在最多翻 6 页（300 封）；
 * 更老的部分由后续轮次继续（超出的 fresh 不写进 seenIds，下一轮会重新命中）。
 */
export async function poll(source, prev) {
  // 还没绑定（令牌文件不存在）：不报错、不推进游标，等用户完成绑定
  if (!tokenExists(source)) return { mode: 'unbound', headers: [], warnings: [] };
  const seen = new Set(Array.isArray(prev?.seenIds) ? prev.seenIds : []);
  const pathname = `/me/mailFolders/${encodeURIComponent(source.folder || 'inbox')}/messages`;
  const byId = new Map();
  let cursor = '';
  let budgetExhausted = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = cursor
      ? await graphRequest(source.tokenFile, cursor) // 绝对 URL：不能再叠 $select/$top
      : await graphRequest(source.tokenFile, pathname, {
          $top: PAGE_TOP,
          $select: LIST_SELECT,
          $orderby: 'receivedDateTime desc',
        });
    const items = (data?.value ?? []).map((m) => headerOf(m, source.id));
    for (const header of items) if (!byId.has(header.graphId)) byId.set(header.graphId, header);
    cursor = typeof data?.['@odata.nextLink'] === 'string' ? data['@odata.nextLink'] : '';
    if (!cursor || items.length === 0) break;
    // 还有下一页但预算已用完：下一轮从顶部重扫（未交付的不会进 seen，所以还能命中）
    budgetExhausted = page === MAX_PAGES - 1;
  }

  const all = [...byId.values()].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (seen.size === 0 && !prev?.initialized) {
    return { mode: 'baseline', headers: all, warnings: [], state: { initialized: true, seenIds: all.slice(0, SEEN_CAP).map((h) => h.graphId) } };
  }

  /*
   * 位置判据（防止"扩窗/换机后把历史当新邮件"）：`all` 是按时间倒序的。
   *   - 遇到**第一个已见 id** 之前的邮件 → 比已知最新还新，才是真·新邮件；
   *   - 之后的邮件 → 比已知更旧，只是"没见过"（seenIds 变浅、窗口变深、状态重建），
   *     只标记已见、**绝不归档**。
   * 以前直接 `filter(!seen)`，一旦 seenIds 只有 49 个而窗口是 300，就会把 250 封
   * 历史邮件当新邮件，每拍抓 50 封重跑一遍 agent。
   */
  const warnings = [];
  let sawSeen = false;
  const freshNewestFirst = [];
  const backlog = [];
  for (const header of all) {
    if (seen.has(header.graphId)) {
      sawSeen = true;
      continue;
    }
    if (sawSeen) backlog.push(header);
    else freshNewestFirst.push(header);
  }

  if (!sawSeen) {
    /*
     * 扫完整个窗口都没有一个已见 id：要么换机/状态被重建，要么积压超过窗口。
     * 这时把整窗当新邮件是最坏选择（几百封重跑 agent）；重建基线更安全——
     * 基线只记位置、不归档。
     */
    warnings.push(`最近 ${all.length} 封里没有一个已见 id：已重建基线（不归档旧邮件）`);
    return {
      mode: 'baseline',
      headers: all,
      warnings,
      state: { initialized: true, seenIds: all.slice(0, SEEN_CAP).map((h) => h.graphId) },
    };
  }

  if (backlog.length > 0) {
    warnings.push(`跳过 ${backlog.length} 封比已知更旧的邮件（只标记已见，不归档）`);
  }

  const fresh = freshNewestFirst.sort((a, b) => String(a.date).localeCompare(String(b.date))); // 旧的先处理（FIFO）
  const batch = fresh.slice(0, MAX_NEW_PER_POLL);
  /*
   * **只有真正交付的这批 + 确认更旧的积压**才写进 seenIds。未交付的新邮件不写，
   * 下一轮还能重新命中（否则分页会把 >50 封新信静默吞掉）。
   * 顺序保持"新在前"，截断只丢最老的已见 id。
   */
  const deliveredIds = new Set(batch.map((header) => header.graphId));
  const undeliveredIds = new Set(fresh.slice(MAX_NEW_PER_POLL).map((header) => header.graphId));
  const backlogIds = new Set(backlog.map((header) => header.graphId));
  const merged = [];
  for (const header of all) {
    if (undeliveredIds.has(header.graphId)) continue;
    if (deliveredIds.has(header.graphId) || backlogIds.has(header.graphId)) merged.push(header.graphId);
  }
  for (const id of seen) if (!merged.includes(id)) merged.push(id);
  const seenIds = merged.slice(0, SEEN_CAP);
  if (budgetExhausted && fresh.length > batch.length) {
    warnings.push(`本轮只扫到最近 ${MAX_PAGES * PAGE_TOP} 封，更老的积压会在后续轮次继续处理`);
  }
  return {
    mode: batch.length ? 'new' : 'idle',
    headers: batch,
    warnings,
    state: { initialized: true, seenIds },
  };
}

/** 该协议的初始游标 */
export function emptyState() {
  return { initialized: false, seenIds: [] };
}

/** 设置页 / `mail_automation_status` 用的一行人话 */
export function describeCursor(state) {
  const seen = Array.isArray(state?.seenIds) ? state.seenIds.length : 0;
  if (!state?.initialized) return '尚未建立基线（首轮拉取后自动建立）';
  return `已见 ${seen} 个 id`;
}

/** 连通性自检（设置页「测试连接」用）：真取 1 封邮件 + 账号信息 */
export async function verify(source) {
  requireBound(source);
  const me = await graphRequest(source.tokenFile, '/me', { $select: 'mail,userPrincipalName,displayName' });
  const headers = await listHeaders(source, 1);
  return {
    ok: true,
    detail: `Graph 登录成功：${me?.mail || me?.userPrincipalName || me?.displayName || '(未知账号)'}，最近 ${headers.length} 封可取`,
  };
}

export function asText(body) {
  if (!body) return '';
  const content = body.content || '';
  if (String(body.contentType || '').toLowerCase() !== 'html') return content;
  return content
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
    // 数字实体：&#26684; / &#x683c;（上一轮实测正文里就漏了这个，显示成 &#26684;）
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
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

export async function fetchBody(source, header) {
  const id = header?.graphId;
  if (!id) throw new Error(`Graph 读取失败：邮件头缺少 graphId（${header?.id}）`);
  requireBound(source);
  const msg = await graphRequest(source.tokenFile, `/me/messages/${encodeURIComponent(id)}`, {
    $select: 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments,webLink',
  });
  let attachments = [];
  if (msg.hasAttachments) {
    try {
      const data = await graphRequest(source.tokenFile, `/me/messages/${encodeURIComponent(id)}/attachments`, {
        $select: 'id,name,contentType,size',
      });
      attachments = (data?.value ?? []).map((a) => ({
        name: a.name || 'attachment',
        size: Number(a.size ?? 0),
        contentType: a.contentType || '',
      }));
    } catch {
      // 附件元数据失败不影响正文
    }
  }
  return {
    // Graph 没有 RFC822；接口返回的 JSON 就是「原始报文」，原样落盘
    raw: msg,
    rawKind: 'json',
    text: asText(msg.body),
    html: String(msg.body?.contentType || '').toLowerCase() === 'html' ? msg.body.content : '',
    subject: msg.subject || header.subject || '',
    from: person(msg.from) || header.from || '',
    to: person(msg.toRecipients) || '',
    date: msg.receivedDateTime || header.date,
    webLink: msg.webLink || '',
    attachments,
  };
}
