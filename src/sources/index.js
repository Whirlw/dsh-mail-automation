/**
 * 来源 provider 注册表：`type` 只是选实现，协议细节（游标、分页、认证）都留在各自模块里。
 *
 * 契约（docs/multi-source.md §2）——每个实现模块必须导出：
 *   listHeaders(source, limit)              → Header[]（最新在前）
 *   poll(source, prevState, options?)       → { mode, headers, warnings?, state }
 *   fetchBody(source, header)               → { raw, rawKind, text, html, subject, from, to, date, attachments }
 *   emptyState()                            → 该协议的初始游标（字段必须在 state-domain.js 白名单里）
 *   describeCursor(state)                   → 一行人类可读游标（设置页 / mail_automation_status）
 *   verify(source)                          → { ok, detail }（设置页「测试连接」）
 *
 * `index.js` 只认这三个调用点：pollSource / fetchBody / baseline 的 listHeaders。
 * 新增协议**不改**调用方：在下面加一行即可。
 */
import * as imap from './imap.js';
import * as pop3 from './pop3.js';
import * as gmail from './gmail.js';
import * as graph from './graph.js';
import { SOURCE_TYPES } from '../config.js';

export { SOURCE_TYPES };

// oauth2 = IMAP + XOAUTH2：连接/取信逻辑与 imap 相同，仅认证方式不同
const PROVIDERS = Object.freeze({ imap, pop3, oauth2: imap, gmail, graph });

/** 设置页 / 工具的输出目录（type 的中文标签，不再在 UI 里写死"只有 IMAP/Graph"） */
export const SOURCE_TYPE_LABELS = Object.freeze({
  imap: 'IMAP',
  pop3: 'POP3',
  oauth2: 'OAuth2（IMAP）',
  gmail: 'Gmail API',
  graph: 'Microsoft Graph',
});
export function isSourceType(value) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, String(value ?? '').toLowerCase());
}

/** 取实现；未知类型**响亮失败**（不静默回落成 IMAP） */
export function providerFor(type) {
  const key = String(type ?? 'imap').toLowerCase();
  const impl = PROVIDERS[key];
  if (!impl) {
    throw new Error(`不支持的邮箱类型：${type}（只支持 ${SOURCE_TYPES.join(' / ')}）`);
  }
  return impl;
}

export function sourceTypeLabel(type) {
  return SOURCE_TYPE_LABELS[String(type ?? '').toLowerCase()] ?? String(type ?? '');
}

export function listProviders() {
  return SOURCE_TYPES.map((type) => ({
    type,
    label: sourceTypeLabel(type),
    emptyState: (() => {
      try {
        return providerFor(type).emptyState();
      } catch {
        return {};
      }
    })(),
  }));
}

/** 连接池回收：只有长连接协议有池（POP3 也是），Gmail/Graph 是无状态 HTTP */
export function pruneSources(keep) {
  const ids = keep instanceof Set ? keep : new Set(keep ?? []);
  return imap.pruneSources(ids) + pop3.pruneSources(ids);
}

export function closeAll() {
  imap.closeAll();
  pop3.closeAll();
}
