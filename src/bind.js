/**
 * 邮箱 / QQ 机器人的「绑定」流程（OAuth 与扫码）。
 *
 * 这里只做**协议与凭据落盘**，不做 UI 渲染：设置页通过两个 HTTP 动作驱动
 * `start*()` → 轮询 `poll*()`，成功后由 uiapi 把 appId/openid 写回 YAML。
 *
 * 三条纪律：
 *   1. **密钥只在宿主侧流转**：`poll*()` 返回的 secret 只交给 uiapi 写凭据/文件，
 *      绝不进快照、日志、HTTP 响应的公开字段；
 *   2. 每个会话都有 TTL（默认 10 分钟），过期/取消/卸载都会关掉本地回调端口；
 *   3. 失败必须**可分类型**（pending / expired / denied / error），UI 才能说清"再扫一次"
 *      还是"配置写错了"。
 *
 * 协议来源（2026-10-31 核对）：
 *   - Microsoft device code：`login.microsoftonline.com/{tenant}/oauth2/v2.0/devicecode|token`
 *   - Google OAuth：`accounts.google.com/o/oauth2/v2/auth` + 回环 `127.0.0.1` 回调
 *   - QQ 扫码：`q.qq.com/lite/create_bind_task` / `/lite/poll_bind_result`
 *     （AES-256-GCM 加密的 client_secret；流程与 q.qq.com 的 connect.html 配套）
 */
import { randomBytes, createDecipheriv } from 'node:crypto';
import http from 'node:http';
import { GOOGLE_AUTH_URL, GOOGLE_TOKEN_URL, GMAIL_SCOPES, withTokenLock, writeTokenFile } from './sources/oauth.js';

const SESSION_TTL_MS = 10 * 60_000;
const MAX_SESSIONS = 8;
const UA = 'dsh-mail-automation/0.8 (+https://github.com/deepseek-ai/dsh)';
const QQ_PORTAL = 'https://q.qq.com';
const QQ_CONNECT_URL =
  'https://q.qq.com/qqbot/openclaw/connect.html?task_id={task_id}&_wv=2&source=dsh-mail-automation';
const GRAPH_AUTHORITY = 'https://login.microsoftonline.com';
const GRAPH_DEVICE_SCOPE = 'offline_access Mail.Read User.Read';

/** id → session */
const sessions = new Map();

const now = () => Date.now();

function newId(provider) {
  return `${provider}_${randomBytes(6).toString('hex')}`;
}

export function pruneExpired() {
  for (const [id, session] of [...sessions.entries()]) {
    if (session.status === 'pending' && session.expiresAt <= now()) {
      session.status = 'expired';
      session.error = '绑定超时（10 分钟），请重新发起';
      session.finishedAt = now();
      closeServer(session);
    }
  }
  // 已结束的会话保留 5 分钟供 UI 读最后一次结果，之后清掉
  for (const [id, session] of [...sessions.entries()]) {
    if (session.status !== 'pending' && session.finishedAt && now() - session.finishedAt > 5 * 60_000) {
      closeServer(session);
      sessions.delete(id);
    }
  }
}

function register(session) {
  pruneExpired();
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (!oldest) break;
    closeServer(oldest[1]);
    sessions.delete(oldest[0]);
  }
  sessions.set(session.id, session);
  return session;
}

function closeServer(session) {
  if (!session?.server) return;
  try {
    session.server.close();
  } catch {
    // ignore
  }
  session.server = null;
}

/** 对外可见的会话摘要（**永远不含** deviceCode / secret / aesKey） */
export function describeBind(id) {
  const session = sessions.get(String(id ?? ''));
  if (!session) return null;
  const base = {
    id: session.id,
    provider: session.provider,
    status: session.status,
    error: session.error || '',
    expiresAt: session.expiresAt,
  };
  if (session.provider === 'graph') {
    return { ...base, userCode: session.userCode, verificationUri: session.verificationUri, message: session.message };
  }
  if (session.provider === 'gmail') {
    return { ...base, url: session.authUrl, redirectUri: session.redirectUri, manual: Boolean(session.manual) };
  }
  if (session.provider === 'qq') {
    return { ...base, url: session.connectUrl, taskId: session.taskId };
  }
  return base;
}

