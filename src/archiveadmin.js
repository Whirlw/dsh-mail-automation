/**
 * 批量存档工具的实现（`mail_automation_archive_list` / `mail_automation_archive_clear`）。
 *
 * 定时任务不分「总览类型」：总览就是一条普通任务，靠这两个工具拿数据、发 QQ、
 * 再清理存档。所有操作只碰 `<archiveDir>/<id>` 下的完整存档（有 meta.json 的目录），
 * 不接受任意路径 —— 批量入口比单封读取更危险，越界校验放在这里而不是交给模型。
 *
 * `id` 的定义：**存档目录名**（也是 `archive_read` 的 `file` 参数）。协议侧的
 * `meta.id`（如 `imap:private:v7-u123`）额外以 `mail_id` 返回，但选择/清理只认目录名，
 * 避免同名协议 id 在不同 validity 下指向不同目录。
 */
import fs from 'node:fs';
import { archiveFile } from './store.js';

/** 可在同一行附加的字段；id 永远返回，不能选 */
export const ARCHIVE_LIST_FIELDS = Object.freeze(['subject', 'date', 'from', 'to', 'conclusion']);

const FIELD_ALIASES = Object.freeze({
  title: 'subject',
  time: 'date',
  sender: 'from',
  recipient: 'to',
  to: 'to',
  conclusion: 'conclusion',
  body: 'conclusion',
  result: 'conclusion',
});

const clip = (value, max) => {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
};

/** 参数里的 fields：数组或逗号/空格分隔字符串；别名归一、去重、未知值 fail loud */
export function normalizeFields(raw) {
  const list = Array.isArray(raw)
    ? raw
    : raw === undefined || raw === null || raw === ''
      ? []
      : String(raw).split(/[,，\s]+/).filter(Boolean);
  const out = [];
  for (const item of list) {
    const key = String(item ?? '').trim().toLowerCase();
    if (!key) continue;
    const field = FIELD_ALIASES[key] ?? (ARCHIVE_LIST_FIELDS.includes(key) ? key : null);
    if (!field) {
      throw new Error(`不认识的字段「${clip(key, 40)}」（可用：${ARCHIVE_LIST_FIELDS.join(' / ')}；id 始终返回）`);
    }
    if (!out.includes(field)) out.push(field);
  }
  return out;
}

/** 存档目录名 + meta.id 都能当选择器；返回按 id 原顺序去重后的目标 */
export function resolveArchives(items, ids) {
  const all = Array.isArray(items) ? items : [];
  const byName = new Map();
  const byMailId = new Map();
  for (const item of all) {
    const name = String(item.name ?? '');
    if (name) byName.set(name, item);
    const mailId = String(item.id ?? '');
    if (mailId && !byMailId.has(mailId)) byMailId.set(mailId, item);
  }
  if (ids === undefined || ids === null) {
    return { items: all, missing: [], byName };
  }
  const list = Array.isArray(ids) ? ids : [ids];
  const seen = new Set();
  const picked = [];
  const missing = [];
  for (const raw of list) {
    const key = String(raw ?? '').trim();
    if (!key) continue;
    const item = byName.get(key) ?? byMailId.get(key);
    if (!item) {
      missing.push(key);
      continue;
    }
    const name = String(item.name ?? key);
    if (seen.has(name)) continue;
    seen.add(name);
    picked.push(item);
  }
  return { items: picked, missing, byName };
}

function conclusionText(dir, maxChars) {
  try {
    const raw = fs.readFileSync(archiveFile.conclusion(dir), 'utf8').trim();
    if (!raw) return { text: '', truncated: false, exists: true };
    if (maxChars > 0 && raw.length > maxChars) {
      return { text: clip(raw, maxChars), truncated: true, exists: true };
    }
    return { text: raw, truncated: false, exists: true };
  } catch {
    return { text: '', truncated: false, exists: false };
  }
}

/** 把一封邮件排成一行（id 在最前；选中的字段依序追加；结论另起缩进行） */
function formatItem(item, fields, conclusion, maxChars) {
  const parts = [String(item.name ?? item.id ?? '')];
  for (const field of fields) {
    if (field === 'conclusion') continue;
    const label = { subject: '标题', date: '时间', from: '发件人', to: '收件人' }[field] ?? field;
    parts.push(`${label}: ${clip(item[field] ?? '', 500) || '—'}`);
  }
  let line = parts.join(' | ');
  if (fields.includes('conclusion')) {
    if (!conclusion.exists) line += '\n  结论: （没有 conclusion.md）';
    else if (!conclusion.text) line += '\n  结论: （空）';
    else {
      const body = conclusion.text.replace(/\r?\n/g, '\n    ');
      line += `\n  结论: ${body}${conclusion.truncated ? `\n    （已截断，最多 ${maxChars} 字）` : ''}`;
    }
  }
  return line;
}

