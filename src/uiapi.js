/**
 * 桌面端设置页的数据通道（host 侧）。
 *
 * 为什么走 HTTP 路由而不是 Typert Remote（对齐官方 UI 技能 + 同代插件的实际做法）：
 * - `settings.section` 的页面组件需要的是一份**只读快照 + 三个写操作**，不是会话派生值；
 * - 同代已装插件（dsh-qqbot-bridge）就是用 `ctx.webServer.register({ kind:'exact', path, handler })`
 *   提供 `/plugins/<包名>/...`，客户端 `fetch` 同一个路径。这条通道在本机 GUI 里已被验证可用。
 *
 * 一条纪律（技能 references/user-actions.md「One operation, two callers」）：
 * 读写参数 / 读写提示词只在这一处实现，设置页与 `mail_automation_config` 工具都调它，
 * 不许两边各写一套逻辑。
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { dayOf } from './store.js';
import { normalizeConfig, mergeConfig, composeConfig, canonicalizeConfig, resolveDshHome, ensureDefaultPromptFiles } from './config.js';
import { BUILTIN_MAIL_TOOLS, MAIL_TOOL_CATALOG, MAIL_TOOL_ALIASES, MAIL_PRESET_ID, normalizeMailTools, resolveToolSpec } from './preset.js';
import { providerFor, sourceTypeLabel, SOURCE_TYPES, SOURCE_TYPE_LABELS } from './sources/index.js';
import { overlaySourceIds, sourceDetail } from './sources-config.js';
import { atomicWriteFile } from './fsutil.js';
import { DEFAULT_MAIL_PROMPT, DEFAULT_HTML_PROMPT } from './defaults.js';
import { planNextRun, describeSchedule } from './schedule.js';

/** 路由路径：设置页与工具共用；改这里只改一处 */
export const UI_ROUTE_PATH = '/plugins/dsh-mail-automation/api';

/**
 * 设置页允许改的参数（**白名单**，键是 UI 用的扁平名，值是 YAML 里的位置与校验）。
 *
 * 只收「改完不用重启、也不改变插件结构」的几项：轮询节奏、启动快照条数、
 * agent/模型/工具、render、QQ 接收人。**定时任务不在这个白名单里**：它是一整份数组，
 * 走 `save-schedules`（`schedules-config.js`），不能按标量逐个改。
 * 信箱来源（含账号）与凭据不在 UI 里改——那是部署配置，改错会直接断掉轮询。
 *
 * `key` 是 **YAML 里的名字**（snake_case，写盘时用）；
 * `field` 是 **规范化运行时配置里的名字**（camelCase，读取时用）。
 * 两者必须分开：`normalizeConfig()` 把 YAML 的 `poll_seconds` 变成 `monitor.pollSeconds`，
 * 按 PARAM_SPECS 的 field 读值，保证设置页读回与保存使用同一套映射。
 */
export const PARAM_SPECS = Object.freeze({
  poll_seconds: { section: 'monitor', key: 'poll_seconds', field: 'pollSeconds', label: '轮询间隔（秒）', type: 'number', min: 5, max: 3600 },
  heartbeat_seconds: { section: 'monitor', key: 'heartbeat_seconds', field: 'heartbeatSeconds', label: '心跳间隔（秒）', type: 'number', min: 1, max: 600 },
  busy_retry_seconds: { section: 'scheduler', key: 'busy_retry_seconds', field: 'busyRetrySeconds', label: '定时任务轮询占锁重试（秒）', type: 'number', min: 1, max: 300 },
  busy_retry_max: { section: 'scheduler', key: 'busy_retry_max', field: 'busyRetryMax', label: '定时任务轮询占锁最多重试次数', type: 'number', min: 1, max: 1000 },
  initial_headers: { section: 'monitor', key: 'initial_headers', field: 'initialHeaders', label: '启动快照条数', type: 'number', min: 1, max: 50 },
  'agent.silent': { section: 'agent', key: 'silent', field: 'silent', label: '静默处理（不在侧边栏显示会话）', type: 'boolean' },
  'agent.session_budget_mb': {
    section: 'agent',
    key: 'session_budget_mb',
    field: 'sessionBudgetMb',
    label: '单个会话体积上限（MB，0 = 不限制；超过就归档换代）',
    type: 'number',
    min: 0,
    max: 512,
  },
  'agent.prompt_max_kb': {
    section: 'agent',
    key: 'prompt_max_kb',
    field: 'promptMaxKb',
    label: '单条提示词上限（KB，0 = 不限制；超过就拒绝发送）',
    type: 'number',
    min: 0,
    max: 65536,
  },
  'agent.workspace': { section: 'agent', key: 'workspace', field: 'workspace', label: '邮件 agent 工作区（会话落地目录）', type: 'path', read: (cfg) => cfg?.agent?.workspaceRaw ?? cfg?.agent?.workspace ?? null },
  // HTML 邮件预览图：不同模型看长图的能力不同、浏览器装在哪也因机器而异，都在这里调。
  'render.width': { section: 'render', key: 'width', field: 'width', label: '预览图视口宽度（px）', type: 'number', min: 320, max: 4096 },
  'render.slice_height': { section: 'render', key: 'slice_height', field: 'sliceHeight', label: '超长页面每片最大高度（px）', type: 'number', min: 600, max: 8000 },
  'render.slice_overlap': { section: 'render', key: 'slice_overlap', field: 'sliceOverlap', label: '相邻切片重叠高度（px）', type: 'number', min: 0, max: 2000 },
  'render.max_height': { section: 'render', key: 'max_height', field: 'maxHeight', label: '整页图最大高度（px）', type: 'number', min: 600, max: 100000 },
  'render.remote_images': { section: 'render', key: 'remote_images', field: 'remoteImages', label: '允许邮件里的远程图片与样式', type: 'boolean' },
  'render.browser': { section: 'render', key: 'browser', field: 'browser', label: 'Chromium 浏览器路径（留空 = 自动探测）', type: 'path' },
  // 成本/质量三件套：模型（成对）、思考强度、工具集。都由 getter/签名现读，改完不用重启。
  'agent.provider': { section: 'agent', key: 'provider', field: 'provider', label: '邮件 agent 模型 provider', type: 'text' },
  'agent.model': { section: 'agent', key: 'model', field: 'model', label: '邮件 agent 模型', type: 'text' },
  'agent.reasoning_effort': {
    section: 'agent',
    key: 'reasoning_effort',
    field: 'reasoningEffort',
    label: '处理邮件时的思考强度',
    type: 'choice',
    options: ['inherit', 'minimal', 'low', 'medium', 'high'],
    read: (cfg) => cfg?.agent?.reasoningEffort || 'inherit',
  },
  'agent.tools': {
    section: 'agent',
    key: 'tools',
    field: 'tools',
    label: '邮件 agent 工具集',
    type: 'tools',
    read: (cfg) => (Array.isArray(cfg?.agent?.tools) ? cfg.agent.tools : []),
  },
  // QQ 推送的接收人/机器人 id：扫码绑定会自动写这三项，断网/换机器人时也能手填。
  // **app_secret 不在这里**：它会被 readParams 读进快照，等于把密钥发到浏览器。
  'qq.enabled': { section: 'qq', key: 'enabled', field: 'enabled', label: '启用 QQ 推送', type: 'boolean' },
  'qq.app_id': { section: 'qq', key: 'app_id', field: 'appId', label: 'QQ 机器人 AppID', type: 'text' },
  'qq.openid': { section: 'qq', key: 'openid', field: 'openid', label: '接收人 openid（扫码绑定自动填写）', type: 'text' },
  'qq.markdown': { section: 'qq', key: 'markdown', field: 'markdown', label: '用 Markdown 发送', type: 'boolean' },
});