/** 完成后的结果摘要：只放不敏感字段（secret 永远不在这里） */
function resultView(session) {
  const result = session.result;
  if (!result) return {};
  const out = {};
  for (const key of ['account', 'email', 'appId', 'openid', 'tokenFile']) {
    if (result[key]) out[key] = result[key];
  }
  return out;
}

function finish(session, status, error = '', result = null) {
  /*
   * 终态不可被晚到的结果覆盖：用户点了取消、或二维码已过期之后，在途 poll 回来仍可能
   * 拿着 completed 结果；直接写会把"取消"变成"绑定成功"。
   */
  if (session.status !== 'pending' && session.status !== status) {
    return { ...describeBind(session.id), result: resultView(session) };
  }
  session.status = status;
  session.error = error;
  session.result = result;
  session.finishedAt = now();
  closeServer(session);
  return { ...describeBind(session.id), result: resultView(session) };
}

// ───────────────────────── Microsoft Graph（device code） ─────────────────────────

/** 绑定链路的 fetch 都要有超时：网络黑洞不能让设置页的 HTTP 请求挂死 */
function fetchWithTimeout(url, options = {}, timeoutMs = 15_000) {
  const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
  return fetch(url, { ...options, ...(signal ? { signal } : {}) });
}

async function postForm(url, form, { accept = 'application/json' } = {}) {
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept },
    body: form.toString(),
  });
  const data = await res.json().catch(() => null);
  return { res, data };
}

async function postJson(url, body) {
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // q.qq.com 在缺少 Accept/UA 时会返回反爬 HTML：把片段带进错误，别只说"解析失败"
    data = { raw: text.slice(0, 200) };
  }
  return { res, data };
}

/**
 * 开始 Graph device code 登录。
 * @param {{clientId:string, tenant?:string, tokenFile:string}} options
 */
export async function startGraphBind({ clientId, tenant = 'common', tokenFile }) {
  if (!String(clientId ?? '').trim()) {
    return { ok: false, error: '缺少 OAuth 客户端 id（Graph 绑定需要先在 Azure 应用注册里创建公共客户端）' };
  }
  const id = newId('graph');
  const session = register({
    id,
    provider: 'graph',
    status: 'pending',
    createdAt: now(),
    expiresAt: now() + SESSION_TTL_MS,
    clientId: String(clientId ?? '').trim(),
    tenant: String(tenant ?? 'common').trim() || 'common',
    tokenFile: String(tokenFile ?? '').trim(),
    interval: 5,
    lastPollAt: 0,
    deviceCode: '',
    userCode: '',
    verificationUri: '',
    message: '',
  });
  const form = new URLSearchParams({ client_id: session.clientId, scope: GRAPH_DEVICE_SCOPE });
  let res;
  let data;
  try {
    ({ res, data } = await postForm(`${GRAPH_AUTHORITY}/${encodeURIComponent(session.tenant)}/oauth2/v2.0/devicecode`, form));
  } catch (err) {
    sessions.delete(id);
    return { ok: false, error: `无法连接 Microsoft 登录服务：${err?.message ?? err}` };
  }
  if (!res.ok || !data?.device_code) {
    sessions.delete(id);
    const detail = data?.error_description || data?.error || res.statusText;
    const hint = res.status === 400 ? '（检查 clientId/tenant；应用需允许"公共客户端流"）' : '';
    return { ok: false, error: `开始 Graph 绑定失败（HTTP ${res.status}）${hint}：${detail}` };
  }
  session.deviceCode = data.device_code;
  session.userCode = String(data.user_code ?? '');
  session.verificationUri = String(data.verification_uri ?? data.verification_url ?? '');
  session.message = String(data.message ?? '');
  session.interval = Math.max(2, Number(data.interval) || 5);
  session.expiresAt = now() + Math.max(60, Number(data.expires_in) || 600) * 1000;
  return { ok: true, bind: describeBind(id) };
}

/**
 * 轮询一次 Graph 绑定。返回 `{ok, bind}`；完成后 `bind.status === 'completed'`。
 * `done.account` 是 `/me` 拿到的账号（尽力而为，失败不算绑定失败）。
 */
