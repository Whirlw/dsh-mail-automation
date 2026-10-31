/**
 * Gmail（Google OAuth2）令牌与 REST 请求的公共层。
 *
 * 设计取舍（与 docs/multi-source.md §3.3 一致）：
 *   - **令牌文件**是一个 JSON 文件（0600 + 原子写 + proper-lockfile），与 `dsh-graph-mail`
 *     的模式一致；refresh_token 绝不进 YAML/日志/工具输出。
 *   - 刷新是**读-改-写**，跨进程用文件锁串行化：Google 会轮换 refresh_token，
 *     两个进程同时刷新会把对方轮换后的值写旧（下一次就是 invalid_grant）。
 *   - 只依赖 `fetch`，不引 googleapis（少一条依赖，链接安装下更稳）。
 */
import fs from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { atomicWriteFile } from '../fsutil.js';
import { resolveDshHome, slug } from '../config.js';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';
/** Gmail 只读 + 读账号邮箱（标识账号用） */
export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
];

/** 每个 Gmail 来源一个令牌文件：`$DSH_HOME/mail-automation/tokens/<id>.json` */
export function defaultGmailTokenFile(source, dshHome) {
  const home = dshHome ?? resolveDshHome();
  return path.join(home, 'mail-automation', 'tokens', `${slug(source?.id ?? 'gmail')}.json`);
}

/** 令牌文件路径（配置里的 tokenFile 已展开成绝对路径；留空用默认位置） */
export function gmailTokenFile(source) {
  const configured = String(source?.tokenFile ?? '').trim();
  return configured || defaultGmailTokenFile(source);
}

export function readTokenFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`读不到 Gmail 令牌文件（${file}）：${err?.message ?? err}（在设置页「邮箱」里点「绑定」重新授权）`);
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Gmail 令牌文件损坏/截断（${file}）：${err?.message ?? err} → 重新绑定该邮箱`);
  }
  if (!state?.refresh_token) {
    throw new Error(`Gmail 令牌文件缺少 refresh_token（${file}）：重新绑定该邮箱`);
  }
  return state;
}

export function writeTokenFile(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFile(file, JSON.stringify(state, null, 2), { mode: 0o600 });
}

/** 同一个令牌文件的跨模块/跨进程互斥（拿不到锁也继续，最坏情况见文件头） */
export async function withTokenLock(file, fn) {
  let release;
  try {
    release = await lockfile.lock(file, {
      realpath: false,
      retries: { retries: 8, minTimeout: 150, maxTimeout: 800 },
      stale: 15_000,
    });
  } catch {
    release = undefined;
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

/** fetch 超时：网络黑洞时轮询/绑定不能无限期挂住（30s） */
function timeoutSignal(ms = 30_000) {
  return typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(ms) : undefined;
}

async function refreshGoogleToken(file, state) {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: state.client_id,
    refresh_token: state.refresh_token,
  });
  // "已安装应用"的 OAuth 客户端带 secret；PKCE/公共客户端可以不带
  if (state.client_secret) form.set('client_secret', state.client_secret);
  const signal = timeoutSignal();
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form.toString(),
    ...(signal ? { signal } : {}),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) {
    const detail = data?.error_description || data?.error || res.statusText;
    throw new Error(`刷新 Gmail 令牌失败（HTTP ${res.status}）：${detail}（重新绑定该邮箱）`);
  }
  state.access_token = data.access_token;
  state.expires_at = Date.now() / 1000 + Number(data.expires_in || 3600);
  if (data.refresh_token) state.refresh_token = data.refresh_token;
  if (data.scope) state.scope = data.scope;
  writeTokenFile(file, state);
  return state.access_token;
}

export async function googleAccessToken(file) {
  const state = readTokenFile(file);
  if (tokenUsable(state)) return state.access_token;
  return withTokenLock(file, async () => {
    const fresh = readTokenFile(file);
    if (tokenUsable(fresh)) return fresh.access_token;
    return refreshGoogleToken(file, fresh);
  });
}

/**
 * 调一次 Gmail REST。`pathname` 是 `/users/me/...`；`params` 会拼成查询串。
 * 401 时作废缓存 token 再重试一次（与 graph.js 同款）。
 */
export async function gmailRequest(source, pathname, params) {
  const file = gmailTokenFile(source);
  let url = `${GMAIL_API}${pathname}`;
  if (params) {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      // Gmail 的 metadataHeaders 是**重复参数**（不是逗号分隔），数组值要 append
      if (Array.isArray(value)) for (const item of value) qs.append(key, String(item));
      else qs.set(key, String(value));
    }
    const q = qs.toString();
    if (q) url += `?${q}`;
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await googleAccessToken(file);
    const signal = timeoutSignal();
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      ...(signal ? { signal } : {}),
    });
    if (res.status === 401 && attempt === 0) {
      await withTokenLock(file, async () => {
        const state = readTokenFile(file);
        state.expires_at = 0;
        writeTokenFile(file, state);
      });
      continue;
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = data?.error?.message || (data ? JSON.stringify(data).slice(0, 300) : res.statusText);
      const hint = res.status === 403 ? '（缺少 gmail.readonly 授权或 OAuth 同意屏未通过）' : '';
      const err = new Error(`Gmail 请求失败 ${res.status}${hint}：${detail}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }
  throw new Error('Gmail 请求失败：重新取 token 后仍未通过');
}

export { tokenUsable };
