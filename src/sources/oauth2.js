/**
 * OAuth2（IMAP XOAUTH2）来源：面向 Microsoft 365 / Outlook（Exchange Online 已停用
 * IMAP 基本认证，只能用 OAuth2 访问令牌）。
 *
 * 流程与 dsh-email 的 oauth2.ts 一致（MIT）：
 *   https://github.com/STARDUSTLC666/dsh-email/blob/main/src/oauth2.ts
 *   1. 设备码登录（device code）— 设置页「登录」→ 浏览器输入代码；
 *   2. 令牌文件（0600、原子写）保存 refresh_token / access_token；
 *   3. 连接前用 `getFreshAccessToken` 换取可用 access_token，快过期才刷新（单飞）。
 *
 * 与 Graph 来源的区别：这里拿到的是 **IMAP 的 XOAUTH2 令牌**（scope 是
 * outlook.office.com/IMAP.AccessAsUser.All），邮件仍走 IMAP 协议读取；
 * Graph 走的是 Microsoft Graph REST。
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from '../fsutil.js';
import { resolveDshHome } from '../config.js';

export const DEFAULT_TENANT = 'common';
/** 只读邮件：offline_access 换 refresh token，IMAP.AccessAsUser.All 换 IMAP 访问权 */
export const OAUTH2_SCOPES = [
  'offline_access',
  'https://outlook.office.com/IMAP.AccessAsUser.All',
];
export const OAUTH2_SCOPE_TEXT = OAUTH2_SCOPES.join(' ');
export const ACCESS_TOKEN_MARGIN_MS = 2 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

/** id → 未完成的设备码登录 */
const pending = new Map();
/** id → 进行中的刷新（单飞，避免轮换 refresh_token 互相覆盖） */
const refreshing = new Map();

export class OAuth2Error extends Error {
  constructor(message) {
    super(message);
    this.name = 'OAuth2Error';
  }
}

