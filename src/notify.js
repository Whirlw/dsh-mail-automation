/**
 * QQ 推送：直接调 QQ 开放平台 Bot API 发单聊消息（主动消息，不带 msg_id）。
 *
 * 走 QQ 官方机器人的进程内调用（不是外部脚本）：
 * agent 不能每封邮件都去起一个 node 子进程，工具层走这条。
 *
 * 凭据走 `ctx.credentials`（官方缝，见 credentials.js），**每次发送前重新解析**——
 * 这也正是「在凭据页改了 key 不用重启」得以成立的原因。
 * 接收人 openid 只来自配置 `qq.openid`（不再去读 qqbot 插件的私有目标表）。
 */
import { createHash } from 'node:crypto';
import { resolveSecret } from './credentials.js';

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const API_BASE = 'https://api.sgroup.qq.com';
const USER_QPM = 20; // 单关系维度：20 条/分钟

/** 按字符上限切分，尽量在换行处断开 */
export function chunkText(text, limit) {
  const input = String(text ?? '');
  if (input.length <= limit) return input ? [input] : [];
  const parts = [];
  let rest = input;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('。'), window.lastIndexOf(' '));
    const take = cut > limit * 0.5 ? cut + 1 : limit;
    parts.push(rest.slice(0, take));
    rest = rest.slice(take);
  }
  if (rest) parts.push(rest);
  return parts;
}

export class QQNotifier {
  constructor({ ctx, cfg, logger }) {
    this.ctx = ctx;
    this.cfg = cfg;
    this.logger = logger;
    this.token = '';
    /** 当前 token 属于哪一对 appId+appSecret（凭据轮换后必须重新取，S5） */
    this.tokenKey = '';
    this.tokenExpiresAt = 0;
    /** 同一凭据的并发取 token 合并成一次请求 */
    this.tokenPending = null;
    /** 上一次记录过的凭据层，只在层变化时打日志 */
    this.loggedSource = '';
    this.sentAt = [];
  }

  get enabled() {
    return this.cfg?.qq?.enabled !== false;
  }

  /** 接收人 openid：只认配置 `qq.openid`（空 = 没配，发送会明确报错） */
  openid() {
    return String(this.cfg?.qq?.openid || '').trim();
  }

  /**
   * QQ 机器人凭据：**配置 > ctx.credentials（凭据页 / 凭据存储，含它自己的 env 层）> 原始 env**。
   *
   * 以前 `process.env` 排在最前，压过插件配置（S3）：用户在配置里填了新 key，机器上留着的
   * 旧 env 仍然生效，日志还写着"来自 config"。现在 env 只做最后的兜底（不存在
   * `ctx.credentials` 的组合里才有意义），并且 `source` 如实报告每一半来自哪一层。
   */
  async credentials() {
    const cfgId = String(this.cfg?.qq?.appId || '').trim();
    const cfgSecret = String(this.cfg?.qq?.appSecret || '').trim();
    const [refId, refSecret] = await Promise.all([
      cfgId ? undefined : resolveSecret(this.ctx, 'QQ_BOT_APP_ID', { logger: this.logger }),
      cfgSecret ? undefined : resolveSecret(this.ctx, 'QQ_BOT_SECRET', { logger: this.logger }),
    ]);
    const pick = (fromConfig, resolved, fromEnv) => {
      if (fromConfig) return { value: fromConfig, from: 'config' };
      if (resolved?.value) return { value: String(resolved.value).trim(), from: resolved.source || 'credentials' };
      if (fromEnv) return { value: String(fromEnv).trim(), from: 'env' };
      return { value: '', from: '' };
    };
    const id = pick(cfgId, refId, process.env.QQ_BOT_APP_ID);
    const secret = pick(cfgSecret, refSecret, process.env.QQ_BOT_SECRET);
    return {
      appId: id.value,
      appSecret: secret.value,
      // 两半同源才报一个层名；混源时把两半都写出来（日志必须说真话）
      source: id.from === secret.from ? id.from : `appId=${id.from || '未配置'}, secret=${secret.from || '未配置'}`,
    };
  }

