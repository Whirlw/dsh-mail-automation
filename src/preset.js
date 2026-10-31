/**
 * 邮件子 agent 的「运行时预设」：工具集由配置生成，不再写死在 cordis.patch.yml。
 * 不包含任何人设：角色与输出格式全部由用户的提示词决定。
 *
 * 工具集（`agent.tools`）是**自由列表**，每一项可以是：
 *   1. 目录里的短 id：`read_image` / `fs` / `search` / `web` / `skill` / `todo`；
 *   2. 常见**工具名**：`read` `write` `edit` `glob` `grep` `web_fetch` `bash` `pwsh` `todo_write` …
 *      —— 自动映射到提供它的宿主工具包（用户按"我要 grep"来想就行）；
 *   3. 任意**模块名**：`@scope/别的插件包` 或含 `/` 的 spec，用来挂**其他插件**提供的工具
 *      （挂载方式与 patch 的 `name:` 一致，loader 解析）。
 *
 * 组装规则：按**包**去重（同一个包不能在一个 preset 里挂两次）；`dsh-tool-fs` 的四个开关由
 * 被选中工具名的并集决定（同时要 read 与 write ⇒ read/write/edit/readImage 全开）。
 *
 * 预设有问题时的兜底在 agent.js：解析/挂载失败都退回部署默认预设，只损失省 token。
 */
export const MAIL_PRESET_ID = 'mail-automation-agent';

/** 目录（设置页的"快速添加"建议；**不是**白名单）。 */
export const MAIL_TOOL_CATALOG = Object.freeze([
  { id: 'read_image', label: '看邮件预览图（read_image）', pkg: '@deepseek-ai/dsh-tool-fs', flags: { readImage: true } },
  { id: 'fs', label: '读/写/改本地文件（read / write / edit）', pkg: '@deepseek-ai/dsh-tool-fs', flags: { read: true, readImage: true, write: true, edit: true } },
  { id: 'search', label: '搜索文件名/内容（glob / grep）', pkg: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: true } },
  { id: 'web', label: '联网抓取与搜索（web_fetch / web_search）', pkg: '@deepseek-ai/dsh-tool-web' },
  { id: 'skill', label: '加载技能说明书（skill）', pkg: '@deepseek-ai/dsh-tool-skill' },
  { id: 'todo', label: '任务清单（todo_write）', pkg: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
  // 插件自己注册的全局工具：可勾可选、也可删；不会挂任何包（本来就在）
  { id: 'mail_automation_archive_read', label: '读本地邮件存档（mail_automation_archive_read）', builtin: true },
  { id: 'mail_automation_archive_list', label: '批量列出存档邮件与结论（mail_automation_archive_list）', builtin: true },
  { id: 'mail_automation_archive_clear', label: '清理存档邮件（mail_automation_archive_clear）', builtin: true },
  { id: 'qq_notify', label: '发 QQ 通知（qq_notify）', builtin: true },
]);

export const DEFAULT_MAIL_TOOLS = Object.freeze([
  'mail_automation_archive_read',
  'mail_automation_archive_list',
  'mail_automation_archive_clear',
  'qq_notify',
  'read_image',
]);

/**
 * 插件自带的工具：**和普通工具一样由 `agent.tools` 选择**，默认出现在首次启动的
 * 工具列表里；用户把它们全删掉后，子 agent 就真的没有任何工具。
 */
export const BUILTIN_MAIL_TOOLS = Object.freeze([
  { id: 'mail_automation_archive_read', label: '读本地邮件存档（mail_automation_archive_read）' },
  { id: 'mail_automation_archive_list', label: '批量列出存档邮件与结论（mail_automation_archive_list）' },
  { id: 'mail_automation_archive_clear', label: '清理存档邮件（mail_automation_archive_clear）' },
  { id: 'qq_notify', label: '发 QQ 通知（qq_notify）' },
]);

/** 工具名 → 宿主工具包（"我想用它，但不知道包名"时用） */
const TOOL_ALIASES = new Map([
  ['read', { pkg: '@deepseek-ai/dsh-tool-fs', flags: { read: true } }],
  ['write', { pkg: '@deepseek-ai/dsh-tool-fs', flags: { write: true } }],
  ['edit', { pkg: '@deepseek-ai/dsh-tool-fs', flags: { edit: true } }],
  ['read_image', { pkg: '@deepseek-ai/dsh-tool-fs', flags: { readImage: true } }],
  ['glob', { pkg: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: true } }],
  ['grep', { pkg: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: true } }],
  ['web_fetch', { pkg: '@deepseek-ai/dsh-tool-web' }],
  ['web_search', { pkg: '@deepseek-ai/dsh-tool-web' }],
  ['bash', { pkg: '@deepseek-ai/dsh-tool-bash' }],
  ['pwsh', { pkg: '@deepseek-ai/dsh-tool-pwsh' }],
  ['skill', { pkg: '@deepseek-ai/dsh-tool-skill' }],
  ['todo_write', { pkg: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } }],
  ['ask_user_question', { pkg: '@deepseek-ai/dsh-tool-ask-user' }],
  ['present', { pkg: '@deepseek-ai/dsh-tool-present' }],
]);