function slug(value) {
  return String(value ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'oauth2';
}

export function defaultTokenFile(source, home) {
  const base = home ?? resolveDshHome();
  return path.join(base, 'mail-automation', 'oauth2', `${slug(source?.id ?? 'mailbox')}.json`);
}

export function tokenFileOf(source) {
  const configured = String(source?.tokenFile ?? '').trim();
  return configured || defaultTokenFile(source);
}

export function clientIdOf(source) {
  return String(source?.clientId ?? '').trim();
}

function tenantOf(source) {
  return String(source?.tenant ?? '').trim() || DEFAULT_TENANT;
}

function authority(source) {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantOf(source))}/oauth2/v2.0`;
}

export function readToken(source) {
  const file = tokenFileOf(source);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw new OAuth2Error(`读不到 OAuth2 令牌文件（${file}）：${err?.message ?? err}`);
  }
  try {
    const state = JSON.parse(raw);
    if (!state || typeof state !== 'object' || !state.refresh_token) return null;
    return state;
  } catch {
    throw new OAuth2Error(`OAuth2 令牌文件损坏（${file}）：请重新登录`);
  }
}

export function hasToken(source) {
  try {
    return Boolean(readToken(source)?.refresh_token);
  } catch {
    return false;
  }
}

function writeToken(source, entry) {
  const file = tokenFileOf(source);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFile(file, JSON.stringify(entry, null, 2), { mode: 0o600 });
}

function clearToken(source) {
  try {
    fs.rmSync(tokenFileOf(source), { force: true });
  } catch {
    // ignore
  }
}

function tokenEntry(source, payload, fallbackRefresh) {
  const access = typeof payload?.access_token === 'string' ? payload.access_token : '';
  const refresh = typeof payload?.refresh_token === 'string' && payload.refresh_token
    ? payload.refresh_token
    : fallbackRefresh;
  if (!access || !refresh) throw new OAuth2Error('登录响应里没有可用的令牌，请重新发起登录');
  return {
    user: String(source?.user ?? '').trim(),
    clientId: clientIdOf(source),
    tenant: tenantOf(source),
    scope: typeof payload?.scope === 'string' ? payload.scope : OAUTH2_SCOPE_TEXT,
    refresh_token: refresh,
    access_token: access,
    expires_at: Date.now() + Math.max(0, Number(payload?.expires_in) || 0) * 1000,
    saved_at: new Date().toISOString(),
  };
}

function aadstsOf(payload) {
  const doc = payload && typeof payload === 'object' ? payload : {};
  const codes = Array.isArray(doc.error_codes) ? doc.error_codes : [];
  for (const code of codes) {
    if (typeof code === 'number' || (typeof code === 'string' && code)) return String(code);
  }
  const match = String(doc.error_description ?? '').match(/AADSTS(\d+)/);
  return match ? match[1] : '';
}

const AADSTS_MESSAGES = {
  7000218: '应用注册需开启「允许公共客户端流」（Entra → 应用注册 → 身份验证 → 高级设置）',
  65001: '权限未授予：请在 Entra → API 权限里为 IMAP.AccessAsUser.All 授予管理员同意',
  700016: '找不到该应用注册：clientId 可能填错了',
  700011: '应用注册无效：请确认应用仍存在且允许多租户/个人账号',
  70008: '刷新令牌已过期，请到设置页重新登录',
  700082: '登录会话已过期，请到设置页重新登录',
  50034: '该用户不存在：请检查账号邮箱地址',
  50076: '需要多重身份验证：请先在浏览器完成 MFA',
  53003: '条件访问策略拦下了登录：需在 Entra 调整访问策略',
  90002: '该账号在此租户没有邮箱，或未分配 Exchange 邮箱',
};

export function classifyFailure(payload, httpStatus = 0) {
  const doc = payload && typeof payload === 'object' ? payload : {};
  const error = typeof doc.error === 'string' ? doc.error : '';
  const aadsts = aadstsOf(doc);
  const mapped = AADSTS_MESSAGES[Number(aadsts)];
  const suffix = aadsts ? `（AADSTS${aadsts}）` : '';
  if (error === 'authorization_pending') return { pending: true };
  if (error === 'slow_down') return { pending: true, slowDown: true };
  if (error === 'expired_token') return { pending: false, message: '设备码超时，请重新发起登录' };
  if (error === 'authorization_declined') return { pending: false, message: '你在登录页拒绝了授权，请重新发起登录' };
  if (error === 'invalid_grant') {
    return {
      pending: false,
      clearToken: true,
      message: mapped ? `${mapped}${suffix}` : '登录已失效（刷新令牌过期或被撤销），请到设置页重新登录',
    };
  }
  if (error === 'invalid_client' || error === 'unauthorized_client') {
    return { pending: false, message: mapped ? `${mapped}${suffix}` : `应用注册不允许设备码流${suffix}` };
  }
  const detail = typeof doc.error_description === 'string' && doc.error_description
    ? doc.error_description
    : (error || `HTTP ${httpStatus}`);
  return { pending: false, message: `${mapped ? `${mapped}${suffix}` : detail}` };
}

async function postForm(url, params) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new OAuth2Error(`无法连接微软登录服务：${err?.message ?? err}`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  return { status: response.status, payload };
}

export async function startDeviceFlow(source) {
  const clientId = clientIdOf(source);
  if (!clientId) {
    throw new OAuth2Error('还没有填写 OAuth2 应用（客户端）ID：请先在 Azure 注册一个公共客户端应用');
  }
  const id = String(source?.id ?? '');
  const { status, payload } = await postForm(`${authority(source)}/devicecode`, {
    client_id: clientId,
    scope: OAUTH2_SCOPE_TEXT,
  });
  const doc = payload && typeof payload === 'object' ? payload : {};
  if (status !== 200 || typeof doc.device_code !== 'string' || typeof doc.user_code !== 'string') {
    throw new OAuth2Error(classifyFailure(payload, status).message);
  }
  const url = typeof doc.verification_uri === 'string' && doc.verification_uri
    ? doc.verification_uri
    : String(doc.verification_uri_complete ?? '');
  if (!url) throw new OAuth2Error('微软没有返回登录网址，请稍后重试');
  const interval = Math.min(60, Math.max(1, Math.trunc(Number(doc.interval) || 5)));
  const expiresIn = Math.max(0, Math.trunc(Number(doc.expires_in) || 900));
  pending.set(id, {
    deviceCode: doc.device_code,
    userCode: doc.user_code,
    url,
    interval,
    // 微软要求按 interval 轮询；设置页每 2.5s 轮一次，未到点直接返回 pending，避免 slow_down
    nextPollAt: Date.now() + interval * 1000,
    expiresAt: Date.now() + expiresIn * 1000,
  });
  return { ok: true, url, code: doc.user_code, interval, expiresIn };
}

export async function pollDeviceFlow(source) {
  const id = String(source?.id ?? '');
  const flow = pending.get(id);
  if (!flow) return { status: 'pending', error: '尚未发起登录：请先点「登录」' };
  if (Date.now() >= flow.expiresAt) {
    pending.delete(id);
    return { status: 'failed', error: '设备码超时，请重新发起登录' };
  }
  if (Date.now() < flow.nextPollAt) return { status: 'pending' };
  flow.nextPollAt = Date.now() + flow.interval * 1000;
  const { status, payload } = await postForm(`${authority(source)}/token`, {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: clientIdOf(source),
    device_code: flow.deviceCode,
  });
  const doc = payload && typeof payload === 'object' ? payload : {};
  if (status === 200 && typeof doc.access_token === 'string') {
    pending.delete(id);
    writeToken(source, tokenEntry(source, doc, ''));
    return { status: 'ok', user: String(source?.user ?? '') };
  }
  const verdict = classifyFailure(payload, status);
  if (verdict.pending) {
    if (verdict.slowDown) flow.interval += 5;
    flow.nextPollAt = Date.now() + flow.interval * 1000;
    return { status: 'pending' };
  }
  pending.delete(id);
  return { status: 'failed', error: verdict.message };
}

export function isDeviceFlowPending(source) {
  return pending.has(String(source?.id ?? ''));
}

/** 给设置页轮询用的展示信息（不含 device_code） */
export function describeDeviceFlow(source) {
  const flow = pending.get(String(source?.id ?? ''));
  if (!flow) return null;
  return { url: flow.url, code: flow.userCode, interval: flow.interval, expiresAt: flow.expiresAt };
}

export function cancelDeviceFlow(source) {
  pending.delete(String(source?.id ?? ''));
}

/** 插件卸载：丢掉未完成的设备码与刷新单飞 */
export function disposeAll() {
  pending.clear();
  refreshing.clear();
}

/** 拿一个可用 access_token：快过期才刷新；同一账号并发只刷新一次 */
export async function getFreshAccessToken(source) {
  const entry = readToken(source);
  if (!entry) {
    throw new OAuth2Error('还没有登录 OAuth2：请先在设置页完成设备码登录');
  }
  if (entry.clientId && clientIdOf(source) && entry.clientId !== clientIdOf(source)) {
    throw new OAuth2Error('clientId 已更改：请重新完成设备码登录');
  }
  if (entry.user && source.user && String(entry.user).toLowerCase() !== String(source.user).toLowerCase()) {
    throw new OAuth2Error('账号地址已更改：请重新完成设备码登录');
  }
  if (entry.access_token && Number(entry.expires_at || 0) - Date.now() > ACCESS_TOKEN_MARGIN_MS) {
    return entry.access_token;
  }
  const id = String(source?.id ?? '');
  if (refreshing.has(id)) return refreshing.get(id);
  const task = (async () => {
    const { status, payload } = await postForm(`${authority(source)}/token`, {
      grant_type: 'refresh_token',
      client_id: clientIdOf(source),
      refresh_token: entry.refresh_token,
      scope: OAUTH2_SCOPE_TEXT,
    });
    const doc = payload && typeof payload === 'object' ? payload : {};
    if (status === 200 && typeof doc.access_token === 'string') {
      const next = tokenEntry(source, doc, entry.refresh_token);
      writeToken(source, next);
      return next.access_token;
    }
    const verdict = classifyFailure(payload, status);
    if (verdict.clearToken) clearToken(source);
    throw new OAuth2Error(verdict.message);
  })();
  const tracked = task.then(
    (token) => {
      refreshing.delete(id);
      return token;
    },
    (error) => {
      refreshing.delete(id);
      throw error;
    },
  );
  refreshing.set(id, tracked);
  return tracked;
}
