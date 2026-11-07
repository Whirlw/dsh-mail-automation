/**
 * 会话体积预算与 billion-context 折叠状态检查（纯函数 + 可注入 IO，便于离线单测）。
 *
 * 为什么要有这个文件 —— 2026-11-07 的一次真实事故：
 *
 * 用户开着 billion-context（下称 bili）做上下文折叠。bili 的车道身份是
 * **`会话 id + system prompt 的 sha256 前 16 位`**（`resolveSessionOrder(rawId, history,
 * personaTag, …)`，`personaTag` 就是整段 system prompt 文本；provider/model 不参与）。
 * 同一个会话的 system prompt 一变（装/卸插件、工具集变化、bili 自己注入的说明），它就开一条
 * `…|sub:<fp>` 的新车道；新车道**不继承原车道的折叠块**。偏偏那次 `reanchor` 的所有启发式
 * 都没命中（`[resume-inheritance] miss: no byte-exact resume among 23 eligible chain(s)`），
 * 结果 31k 条消息 / 19.5 MB 原文进了零折叠车道，撞上 bili 的 egress fuse，413 且无法自愈
 * （详见 docs/lessons.md 的 2026-11-07 条目）。
 *
 * 插件侧能做的两件事，都在这里：
 *
 * 1. **给会话设体积上限**：任何单个会话（父会话 / 每日会话）的累计事件字节超过预算就换代。
 *    这样即使外部折叠失效，送出去的载荷也不会无界增长——bili 的闸门是「窗口 × 7.5 B/token」，
 *    8 MB 的会话仍在安全区，而且换代本身能自愈（新会话从 0 开始）。
 * 2. **提醒 bili 没开自动折叠**：`compress.externalSummary.enabled + autoFold` 关着时，
 *    请求一旦注定超窗，bili 会 fail-fast 直接 413，而不是先折叠再送。装上但没武装，
 *    是那次事故里真正致命的一环。检出 bili 才提示，不打扰没装的人。
 *
 * 这里的常量**刻意与 bili 的实现对齐**（`DOOMED_PROBE_BYTES_PER_TOKEN = 7.5`、
 * 兜底窗口 792,576 tokens），但插件不依赖 bili：没有 bili 时这些数字只是「别把会话养到
 * 荒谬大小」的保守建议。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 与 bili 的 `DOOMED_PROBE_BYTES_PER_TOKEN` 同源：每 token 最多按 7.5 字节估。 */
export const BYTES_PER_TOKEN = 7.5;

/**
 * 模型声称的窗口未知时的兜底窗口（token）。
 * 与 bili 的 `MIN_ASSUMED_WINDOW_TOKENS` 取值相同：宁可保守，也不要按"大窗口"估。
 */
export const MIN_ASSUMED_WINDOW_TOKENS = 792_576;

/** 单个会话的默认字节预算（MB）。8 MB ≈ 100 万 token 的原文，远超任何一次有用请求。 */
export const DEFAULT_SESSION_BUDGET_MB = 8;

/** 换算成「窗口 × 7.5 B/token」的安全阈值（字节）；窗口未知时用兜底窗口。 */
export function windowSafeBytes(windowTokens) {
  const tokens = Number(windowTokens);
  const window = Number.isFinite(tokens) && tokens > 0 ? tokens : MIN_ASSUMED_WINDOW_TOKENS;
  return Math.floor(window * BYTES_PER_TOKEN);
}

/** UTF-8 字节数；非字符串一律 0（不猜） */
export function utf8Bytes(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return Buffer.byteLength(text, 'utf8');
}

/** 单条会话事件的近似字节数：不能 JSON 序列化的算 0 */
export function eventBytes(event) {
  if (event === undefined || event === null) return 0;
  try {
    return utf8Bytes(JSON.stringify(event));
  } catch {
    return 0;
  }
}

/**
 * 一组会话事件的（条数, 近似字节数）。
 *
 * 用 `JSON.stringify` 而不是精确的内存测量：这里只关心量级，而事件里最大的部分是
 * 文本/工具输出，序列化长度与真正送出去的载荷同阶。逐条序列化意味着不构造一个巨大的
 * 中间字符串（`snapshotEvents()` 本身已经是数组了）。
 */