export async function pollGraphBind(id) {
  const session = sessions.get(String(id ?? ''));
  if (!session) return { ok: false, error: '绑定会话不存在或已过期，请重新发起' };
  // 单飞：慢请求超过 interval 时，第二次轮询可能并发兑换同一个 device_code（只能兑一次）
  if (session.polling) return { ok: true, bind: describeBind(id) };
  session.polling = true;
  try {
    return await pollGraphBindOnce(id);
  } finally {
    session.polling = false;
  }
}

async function pollGraphBindOnce(id) {
  const session = sessions.get(String(id ?? ''));
  if (!session) return { ok: false, error: '绑定会话不存在或已过期，请重新发起' };
  if (session.status !== 'pending') return { ok: true, bind: describeBind(id) };
  if (session.expiresAt <= now()) {
    return { ok: true, bind: finish(session, 'expired', '绑定超时，请重新发起') };
  }
  const wait = session.interval * 1000 - (now() - session.lastPollAt);
  if (wait > 0) {
    // 没到服务端要求的轮询间隔：不打扰服务端，直接回 pending（UI 继续等）
    return { ok: true, bind: describeBind(id) };
  }
  session.lastPollAt = now();
  const form = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: session.clientId,
    device_code: session.deviceCode,
  });
  let res;
  let data;
  try {
    ({ res, data } = await postForm(`${GRAPH_AUTHORITY}/${encodeURIComponent(session.tenant)}/oauth2/v2.0/token`, form));
  } catch (err) {
    return { ok: true, bind: { ...describeBind(id), error: `网络错误：${err?.message ?? err}` } };
  }
  if (!res.ok || !data?.access_token) {
    const code = String(data?.error ?? '');
    if (code === 'authorization_pending') return { ok: true, bind: describeBind(id) };
    if (code === 'slow_down') {
      session.interval += 5;
      return { ok: true, bind: describeBind(id) };
    }
    if (code === 'expired_token') return { ok: true, bind: finish(session, 'expired', '二维码/验证码已过期，请重新发起') };
    if (code === 'authorization_declined') return { ok: true, bind: finish(session, 'denied', '用户在授权页面拒绝了本次授权') };
    const detail = data?.error_description || data?.error || res.statusText;
    return { ok: true, bind: finish(session, 'failed', `Graph 授权失败（HTTP ${res.status}）：${detail}`) };
  }
  if (!data.refresh_token) {
    return {
      ok: true,
      bind: finish(
        session,
        'failed',
        'Microsoft 没有返回 refresh_token（缺少 offline_access 或应用类型不对）：请在 Azure 应用里允许公共客户端并重新授权',
      ),
    };
  }
  const tokenState = {
    client_id: session.clientId,
    tenant: session.tenant,
    scope: String(data.scope ?? GRAPH_DEVICE_SCOPE),
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: now() / 1000 + Number(data.expires_in || 3600),
    saved_at: new Date().toISOString(),
  };
  // 账号信息只是"给人看的证据"：拿不到不影响绑定成功
  try {
    const me = await fetchWithTimeout(`https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName`, {
      headers: { authorization: `Bearer ${tokenState.access_token}`, accept: 'application/json' },
    });
    const profile = await me.json().catch(() => null);
    if (profile) tokenState.account = String(profile.mail || profile.userPrincipalName || profile.displayName || '');
  } catch {
    // ignore
  }
  try {
    // 与后台刷新共用同一把文件锁：Graph 默认令牌文件还会被 dsh-graph-mail 刷新
    await withTokenLock(session.tokenFile, async () => writeTokenFile(session.tokenFile, tokenState));
  } catch (err) {
    return { ok: true, bind: finish(session, 'failed', `令牌写入失败（${session.tokenFile}）：${err?.message ?? err}`) };
  }
  return {
    ok: true,
    bind: finish(session, 'completed', '', { tokenFile: session.tokenFile, account: tokenState.account || '' }),
  };
}

// ───────────────────────── Gmail（OAuth 回环 + 手动粘贴） ─────────────────────────