/** 两份通用提示词在 UI 里的键 → 运行时配置里的路径（定时任务各自的提示词在 schedules 里） */
const PROMPT_KEYS = {
  mail: (cfg) => cfg.prompt?.file ?? '',
  html: (cfg) => cfg.prompt?.htmlFile ?? '',
};

/** 参数校验：合法返回规范化后的值，非法返回 { error } */
export function normalizeParam(name, raw) {
  const spec = PARAM_SPECS[name];
  if (!spec) return { error: `不认识的参数：${name}` };
  if (spec.type === 'boolean') {
    if (typeof raw === 'boolean') return { value: raw };
    const text = String(raw ?? '').trim().toLowerCase();
    if (text === 'true' || text === '1') return { value: true };
    if (text === 'false' || text === '0') return { value: false };
    return { error: `${spec.label} 需要 true/false` };
  }
  if (spec.type === 'clock') {
    const text = String(raw ?? '').trim();
    const m = /^(\d{1,2}):(\d{2})$/.exec(text);
    if (!m) return { error: `${spec.label} 需要 HH:MM` };
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour > 23 || minute > 59) return { error: `${spec.label} 不是合法时刻` };
    return { value: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
  }
  if (spec.type === 'path') {
    // 允许留空：空 = 用默认落点（$DSH_HOME/workspace/default），与设置里的说明一致
    return { value: String(raw ?? '').trim() };
  }
  if (spec.type === 'text') {
    /*
     * 自由文本（provider/model 这类 id）。只挡长度与明显非法的字符：
     * 这里**不**拿宿主的模型目录做白名单——目录可能暂时拿不到（早期启动/离线），
     * 而写错的值在 runner 里会退回部署默认并留一条 WARN，不会把插件搞坏。
     */
    const text = String(raw ?? '').trim();
    if (text.length > 200) return { error: `${spec.label} 太长了（上限 200 字符）` };
    if (text && !/^[A-Za-z0-9._:@/-]+$/.test(text)) {
      return { error: `${spec.label} 只能包含字母、数字与 . _ : @ / -` };
    }
    return { value: text };
  }
  if (spec.type === 'choice') {
    const text = String(raw ?? '').trim().toLowerCase();
    if (!spec.options.includes(text)) {
      return { error: `${spec.label} 只能是 ${spec.options.join(' / ')}` };
    }
    return { value: text };
  }
  if (spec.type === 'tools') {
    const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[,\n]/);
    const entries = normalizeMailTools(list.map((item) => String(item)));
    /*
     * 工具集是**自由列表**：目录短 id、常见工具名（read/grep/web_fetch…）、
     * 或任意模块名（`@scope/别的插件包`）。这里只挡"看起来什么都不是"的条目，
     * 避免把 `read_img` 这种拼写错误静默当成合法包名去挂载。
     */
    const unknown = entries.filter((entry) => !resolveToolSpec(entry));
    if (unknown.length > 0) {
      return {
        error:
          `${spec.label} 里有无法解析的条目：${unknown.join('、')}。` +
          `可以写工具名（${MAIL_TOOL_CATALOG.map((entry) => entry.id).join(' / ')} / read / grep / web_fetch …），` +
          '或直接写模块名（如 @scope/other-plugin）。',
      };
    }
    return { value: entries };
  }
  const num = Number(raw);
  if (!Number.isFinite(num)) return { error: `${spec.label} 需要数字` };
  const value = Math.trunc(num);
  if (value < spec.min || value > spec.max) return { error: `${spec.label} 需在 ${spec.min}–${spec.max} 之间` };
  return { value };
}

/** 把值渲染成 YAML 标量（字符串加引号，布尔/数字原样，数组写成 flow 序列） */
function renderScalar(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => String(item)));
  return JSON.stringify(String(value));
}