export const MAIL_TOOL_ALIASES = Object.fromEntries(TOOL_ALIASES);

const catalogById = new Map(MAIL_TOOL_CATALOG.map((entry) => [entry.id, entry]));
const FS_FLAGS = ['read', 'readImage', 'write', 'edit'];

/** 看起来像模块名（而不是工具名）：`@scope/pkg` 或 `foo/bar` */
export const looksLikeModuleSpec = (value) => /^@[^/\s]+\/[^/\s]+/.test(value) || /^[a-z0-9][\w.-]*\/[\w./-]+$/i.test(value);

/**
 * 把一条用户输入解析成"要挂的包"。
 * @returns {{pkg: string, flags?: object, config?: object, id: string} | null}
 */
export function resolveToolSpec(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const catalog = catalogById.get(text);
  if (catalog?.builtin) return { id: catalog.id, builtin: true, pkg: null };
  if (catalog) {
    return {
      id: catalog.id,
      pkg: catalog.pkg,
      ...(catalog.flags ? { flags: { ...catalog.flags } } : {}),
      ...(catalog.config ? { config: structuredClone(catalog.config) } : {}),
    };
  }
  const alias = TOOL_ALIASES.get(text);
  if (alias) {
    return {
      id: text,
      pkg: alias.pkg,
      ...(alias.flags ? { flags: { ...alias.flags } } : {}),
      ...(alias.config ? { config: structuredClone(alias.config) } : {}),
    };
  }
  if (looksLikeModuleSpec(text)) return { id: text, pkg: text };
  return null;
}

/** 工具集 → 去重后的**原始条目**（保留用户写法，供设置页回显）；未配置 → 默认 */
export function normalizeMailTools(value) {
  const list = Array.isArray(value)
    ? value.map(String)
    : typeof value === 'string'
      ? value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean)
      : null;
  if (!list) return [...DEFAULT_MAIL_TOOLS];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const text = item.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/** 解析不出来的条目（日志/设置页提示用；不参与运行） */
export function unresolvedMailTools(value) {
  return normalizeMailTools(value).filter((item) => !resolveToolSpec(item));
}

/**
 * 由配置生成 PresetDefinition。
 * @param {{tools?: string[]}} config
 */
export function buildMailPreset(config = {}) {
  const tools = normalizeMailTools(config.tools);
  /** 包 → { flags, config } */
  const byPackage = new Map();
  for (const item of tools) {
    const resolved = resolveToolSpec(item);
    if (!resolved || resolved.builtin) continue;
    const current = byPackage.get(resolved.pkg) ?? { flags: null, config: null };
    if (resolved.flags) current.flags = { ...(current.flags ?? {}), ...resolved.flags };
    if (resolved.config) current.config = { ...(current.config ?? {}), ...resolved.config };
    byPackage.set(resolved.pkg, current);
  }

  // 不挂任何人设插件：角色/输出格式全部由用户的提示词决定。
  const plugins = [];
  let index = 0;
  for (const [pkg, merged] of byPackage) {
    index += 1;
    // id 只在 preset 内局部有效；加前缀避免与宿主顶层行 id 撞名（doctor X5 会报）
    const short = pkg.replace(/^@[^/]+\//, '').replace(/[^\w-]+/g, '-').slice(0, 36) || 'tool';
    const config_ = merged.flags
      ? { ...(merged.config ?? {}), ...Object.fromEntries(FS_FLAGS.map((flag) => [flag, Boolean(merged.flags[flag])])) }
      : merged.config;
    plugins.push({
      id: `mail-${short}-${index}`,
      name: pkg,
      ...(config_ ? { config: structuredClone(config_) } : {}),
    });
  }
  return {
    id: MAIL_PRESET_ID,
    name: '邮件自动化',
    description: `无内置人设，行为完全由提示词决定；工具来自 agent.tools：${tools.join(' / ') || '(无)'}。`,
    order: 90,
    plugins,
  };
}

/** 预设内容的签名：包与最终 config 没变就不重注册（重注册会让新 agent 换代） */
export function mailPresetSignature(definition) {
  return JSON.stringify(definition.plugins.map((plugin) => [plugin.name, plugin.config ?? null]));
}