function buildGmailAuthUrl({ clientId, redirectUri, state }) {
  const qs = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GMAIL_SCOPES.join(' '),
    access_type: 'offline',
    // 强制重发 refresh_token：不然第二次授权拿不到（Google 只在首次/consent 时给）
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${GOOGLE_AUTH_URL}?${qs.toString()}`;
}

/** 从"完整回调 URL"或"裸 code"里取出授权码（用户手动粘贴两种都认） */
export function extractGmailCode(input) {
  const text = String(input ?? '').trim();
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      return String(url.searchParams.get('code') ?? '').trim();
    } catch {
      return '';
    }
  }
  // 用户可能把 "code=4/xxx&scope=..." 整段粘进来
  const match = /(?:^|&)code=([^&\s]+)/.exec(text);
  if (match) return decodeURIComponent(match[1]);
  return text;
}

function gmailCallbackPage(ok, message) {
  const escape = (value) =>
    String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  return (
    '<!doctype html><meta charset="utf-8"><title>dsh-mail-automation</title>' +
    '<style>body{font:15px/1.6 system-ui;margin:48px;color:#222}code{background:#f2f2f2;padding:2px 6px}</style>' +
    `<h2>${ok ? '授权完成' : '授权失败'}</h2><p>${escape(message)}</p>` +
    '<p>可以关闭这个页面，回到 DeepSeek Harness 的「邮件自动化 → 邮箱」查看绑定结果。</p>'
  );
}

/**
 * 开始 Gmail 绑定：优先起一个 127.0.0.1 回环回调；起不来就退化成"手动粘贴 code"。
 * @param {{clientId:string, clientSecret?:string, tokenFile:string, timeoutSeconds?:number}} options
 */
export async function startGmailBind({ clientId, clientSecret = '', tokenFile, logger } = {}) {
  if (!String(clientId ?? '').trim()) {
    return { ok: false, error: '缺少 OAuth 客户端 id（Gmail 绑定需要先在 Google Cloud 创建「桌面应用」OAuth 客户端）' };
  }
  const id = newId('gmail');
  const state = randomBytes(12).toString('hex');
  const session = register({
    id,
    provider: 'gmail',
    status: 'pending',
    createdAt: now(),
    expiresAt: now() + SESSION_TTL_MS,
    clientId: String(clientId ?? '').trim(),
    clientSecret: String(clientSecret ?? '').trim(),
    tokenFile: String(tokenFile ?? '').trim(),
    state,
    code: '',
    manual: false,
    redirectUri: '',
    authUrl: '',
    server: null,
  });
  session.redirectUri = 'http://127.0.0.1:0/';
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/') {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
        return;
      }
      const code = String(url.searchParams.get('code') ?? '').trim();
      const error = String(url.searchParams.get('error') ?? '').trim();
      const returnedState = String(url.searchParams.get('state') ?? '').trim();
      if (error) {
        session.error = `授权被拒绝：${error}`;
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(gmailCallbackPage(false, error));
        return;
      }
      // state 必须严格匹配；请求里**不带 state** 也拒绝（否则本机进程可构造 code 回调做登录 CSRF）
      if (returnedState !== session.state) {
        session.error = '回调 state 缺失或不匹配（可能是重放/串线）：请重新绑定';
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(gmailCallbackPage(false, 'state 缺失或不匹配'));
        return;
      }
      if (!code) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(gmailCallbackPage(false, '回调里没有 code'));
        return;
      }
      session.code = code;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(gmailCallbackPage(true, '已收到授权码，正在换取令牌…'));
    } catch (err) {
      try {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(String(err?.message ?? err));
      } catch {
        // ignore
      }
    }
  });
  const listen = () =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(server.address()));
    });
  try {
    const address = await listen();
    const port = Number(address?.port ?? 0);
    if (!port) throw new Error('回环端口分配失败');
    session.server = server;
    session.redirectUri = `http://127.0.0.1:${port}/`;
  } catch (err) {
    /*
     * 环境不允许监听本地端口（被策略禁止/端口耗尽）：退回手动模式。
     * 这不是失败——用户仍然可以打开授权链接、从地址栏复制 code 粘回来。
     */
    logger?.warn?.(`[mail-automation] Gmail 绑定无法启动本地回调端口（${err?.message ?? err}），改用手动粘贴 code`);
    session.manual = true;
    session.redirectUri = 'http://127.0.0.1:8765/';
  }
  session.authUrl = buildGmailAuthUrl({
    clientId: session.clientId,
    redirectUri: session.redirectUri,
    state: session.state,
  });
  return { ok: true, bind: describeBind(id) };
}