/**
 * 列出存档邮件。
 *
 * @param {{store:object, ids?:string|string[], fields?:string|string[],
 *          limit?:number, maxConclusionChars?:number}} input
 */
export function listArchives({ store, ids, fields, limit = 1000, maxConclusionChars = 4000 } = {}) {
  const selectedFields = normalizeFields(fields);
  const all = store.listArchived();
  const resolved = resolveArchives(all, ids);
  const total = resolved.items.length;
  const cap = Math.max(1, Math.min(2000, Math.trunc(Number(limit)) || 1000));
  const returned = resolved.items.slice(0, cap);
  const maxChars = Math.max(0, Math.min(20000, Math.trunc(Number(maxConclusionChars)) || 0));
  const items = returned.map((item) => {
    const conclusion = selectedFields.includes('conclusion')
      ? conclusionText(item.dir ?? item.file, maxChars)
      : null;
    const out = {
      id: String(item.name ?? ''),
      mail_id: String(item.id ?? ''),
      subject: String(item.subject ?? ''),
      date: String(item.date ?? ''),
      from: String(item.from ?? ''),
      to: String(item.to ?? ''),
    };
    if (conclusion) {
      out.conclusion = conclusion.text;
      out.conclusion_exists = conclusion.exists;
      out.conclusion_truncated = conclusion.truncated;
    }
    return out;
  });
  const lines = returned.map((item, index) => formatItem(item, selectedFields, items[index].conclusion_exists === undefined ? { exists: false } : {
    exists: items[index].conclusion_exists,
    text: items[index].conclusion ?? '',
    truncated: Boolean(items[index].conclusion_truncated),
  }, maxChars));
  const head = [];
  if (ids !== undefined && ids !== null) {
    head.push(`指定 id：${total} 封${resolved.missing.length ? `；找不到：${resolved.missing.join('、')}` : ''}`);
  }
  if (total > returned.length) head.push(`共 ${total} 封，只返回前 ${returned.length} 封（limit=${cap}）`);
  const body = lines.length > 0 ? lines.join('\n') : '没有存档邮件。';
  return {
    ok: true,
    total,
    returned: returned.length,
    fields: selectedFields,
    items,
    missing: resolved.missing,
    truncated: total > returned.length,
    text: [...head, body].join('\n'),
  };
}

/** 清掉与这些目录相关的 retries（目录已经不存在时它们只会变成孤儿） */
function dropRetriesFor(store, dirs) {
  const retries = store.state?.retries ?? {};
  const dirset = new Set(dirs.map((dir) => String(dir)));
  let removed = 0;
  for (const [key, entry] of Object.entries(retries)) {
    const target = String(entry?.dir ?? entry?.file ?? '');
    if (target && dirset.has(target)) {
      delete retries[key];
      removed += 1;
    }
  }
  return removed;
}

/**
 * 清理存档。`ids` 不传 = 清理全部；显式空数组会被拒绝（避免"传了一个空列表结果删光"）。
 *
 * @param {{store:object, ids?:string|string[], logger?:object}} input
 */
export function clearArchives({ store, ids, logger } = {}) {
  if (Array.isArray(ids) && ids.length === 0) {
    return { ok: false, error: 'ids 是空数组：要清理全部请不传 ids；要清理指定邮件请给出 id 列表' };
  }
  const all = store.listArchived();
  const resolved = resolveArchives(all, ids);
  const targets = resolved.items.map((item) => item.dir ?? item.file);
  const names = resolved.items.map((item) => String(item.name ?? ''));
  const removed = store.deleteMails(targets);
  const retriesRemoved = dropRetriesFor(store, targets);
  if (retriesRemoved > 0) store.save();
  const remaining = [];
  for (const [index, target] of targets.entries()) {
    try {
      if (fs.existsSync(target)) remaining.push(names[index] ?? String(target));
    } catch {
      remaining.push(names[index] ?? String(target));
    }
  }
  if (removed > 0) {
    logger?.info?.(
      `[mail-automation] 已清理 ${removed} 个存档${resolved.missing.length ? `（找不到 ${resolved.missing.length} 个 id）` : ''}`,
    );
  }
  return {
    ok: true,
    removed,
    ids: names,
    missing: resolved.missing,
    remaining,
    retries_removed: retriesRemoved,
    total_before: all.length,
    text:
      `已清理 ${removed} 个存档` +
      `${resolved.missing.length ? `；找不到：${resolved.missing.join('、')}` : ''}` +
      `${remaining.length ? `；仍有 ${remaining.length} 个没删掉（${remaining.slice(0, 5).join('、')}）` : ''}`,
  };
}