export function sessionFootprint(events) {
  const list = Array.isArray(events) ? events : [];
  let bytes = 0;
  for (const event of list) bytes += eventBytes(event);
  return { count: list.length, bytes };
}

/** 人类可读的体量描述（日志用） */
export function describeFootprint(footprint) {
  const bytes = Number(footprint?.bytes) || 0;
  const count = Number(footprint?.count) || 0;
  const mb = bytes / (1024 * 1024);
  const size = mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${count.toLocaleString('en-US')} 条事件 / ${size}`;
}

/**
 * 会话是否超预算。
 *
 * `maxBytes <= 0` 表示**关掉**（用户显式设 0）：仍然返回测得的量，但 `over` 恒为 false，
 * 便于日志照常打印体量而不触发换代。
 */
export function evaluateSessionBudget(footprint, { maxBytes = 0 } = {}) {
  const bytes = Number(footprint?.bytes) || 0;
  const count = Number(footprint?.count) || 0;
  const limit = Number(maxBytes) > 0 ? Number(maxBytes) : 0;
  return { count, bytes, limit, over: limit > 0 && bytes > limit };
}

/** 单条提示词是否超预算（发出去之前拦，避免"注定 413 的请求"） */
export function evaluatePromptBudget(prompt, { maxBytes = 0 } = {}) {
  const bytes = utf8Bytes(prompt);
  const limit = Number(maxBytes) > 0 ? Number(maxBytes) : 0;
  return { bytes, limit, over: limit > 0 && bytes > limit };
}

/**
 * 本机是否装着 billion-context：只看数据目录，不执行它、不读它的库。
 *
 * 路径按 bili 的 `src/paths.ts`：data 在 `~/.local/share/billion-context/sessions`，
 * config 在 `~/.config/billion-context/`。两个都试，任一存在即算在场
 * （Windows 上 bili 也落在这两个相对位置，所以不用分平台）。
 */
export function detectBillionContext({ homedir = os.homedir(), existsSync = fs.existsSync } = {}) {
  const home = String(homedir ?? '');
  if (!home) return false;
  const candidates = [
    path.join(home, '.local', 'share', 'billion-context', 'sessions'),
    path.join(home, '.config', 'billion-context'),
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return true;
    } catch {
      // 探测失败就当没装：这只是提示，不能因此打扰启动
    }
  }
  return false;
}

/**
 * 读本机 bili 的配置（只读；读不到/解析失败一律 `undefined`）。
 *
 * 只取 `compress.externalSummary` 用的那几个键，别的字段一概不碰——这是别人的配置文件，
 * 插件的立场是"看得懂就提示一句，看不懂就当没装"。
 */
export function readBillionContextConfig({ homedir = os.homedir(), readFileSync = fs.readFileSync } = {}) {
  const home = String(homedir ?? '');
  if (!home) return undefined;
  const file = path.join(home, '.config', 'billion-context', 'billion-context.json');
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 「bili 装了，但折叠没武装」——它会不会在超窗时先折叠、而不是直接 413。
 *
 * bili 的 `growthFoldingArmed()` 要求 `externalSummary.enabled === true && autoFold === true`
 * 且至少一个 target；不满足时请求走 fail-fast 分支，`413 egress_window_fuse` 之后没有自愈动作。
 * 这正是 2026-11-07 那次事故无法恢复的原因，所以值得在启动时提一句。
 *
 * 没有 bili 时永远不提示（`needed: false`）：这个风险只对它成立。
 */
export function billionContextFoldVerdict({ biliPresent = false, config } = {}) {
  if (!biliPresent) return { needed: false, reason: '' };
  const externalSummary = config?.compress?.externalSummary;
  const armed =
    externalSummary?.enabled === true &&
    externalSummary?.autoFold === true &&
    Array.isArray(externalSummary?.targets) &&
    externalSummary.targets.length > 0;
  if (armed) return { needed: false, reason: '' };
  return {
    needed: true,
    reason:
      '本机装着 billion-context，但它没开自动折叠（compress.externalSummary.enabled + autoFold + targets）：' +
      '它的车道身份是「会话 id + system prompt 哈希」，system prompt 一变就会开一条零折叠的新车道；' +
      '没开 autoFold 时，超窗请求会被直接判 413 而不是先折叠。' +
      '注意给某个 agent 换 provider/key 不会改变这条身份（provider 不参与哈希），只能分隔配额。',
  };
}