async function exchangeGmailCode(session, code) {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: session.clientId,
    redirect_uri: session.redirectUri,
  });
  if (session.clientSecret) form.set('client_secret', session.clientSecret);
  const { res, data } = await postForm(GOOGLE_TOKEN_URL, form);
  if (!res.ok || !data?.access_token) {
    const detail = data?.error_description || data?.error || res.statusText;
    throw new Error(`用授权码换 token 失败（HTTP ${res.status}）：${detail}`);
  }
  if (!data.refresh_token) {
    throw new Error(
      'Google 没有返回 refresh_token（通常是之前授权过、这次没带 prompt=consent）：请到 Google 账号的「第三方应用」里撤销本应用后重新绑定',
    );
  }
  const tokenState = {
    client_id: session.clientId,
    refresh_token: data.refresh_token,
    access_token: data.access_token,
    expires_at: now() / 1000 + Number(data.expires_in || 3600),
    scope: String(data.scope ?? GMAIL_SCOPES.join(' ')),
    saved_at: new Date().toISOString(),
  };
  if (session.clientSecret) tokenState.client_secret = session.clientSecret;
  // 账号地址：调一次 profile（失败不算绑定失败）
  try {
    const profile = await fetchWithTimeout(`${'https://gmail.googleapis.com/gmail/v1'}/users/me/profile`, {
      headers: { authorization: `Bearer ${tokenState.access_token}`, accept: 'application/json' },
    });
    const info = await profile.json().catch(() => null);
    if (info?.emailAddress) tokenState.email = String(info.emailAddress);
  } catch {
    // ignore
  }
  // 与 oauth.js 的后台刷新共用文件锁（refresh_token 会被轮换，两个写者必须串行）
  await withTokenLock(session.tokenFile, async () => writeTokenFile(session.tokenFile, tokenState));
  return tokenState;
}

/** 手动完成：粘贴回调 URL 或 code */
export async function completeGmailBind(id, input) {
  const session = sessions.get(String(id ?? ''));
  if (!session) return { ok: false, error: '绑定会话不存在或已过期，请重新发起' };
  if (session.status !== 'pending') return { ok: true, bind: describeBind(id) };
  const code = extractGmailCode(input);
  if (!code) return { ok: false, error: '没有识别出授权码：请粘贴完整回调 URL（含 code=…）或 code 本身' };
  if (session.exchanging) return { ok: true, bind: describeBind(id) };
  session.exchanging = true;
  try {
    const token = await exchangeGmailCode(session, code);
    return { ok: true, bind: finish(session, 'completed', '', { tokenFile: session.tokenFile, email: token.email || '' }) };
  } catch (err) {
    return { ok: true, bind: finish(session, 'failed', err?.message ?? String(err)) };
  } finally {
    session.exchanging = false;
  }
}

/** 轮询一次 Gmail 绑定：回调页已带回 code 就换 token */
export async function pollGmailBind(id) {
  const session = sessions.get(String(id ?? ''));
  if (!session) return { ok: false, error: '绑定会话不存在或已过期，请重新发起' };
  if (session.polling) return { ok: true, bind: describeBind(id) };
  session.polling = true;
  try {
    return await pollGmailBindOnce(id);
  } finally {
    session.polling = false;
  }
}

async function pollGmailBindOnce(id) {
  const session = sessions.get(String(id ?? ''));
  if (!session) return { ok: false, error: '绑定会话不存在或已过期，请重新发起' };
  if (session.status !== 'pending') return { ok: true, bind: describeBind(id) };
  if (session.expiresAt <= now()) {
    return { ok: true, bind: finish(session, 'expired', '绑定超时，请重新发起') };
  }
  if (session.error) return { ok: true, bind: finish(session, 'failed', session.error) };
  if (!session.code) return { ok: true, bind: describeBind(id) };
  if (session.exchanging) return { ok: true, bind: describeBind(id) };
  session.exchanging = true;
  try {
    const token = await exchangeGmailCode(session, session.code);
    return { ok: true, bind: finish(session, 'completed', '', { tokenFile: session.tokenFile, email: token.email || '' }) };
  } catch (err) {
    return { ok: true, bind: finish(session, 'failed', err?.message ?? String(err)) };
  } finally {
    session.exchanging = false;
  }
}

// ───────────────────────── QQ 官方机器人（扫码绑定） ─────────────────────────