  /** token 缓存键：绑定 appId + secret 指纹（secret 明文不进键、不进日志） */
  static credentialKey(appId, appSecret) {
    return `${appId}:${createHash('sha256').update(String(appSecret)).digest('hex').slice(0, 12)}`;
  }

  invalidate() {
    this.token = '';
    this.tokenKey = '';
    this.tokenExpiresAt = 0;
  }

  async accessToken({ force = false } = {}) {
    // 先解析凭据再查缓存：缓存键依赖它们（S5），也保证"每次发送前重新解析"是真的
    const { appId, appSecret, source } = await this.credentials();
    if (!appId || !appSecret) {
      throw new Error(
        `缺少 QQ 机器人凭据（${source || 'appId/secret 均未配置'}）：用凭据页写入，或放进 $DSH_HOME/.credentials.yaml 的 refs`,
      );
    }
    const key = QQNotifier.credentialKey(appId, appSecret);
    if (!force && this.token && this.tokenKey === key && this.tokenExpiresAt > Date.now() + 60_000) return this.token;
    if (!force && this.tokenPending?.key === key) return this.tokenPending.promise;
    if (source && source !== this.loggedSource) {
      this.logger?.info?.(`[mail-automation] QQ 凭据层：${source}`);
      this.loggedSource = source;
    }
    const pending = (async () => {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appId, clientSecret: appSecret }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.access_token) {
        throw new Error(`取 QQ access token 失败 [${res.status}]（凭据来源 ${source || '未知'}）：${JSON.stringify(data).slice(0, 200)}`);
      }
      // 三个字段在同一同步块里赋值：不允许出现"token 是新的、key 是旧的"半更新窗口
      this.token = data.access_token;
      this.tokenKey = key;
      this.tokenExpiresAt = Date.now() + Number(data.expires_in || 3600) * 1000;
      return this.token;
    })();
    this.tokenPending = { key, promise: pending };
    try {
      return await pending;
    } finally {
      if (this.tokenPending?.promise === pending) this.tokenPending = null;
    }
  }

  throttle() {
    const now = Date.now();
    this.sentAt = this.sentAt.filter((t) => now - t < 60_000);
    if (this.sentAt.length >= USER_QPM) {
      const wait = this.sentAt[0] + 60_000 - now;
      throw new Error(`触发单关系频控（${USER_QPM} 条/分钟），请 ${Math.ceil(wait / 1000)} 秒后再发`);
    }
  }

  /**
   * 发送一段文本（自动分片）。
   *
   * **永不抛**：网络异常也折叠成 `{ ok:false, reason, retriable, error }`（D1）——
   * fetch 失败只影响本次发送，不会让调用方跳过后续清理/状态更新。
   *
   * 返回值：`{ ok, sent, chunks, reason, retriable, error?, retryAfterMs? }`
   *   - `reason`: `disabled` / `no-openid` / `empty` / `token` / `network` / `http` / `throttle`
   *   - `retriable`: 值得过几分钟再试的网络/5xx/频控类；配置类错误为 false
   *   - `resumeFrom`: 续发起点（D3：上一轮已经发出去几段就从第几段继续，不重发前面的）
   */
  async send(text, { markdown = false, signal, resumeFrom = 0 } = {}) {
    const parts = chunkText(text, markdown ? 3_500 : 1_500);
    const chunks = parts.length;
    const fail = (sent, reason, retriable, error, extra = {}) => ({
      ok: false,
      sent,
      chunks,
      reason,
      retriable,
      error,
      ...extra,
    });
    if (!this.enabled) return fail(0, 'disabled', false, 'QQ 推送已在配置里关闭');
    const openid = this.openid();
    if (!openid) return fail(0, 'no-openid', false, '没有可用的 QQ openid：在插件配置里填 qq.openid（接收人标识）');
    if (chunks === 0) return fail(0, 'empty', false, '消息为空');

    const start = Math.min(Math.max(0, Number(resumeFrom) || 0), chunks);
    if (start >= chunks) return { ok: true, sent: chunks, chunks, reason: '', retriable: false };

    let token;
    try {
      token = await this.accessToken();
    } catch (err) {
      // 凭据类错误不可重试：缺 key / token 端点 4xx，重试只会刷日志
      return fail(start, 'token', false, String(err?.message ?? err));
    }

    let sent = start;
    const endpoint = `${API_BASE}/v2/users/${encodeURIComponent(openid)}/messages`;
    const post = async (payload, authToken) => {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { Authorization: `QQBot ${authToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          ...(signal ? { signal } : {}),
        });
        const body = await res.text();
        return { res, body };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    };
    const codeOf = (body) => {
      try {
        const parsed = JSON.parse(body);
        return String(parsed?.code ?? parsed?.err_code ?? '');
      } catch {
        const matched = /"code"\s*:\s*"?(-?\d+)/.exec(body);
        return matched ? matched[1] : '';
      }
    };

    for (const part of parts.slice(start)) {
      // 每一段都有独立的 401 预算：第 2 段再遇到 token 失效仍应能重取一次
      let authRetried = false;
      for (;;) {
        try {
          this.throttle();
        } catch (err) {
          const seconds = /(\d+)\s*秒/.exec(String(err?.message ?? ''));
          return fail(sent, 'throttle', true, String(err?.message ?? err), {
            retryAfterMs: seconds ? Number(seconds[1]) * 1000 : 60_000,
          });
        }
        const payload = markdown ? { msg_type: 2, markdown: { content: part } } : { msg_type: 0, content: part };
        let out = await post(payload, token);
        if (out.error) return fail(sent, 'network', true, `网络错误：${out.error}`);
        let { res, body } = out;
        if (!res.ok && (res.status === 401 || res.status === 403) && !authRetried) {
          /*
           * token 被服务端吊销/轮换（401/403）：清缓存、按当前凭据重取一次再重发这一段。
           * 只重试一次 —— 凭据本身错时不要无限循环。
           */
          authRetried = true;
          this.invalidate();
          try {
            token = await this.accessToken({ force: true });
          } catch (err) {
            return fail(sent, 'token', false, String(err?.message ?? err));
          }
          continue;
        }
        if (!res.ok) {
          /*
           * markdown 不被支持时退回纯文本重试一次。
           *
           * 判据必须看**响应体里的业务码**：QQ 的 40034 在 body 的 code 字段里，拿它去匹配
           * `res.status` 永远匹配不到。裸 400 只有在**没有**业务码时才当"不支持 markdown"，
           * 否则参数错误（如 11244）也会被误当成格式问题、白重发一次。
           */
          const bodyCode = codeOf(body);
          const markdownRejected =
            markdown && (bodyCode === '40034' || (bodyCode === '' && [400, 404, 405, 415].includes(res.status)));
          if (markdownRejected) {
            out = await post({ msg_type: 0, content: part }, token);
            if (out.error) return fail(sent, 'network', true, `网络错误：${out.error}`);
            ({ res, body } = out);
            if (res.ok) {
              this.sentAt.push(Date.now());
              sent += 1;
              break;
            }
            const retryCode = codeOf(body);
            return fail(
              sent,
              'http',
              res.status === 429 || res.status >= 500,
              `HTTP ${res.status}${retryCode ? ` code=${retryCode}` : ''}，纯文本重试也失败：${body.slice(0, 200)}`,
            );
          }
          return fail(
            sent,
            'http',
            res.status === 429 || res.status >= 500,
            `HTTP ${res.status}${bodyCode ? ` code=${bodyCode}` : ''} ${body.slice(0, 300)}`,
          );
        }
        this.sentAt.push(Date.now());
        sent += 1;
        break;
      }
    }
    return { ok: true, sent, chunks, reason: '', retriable: false };
  }
}