/** 检测并保留原文件的换行符 */
function eolOf(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * 在 YAML 文本里**就地**改一个段内的标量，尽量不破坏注释与顺序。
 *
 * 为什么不 `YAML.stringify(parse(text))`：那样会把用户写的整份注释（这次配置里的说明
 * 占了一半篇幅）全部抹掉。设置页只改 6 个标量，没必要为此牺牲可读性。
 */
export function setYamlScalar(text, section, key, value) {
  const eol = eolOf(text);
  // BOM 会让 `^monitor:` 匹配不到，随后"段缺失 → 追加"，造出重复键
  const lines = String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const rendered = renderScalar(value);
  const name = String(section).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 允许 `monitor :`（冒号前有空格）和 `"monitor":` 两种合法写法
  const sectionRe = new RegExp(`^(?:"${name}"|'${name}'|${name})\\s*:(.*)$`);
  const head = lines.findIndex((line) => sectionRe.test(line));

  const setInLine = (index) => {
    const line = lines[index];
    const re = new RegExp(`^(\\s+)${key}\\s*:(.*)$`);
    const m = re.exec(line);
    if (!m) return false;
    // 保留行尾注释（`poll_seconds: 30   # 轮询间隔`）
    const tail = /\s+#.*$/.exec(m[2])?.[0] ?? '';
    const indent = m[1].length;
    lines[index] = `${m[1]}${key}: ${rendered}${tail}`;
    /*
     * 关键：如果这个键原来是**块状列表**（`tools:` 下一行起 `    - read_image`），
     * 只改写这一行会留下孤立的 `- …` 项 —— YAML 直接解析失败（或把段变成字符串），
     * 于是整次保存被"写入校验失败"拒掉，且用户看不出原因。
     * 这里把属于该键的续行一并删掉：缩进比该键更深的行、以及块状 `- ` 项、空行。
     * 遇到"缩进 ≤ 该键缩进且非空"的行（下一个键/下一个段）立即停。
     */
    let next = index + 1;
    while (next < lines.length) {
      const candidate = lines[next];
      const trimmed = candidate.trim();
      if (trimmed === '') {
        next += 1;
        continue;
      }
      const candidateIndent = candidate.match(/^(\s*)/)[1].length;
      const isItem = /^-\s|^-$/.test(trimmed);
      if (candidateIndent > indent || (isItem && candidateIndent >= indent)) {
        next += 1;
        continue;
      }
      break;
    }
    if (next > index + 1) lines.splice(index + 1, next - (index + 1));
    return true;
  };

  if (head >= 0) {
    /*
     * 行内写法（`monitor: {poll_seconds: 30}`）没法"就地改一个标量"：以前会走到
     * "段里没这个键 → 插一行"，把 `  poll_seconds: …` 插进一个 flow map 后面，写出坏 YAML。
     * 这里明确拒绝，让用户改成块状写法——比静默写出一个下次启动会挂的文件好。
     */
    const rest = (sectionRe.exec(lines[head])?.[1] ?? '').replace(/\s+#.*$/, '').trim();
    // `render: null` / `credentials: ~`：段存在但值为空，属合法空块；归一成 `section:` 再插键，
    // 不要判成"非块状写法"把整次保存拒掉（本机覆盖层里就有 `render: null`）。
    if (/^(?:null|~)$/i.test(rest)) lines[head] = `${section}:`;
    else if (rest) {
      // 行内映射、锚点（&m）、标签（!!map）、流式数组……都不是"块状段落"，改不了单个标量
      throw new Error(`配置里的 ${section} 段不是块状（多行）写法（${rest.slice(0, 24)}），设置页无法安全改写；请先把它改成多行再保存`);
    }
    // 段体 = 紧随其后、缩进或空行或注释的行
    let end = head + 1;
    while (end < lines.length && (lines[end].trim() === '' || /^\s/.test(lines[end]) || /^\s*#/.test(lines[end]))) end += 1;
    let replaced = false;
    for (let i = head + 1; i < end; i += 1) {
      if (setInLine(i)) {
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      // 段里没有这个键：插在段首（保持两格缩进）
      lines.splice(head + 1, 0, `  ${key}: ${rendered}`);
    }
  } else {
    // 整段缺失：追加到文件末尾
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push(`${section}:`, `  ${key}: ${rendered}`);
  }
  return lines.join(eol);
}

/** 读三份提示词；文件不存在时用内置兜底文本并标记 exists=false */
export function readPrompts(cfg) {
  // 没配路径/文件缺失时先把兜底落盘，设置页能直接编辑并保存
  ensureDefaultPromptFiles(cfg);
  const out = {};
  for (const [name, resolve] of Object.entries(PROMPT_KEYS)) {
    const file = resolve(cfg);
    let text = '';
    let exists = false;
    if (file) {
      try {
        text = fs.readFileSync(file, 'utf8');
        exists = true;
      } catch {
        exists = false;
      }
    }
    if (!text) {
      text = name === 'html' ? DEFAULT_HTML_PROMPT : DEFAULT_MAIL_PROMPT;
    }
    out[name] = { path: file, text, exists };
  }
  return out;
}

/** 写提示词。只写请求里出现的键；路径为空则不写该键。 */
export function savePrompts(cfg, prompts) {
  const written = [];
  for (const [name, resolve] of Object.entries(PROMPT_KEYS)) {
    if (!Object.prototype.hasOwnProperty.call(prompts ?? {}, name)) continue;
    const file = resolve(cfg);
    if (!file) return { ok: false, error: `配置里没有 ${name} 提示词的文件路径（prompt.file / prompt.htmlFile）` };
    const text = String(prompts[name] ?? '');
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text, 'utf8');
      written.push(file);
    } catch (err) {
      return { ok: false, error: `写入 ${file} 失败：${err?.message ?? err}` };
    }
  }
  return { ok: true, written };
}

/**
 * 保存参数：读 YAML → 就地改标量 → **写完再解析校验** → 落盘。
 * 校验不通过就整份不写，避免把配置写成半坏状态。
 */
export function saveParams({ configFile, params, base, dshHome, secrets } = {}) {
  if (!configFile) return { ok: false, error: '没有可写的 configFile（当前只用 cordis.yml 配置）' };
  let text = '';
  try {
    text = fs.readFileSync(configFile, 'utf8');
  } catch (err) {
    // 全新部署：sources 写在 cordis.patch.yml、覆盖层还没创建。此时从空文本开始写
    // （atomicWriteFile 会自动建目录），而不是让设置页所有保存都报 ENOENT。
    if (err?.code !== 'ENOENT') return { ok: false, error: `读取 ${configFile} 失败：${err?.message ?? err}` };
    text = '';
  }
  const changes = [];
  for (const [name, raw] of Object.entries(params ?? {})) {
    const spec = PARAM_SPECS[name];
    if (!spec) return { ok: false, error: `不认识的参数：${name}` };
    const normalized = normalizeParam(name, raw);
    if (normalized.error) return { ok: false, error: normalized.error };
    try {
      text = setYamlScalar(text, spec.section, spec.key, normalized.value);
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
    changes.push({ name, value: normalized.value });
  }
  if (changes.length === 0) return { ok: true, written: [], changes };

  // 写前校验：能解析、且每个键确实读得出期望值
  let parsed;
  try {
    parsed = YAML.parse(text) ?? {};
  } catch (err) {
    return { ok: false, error: `改完的 YAML 解析失败，已放弃写入：${err?.message ?? err}` };
  }
  for (const change of changes) {
    const spec = PARAM_SPECS[change.name];
    const actual = parsed?.[spec.section]?.[spec.key];
    // 数组（agent.tools）按 JSON 比，标量按字符串比：`String(['a'])` 与 `'a'` 会撞在一起
    const same = (left, right) =>
      Array.isArray(left) || Array.isArray(right)
        ? JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
        : String(left) === String(right);
    if (!same(actual, change.value)) {
      return { ok: false, error: `写入校验失败：${spec.section}.${spec.key} 读回 ${JSON.stringify(actual)}，期望 ${JSON.stringify(change.value)}，已放弃写入` };
    }
  }
  /*
   * 整表校验（G7）：逐键读回只保证"这一个标量写对了"，不代表整张表还是合法配置。
   * 设置页是**正则改 YAML**，绕过 `ctx.settings` 的 schema —— 这里补一道与启动时
   * 完全相同的 `normalizeConfig()`：来源类型/必填字段/重复 id 任何一项不合法就整份不写。
   * 缺 secrets 不影响这一层（凭据是引用，到 credentials.js 才解析）。
   */
  try {
    /*
     * 校验对象必须是**合并后的整张表**：sources 常常写在 cordis.patch.yml（schema 层），
     * 覆盖层只写几个标量。只拿 overlay 去 normalize 会恒报"没有 sources"，把全部保存拒掉。
     * 只有调用方显式给了 base 才校验（第三方调用方保持旧行为，不被新校验误杀）。
     */
    if (base !== undefined) {
      const validated = normalizeConfig(composeConfig(base ?? {}, canonicalizeConfig(parsed), { dshHome }), { dshHome, configFile, secrets });
      /*
       * 模型选择必须成对：只填 provider 时 host 只会按部署默认跑，用户以为选了 A 模型、实际跑 B，
       * 而且日志里只有一条 WARN。这里在**写盘前**拒绝，把问题挡在设置页。
       */
      const provider = String(validated?.agent?.provider ?? '').trim();
      const model = String(validated?.agent?.model ?? '').trim();
      if (provider && !model) {
        return { ok: false, error: 'agent.provider 已填但 agent.model 为空：请手动填模型 id（该 provider 下没取到模型列表时要手填），或把两项都留空以跟随部署默认' };
      }
      if (model && !provider) {
        return { ok: false, error: 'agent.model 已填但 agent.provider 为空：请补上 provider，或把两项都留空以跟随部署默认' };
      }
    }
  } catch (err) {
    return { ok: false, error: `改完的 YAML 没通过整表校验，已放弃写入：${err?.message ?? err}` };
  }

  // 配置文件里可能存着 app_secret：原子写 rename 会丢原权限，这里显式保留
  let mode;
  try {
    mode = fs.statSync(configFile).mode & 0o777;
  } catch {
    mode = undefined;
  }
  try {
    atomicWriteFile(configFile, text, mode === undefined ? {} : { mode });
  } catch (err) {
    return { ok: false, error: `写入 ${configFile} 失败：${err?.message ?? err}` };
  }
  return { ok: true, written: [configFile], changes };
}

/**
 * 写一个 YAML 标量（不在 PARAM_SPECS 白名单里的键用它）。
 *
 * 场景：QQ 扫码绑定成功后要把 `qq.app_id` / `qq.openid` 落盘；凭据缝不可用时还要
 * 兜底写 `qq.app_secret`（明文进 YAML 是有意的降级，调用方必须把 warnings 透出去）。
 * 与 saveParams 走**同一条**校验路径：整表 `normalizeConfig` 不过就整份不写。
 */
export function writeConfigScalar({ configFile, section, key, value, base, dshHome, secrets } = {}) {
  if (!configFile) return { ok: false, error: '没有可写的 configFile（当前只用 cordis.yml 配置）' };
  let text = '';
  try {
    text = fs.readFileSync(configFile, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') return { ok: false, error: `读取 ${configFile} 失败：${err?.message ?? err}` };
    text = '';
  }
  let next;
  try {
    next = setYamlScalar(text, section, key, value);
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
  try {
    const parsed = YAML.parse(next) ?? {};
    normalizeConfig(composeConfig(base ?? {}, canonicalizeConfig(parsed), { dshHome }), { dshHome, configFile, secrets });
    // 逐键读回：与 saveParams 同一条保证，避免"写到了能被解析、但读回不是期望值"的位置
    const actual = parsed?.[section]?.[key];
    const expected = value;
    const same = (left, right) =>
      Array.isArray(left) || Array.isArray(right)
        ? JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
        : String(left) === String(right);
    if (!same(actual, expected)) {
      return {
        ok: false,
        error: `写入校验失败：${section}.${key} 读回 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}，已放弃写入`,
      };
    }
  } catch (err) {
    return { ok: false, error: `改完的 YAML 没通过整表校验，已放弃写入：${err?.message ?? err}` };
  }
  let mode;
  try {
    mode = fs.statSync(configFile).mode & 0o777;
  } catch {
    mode = undefined;
  }
  try {
    atomicWriteFile(configFile, next, mode === undefined ? {} : { mode });
  } catch (err) {
    return { ok: false, error: `写入 ${configFile} 失败：${err?.message ?? err}` };
  }
  return { ok: true, written: [configFile], section, key };
}

/** 当前参数快照（从运行时配置读，保证与插件实际在跑的值一致） */export function readParams(cfg) {
  const out = {};
  for (const [name, spec] of Object.entries(PARAM_SPECS)) {
    // 按 section 名直接取（monitor / scheduler / storage / agent）。
    // 其余一律落到 cfg.storage，于是 agent.* 两个新参数恒为 null、界面上读不到值。
    const scope = cfg?.[spec.section] ?? {};
    out[name] = spec.read ? spec.read(cfg) : (scope[spec.field] ?? null);
  }
  return out;
}

const iso = (ms) => (ms ? new Date(ms).toISOString() : '');

/** 令牌文件"看起来可用"：存在 + 能解析 + 有 refresh_token（截断/半截文件不能算已绑定） */
function tokenFileUsable(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Boolean(state && typeof state === 'object' && state.refresh_token);
  } catch {
    return false;
  }
}

/** 状态快照：设置页首屏就是这一份（不含任何凭据） */
export function statusSnapshot({ state, cfg, store, configFile = '', now = Date.now() }) {
  // 覆盖层里声明过、可在设置页编辑/删除的来源；base（cordis.patch.yml）里的只读
  const editable = (() => {
    try {
      return new Set(overlaySourceIds(cfg?.configFile || configFile, resolveDshHome()));
    } catch {
      return new Set();
    }
  })();
  const sources = (cfg?.sources ?? []).map((source) => {
    const cursorState = store?.sourceState?.(source.id) ?? {};
    let cursor = '';
    try {
      cursor = providerFor(source.type).describeCursor(cursorState);
    } catch {
      cursor = '未知协议';
    }
    const bound = ['gmail', 'graph', 'oauth2'].includes(String(source.type))
      ? Boolean(source.tokenFile && fs.existsSync(source.tokenFile) && tokenFileUsable(source.tokenFile))
      : true;
    return {
      id: source.id,
      name: source.name,
      type: source.type,
      typeLabel: sourceTypeLabel(source.type),
      cursor,
      detail: sourceDetail(source),
      editable: editable.has(source.id),
      canBind: source.type === 'gmail' || source.type === 'graph' || source.type === 'oauth2',
      bound,
      clientId: source.clientId ?? '',
      tenant: source.tenant ?? '',
      // 编辑表单回填用的非敏感字段（**不含** password / clientSecret）
      host: source.host ?? '',
      port: source.port ?? 0,
      secure: source.secure !== false,
      user: source.user ?? '',
      mailbox: source.mailboxRaw ?? '',
      folder: source.folderRaw ?? '',
      provider: source.provider ?? '',
      tokenFile: source.tokenFileRaw ?? '',
      clientSecretRef: source.clientSecretRef ?? '',
      passwordRef: source.passwordRef ?? '',
    };
  });

  let pending = [];
  try {
    pending = (store?.listArchived?.() ?? []).map((item) => {
      const dir = item.dir ?? item.file ?? '';
      // 结果判定收敛在 Store 里（与 adoptOrphans / 手动重试共用同一份逻辑）
      const verdict = store?.conclusionState?.(dir) ?? { outcome: 'pending', error: '' };
      return {
        dir,
        name: item.name ?? '',
        subject: item.subject ?? '',
        from: item.from ?? '',
        date: item.date ?? '',
        day: dayOf(item.date),
        source: item.source ?? '',
        hasConclusion: verdict.outcome !== 'pending',
        /** 'ok' 已处理 ／ 'failed' 处理失败 ／ 'pending' 还没跑 */
        outcome: verdict.outcome,
        error: verdict.outcome === 'failed' ? verdict.error : '',
      };
    });
  } catch {
    pending = [];
  }

  /*
   * 定时任务快照：每条任务的排期描述、下次时间、上次运行结果与**提示词正文**。
   * 提示词直接下发（readPrompts 同样如此）——设置页要在同一个表单里编辑它；
   * 任务提示词不是凭据，没有"不下发"的理由。
   */
  const scheduleRows = (cfg?.schedules ?? []).map((task) => {
    const run = store?.state?.scheduleRuns?.[task.id] ?? {};
    let planRun = run;
    if (task.schedule?.type === 'interval' && !run.lastRunAtMs && !run.lastRunAt) {
      const anchor = state?.intervalAnchors?.get?.(task.id);
      if (anchor) planRun = { ...run, lastRunAtMs: anchor };
    }
    const plan = task.enabled === false ? { at: 0, done: true } : planNextRun(task, planRun, now);
    const deferred = task.schedule?.type === 'startup' && Boolean(state?.startupDeferred?.has?.(task.id));
    const pendingRetry = state?.schedulePending?.get?.(task.id) ?? null;
    const manualAtMs = Number(run.lastManualAtMs) || Date.parse(run.lastManualAt || '') || 0;
    const autoAtMs = Number(run.lastRunAtMs) || Date.parse(run.lastRunAt || '') || 0;
    const manualNewer = manualAtMs > autoAtMs;
    const displayAtMs = manualNewer ? manualAtMs : autoAtMs;
    const displayAt = manualNewer ? (run.lastManualAt ?? '') : (run.lastRunAt ?? '');
    const displayStatus = manualNewer ? (run.lastManualStatus ?? '') : (run.lastStatus ?? '');
    const displayError = manualNewer ? (run.lastManualError ?? '') : (run.lastError ?? '');
    const displayCount = manualNewer ? (run.lastManualCount ?? 0) : (run.lastCount ?? 0);
    let prompt = task.prompt || '';
    if (task.promptFile) {
      try {
        prompt = fs.readFileSync(task.promptFile, 'utf8');
      } catch {
        // 文件暂时读不到：退回内联（保存时仍写回同一个路径）
      }
    }
    return {
      id: task.id,
      name: task.name,
      enabled: task.enabled !== false,
      schedule: task.schedule,
      description: describeSchedule(task.schedule),
      deferred,
      nextAt: plan.done || deferred ? 0 : plan.at,
      nextAtIso: iso(plan.done || deferred ? 0 : plan.at),
      lastRunAt: displayAt,
      lastRunAtMs: displayAtMs,
      lastStatus: displayStatus,
      lastError: displayError,
      lastFile: manualNewer ? '' : (run.lastFile ?? ''),
      lastCount: displayCount,
      // 到点撞上轮询/处理时的内存退避：前端用它显示“n 秒后重试”
      retryAt: Number(pendingRetry?.at) || 0,
      retryAttempt: Number(pendingRetry?.attempt) || 0,
      prompt,
      // 只下发用户写的原文：回写绝对路径会把本机路径固化进 YAML（G3）
      prompt_file: task.promptFileRaw || '',
      has_prompt_file: Boolean(task.promptFile),
      source: task.source ?? 'explicit',
    };
  });
  const nextSchedule = scheduleRows
    .filter((row) => row.enabled && row.nextAt > 0)
    .sort((a, b) => a.nextAt - b.nextAt)[0];

  return {
    ok: true,
    now,
    status: {
      disposed: Boolean(state?.disposed),
      booting: Boolean(state?.booting),
      baselined: Boolean(state?.baselined),
      running: Boolean(state?.running),
      /** 'polling' | 'processing' | 'task' | ''（空闲）：界面据此区分"正在拉取/处理/跑任务" */
      activity: state?.activity ?? '',
      /** 当前正交给 agent 的那封存档目录（列表里显示"处理中"） */
      processingDir: state?.processingDir ?? '',
      lastTickAt: state?.lastTickAt ?? 0,
      lastTickAtIso: iso(state?.lastTickAt),
      lastError: state?.lastError ?? '',
      /** 配置还没完成（例如一个邮箱都没有）：不是错误，UI 显示引导而不是红色报错 */
      setupRequired: Boolean(state?.setupRequired),
      /** 上次失败的时刻（整轮成功后清 0）：设置页据此显示"上次轮询失败" */
      lastErrorAt: state?.lastErrorAt ?? 0,
      lastErrorAtIso: iso(state?.lastErrorAt),
      /** 最近一条要触发的任务（设置页「下次定时任务」） */
      nextScheduleAt: nextSchedule?.nextAt ?? 0,
      nextScheduleAtIso: iso(nextSchedule?.nextAt ?? 0),
      nextScheduleTask: nextSchedule?.name ?? '',
      schedulesArmed: Boolean(state?.schedulesArmed),
      backend: store?.backend ?? 'unknown',
      configFile: cfg?.configFile || configFile || '',
      archiveDir: cfg?.storage?.archiveDir ?? '',
    },
    sources,
    /** 定时任务（提示词、排期、上次运行/错误、下次时间） */
    schedules: scheduleRows,
    pending: { count: pending.length, items: pending.slice(0, 100) },
    params: readParams(cfg ?? {}),
    prompts: readPrompts(cfg ?? {}),
    /**
     * 可选项目录（给前端渲染"模型 / 思考强度 / 工具集"三组控件）。
     * 模型目录要现读宿主服务、可能为空——所以它是**可选**字段，前端拿不到就退化成手填。
     */
    catalog: {
      tools: MAIL_TOOL_CATALOG.map((entry) => ({ id: entry.id, label: entry.label, hint: entry.hint ?? '' })),
      efforts: ['inherit', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      aliases: MAIL_TOOL_ALIASES,
      builtins: BUILTIN_MAIL_TOOLS,
      /** 新增协议后 UI 不再写死"只有 IMAP/Graph"：下拉直接用这份目录 */
      sourceTypes: SOURCE_TYPES.map((type) => ({ type, label: SOURCE_TYPE_LABELS[type] ?? type })),
    },
    /** QQ 绑定状态（appId/openid 不是秘密；secret 永远不出现在快照里） */
    qq: {
      enabled: cfg?.qq?.enabled !== false,
      appId: cfg?.qq?.appId ?? '',
      openid: cfg?.qq?.openid ?? '',
      markdown: cfg?.qq?.markdown !== false,
      bound: Boolean(String(cfg?.qq?.appId ?? '').trim() && String(cfg?.qq?.openid ?? '').trim()),
    },
    /** 邮件预设的注册状态：勾了工具却注册失败时，用户要能在概览页看见（否则只剩一行日志） */
    preset: {
      id: MAIL_PRESET_ID,
      registered: Boolean(state?.presetDispose),
      error: state?.presetError ?? '',
      tools: Array.isArray(cfg?.agent?.tools) ? cfg.agent.tools : [],
    },
  };
}

function sendJson(res, status, data) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/** POST 请求体上限：三份提示词实测量级 ~9 KB，64 KiB 留足余量 */
export const MAX_BODY_BYTES = 64 * 1024;

/** 真实 content-type 是不是 application/json（允许 `; charset=utf-8`） */
export function isJsonContentType(headers) {
  const raw = headers?.['content-type'];
  const essence = typeof raw === 'string' ? String(raw).split(';', 1)[0].trim().toLowerCase() : '';
  return essence === 'application/json';
}

/** 手写同源检查（只在宿主没有 connection 服务时作为唯一防线） */
function sameOriginRequest(req) {
  if (String(req?.headers?.['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return false;
  const origin = req?.headers?.origin;
  if (!origin) return true;
  try {
    return new URL(String(origin)).host === String(req?.headers?.host ?? '');
  } catch {
    return false;
  }
}

/**
 * 请求鉴权：走宿主 `ctx.connection.requestRejection()`（Host/Origin 栅栏 + 浏览器会话 cookie）。
 *
 * 为什么必须走这条缝（S2）：`webServer.register()` 出来的具名路由**不在** Connection 的
 * 保护范围内，`node:http` 载体本身"owns no authentication or Origin policy"。
 * 手写的 `Origin === Host` 挡不住 DNS rebinding（两者会一起变成攻击者域），缺 Origin 时还直接放行。
 *
 * 三条降级规则：
 *   1. 组合里**没有** connection 服务（CLI/headless）→ 退回同源检查并只 WARN 一次；
 *   2. 缝存在但抛错 → **fail closed**（403）：控制面故障不能静默变成"无鉴权"；
 *   3. 返回形状不认识（非 401/403/undefined）→ 也 403。
 *
 * 不能把 `connection` 写进 `inject`：那会让没有该服务的组合永久停在 PENDING，
 * `apply()` 根本不执行（插件"装了但什么都没有"）。所以每请求现取、用 `ctx.get`。
 */
export function createRequestAuthorizer(ctx, logger) {
  let warned = false;
  const warnOnce = (message) => {
    if (warned) return;
    warned = true;
    logger?.warn?.(`[mail-automation] ${message}`);
  };
  return function authorize(req) {
    const connection = (() => {
      try {
        const value = ctx?.get?.('connection');
        return typeof value?.requestRejection === 'function' ? value : undefined;
      } catch {
        return undefined;
      }
    })();

    if (!connection) {
      warnOnce('宿主没有 connection 服务：设置页路由退化为仅同源检查（浏览器会话鉴权缺失）');
      return sameOriginRequest(req) ? undefined : { status: 403, code: 'forbidden', error: '跨站请求被拒绝（Origin 与 Host 不一致）' };
    }

    let verdict;
    try {
      verdict = connection.requestRejection(req);
    } catch (err) {
      warnOnce(`connection.requestRejection 抛错，按拒绝处理：${err?.message ?? err}`);
      return { status: 403, code: 'forbidden', error: '请求鉴权失败（宿主鉴权服务异常）' };
    }
    if (verdict === undefined || verdict === null || verdict === false || verdict === 0) return undefined;
    const status = Number(verdict) === 401 ? 401 : 403;
    return {
      status,
      code: status === 401 ? 'unauthenticated' : 'forbidden',
      error:
        status === 401
          ? '未通过浏览器会话认证：请重新打开 dsh 打印的带 token 地址'
          : '请求来源不被信任（Host/Origin 或凭据校验未通过）',
    };
  };
}

/**
 * 读请求体（带上限）。超限时先 `resume()` 排空再让调用方回 413：
 * 直接 destroy 的话客户端只会看到 `ERR_CONNECTION_RESET`，分不清"太大"还是"服务挂了"。
 */
export function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try {
        req.resume();
      } catch {
        // 已经结束
      }
      reject(err);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      if (size > limit) {
        const err = new Error(`请求体超过 ${limit} 字节上限`);
        err.status = 413;
        fail(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text.trim() ? JSON.parse(text) : {});
      } catch (err) {
        const bad = new Error(`请求体不是合法 JSON：${err?.message ?? err}`);
        bad.status = 400;
        reject(bad);
      }
    });
    req.on('error', fail);
  });
}

/**
 * 注册设置页的数据通道。返回 disposer（由调用方的 effect 负责撤销）。
 *
 * `deps` 里都是 getter：配置/状态/存储会被热替换（YAML 改完即生效），
 * 路由闭包里每次请求都取最新的一份。
 */
export function registerUiRoute(ctx, deps) {
  const {
    getState, getConfig, getStore, refresh, retryFailed, deleteMail, retryPoll, saveParams: saveParamsOp, listModels, logger,
    saveSchedules, runTask,
    saveSource, deleteSource, verifySource,
    startMailBind, pollBind, completeBind, cancelBind,
    startQqBind, pollQqBind, cancelQqBind, saveSecret,
  } = deps;

  const snapshot = () => statusSnapshot({ state: getState(), cfg: getConfig(), store: getStore() });

  /** 模型目录是异步的：GET 时现取，拿不到就给 null（前端退化成手填，不影响保存）。 */
  const modelsOf = async () => {
    if (typeof listModels !== 'function') return null;
    try {
      return await listModels();
    } catch {
      return null;
    }
  };

  const authorize = createRequestAuthorizer(ctx, logger);

  const handler = async (req, res) => {
    const method = String(req.method ?? 'GET').toUpperCase();
    try {
      /*
       * 鉴权放在最前，且 GET / POST / 405 都要过：
       * 未鉴权的请求连磁盘都不该碰 —— snapshot() 会同步读三份提示词、扫 archive。
       */
      const rejection = authorize(req);
      if (rejection) {
        sendJson(res, rejection.status, { ok: false, code: rejection.code, error: rejection.error });
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, { ...snapshot(), models: await modelsOf() });
        return;
      }
      if (method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
        return;
      }
      // 第二道：只接受 JSON 请求体（client.js 已显式带这个头；手写 curl 要跟进）
      if (!isJsonContentType(req.headers)) {
        sendJson(res, 415, { ok: false, code: 'unsupported-media-type', error: 'content-type 必须是 application/json' });
        return;
      }
      let body;
      try {
        body = await readBody(req);
      } catch (err) {
        const status = Number(err?.status) === 413 ? 413 : 400;
        sendJson(res, status, {
          ok: false,
          code: status === 413 ? 'payload-too-large' : 'bad-request',
          error: err?.message ?? String(err),
        });
        return;
      }
      const action = String(body?.action ?? '');
      if (action === 'save-params') {
        // 优先用宿主传进来的保存操作：它在成功后还要重建 runner（静默/工作区改动立刻生效），
        // 只调本模块的 saveParams() 会漏掉那一步。
        const result = typeof saveParamsOp === 'function'
          ? saveParamsOp(body.params)
          : saveParams({ configFile: getConfig()?.configFile, params: body.params, base: getConfig() ?? {} });
        if (!result.ok) {
          sendJson(res, 400, result);
          return;
        }
        // 参数要立刻生效：重读配置（下一次心跳/轮询都会用新值）
        try {
          refresh?.();
        } catch (err) {
          logger?.warn?.(`[mail-automation] 设置页保存参数后重载配置失败：${err?.message ?? err}`);
        }
        logger?.info?.(`[mail-automation] 设置页更新参数：${result.changes.map((c) => `${c.name}=${c.value}`).join('、')}`);
        sendJson(res, 200, { ok: true, changes: result.changes, ...snapshot() });
        return;
      }
      if (action === 'save-prompts') {
        const result = savePrompts(getConfig(), body.prompts);
        if (!result.ok) {
          sendJson(res, 400, result);
          return;
        }
        logger?.info?.(`[mail-automation] 设置页更新提示词：${result.written.map((f) => path.basename(f)).join('、')}`);
        sendJson(res, 200, { ok: true, written: result.written, ...snapshot() });
        return;
      }
      if (action === 'retry-poll') {
        // 与 `mail_automation_config` 的 retry_poll 同一个操作（会顺手解开卡住的那一轮）
        if (typeof retryPoll !== 'function') {
          sendJson(res, 400, { ok: false, error: '轮询操作不可用（插件未成功装配）' });
          return;
        }
        const result = await retryPoll();
        if (!result.ok) {
          sendJson(res, 409, { ok: false, error: result.error, ...snapshot() });
          return;
        }
        sendJson(res, 200, { ok: true, text: result.text ?? '', ...snapshot() });
        return;
      }
      if (action === 'retry-failed') {
        // 与 `mail_automation_config` 的 retry_failed 同一个操作
        if (typeof retryFailed !== 'function') {
          sendJson(res, 400, { ok: false, error: '重试操作不可用（插件未成功装配）' });
          return;
        }
        const result = await retryFailed();
        if (!result.ok) {
          sendJson(res, 400, result);
          return;
        }
        sendJson(res, 200, { ok: true, queued: result.count, ...snapshot() });
        return;
      }
      if (action === 'delete-mail') {
        if (typeof deleteMail !== 'function') {
          sendJson(res, 400, { ok: false, error: '删除存档操作不可用（插件未成功装配）' });
          return;
        }
        const id = String(body?.id ?? body?.ids?.[0] ?? '').trim();
        if (!id) {
          sendJson(res, 400, { ok: false, error: '缺少要删除的存档 id' });
          return;
        }
        const result = await deleteMail(id);
        if (!result.ok) {
          sendJson(res, 400, result);
          return;
        }
        sendJson(res, 200, { ok: true, removed: result.removed ?? 0, id, ...snapshot() });
        return;
      }
      if (action === 'save-schedules') {
        if (typeof saveSchedules !== 'function') {
          sendJson(res, 400, { ok: false, error: '定时任务管理不可用（插件未成功装配）' });
          return;
        }
        const result = await saveSchedules(body?.schedules, body?.editedId);
        if (!result.ok) {
          sendJson(res, 400, result);
          return;
        }
        sendJson(res, 200, { ok: true, ...result, ...snapshot() });
        return;
      }
      if (action === 'run-task') {
        if (typeof runTask !== 'function') {
          sendJson(res, 400, { ok: false, error: '定时任务执行不可用（插件未成功装配）' });
          return;
        }
        const result = await runTask(String(body?.id ?? ''));
        if (!result.ok && result.unavailable) {
          sendJson(res, 400, { ok: false, error: result.error });
          return;
        }
        if (result.busy) {
          sendJson(res, 409, { ok: false, error: result.error, ...snapshot() });
          return;
        }
        sendJson(res, 200, {
          ...snapshot(),
          ok: Boolean(result.ok),
          error: result.error ?? '',
          text: `「${result.name}」${result.ok ? '完成' : '失败'}` +
            `${result.count !== undefined ? `：${result.count} 封` : ''}${result.removed ? `，清理 ${result.removed} 封` : ''}` +
            `${result.error ? `（${result.error}）` : ''}`,
          count: result.count ?? 0,
          removed: result.removed ?? 0,
          file: result.file ?? '',
        });
        return;
      }
      if (action === 'save-source') {
        if (typeof saveSource !== 'function') {
          sendJson(res, 400, { ok: false, error: '来源管理不可用（插件未成功装配）' });
          return;
        }
        const result = await saveSource(body ?? {});
        if (!result.ok) {
          sendJson(res, 400, { ok: false, error: result.error });
          return;
        }
        sendJson(res, 200, { ...result, ...snapshot() });
        return;
      }
      if (action === 'delete-source') {
        if (typeof deleteSource !== 'function') {
          sendJson(res, 400, { ok: false, error: '来源管理不可用（插件未成功装配）' });
          return;
        }
        const result = await deleteSource({ id: body?.id, deleteArchives: body?.deleteArchives === true });
        if (!result.ok) {
          sendJson(res, 400, { ok: false, error: result.error });
          return;
        }
        sendJson(res, 200, { ...result, ...snapshot() });
        return;
      }
      if (action === 'verify-source') {
        if (typeof verifySource !== 'function') {
          sendJson(res, 400, { ok: false, error: '来源自检不可用（插件未成功装配）' });
          return;
        }
        const result = await verifySource(String(body?.id ?? ''));
        // 顺序很重要：快照自带 `ok:true`，失败时必须让 result 的 ok/error 覆盖它
        sendJson(res, result.ok ? 200 : 400, { ...snapshot(), ...result });
        return;
      }
      if (action === 'mail-bind-start') {
        if (typeof startMailBind !== 'function') {
          sendJson(res, 400, { ok: false, error: '绑定不可用（插件未成功装配）' });
          return;
        }
        const result = await startMailBind(String(body?.sourceId ?? ''));
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }
      if (action === 'mail-bind-poll') {
        if (typeof pollBind !== 'function') {
          sendJson(res, 400, { ok: false, error: '绑定不可用（插件未成功装配）' });
          return;
        }
        const result = await pollBind(String(body?.id ?? ''));
        sendJson(res, result.ok ? 200 : 400, result.ok ? { ...result, ...snapshot() } : result);
        return;
      }
      if (action === 'mail-bind-complete') {
        if (typeof completeBind !== 'function') {
          sendJson(res, 400, { ok: false, error: '绑定不可用（插件未成功装配）' });
          return;
        }
        const result = await completeBind(String(body?.id ?? ''), String(body?.code ?? ''));
        sendJson(res, result.ok ? 200 : 400, result.ok ? { ...result, ...snapshot() } : result);
        return;
      }
      if (action === 'mail-bind-cancel') {
        if (typeof cancelBind !== 'function') {
          sendJson(res, 400, { ok: false, error: '绑定不可用（插件未成功装配）' });
          return;
        }
        // cancelBind 返回 {ok,bind}：这里展开成顶层形状（早期实现嵌套成 {ok:true,bind:{ok:true,bind}}）
        const result = cancelBind(String(body?.id ?? ''));
        sendJson(res, result.ok ? 200 : 400, { ok: result.ok, bind: result.bind, error: result.error });
        return;
      }
      if (action === 'qq-bind-start') {
        if (typeof startQqBind !== 'function') {
          sendJson(res, 400, { ok: false, error: 'QQ 绑定不可用（插件未成功装配）' });
          return;
        }
        const result = await startQqBind();
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }
      if (action === 'qq-bind-poll') {
        if (typeof pollQqBind !== 'function') {
          sendJson(res, 400, { ok: false, error: 'QQ 绑定不可用（插件未成功装配）' });
          return;
        }
        const result = await pollQqBind(String(body?.id ?? ''));
        // 失败可能是"部分成功"（appId/openid 已写）：把快照一起回，UI 才能显示真实状态
        sendJson(res, result.ok ? 200 : 400, { ...snapshot(), ...result });
        return;
      }
      if (action === 'qq-bind-cancel') {
        if (typeof cancelQqBind !== 'function') {
          sendJson(res, 400, { ok: false, error: 'QQ 绑定不可用（插件未成功装配）' });
          return;
        }
        const result = cancelQqBind(String(body?.id ?? ''));
        sendJson(res, result.ok ? 200 : 400, { ok: result.ok, bind: result.bind, error: result.error });
        return;
      }
      if (action === 'save-secret') {
        if (typeof saveSecret !== 'function') {
          sendJson(res, 400, { ok: false, error: '凭据写入不可用（插件未成功装配）' });
          return;
        }
        const result = await saveSecret(String(body?.ref ?? ''), String(body?.value ?? ''));
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }
      sendJson(res, 400, { ok: false, error: `不认识的操作：${action || '(空)'}` });
    } catch (err) {
      logger?.warn?.(`[mail-automation] 设置页请求失败：${err?.message ?? err}`);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
    }
  };

  let unregister;
  let warnedMissingApi = false;
  const register = (server) => {
    /*
     * U3：宿主对重复 `(kind,path)` 是**故意抛错**的（组合错误）。但这条注册跑在
     * `ctx.effect` 里：同步抛错会中止 apply 并撤销该 fiber 的**全部** effect ——
     * 心跳、定时器、工具都要跟着没，邮件助理直接停。设置页是次要面，绝不能拖死主功能。
     * 所以在这里吞掉：重复注册降级成 WARN，其它注册错误记 ERROR，都不 rethrow。
     */
    if (typeof server?.register !== 'function') {
      if (!warnedMissingApi) {
        warnedMissingApi = true;
        logger?.warn?.('[mail-automation] 宿主没有可用的 webServer.register()：设置页路由未注册（邮件处理不受影响）');
      }
      return;
    }
    try {
      unregister = server.register({ kind: 'exact', path: UI_ROUTE_PATH, handler });
    } catch (err) {
      const message = String(err?.message ?? err);
      if (/duplicate|already|conflict|exists/i.test(message)) {
        logger?.warn?.(
          `[mail-automation] 设置页路由 ${UI_ROUTE_PATH} 已被占用，本实例跳过注册（页面由占用者提供；` +
            `另一个 DSH 实例可能没卸干净）：${message}`,
        );
      } else {
        logger?.error?.(`[mail-automation] 设置页路由注册失败，设置页将不可用（邮件处理继续）：${message}`);
      }
      unregister = undefined; // 只有注册成功才有 disposer，绝不删别人的路由
    }
  };

  // webServer 可能比插件晚到：先直接取，取不到就用 ctx.inject 等它就绪
  const direct = (() => {
    try {
      return ctx.get?.('webServer');
    } catch {
      return undefined;
    }
  })();
  if (direct) {
    register(direct);
    return () => {
      try {
        unregister?.();
      } catch {
        // ignore
      }
    };
  }
  const disposeInject = ctx.inject?.(['webServer'], (subCtx) => {
    const server = subCtx?.webServer ?? ctx.get?.('webServer');
    register(server);
  });
  if (!disposeInject) {
    // 既没有现成的 webServer，也没法等它：路由永远不会出现，至少留一条日志（U3）
    logger?.warn?.('[mail-automation] 宿主没有 webServer 也没有 ctx.inject：设置页路由无法注册（邮件处理不受影响）');
  }
  return () => {
    try {
      disposeInject?.();
    } catch {
      // ignore
    }
    try {
      unregister?.();
    } catch {
      // ignore
    }
  };
}