/**
 * 读取 QQ 扫码成功后的凭据（**只读、不擦除**）。
 *
 * `pollQqBind()` 的返回值会经 uiapi 转发给浏览器，所以 secret 不能放在 `bind.result` 里；
 * 但也不能一读就删：落盘可能失败（YAML 不可写 / credentials.set 抛错），擦除后只能重扫。
 * 因此拆成两步：peek（读）→ 写入成功后 consume（擦除）。
 */
export function peekQqCredentials(id) {
  const session = sessions.get(String(id ?? ''));
  if (!session || session.provider !== 'qq' || session.status !== 'completed') return null;
  const result = session.result ?? {};
  return {
    appId: String(result.appId ?? ''),
    openid: String(result.openid ?? ''),
    secret: String(result.secret ?? ''),
  };
}

/** 落盘成功后擦除秘密；返回是否真的还有值可擦 */
export function consumeQqCredentials(id) {
  const session = sessions.get(String(id ?? ''));
  if (!session || session.provider !== 'qq') return false;
  const had = Boolean(session.result?.secret);
  if (session.result) delete session.result.secret;
  session.secretConsumed = true;
  return had;
}

/**
 * 解出 QQ 扫码返回的 client_secret。
 * 密文布局：`iv(12) ‖ ciphertext ‖ tag(16)`，AES-256-GCM，key 是 create_bind_task 里我们给的 32 字节随机数。
 */
