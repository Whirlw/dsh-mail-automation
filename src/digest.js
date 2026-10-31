/**
 * 定时任务提示词的模板变量与渲染（不再是"总览专用"实现）。
 *
 * 任务提示词由文件提供，插件只负责把 `{{...}}` 换成当前值；选邮件/发 QQ/清存档
 * 全部由提示词里点名的工具完成。
 */
import fs from 'node:fs';
import path from 'node:path';
import { dayString } from './store.js';
import { fillTemplate, loadSchedulePrompt } from './config.js';

function clip(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/** 读存档目录里的 conclusion.md（agent 处理结论单独一份，见 store.js） */
function agentFindings(dir) {
  try {
    const text = fs.readFileSync(path.join(dir, 'conclusion.md'), 'utf8').trim();
    if (!text) return '';
    // 失败痕迹只作标记，不要把几百字的报错塞进总览
    if (/^（agent 处理失败/.test(text)) return '（这封当时没处理成功）';
    return clip(text, 160);
  } catch {
    return '';
  }
}

/** 总览提示词里逐封清单的上限（只影响提示词，不影响计数与清理） */
export const INVENTORY_LIMIT = 80;

/** 目录指纹：win32 大小写不敏感；去掉尾分隔符，避免同一目录两种写法各算一份 */
function dirKey(value) {
  const flat = path.resolve(String(value ?? '')).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? flat.toLowerCase() : flat;
}

/**
 * 挑出这次总览该覆盖哪些邮件（A6 / B-N3）。
 *
 * - **跳过还在重试队列里的**：它们的 `conclusion.md` 还没有（或还是失败占位），
 *   汇总进去再删掉存档，重试条目就成了指向不存在目录的孤儿，这封信连结论一起消失。
 * - 判据只能按**目录**：`retries` 的键有 `header.id` / `retry:<name>` / `adopt:<name>`
 *   三种形态，同一目录还可能同时有多条键，按键匹配必漏。
 * - `attempts >= maxAttempts` 的不跳：它在下一拍就会被 `retryPending` 丢弃，
 *   这时让它回到总览（结论里会标注"当时没处理成功"），避免"永久隐形"。
 */
export function digestSelection({ items, retries = {}, maxAttempts = 3, limit = INVENTORY_LIMIT, shouldHold } = {}) {
  const alive = new Set();
  for (const entry of Object.values(retries ?? {})) {
    if (!entry || Number(entry.attempts ?? 0) >= maxAttempts) continue;
    for (const dir of [entry.dir, entry.file]) {
      if (dir) alive.add(dirKey(dir));
    }
  }
  const hold = typeof shouldHold === 'function' ? shouldHold : () => true;
  const included = [];
  const skipped = [];
  for (const item of items ?? []) {
    const dir = item.dir ?? item.file;
    if (alive.has(dirKey(dir)) && hold(item)) skipped.push(item);
    else included.push(item);
  }
  const listed = included.slice(-Math.max(1, Number(limit) || INVENTORY_LIMIT));
  return { included, skipped, listed, truncated: Math.max(0, included.length - listed.length) };
}

/** 逐封清单（提示词用）；只列最近 `limit` 封，超出部分明确告诉 agent"不要编造" */
export function formatInventory(items, { limit = INVENTORY_LIMIT } = {}) {
  const listed = (items ?? []).slice(-Math.max(1, Number(limit) || INVENTORY_LIMIT));
  const inventory = listed
    .map((item, index) => {
      const time = String(item.date || '').replace('T', ' ').replace('Z', '').slice(0, 16);
      const finding = agentFindings(item.dir ?? item.file);
      return [
        `${index + 1}. [${item.source || '未知来源'}] ${time} ${item.from || ''}`,
        `   主题：${item.subject || '(无主题)'}`,
        `   存档：${item.dir ?? item.file}（结论 conclusion.md，正文 body.txt）`,
        finding ? `   已处理结论：${finding}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');
  return { inventory, listed, truncated: Math.max(0, (items?.length ?? 0) - listed.length) };
}

/** 启动快照文本（给 `startup` 任务的提示词变量用；读不到就空串） */
function readStartupSnapshot(cfg) {
  const file = cfg?.storage?.snapshotFile;
  if (!file) return '';
  try {
    return fs.readFileSync(file, 'utf8').slice(0, 8_000);
  } catch {
    return '';
  }
}

/**
 * 组装一次任务运行的上下文：
 *   - `selection`：这次覆盖哪些待总览邮件（跳过重试中的）；
 *   - `vars`：可写进提示词的模板变量（未知占位符原样保留，见 fillTemplate）。
 */
export function buildTaskContext({ cfg, store, task, day = '', limit = INVENTORY_LIMIT } = {}) {
  const all = store.listArchived(day ? { day } : {});
  const selection = digestSelection({
    items: all,
    retries: store.state?.retries ?? {},
    maxAttempts: Math.max(1, Number(cfg?.agent?.retryAttempts ?? 3)),
    // 已经有正常结论的（陈旧 retry 条目）不该被挡在总览外
    shouldHold: (item) => store.conclusionState(item.dir ?? item.file).outcome !== 'ok',
    limit,
  });
  const { inventory, listed, truncated } = formatInventory(selection.included, { limit });
  const vars = {
    now: new Date().toLocaleString(),
    date: dayString(),
    task_id: String(task?.id ?? ''),
    task_name: String(task?.name ?? ''),
    pending_count: String(selection.included.length),
    pending_omitted: String(truncated),
    pending_list: inventory || '(没有待总览的邮件)',
    archive_dir: cfg?.storage?.archiveDir ?? '',
    snapshot_file: cfg?.storage?.snapshotFile ?? '',
    startup_snapshot: readStartupSnapshot(cfg),
  };
  return { selection, vars, listed, truncated };
}

/** 把任务提示词里的 `{{变量}}` 替换成当前值 */
export function composeTaskPrompt({ template, vars }) {
  return fillTemplate(String(template ?? ''), vars);
}
/** 普通定时任务的 prompt：只做模板替换，空提示词直接失败（不静默自由发挥） */
export function buildAgentTaskPrompt({ cfg, store, task, day = '' } = {}) {
  const context = buildTaskContext({ cfg, store, task, day });
  const template = loadSchedulePrompt(task);
  if (!template.trim()) {
    throw new Error(`定时任务「${task?.name ?? task?.id ?? '?'}」的提示词为空或文件不可读：${task?.promptFile || '(未配置)'}`);
  }
  return {
    prompt: composeTaskPrompt({ template, vars: context.vars }),
    count: context.selection.included.length,
    skipped: context.selection.skipped.length,
    vars: context.vars,
  };
}