export function decryptQqSecret(encryptedBase64, keyBase64) {
  const key = Buffer.from(String(keyBase64 ?? ''), 'base64');
  if (key.length !== 32) throw new Error('QQ 绑定密钥长度不是 32 字节（应为 AES-256）');
  const raw = Buffer.from(String(encryptedBase64 ?? ''), 'base64');
  if (raw.length <= 28) throw new Error('QQ 返回的加密凭据长度异常');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const ciphertext = raw.subarray(12, raw.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** QQ 扫码连接页 URL（二维码编码的就是它） */
export function qqConnectUrl(taskId) {
  return QQ_CONNECT_URL.replace('{task_id}', encodeURIComponent(String(taskId ?? '')));
}

export async function startQqBind() {
  const id = newId('qq');
  const key = randomBytes(32).toString('base64');
  const session = register({
    id,
    provider: 'qq',
    status: 'pending',
    createdAt: now(),
    expiresAt: now() + SESSION_TTL_MS,
    aesKey: key,
    taskId: '',
    connectUrl: '',
    lastPollAt: 0,
    interval: 2,
  });
  let res;
  let data;
  try {
    ({ res, data } = await postJson(`${QQ_PORTAL}/lite/create_bind_task`, { key }));
  } catch (err) {
    sessions.delete(id);
    return { ok: false, error: `无法连接 q.qq.com：${err?.message ?? err}` };
  }
  if (!res.ok || Number(data?.retcode) !== 0 || !data?.data?.task_id) {
    sessions.delete(id);
    const detail = data?.msg || data?.raw || res.statusText;
    return { ok: false, error: `创建 QQ 绑定任务失败（HTTP ${res.status}）：${detail}` };
  }
  session.taskId = String(data.data.task_id);
  session.connectUrl = qqConnectUrl(session.taskId);
  return { ok: true, bind: describeBind(id) };
}

export async function pollQqBind(id) {
  const session = sessions.get(String(id ?? ''));
  if (!session) return { ok: false, error: '绑定会话不存在或已过期，请重新发起' };
  if (session.polling) return { ok: true, bind: describeBind(id) };
  session.polling = true;
  try {
    return await pollQqBindOnce(id);
  } finally {
    session.polling = false;
  }
}

async function pollQqBindOnce(id) {
  const session = sessions.get(String(id ?? ''));
  if (!session) return { ok: false, error: '绑定会话不存在或已过期，请重新发起' };
  if (session.status !== 'pending') return { ok: true, bind: describeBind(id) };
  if (session.expiresAt <= now()) {
    return { ok: true, bind: finish(session, 'expired', '二维码已过期，请重新生成') };
  }
  const wait = session.interval * 1000 - (now() - session.lastPollAt);
  if (wait > 0) return { ok: true, bind: describeBind(id) };
  session.lastPollAt = now();
  let res;
  let data;
  try {
    ({ res, data } = await postJson(`${QQ_PORTAL}/lite/poll_bind_result`, { task_id: session.taskId }));
  } catch (err) {
    return { ok: true, bind: { ...describeBind(id), error: `网络错误：${err?.message ?? err}` } };
  }
  if (!res.ok || Number(data?.retcode) !== 0) {
    const detail = data?.msg || data?.raw || res.statusText;
    /*
     * 5xx / 429 / 网关抖动是**可重试**的：一次失败不该让用户重新生成二维码。
     * 4xx 业务码才终结（比如 task 不存在/参数错）。
     */
    const transient = res.status === 429 || res.status >= 500;
    if (transient) {
      session.transientErrors = Number(session.transientErrors ?? 0) + 1;
      if (session.transientErrors <= 5) {
        return {
          ok: true,
          bind: { ...describeBind(id), error: `查询失败（HTTP ${res.status}），自动重试中（${session.transientErrors}/5）` },
        };
      }
      return { ok: true, bind: finish(session, 'failed', `查询 QQ 绑定结果连续失败：HTTP ${res.status} ${detail}`) };
    }
    return { ok: true, bind: finish(session, 'failed', `查询 QQ 绑定结果失败（HTTP ${res.status}）：${detail}`) };
  }
  session.transientErrors = 0;
  const payload = data?.data ?? {};
  const status = Number(payload.status ?? 0);
  if (status === 3) return { ok: true, bind: finish(session, 'expired', '二维码已过期，请重新生成') };
  if (status !== 2) {
    if (status !== 0 && status !== 1) {
      // 字段/语义漂移要可观测：不把"未知状态"伪装成"继续等待"
      session.unexpectedStatus = status;
    }
    const bind = describeBind(id);
    return { ok: true, bind: session.unexpectedStatus ? { ...bind, error: `接口返回了未识别的状态 ${session.unexpectedStatus}` } : bind };
  }
  const appId = String(payload.bot_appid ?? '').trim();
  const openid = String(payload.user_openid ?? '').trim();
  const encrypted = String(payload.bot_encrypt_secret ?? '').trim();
  if (!appId) return { ok: true, bind: finish(session, 'failed', '扫码结果里没有 bot_appid') };
  let secret = '';
  if (encrypted) {
    try {
      secret = decryptQqSecret(encrypted, session.aesKey);
    } catch (err) {
      return { ok: true, bind: finish(session, 'failed', `解密 client_secret 失败：${err?.message ?? err}`) };
    }
  }
  if (!secret) return { ok: true, bind: finish(session, 'failed', '扫码结果里没有可用的 client_secret') };
  return { ok: true, bind: finish(session, 'completed', '', { appId, openid, secret }) };
}

export function cancelBind(id) {
  const session = sessions.get(String(id ?? ''));
  if (!session) return { ok: false, error: '绑定会话不存在' };
  if (session.status === 'pending') finish(session, 'cancelled', '已取消');
  return { ok: true, bind: describeBind(id) };
}

/** 会话属于哪种协议（空串 = 不存在）；UI 轮询时不必自己记住 */
export function bindProviderOf(id) {
  return sessions.get(String(id ?? ''))?.provider ?? '';
}

/** 按会话自己的协议分发一次轮询（调用方不需要知道 id 前缀） */
export async function pollBind(id) {
  const provider = bindProviderOf(id);
  if (provider === 'graph') return pollGraphBind(id);
  if (provider === 'gmail') return pollGmailBind(id);
  if (provider === 'qq') return pollQqBind(id);
  return { ok: false, error: '绑定会话不存在或已过期，请重新发起' };
}

/** 卸载：关掉所有本地回调端口并清空会话（在途的轮询下一次会得到"会话不存在"） */
export function disposeAll() {
  for (const session of sessions.values()) closeServer(session);
  sessions.clear();
}

/** 测试用：当前会话数 / 键 */
export function sessionIds() {
  return [...sessions.keys()];
}

/** 测试用：注入/读取会话（只给离线断言用，运行时不要调） */
export function __testSession(overrides = {}) {
  const session = {
    id: overrides.id ?? newId(overrides.provider ?? 'gmail'),
    provider: 'gmail',
    status: 'pending',
    createdAt: now(),
    expiresAt: now() + SESSION_TTL_MS,
    ...overrides,
  };
  sessions.set(session.id, session);
  return session;
}
