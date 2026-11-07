/**
 * dsh-mail-automation 插件入口。
 *
 * 装配顺序（对齐 dsh-plugin-guide §3.3 / §3.3.1）：
 *   apply() 是**同步函数**：先把所有 effect / 监听 / 定时器建立起来，再做异步引导。
 *   - 异步注册（工具要等宿主模块 import 完）用 `registerAsync()` 包一层 effect：
 *     注册动作在 effect 内完成、disposer 由该 effect 负责，卸载窗口内也不会漏。
 *   - 异步引导（凭据 / 配置 / 基线 / 总览排期）放在 bootstrap() 里，失败只写日志。
 *
 * 其余流程：
 *   1. 读配置（Schemastery 配置 + 可选 YAML 覆盖层，每轮重读；凭据每轮重新解析）
 *   2. 注册 agent 工具 + 四个 skill
 *   3. 启动时对每个邮箱取前 N 条邮件头 → 记基线（不算新邮件），并补处理关着时到的邮件
 *   4. 心跳循环：按 poll_seconds 轮询；有新邮件就 存档 → 交给 agent 按提示词处理
 *   5. 按 schedules 跑定时任务（默认「总览」任务；每条一个 agent 回合，QQ 由 agent 自己发）
 *
 * 所有失败都只写日志，绝不把异常抛回宿主（不能因为邮箱挂了把 DSH 弄崩）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { loadConfig, loadMailPrompt, fillTemplate, resolveDshHome, resolveProfileDir, unwrapVolatile, ensureDefaultPromptFiles, ensureFirstInstallConfig } from './config.js';
import { schemaSource } from './schema.js';
import { resolveSourceSecretsDetailed, isFallbackLayer, resolveSecret } from './credentials.js';
import { Store, archiveFile, readMeta } from './store.js';
import { openStateDomain } from './state-domain.js';
import { MailAgentRunner } from './agent.js';
import { QQNotifier } from './notify.js';
import { registerTools } from './tools.js';
import { buildAgentTaskPrompt } from './digest.js';
import {
  planNextRun,
  planBusyRetry,
  describeSchedule,
} from './schedule.js';
import { renderHtmlPreview, createProcessRunner } from './render.js';
import { buildMailPreset, mailPresetSignature, MAIL_PRESET_ID } from './preset.js';
import { loadHost } from './host.js';
import { detectBillionContext, billionContextFoldVerdict, readBillionContextConfig } from './budget.js';
import { registerUiRoute, statusSnapshot, saveParams, savePrompts, writeConfigScalar } from './uiapi.js';
import * as mailSources from './sources/index.js';
import * as oauth2Source from './sources/oauth2.js';
import * as bind from './bind.js';
import { upsertSource, removeSource } from './sources-config.js';
import { saveSchedules as saveSchedulesConfig } from './schedules-config.js';
import { clearArchives } from './archiveadmin.js';
import { qrDataUrl } from './qr.js';

export { Config } from './schema.js';
export const name = 'mail-automation';
/**
 * 只声明真正必需的服务。
 *
 * `timer` **不进 inject**：它唯一的用途是提供 `ctx.interval`（一个随 fiber 自动销毁的
 * 定时器），而声明成硬依赖的代价是——没有 timer 提供方的组合里 fiber 会永久停在
 * PENDING，`apply()` 根本不执行，`dsh web` 下这个失败又没有日志 sink
 * （guide/unfixed-issues.md T3、cordis-tutorial 06 的同一陷阱），最终表现成
 * 「插件装了、日志全绿、能力一个都没有」。心跳自带 setInterval 兜底，见下面第 2 个 effect。
 */
export const inject = ['tools'];

const PLUGIN_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
/** 日志轮转阈值的兜底值；真正的值来自配置 `storage.logMaxBytes` */
const DEFAULT_MAX_LOG_BYTES = 2 * 1024 * 1024;
/**
 * 插件自带的 skill（目录名 = skill 名）：
 *   qq-notify    —— 什么时候该给我发 QQ、怎么发
 *   mail-automation-archive —— 怎么用 mail_automation_archive_read 读本地存档（正文 / HTML / 预览图 / 原始报文 / 结论）
 *
 * 这里的 `description` 只是**兜底**：真正的描述优先取 SKILL.md 的 frontmatter。
 * 原因见 dsh-plugin-guide §4.9 要点 1——description 是"什么时候该用这个技能"的触发器，
 * 宿主只把 name + description 放进目录给模型挑，写错了技能就不容易被选中。
 */
const SKILLS = [
  { name: 'qq-notify', description: '通过 QQ 官方机器人给用户发主动消息（邮件助理插件提供；紧急邮件提醒用 qq_notify 工具）' },
  {
    name: 'mail-automation-archive',
    description:
      '读邮件助理的本地存档（只在本地，不碰邮箱）：用 mail_automation_archive_read 按 part 取正文 text / HTML / 预览图 image / 原始报文 raw / 处理结论 conclusion / 元数据 meta。',
  },
  {
    name: 'mail-automation-archive-batch',
    description:
      '批量读本地邮件存档：用 mail_automation_archive_list 一次拿到全部（或指定 id 的）存档 id，并把标题/时间/发件人/收件人/conclusion.md 按需附在同一行。',
  },
  {
    name: 'mail-automation-archive-clear',
    description:
      '清理本地邮件存档：用 mail_automation_archive_clear 一次清空全部存档，或按 id 列表删除指定邮件；破坏性操作，只在发送成功后或用户明确要求时使用。',
  },
];

/** 安全调用 disposer（DSH 的 register() 返回 disposer，也可能返回 undefined） */
function safeDispose(disposer) {
  try {
    const result = disposer?.();
    if (result && typeof result.catch === 'function') result.catch(() => undefined);
  } catch {
    // 卸载期的异常不该影响其它资源回收
  }
}

/**
 * 这一批新邮件能不能推进游标（C1）。
 *
 * 只有"整批都落盘了、且没被卸载打断"才允许提交：
 *   - `blocking` 非空 = 有邮件该重试却还没落盘 ⇒ 不提交，下一轮从旧游标重来；
 *   - `aborted`   = 卸载中途被打断 ⇒ 不提交（没尝试过的那几封靠旧游标回到队列）。
 *
 * 单独抽成导出函数是为了能离线断言（`test/issues.test.mjs`），
 * 不必为了测这一行去伪造 IMAP 连接。
 */
export function shouldAdvanceCursor(outcome) {
  if (!outcome) return true;
  if (outcome.aborted) return false;
  return (outcome.blocking?.length ?? 0) === 0;
}

/**
 * 一个 agent 回合该怎么算（A2）。
 *
 * `ok` 但**没有任何文本**（空回复 / 只调用了工具）不能当成成功：以前这种回合什么都不写，
 * 邮件停在 `pending`、`retries` 里也没有条目，本进程内永远不会再处理它（游标已经越过），
 * 只能等下次重启的 `adoptOrphans`。这里把它与真正的失败归到同一处置。
 *
 * 占位文案**必须**以 `（agent 处理失败：` 开头：`agentFindings` 与
 * `store.conclusionState` 的旧数据回退都靠这个前缀判定失败。
 */
export function classifyTurn(result) {
  const text = typeof result?.text === 'string' ? result.text.trim() : '';
  if (!result?.ok) {
    const error = String(result?.error ?? '未知错误');
    return { outcome: 'failed', text: '', error, placeholder: `（agent 处理失败：${error}）` };
  }
  if (text) return { outcome: 'ok', text, error: '', placeholder: '' };
  const error = 'agent 没有输出结论（空回复或只调用了工具）';
  return { outcome: 'empty', text: '', error, placeholder: `（agent 处理失败：${error}）` };
}

/**
 * 一轮"多久没进展"算卡死（L1）。
 *
 * 阈值必须大于**一轮里最长的合法静默**，否则正常的长回合会被当成卡死：
 * 最长静默 = 一个 agent 回合（`agent.turnTimeoutSeconds`，默认 300s）+ 收尾余量。
 * 同时保留 `3×轮询间隔` 与 120s 两个下限（短间隔部署下不至于太敏感）。
 */
export function staleMsFor(pollSeconds, turnTimeoutSeconds) {
  const pollMs = Math.max(5, Number(pollSeconds ?? 30)) * 1000;
  const turnMs = Math.max(30, Number(turnTimeoutSeconds ?? 300)) * 1000;
  return Math.max(pollMs * 3, 120_000, turnMs + 60_000);
}

/**
 * 轮次锁（带归属令牌 + 进度心跳）。
 *
 * 之前 `state.running` 是一个**没有归属**的布尔：看门狗、`retryPoll`、`tick` 的 `finally`
 * 都能清掉别人的锁，于是同一封信被两轮同时处理（重复 token / 重复 QQ），
 * 最坏还与总览并发、把正在写结论的存档删掉。
 *
 * 这里四条规则：
 *   1. `acquire()` 只在无主时成功，返回令牌；
 *   2. `beat()` / `holds()` 只认自己那块令牌 → 被接管的旧轮从下一个检查点起停止提交；
 *   3. `release()` 只释放自己（旧轮的 finally 不会清新锁）；
 *   4. 心跳缺失一律**当"活"**（fail closed）：宁可晚一点判死，也不要把正在干活的轮次抢掉。
 */
export function createCycleLock(state) {
  return {
    acquire(kind) {
      if (state.lockOwner) return null;
      const token = { kind, at: Date.now() };
      state.lockOwner = token;
      state.lockKind = kind;
      state.lockBeatAt = token.at;
      state.running = true;
      state.runningSince = token.at;
      return token;
    },
    holds(token) {
      return Boolean(token) && state.lockOwner === token;
    },
    beat(token) {
      if (state.lockOwner !== token) return false;
      state.lockBeatAt = Date.now();
      return true;
    },
    release(token) {
      if (state.lockOwner !== token) return false;
      state.lockOwner = null;
      state.lockKind = '';
      state.lockBeatAt = 0;
      state.running = false;
      state.runningSince = 0;
      state.activity = '';
      state.processingDir = '';
      return true;
    },
    /** 距上一次心跳过了多久（ms）；没有心跳时按"刚开始"算，绝不返回巨大值去误杀 */
    idleMs() {
      const base = state.lockBeatAt || state.runningSince || Date.now();
      return Date.now() - base;
    },
  };
}

/**
 * 异步注册的标准写法：**effect 同步建立**，注册在 effect 内完成。
 *
 * §3.3.1 的坑不是「不能 await」，而是「await 之后才注册、且没有 disposer 覆盖」。
 * 这里把注册放进 effect 的回调链里：卸载时（哪怕注册还没完成）由本 effect 负责撤销。
 */
function registerAsync(ctx, log, factory) {
  ctx.effect(() => {
    let disposers = [];
    let closed = false;
    Promise.resolve()
      .then(factory)
      .then((made) => {
        const list = (Array.isArray(made) ? made : [made]).filter((item) => typeof item === 'function');
        if (closed) {
          for (const disposer of list) safeDispose(disposer);
          return;
        }
        disposers = list;
      })
      .catch((err) => log.error(`[mail-automation] 异步注册失败：${err?.message ?? err}`));
    return () => {
      closed = true;
      const list = disposers;
      disposers = [];
      for (const disposer of list) safeDispose(disposer);
    };
  });
}

/**
 * 拆 SKILL.md：取 frontmatter 里的 `description`（模型可见的**触发描述**）+ 去掉 frontmatter 的正文。
 *
 * 两个坑（dsh-plugin-guide §4.9 要点 1/2）：
 *   - description 决定"技能何时被选中"，所以优先用 SKILL.md 里写的那句；解析不出来才退回常量。
 *   - 必须容忍 CRLF：Windows 检出用 `startsWith('---\n')` 会失配，表现是**静默退化**
 *     （描述掉回兜底字符串，且整份文件连 frontmatter 一起被当成正文注入）。
 */
function readSkillFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { description: '', content: raw };
  let description = '';
  try {
    const meta = YAML.parse(match[1]);
    if (meta && typeof meta.description === 'string') description = meta.description.trim();
  } catch {
    // frontmatter 不是合法 YAML：正文照常注册，描述退回常量
  }
  return { description, content: raw.slice(match[0].length) };
}

/** 文件日志：宿主在 `dsh web` 下可能完全没有日志 sink，插件自己落一份；超过阈值轮转一次 */
function makeFileLog(logFile, maxBytes = DEFAULT_MAX_LOG_BYTES) {
  const limit = Number.isFinite(maxBytes) && maxBytes >= 65536 ? maxBytes : DEFAULT_MAX_LOG_BYTES;
  return (level, message) => {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      try {
        if (fs.statSync(logFile).size > limit) {
          const backup = `${logFile}.1`;
          try {
            fs.rmSync(backup, { force: true });
          } catch {
            // 旧备份删不掉就覆盖不了，下次再试
          }
          fs.renameSync(logFile, backup);
        }
      } catch {
        // 文件还不存在
      }
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${level} ${message}\n`, 'utf8');
    } catch {
      // 日志写不进去不影响业务
    }
  };
}

export function apply(ctx, config = {}) {
  const logger = ctx.logger;
  const dshHome = resolveDshHome();
  const configFile = String(unwrapVolatile(config?.configFile) || '');
  const logFile = path.join(
    configFile ? path.dirname(path.resolve(configFile)) : path.join(dshHome, 'mail-automation'),
    'mail-automation.log',
  );
  const fileLog = makeFileLog(logFile, Number(unwrapVolatile(config?.storage?.logMaxBytes)) || DEFAULT_MAX_LOG_BYTES);
  const log = {
    info: (message) => {
      logger?.info?.(message);
      fileLog('INFO', message);
    },
    warn: (message) => {
      logger?.warn?.(message);
      fileLog('WARN', message);
    },
    error: (message) => {
      logger?.error?.(message);
      fileLog('ERROR', message);
    },
  };

  /** 运行期状态（全部放一处，方便 effect 的清理体统一收尾） */
  const state = {
    disposed: false,
    cfg: null,
    store: null,
    runner: null,
    notifier: null,
    secrets: {},
    baselined: false,
    booting: true,
    /** 单定时器槽：所有定时任务共用（哪个先到排哪个，见 armSchedules） */
    scheduleTimer: null,
    /** 下一次定时任务的时刻（ms）与任务名：设置页「下次定时任务」用 */
    nextScheduleAt: 0,
    nextScheduleTask: '',
    /** 当前排期计划：Map<taskId, { task, at, slot }>（每次 arm 重建，不跨 arm 累积） */
    schedulePlan: new Map(),
    /** busy 退避中的任务：Map<taskId, { at, slot, attempt }>（只在内存：重启后按新排期走） */
    schedulePending: new Map(),
    /**
     * 本进程内刚保存/手动跑过的 startup 任务：只跳过“当前进程的自动触发”，
     * 下一次启动照常跑。Set<taskId>。
     */
    startupDeferred: new Set(),
    /** 首次排期时已有的 startup 任务：后来新出现的（UI/YAML 都算）延到下一次启动 */
    startupKnown: new Set(),
    startupBaselineReady: false,
    /** interval 任务首次排期的锚点（没有 lastRun 时避免每次重排把下次时间往后推） */
    intervalAnchors: new Map(),
    /** 配置里 schedules 的签名：变了才重排（心跳每拍比较） */
    scheduleSignature: '',
    /** 定时任务是否已经开始排期（boot 完成前不 arm，避免早于 store.ready） */
    schedulesArmed: false,
    lastTickAt: 0,
    lastError: '',
    /** 上一次轮询失败的时刻（ms）；整轮成功会清 0 */
    lastErrorAt: 0,
    /** 当前配置错误（粘性）：配置写坏时 tick 结束不能把它清掉，否则设置页看不见 */
    configError: '',
    running: false,
    /** 本轮开始时刻：用来识别"卡住的那一轮" */
    runningSince: 0,
    /** 轮次锁：归属令牌 / 种类 / 上次进度心跳（见 createCycleLock） */
    lockOwner: null,
    lockKind: '',
    lockBeatAt: 0,
    /** 「定时任务长时间无进展」只报一次 WARN，避免每个心跳刷屏 */
    scheduleStaleWarned: false,
    /** 正在做什么：'' | 'polling' | 'processing' | 'task'（设置页据此显示状态） */
    activity: '',
    /** 当前正交给 agent 的那封存档目录（列表里显示"处理中"） */
    processingDir: '',
    /** 每个来源上次尝试解析 passwordRef 的时间（解析不到时退避，避免每轮刷 WARN） */
    secretRetryAt: {},
    /**
     * 逐封存档失败的内存计数（id → 连续失败次数）。
     *
     * 只放内存、**不进状态存储**：一是避免改状态记录形状（会让 state 域里的旧记录与
     * 解析器对不上），二是"每次启动给一轮新预算"本就与 adoptOrphans 的语义一致。
     * 超过上限就放弃这一封并 ERROR 留痕，绝不静默丢（C1）。
     */
    archiveAttempts: new Map(),
    /** 每个来源的密码「来自哪一层」（credentials:file = 官方缝；credentials-file = 本插件兜底） */
    secretLayers: {},
    /** `{ domain, owned }`：状态存储域句柄（null = 这个宿主没有，状态写 state.json） */
    domainHandle: null,
    /** 运行时注册的邮件预设：disposer + 内容签名（工具集没变就不重注册） */
    presetDispose: null,
    presetSig: '',
    /** 卸载/重注册的代数：每次 await 之后都拿它判断"这次注册还算不算数" */
    presetEpoch: 0,
    /** 最近一次注册失败的信息（设置页概览要能看见；空串 = 没失败过） */
    presetError: '',
    /** `{ signature, at }`：同一签名的失败退避，避免每拍/每次保存都刷 WARN */
    presetFail: null,
    /** 晚到的 agentPresets 服务（`ctx.inject(['agentPresets'])` 拿到后存这里） */
    presets: null,
    /** 宿主没有 agentPresets.register() 时只提醒一次 */
    presetApiWarned: false,
    /** 预设注册的单飞链（放 state 里，避免 refreshConfig 早于 let 初始化时的 TDZ） */
    presetTask: null,
  };

  fileLog(
    'INFO',
    `插件加载：configFile=${configFile || '(未设置，只用 cordis.yml)'} dshHome=${dshHome} profileDir=${resolveProfileDir()} schema=${schemaSource}`,
  );

  /** 轮次锁：tick / baseline / 总览共用一把（同一时刻只允许一件"会写存档"的活） */
  const lock = createCycleLock(state);

  // 先同步读一次配置：心跳间隔这类「effect 建立时就要定下来」的值来自它。
  // 之后每轮轮询仍会重读（YAML 覆盖层改完即生效），这里只是取初值。
  /** agentPresets 服务：`ctx.get` 现取，晚到的由下面的 `ctx.inject` 补上并立即补注册 */
  function presetsOf() {
    if (state.presets?.register) return state.presets;
    try {
      return ctx.get?.('agentPresets');
    } catch {
      return undefined;
    }
  }

  // 0) 预设注册的两条生命周期保障（都在 apply 阶段同步建立）：
  //    a. 服务晚到时补注册（与 skills 注册同一手法，避免 boot 抢在注册表前面永久不注册）；
  //    b. 兜底撤销：fiber 被直接销毁（没走 shutdown）时也只撤自己的定义。
  ctx.effect(() => {
    let disposeInject;
    try {
      disposeInject = ctx.inject?.(['agentPresets'], (child) => {
        const service = child?.agentPresets ?? child?.get?.('agentPresets');
        if (!service?.register) return;
        state.presets = service;
        void ensureMailPreset(state.cfg).catch(() => undefined);
      });
    } catch {
      disposeInject = undefined;
    }
    return () => {
      try {
        disposeInject?.();
      } catch {
        // 卸载期异常不影响其它清理
      }
      state.presets = null;
    };
  });
  ctx.effect(() => () => {
    state.presetEpoch += 1; // 让在飞的注册在下一个 await 之后自废
    const dispose = state.presetDispose;
    state.presetDispose = null;
    state.presetSig = '';
    safeDispose(dispose);
  });

  const initialCfg = refreshConfig();

  // ───────────────────────── 效果（全部同步建立） ─────────────────────────

  // 1) 主清理体：卸载时停掉总览定时器、释放 agent、落盘状态、关掉 IMAP 长连接
  //    （心跳由它自己的 effect 负责）。清理有顺序依赖，所以**全部放在同一个 disposer 里串行
  //    await**：§3.2 明确多个异步 disposer 是并发执行的、跨 disposer 没有完成顺序保证。
  async function shutdown() {
    state.disposed = true;
    // 作废在途轮次：它会在下一个检查点（beat 失败）停止提交，不再和下面的 store.close() 抢写
    try {
      if (state.lockOwner) lock.release(state.lockOwner);
    } catch {
      // 卸载期的异常不该阻断清理
    }
    if (state.scheduleTimer) clearTimeout(state.scheduleTimer);
    state.scheduleTimer = null;
    state.schedulePending.clear();
    state.schedulePlan.clear();
    state.nextScheduleAt = 0;
    state.nextScheduleTask = '';
    state.schedulesArmed = false;
    const step = async (label, run) => {
      try {
        await run();
      } catch (err) {
        log.warn(`[mail-automation] 卸载清理「${label}」失败：${err?.message ?? err}`);
      }
    };
    // 顺序有意义：先让在途 agent 回合静默（它还在写 store），再落盘状态，最后关网络连接
    await step('释放 agent', () => state.runner?.dispose?.());
    // 预设定义随插件卸载撤销（在跑的 agent 保留自己那一版 revision，不受影响）。
    // 先 `presetEpoch += 1` 让在飞的注册自废，再**有界**等注册链收尾，最后撤 disposer。
    state.presetEpoch += 1;
    await step('注销邮件预设', async () => {
      await Promise.race([
        state.presetTask ?? Promise.resolve(),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, 5_000);
          if (typeof timer.unref === 'function') timer.unref();
        }),
      ]);
      const dispose = state.presetDispose;
      state.presetDispose = null;
      state.presetSig = '';
      await dispose?.();
    });
    await step('关闭状态存储', () => state.store?.close?.());
    await step('关闭来源连接', () => mailSources.closeAll());
    // 绑定流程可能还开着本地回调端口（Gmail 回环）：卸载必须关掉
    await step('关闭绑定回调', () => bind.disposeAll());
    oauth2Source.disposeAll();
  }
  ctx.effect(() => () => shutdown());

  // 2) 心跳：有 timer 服务时用它的 interval（随 fiber 自动销毁），否则退回 unref 的 setInterval。
  //    `timer` 刻意没写进 inject（见文件头注释），所以必须经 `ctx.get('timer')` **探测**——
  //    直接写 `ctx.interval` 是对未声明服务取属性（K1），只是恰好被 timer 的 mixin 兜住。
  //    间隔来自配置 monitor.heartbeatSeconds（这里先同步读一次配置，注释见下）。
  const heartbeatMs = Math.max(1_000, Number(initialCfg?.monitor?.heartbeatSeconds ?? 5) * 1000);
  ctx.effect(() => {
    const tickLoop = () => {
      if (state.disposed) return;
      void heartbeat().catch((err) => log.warn(`[mail-automation] 心跳异常：${err?.message ?? err}`));
    };
    const timerService = (() => {
      try {
        return ctx.get?.('timer');
      } catch {
        return undefined;
      }
    })();
    if (timerService?.interval) return timerService.interval(tickLoop, heartbeatMs);
    // 没有 timer 服务：下面退回普通定时器
    const timer = setInterval(tickLoop, heartbeatMs);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  });

  // 3) 实时字段改动（volatile）：不用重载插件，下一次操作就按新值走
  ctx.on('loader/volatile-update', () => {
    try {
      log.info('[mail-automation] 检测到实时配置改动：轮询间隔下一次心跳生效，总览时间重新排期');
      // 必须用**刷新后**的配置排期：以前这里传 state.cfg（旧快照），改完总览时间等于没改
      refreshThenReschedule();
    } catch (err) {
      log.warn(`[mail-automation] 处理实时配置改动失败：${err?.message ?? err}`);
    }
  });

  // 4) 凭据被改写（凭据页 set/unset、或 .credentials.yaml 被外部编辑）：
  //    **强制**重解 passwordRef → 重读配置。指南要求这条链「下一次操作就生效」。
  ctx.on('credentials/reference-updated', () => {
    if (state.disposed) return;
    void (async () => {
      try {
        const current = refreshConfig();
        if (!current) return;
        await ensureSecrets(current, { force: true });
        armSchedules(state.cfg ?? current);
      } catch (err) {
        log.warn(`[mail-automation] 凭据更新后重载失败：${err?.message ?? err}`);
      }
    })();
  });

  /**
   * 读宿主的模型目录（设置页"模型"下拉用）。
   *
   * 优先 `sessionController.modelCatalog()`（provider 分组 + 部署默认），
   * 退路是 `llm.listConfigurableProviders()` + `llm.listModels(provider)`。
   * 两种形状都不稳定（版本间会变），所以这里**归一化**成
   * `{ default:{provider,model}, providers:[{id, models:[id,...]}] }`；
   * 拿不到就返回 null，前端退化成手填——保存不依赖它。
   */
  /**
   * 模型目录的缓存/单飞层：设置页每 5 s 轮询一次 GET，如果每次都现问宿主，
   * `listModels()` 可能触网或串行等十几个 provider。这里缓存 30 s、并发请求合并成一次、整体 1.5 s 超时。
   * 拿不到就返回上一次的缓存（可能为 null），前端退化成手填。
   */
  let modelsCache = { at: 0, value: null };
  let modelsTask = null;
  function listModels() {
    if (modelsCache.value && Date.now() - modelsCache.at < 30_000) return Promise.resolve(modelsCache.value);
    if (modelsTask) return modelsTask;
    modelsTask = (async () => {
      try {
        const timeout = new Promise((resolve) => {
          const timer = setTimeout(() => resolve(null), 1_500);
          if (typeof timer.unref === 'function') timer.unref();
        });
        const value = await Promise.race([collectModels(), timeout]);
        if (value) modelsCache = { at: Date.now(), value };
        return value ?? modelsCache.value ?? null;
      } catch {
        return modelsCache.value ?? null;
      } finally {
        modelsTask = null;
      }
    })();
    return modelsTask;
  }

  async function collectModels() {
    /** 模型条目：`{id, name, efforts[], defaultEffort}`——efforts 来自宿主的 `reasoning.efforts` */
    const asModel = (entry) => {
      if (typeof entry === 'string') return { id: entry, name: entry, efforts: [], defaultEffort: '' };
      const id = String(entry?.id ?? entry?.model ?? '');
      const efforts = (Array.isArray(entry?.reasoning?.efforts) ? entry.reasoning.efforts : [])
        .map((effort) => (typeof effort === 'string' ? effort : String(effort?.id ?? '')))
        .filter(Boolean);
      return { id, name: String(entry?.name ?? id), efforts, defaultEffort: String(entry?.reasoning?.defaultEffort ?? '') };
    };
    const normalize = (defaults, providers) => ({
      default: {
        provider: String(defaults?.provider ?? ''),
        model: String(defaults?.model ?? ''),
        reasoningEffort: String(defaults?.reasoningEffort ?? ''),
      },
      providers: (Array.isArray(providers) ? providers : [])
        .map((provider) => ({
          id: String(provider?.id ?? provider?.provider ?? ''),
          name: String(provider?.name ?? provider?.id ?? ''),
          models: (Array.isArray(provider?.models) ? provider.models : []).map(asModel).filter((model) => model.id),
        }))
        .filter((provider) => provider.id),
    });

    const controller = (() => {
      try {
        return ctx.get?.('sessionController');
      } catch {
        return undefined;
      }
    })();
    try {
      const catalog = await controller?.modelCatalog?.();
      if (catalog) {
        /*
         * 宿主 `ModelCatalog` 的真实形状（`@deepseek-ai/dsh-tool-cordis` 的 api-catalog 里可查）：
         * `{ default: ModelSelection, routableProviders: string[], groups: [{ id, name, models: [{id,name,…}] }], failures: [...] }`。
         * 早先只读 `providers/providerGroups` → 主路径永远空，退化到 llm 的"可配置 provider"目录
         * （不含账号型/部署默认 provider），用户就选不到实际在用的模型。
         */
        const providers = catalog.groups ?? catalog.providers ?? catalog.providerGroups ?? [];
        const failures = Array.isArray(catalog.failures) ? catalog.failures : [];
        if (failures.length > 0) {
          log.warn(
            `[mail-automation] 模型目录有 ${failures.length} 个 provider 读取失败：` +
              failures
                .slice(0, 3)
                .map((failure) => `${failure?.id ?? '?'}（${failure?.message ?? '未知'}）`)
                .join('；'),
          );
        }
        const normalized = normalize(catalog.default ?? catalog.deploymentDefault, providers);
        if (normalized.providers.length > 0) return normalized;
      }
    } catch (err) {
      log.warn(`[mail-automation] 读模型目录失败（sessionController）：${err?.message ?? err}`);
    }

    const llm = (() => {
      try {
        return ctx.get?.('llm');
      } catch {
        return undefined;
      }
    })();
    try {
      const entries = await llm?.listConfigurableProviders?.();
      const providers = [];
      for (const entry of Array.isArray(entries) ? entries : []) {
        /*
         * 返回值是 `LlmConfigurableProvider[]`（对象：`provider` / `displayName` / `settingsNs`…），
         * 不是字符串数组；`listModels(provider: string)` 只接受那个 provider 键。
         * 早期版本直接把对象当 id 传进去，前端会收到一个字面量 "[object Object]" 的假 provider。
         */
        const id = typeof entry === 'string' ? entry : String(entry?.provider ?? entry?.id ?? '');
        if (!id) continue;
        try {
          providers.push({ id, models: (await llm.listModels?.(id)) ?? [] });
        } catch {
          providers.push({ id, models: [] });
        }
      }
      const fallback = normalize(
        { provider: state.cfg?.agent?.provider ?? '', model: state.cfg?.agent?.model ?? '' },
        providers,
      );
      if (fallback.providers.length > 0) return fallback;
    } catch (err) {
      log.warn(`[mail-automation] 读模型目录失败（llm）：${err?.message ?? err}`);
    }
    return null;
  }

  /** 有界等待：连通性自检/绑定轮询不能把 HTTP 请求无限拖住（超时只 reject，不取消底层 I/O） */
  function withTimeout(promise, ms, message) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), Math.max(1_000, Number(ms) || 10_000));
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]).finally(() => clearTimeout(timer));
  }

  /** 按 id 找当前配置里的来源（设置页的绑定/自检都以 id 为入口） */
  function sourceById(id) {
    return (state.cfg?.sources ?? []).find((source) => source.id === String(id ?? ''));
  }

  /**
   * 设置页与 `mail_automation_config` 工具共用的三个操作（实现都在 uiapi.js）。
   * 放在 apply 作用域里，两个调用方拿到的是同一份闭包。
   */
  const ui = {
    snapshot: () => statusSnapshot({ state, cfg: state.cfg, store: state.store, configFile }),
    /** 设置页的模型下拉 / 工具集复选框（同一个目录也暴露给 `mail_automation_config action=read`） */
    listModels: () => listModels(),
    /** 手动"立即重试拉取"：设置页按钮、`mail_automation_config` 的 retry_poll、`mail_automation_poll` 共用 */
    retryPoll: () => retryPoll(),
    saveParams(params) {
      const result = saveParams({ configFile: state.cfg?.configFile, params, base: config, dshHome, secrets: state.secrets });
      if (result.ok) {
        // 注意：`agent.silent` / `agent.workspace` 影响的是**父会话怎么建**，只在启动时生效
        // （设置页那两项已标注"重启生效"）。这里重载配置并按新值重排总览。
        try {
          refreshThenReschedule();
        } catch (err) {
          log.warn(`[mail-automation] 保存参数后重载配置失败：${err?.message ?? err}`);
        }
      }
      return result;
    },
    savePrompts(prompts) {
      return savePrompts(state.cfg, prompts);
    },
    /**
     * 保存定时任务（新增/编辑/删除/调整排期与提示词）。
     * 与来源管理同一套纪律：只改覆盖层、整表校验后原子写；成功后立刻重排。
     */
    async saveSchedules(schedules, editedId = '') {
      const result = await saveSchedulesConfig({
        configFile,
        base: config,
        dshHome,
        secrets: state.secrets,
        schedules,
        logger: log,
      });
      if (result.ok) {
        /*
         * 编辑过的任务、以及新增任务（同 id 可能是删掉后重建）都重新回到"未运行"：
         * 旧运行记录不能拿来描述刚改过/新建的任务。连同 busy 退避一起清。
         */
        const beforeIds = new Set((state.cfg?.schedules ?? []).map((task) => task.id));
        const resetIds = new Set();
        const explicitEdited = String(editedId ?? '').trim();
        if (explicitEdited) resetIds.add(explicitEdited);
        if (Array.isArray(schedules)) {
          for (const [index, raw] of schedules.entries()) {
            const id = String(raw?.id ?? '').trim() || `task-${index + 1}`;
            if (!beforeIds.has(id)) resetIds.add(id);
          }
        }
        if (resetIds.size > 0 && state.store) {
          const runs = state.store.state.scheduleRuns ?? {};
          let changed = false;
          for (const id of resetIds) {
            state.schedulePending.delete(id);
            state.intervalAnchors.delete(id);
            if (Object.prototype.hasOwnProperty.call(runs, id)) {
              delete runs[id];
              changed = true;
            }
          }
          if (changed) state.store.save();
        }
        /*
         * 刚保存的 startup 任务只在**下一次进程启动**运行；本次保存触发的重排
         * 不能把它当成"本进程还没跑过"而立刻执行。
         */
        for (const [index, raw] of (Array.isArray(schedules) ? schedules : []).entries()) {
          const schedule = raw?.schedule ?? raw?.scheduleRaw ?? {};
          if (String(schedule.type ?? '').toLowerCase() !== 'startup') continue;
          if (raw?.enabled === false) continue;
          const id = String(raw?.id ?? '').trim() || `task-${index + 1}`;
          state.startupDeferred.add(id);
        }
        refreshThenReschedule();
        log.info(`[mail-automation] 定时任务已保存：${(result.ids ?? []).join('、') || '(空)'}`);
      }
      return result;
    },
    /** 手动运行一条定时任务（设置页「立即运行」）：只跑这一次，不认领排期槽 */
    async runTask(id) {
      const task = (state.cfg?.schedules ?? []).find((entry) => entry.id === String(id ?? ''));
      if (!task) return { ok: false, error: `没有 id 为「${id}」的定时任务` };
      // 手动跑 startup 任务后，不要在同一次重排里再自动跑一次
      if (task.schedule?.type === 'startup') state.startupDeferred.add(task.id);
      const result = await runScheduledTask(task, { manual: true, slot: `manual:${Date.now()}` });
      return { ...result, name: task.name, id: task.id };
    },
    /**
     * 新增/更新一个邮箱来源（表单 → 覆盖层 YAML → 整表校验 → 原子写）。
     * 成功后就地刷新配置并回收旧连接；新来源没有游标，下一拍自动建基线（不归档历史）。
     */
    async saveSource(payload = {}) {
      /*
       * 不能要求 `state.cfg` 已加载：当配置里一个来源都没有时，normalizeConfig 会报
       * "配置里没有 sources"，state.cfg 为 null——如果这里也拒绝，设置页就**永远加不进第一个邮箱**
       * （用户只能手改 YAML）。写入只需要 configFile 与 base，写完 refreshConfig 即可恢复。
       */
      if (!configFile) return { ok: false, error: '没有可写的 configFile（当前只用 cordis.yml 配置）：无法在界面里改来源' };
      const credentials = (() => {
        try {
          const service = ctx.get?.('credentials');
          return service?.set ? service : undefined;
        } catch {
          return undefined;
        }
      })();
      const result = await upsertSource({
        configFile,
        base: config,
        dshHome,
        secrets: state.secrets,
        source: payload.source,
        secret: payload.secret,
        clientSecret: payload.clientSecret,
        previousId: payload.previousId,
        credentials,
        logger: log,
      });
      if (result.ok) {
        // 先刷新配置，让在途轮次的 commitSourceState 看到新身份；再删旧游标。
        refreshThenReschedule();
        imapPrune(state.cfg?.sources ?? []);
        /*
         * 改 id、文件夹/协议 = 新邮箱：旧游标必须一起删。否则以后加回旧 id，
         * 或对同一 id 换了文件夹，会接上一条指向别的邮箱/文件夹的旧游标。
         */
        const previousKey = String(payload.previousId ?? '').trim();
        const identityChanged = Boolean(result.identityChanged) || (previousKey && previousKey !== result.id);
        if (previousKey && identityChanged && state.store) {
          if (Object.prototype.hasOwnProperty.call(state.store.state.sources, previousKey)) {
            delete state.store.state.sources[previousKey];
            state.store.save();
            result.warnings = [
              ...(result.warnings ?? []),
              previousKey !== result.id
                ? `旧 id「${previousKey}」的游标已删除；旧存档目录仍以旧 id 为前缀，不会自动改名`
                : `文件夹/协议已变更，来源「${previousKey}」的旧游标已删除，下一拍重建基线`,
            ];
          }
        }
        log.info(`[mail-automation] 来源已保存：${result.id}（${result.created ? '新增' : '更新'}），下一拍生效`);
      }
      return result;
    },
    /**
     * 删除一个来源：只删 YAML 定义 + 该来源的游标；存档默认保留
     * （`deleteArchives: true` 才会连未总览的存档一起删——这是删用户数据，UI 必须二次确认）。
     */
    async deleteSource({ id, deleteArchives = false } = {}) {
      if (!configFile) return { ok: false, error: '没有可写的 configFile（当前只用 cordis.yml 配置）：无法在界面里改来源' };
      const result = removeSource({
        configFile,
        base: config,
        dshHome,
        id,
        secrets: state.secrets,
        logger: log,
      });
      if (!result.ok) return result;
      let removedArchives = 0;
      const warnings = [];
      if (state.store) {
        // 游标跟着来源一起消失：否则以后加回同 id 会沿用一条指向别的账号的旧游标（C6 同类）
        delete state.store.state.sources[id];
        if (deleteArchives) {
          /*
           * 与在途轮询/总览互斥：`deleteMails` 是直接 rm，正在写 meta / 正在汇总的目录
           * 被删会让已处理的邮件凭空消失。有活动轮次时只删定义、保留存档，并明确告知。
           */
          if (state.lockOwner || state.processingDir) {
            warnings.push('正在轮询/处理邮件：本次只删除了邮箱定义，存档保留（稍后可再删一次存档）');
          } else {
            const dirs = (state.store.listArchived() ?? [])
              .filter((item) => String(item.source_id ?? item.sourceId ?? '') === String(id))
              .map((item) => item.dir ?? item.file)
              .filter(Boolean);
            if (dirs.length > 0) removedArchives = state.store.deleteMails(dirs);
          }
        }
        state.store.save();
      }
      refreshThenReschedule();
      imapPrune(state.cfg?.sources ?? []);
      log.info(`[mail-automation] 来源已删除：${id}${removedArchives > 0 ? `（含 ${removedArchives} 份未总览存档）` : '（存档保留）'}`);
      return { ...result, removedArchives, warnings };
    },
    /** 连通性自检（设置页「测试连接」）：真登录/真取一封，20s 上限 */
    async verifySource(id) {
      const source = sourceById(id);
      if (!source) return { ok: false, error: `没有 id 为「${id}」的来源` };
      const provider = mailSources.providerFor(source.type);
      if (typeof provider.verify !== 'function') return { ok: false, error: `${mailSources.sourceTypeLabel(source.type)} 不支持连通性自检` };
      try {
        const result = await withTimeout(provider.verify(source), 20_000, '连通性自检超时（20s）');
        log.info(`[mail-automation] 来源「${source.name}」自检成功：${result.detail}`);
        return { ok: true, detail: result.detail };
      } catch (err) {
        const message = err?.message ?? String(err);
        state.lastError = message;
        state.lastErrorAt = Date.now();
        log.warn(`[mail-automation] 来源「${source.name}」自检失败：${message}`);
        return { ok: false, error: message };
      }
    },
    /**
     * 开始 OAuth 绑定（Gmail / Graph）。
     * clientSecret 优先取来源配置，其次经凭据缝解析 clientSecretRef。
     */
    async startMailBind(sourceId) {
      const source = sourceById(sourceId);
      if (!source) return { ok: false, error: `没有 id 为「${sourceId}」的来源` };
      if (source.type === 'graph') {
        const result = await bind.startGraphBind({
          clientId: source.clientId,
          tenant: source.tenant || 'common',
          tokenFile: source.tokenFile,
        });
        return result.ok ? { ...result, sourceId: source.id } : result;
      }
      if (source.type === 'oauth2') {
        try {
          const start = await oauth2Source.startDeviceFlow(source);
          return {
            ok: true,
            sourceId: source.id,
            bind: {
              id: `oauth2:${source.id}`,
              provider: 'oauth2',
              status: 'pending',
              url: start.url,
              verificationUri: start.url,
              code: start.code,
              userCode: start.code,
              interval: start.interval,
            },
          };
        } catch (err) {
          return { ok: false, error: err?.message ?? String(err) };
        }
      }
      if (source.type === 'gmail') {
        let clientSecret = String(source.clientSecret ?? '');
        if (!clientSecret && source.clientSecretRef) {
          const resolved = await resolveSecret(ctx, source.clientSecretRef, { logger: log, dshHome });
          clientSecret = resolved?.value ?? '';
        }
        const result = await bind.startGmailBind({
          clientId: source.clientId,
          clientSecret,
          tokenFile: source.tokenFile,
          logger: log,
        });
        return result.ok ? { ...result, sourceId: source.id } : result;
      }
      return {
        ok: false,
        error: `${mailSources.sourceTypeLabel(source.type)} 用账号密码登录，不需要 OAuth 绑定；直接填 host/user/passwordRef 即可`,
      };
    },
    /** 轮询一次 OAuth 绑定；完成时刷新配置（令牌文件已由 bind.js 原子写入） */
    async pollBind(id) {
      const bindId = String(id ?? '');
      if (bindId.startsWith('oauth2:')) {
        const source = sourceById(bindId.slice('oauth2:'.length));
        if (!source || source.type !== 'oauth2') return { ok: false, error: 'OAuth2 来源不存在或已被删除' };
        const result = await oauth2Source.pollDeviceFlow(source);
        if (result.status === 'pending') {
          const shown = oauth2Source.describeDeviceFlow(source);
          return {
            ok: true,
            bind: {
              id: bindId,
              provider: 'oauth2',
              status: 'pending',
              url: shown?.url || '',
              verificationUri: shown?.url || '',
              code: shown?.code || '',
              userCode: shown?.code || '',
              interval: shown?.interval,
            },
          };
        }
        if (result.status === 'ok') {
          log.info(`[mail-automation] OAuth2（IMAP）登录完成：${result.user || source.user}（令牌文件已写入，下一拍开始取信）`);
          refreshThenReschedule();
          return {
            ok: true,
            bind: { id: bindId, provider: 'oauth2', status: 'completed', result: { account: result.user || source.user } },
          };
        }
        return { ok: false, error: result.error || 'OAuth2 登录失败' };
      }
      const result = await bind.pollBind(id);
      if (result.ok && result.bind?.status === 'completed') {
        const account = result.bind.result?.account || result.bind.result?.email || '';
        log.info(
          `[mail-automation] ${result.bind.provider === 'graph' ? 'Microsoft Graph' : 'Gmail'} 绑定完成` +
            `${account ? `：${account}` : ''}（令牌文件已写入，下一拍开始取信）`,
        );
        refreshThenReschedule();
      }
      return result;
    },
    /** 手动粘贴授权码完成 Gmail 绑定（回环端口不可用时的兜底） */
    async completeBind(id, code) {
      const result = await bind.completeGmailBind(id, code);
      if (result.ok && result.bind?.status === 'completed') {
        log.info(`[mail-automation] Gmail 绑定完成（手动授权码）：${result.bind.result?.email || ''}`);
        refreshThenReschedule();
      }
      return result;
    },
    cancelBind(id) {
      const bindId = String(id ?? '');
      if (bindId.startsWith('oauth2:')) {
        const source = sourceById(bindId.slice('oauth2:'.length));
        if (source) oauth2Source.cancelDeviceFlow(source);
        return { ok: true };
      }
      return bind.cancelBind(id);
    },
    /**
     * 开始 QQ 官方机器人扫码绑定：返回连接页 URL + 二维码 data URL。
     * 二维码内容是一次性 task_id，只放在响应里（不落盘、不写日志）。
     */
    async startQqBind() {
      const result = await bind.startQqBind();
      if (!result.ok) return result;
      try {
        return { ...result, qr: qrDataUrl(result.bind.url) };
      } catch (err) {
        return { ...result, qr: '', qrError: `二维码生成失败：${err?.message ?? err}（可直接打开链接）` };
      }
    },
    /**
     * 轮询 QQ 扫码结果；成功则把 appId/openid 写回 YAML、secret 写进凭据缝
     * （没有凭据缝才退回 YAML 明文，并在 warnings 里明说）。secret 绝不进返回值。
     */
    async pollQqBind(id) {
      const result = await bind.pollQqBind(id);
      if (!result.ok || result.bind?.status !== 'completed') return result;
      /*
       * secret **不在 poll 返回值里**（那个对象会被 uiapi 转给浏览器）：宿主侧 peek 读取，
       * 只有所有落盘都成功后才 consume（擦除）。写入失败时保留 secret，允许对同一会话重试——
       * 早期实现"读即擦"，一次写失败就只能重扫。
       */
      const credentials = bind.peekQqCredentials(id) ?? {};
      const appId = String(credentials.appId ?? '');
      const openid = String(credentials.openid ?? '');
      const secret = String(credentials.secret ?? '');
      const configFile = state.cfg?.configFile;
      const warnings = [];
      /*
       * 凭据服务同时用于两件事：
       *   - QQ_BOT_SECRET：本插件与其它 QQ 插件共用；
       *   - QQ_BOT_APP_ID：其它插件（如 dsh-qqbot）按这个 ref 找 AppID，绑定后必须一起写，
       *     否则它们只看到 secret、找不到机器人 id。
       */
      const credentialsService = (() => {
        try {
          const service = ctx.get?.('credentials');
          return service?.set ? service : undefined;
        } catch {
          return undefined;
        }
      })();
      const writeScalar = (key, value) =>
        writeConfigScalar({
          configFile,
          section: 'qq',
          key,
          value,
          base: config,
          dshHome,
          secrets: state.secrets,
        });
      const partial = (error) => {
        // 已经写进去的部分要让它立刻生效，UI 才能看到"半成功"而不是停留在旧状态
        refreshThenReschedule();
        state.notifier?.invalidate?.();
        return { ok: false, partial: true, error: `${error}（已写入的部分已生效；client_secret 仍保留，可直接重试）` };
      };
      if (!appId) return { ok: false, error: '扫码结果里没有 bot_appid：请重新扫码，或手填 AppID/openid' };
      if (!openid) warnings.push('服务端没有返回接收人 openid：请在这张卡片里手填，否则推送会报"没有可用的 openid"');

      const idWrite = writeScalar('app_id', appId);
      if (!idWrite.ok) return partial(`写入 qq.app_id 失败：${idWrite.error}`);
      if (credentialsService) {
        try {
          await credentialsService.set('QQ_BOT_APP_ID', appId);
        } catch (err) {
          warnings.push(`写入凭据 QQ_BOT_APP_ID 失败：${err?.message ?? err}（YAML 里已有效，其它插件可能读不到）`);
        }
      }
      if (openid) {
        const openWrite = writeScalar('openid', openid);
        if (!openWrite.ok) return partial(`写入 qq.openid 失败：${openWrite.error}`);
      }
      if (secret) {
        if (credentialsService) {
          try {
            await credentialsService.set('QQ_BOT_SECRET', secret);
          } catch (err) {
            return partial(`写入凭据 QQ_BOT_SECRET 失败：${err?.message ?? err}`);
          }
        } else {
          const secretWrite = writeScalar('app_secret', secret);
          if (!secretWrite.ok) return partial(`写入 qq.app_secret 失败：${secretWrite.error}`);
          warnings.push('这版宿主没有凭据服务：appSecret 已明文写入 mail-automation.yaml（建议改用凭据页）');
        }
        bind.consumeQqCredentials(id);
      } else {
        warnings.push('本次扫码结果没有 client_secret（可能已保存过）：请到凭据页确认 QQ_BOT_SECRET，必要时重新扫码');
      }
      refreshThenReschedule();
      state.notifier?.invalidate?.();
      log.info(`[mail-automation] QQ 机器人扫码绑定完成：appId=${appId} openid=${openid ? '已写入' : '(未返回)'} secret=${secret ? '已保存' : '未提供'}`);
      return {
        ok: true,
        bind: { ...result.bind, result: { appId, openid } },
        saved: Boolean(secret),
        warnings,
      };
    },
    cancelQqBind(id) {
      return bind.cancelBind(id);
    },
    /**
     * 写一个凭据引用（手动填写 QQ appSecret / 邮箱授权码时的兜底入口）。
     * **只写不读**：返回值里没有值本身，快照也不会包含它。
     */
    async saveSecret(ref, value) {
      const name = String(ref ?? '').trim();
      const secret = String(value ?? '');
      /*
       * 白名单：这个动作只服务"手填 QQ appSecret（以及可选 AppID）"，不应成为
       * 改写共享凭据存储里任意 key 的通用后门（同源页面/脚本都能调到这条路由）。
       */
      if (!['QQ_BOT_SECRET', 'QQ_BOT_APP_ID'].includes(name)) {
        return { ok: false, error: `只允许写 QQ_BOT_SECRET / QQ_BOT_APP_ID（收到：${name || '(空)'}）；其它凭据请到凭据页操作` };
      }
      if (!secret) return { ok: false, error: '凭据值不能为空（清空请到凭据页 unset）' };
      let service;
      try {
        service = ctx.get?.('credentials');
      } catch {
        service = undefined;
      }
      if (!service?.set) {
        return { ok: false, error: '这版宿主没有可写的凭据服务：请把值写进 $DSH_HOME/.credentials.yaml 的 refs 块' };
      }
      try {
        await service.set(name, secret);
      } catch (err) {
        return { ok: false, error: `写入凭据 ${name} 失败：${err?.message ?? err}` };
      }
      log.info(`[mail-automation] 已写入凭据 ${name}`);
      return { ok: true, ref: name };
    },
    /**
     * 手动重试所有"处理失败"的邮件：清掉失败占位结论、attempts 归零、放回重试队列。
     * 这里**不直接跑**——一轮 agent 要几十秒，会把 HTTP 请求和按钮拖住；
     * 下一拍（≤30s）由 retryPending 处理。
     */
    async retryFailed() {
      if (!state.store) return { ok: false, error: '插件还没成功加载配置' };
      /*
       * P-N1：域后端在 `ready()` 之前 `save()` 是**假成功**（#queueFlush 会丢弃），
       * 随后的 hydrate 又把内存覆盖成域里的值 —— 用户看到"已排队 N 封"却什么都没发生。
       */
      await state.store.ready?.();
      const retries = (state.store.state.retries ??= {});
      let queued = 0;
      for (const item of state.store.listArchived()) {
        const dir = item.dir ?? item.file;
        if (!dir) continue;
        const verdict = state.store.conclusionState(dir);
        if (verdict.outcome !== 'failed') continue;
        state.store.clearConclusion(dir);
        const key = String(item.id || `retry:${item.name || path.basename(dir)}`);
        retries[key] = {
          dir,
          file: dir,
          sourceId: item.source_id || item.sourceId || '',
          attempts: 0,
          lastError: `手动重试（上次：${verdict.error || '未知原因'}）`,
          at: new Date().toISOString(),
        };
        queued += 1;
      }
      if (queued > 0) {
        state.store.save();
        log.info(`[mail-automation] 手动重试：已排队 ${queued} 封失败的邮件，下一拍处理`);
      }
      return { ok: true, count: queued };
    },
    /** 删除单封/多封存档（设置页每行的删除按钮；不碰邮箱） */
    async deleteMail(ids) {
      if (!state.store) return { ok: false, error: '插件还没成功加载配置' };
      await state.store.ready?.();
      const list = Array.isArray(ids) ? ids : [ids];
      const cleaned = list.map((id) => String(id ?? '').trim()).filter(Boolean);
      if (cleaned.length === 0) return { ok: false, error: '缺少要删除的存档 id' };
      const result = clearArchives({ store: state.store, ids: cleaned, logger: log });
      return result;
    },
  };

  // 5) 设置页的数据通道（host 侧 HTTP 路由，客户端用同一个路径 fetch）。
  //    与 `mail_automation_config` 工具共用 uiapi.js 里的同一套操作（技能 user-actions.md
  //    「One operation, two callers」）：读快照 / 存参数 / 存提示词都只有一份实现。
  //
  //    这也是唯一一处**故意不包 registerAsync** 的注册：webServer 路由本身是同步注册，
  //    不需要等宿主模块。`ctx.inject` 兜住「webServer 比插件晚到」的组合。
  ctx.effect(() =>
    registerUiRoute(ctx, {
      getState: () => state,
      getConfig: () => state.cfg,
      getStore: () => state.store,
      refresh: () => refreshConfig(),
      saveParams: (params) => ui.saveParams(params),
      saveSchedules: (schedules, editedId) => ui.saveSchedules(schedules, editedId),
      runTask: (id) => ui.runTask(id),
      retryFailed: () => ui.retryFailed(),
      deleteMail: (id) => ui.deleteMail(id),
      retryPoll: () => ui.retryPoll(),
      listModels: () => ui.listModels(),
      // 来源管理（添加/删除/自检）与三种绑定流程：与工具共用同一份 ui 实现
      saveSource: (payload) => ui.saveSource(payload),
      deleteSource: (payload) => ui.deleteSource(payload),
      verifySource: (id) => ui.verifySource(id),
      startMailBind: (sourceId) => ui.startMailBind(sourceId),
      pollBind: (id) => ui.pollBind(id),
      completeBind: (id, code) => ui.completeBind(id, code),
      cancelBind: (id) => ui.cancelBind(id),
      startQqBind: () => ui.startQqBind(),
      pollQqBind: (id) => ui.pollQqBind(id),
      cancelQqBind: (id) => ui.cancelQqBind(id),
      saveSecret: (ref, value) => ui.saveSecret(ref, value),
      logger: log,
    }),
  );

  // 6) 工具：需要宿主模块，异步注册（effect 已同步建立，卸载窗口内也会撤销）
  registerAsync(ctx, log, async () => {
    const { defineTool } = await loadHost();
    if (typeof defineTool !== 'function') throw new Error('宿主的 @deepseek-ai/dsh-tools 没有导出 defineTool');
    const disposers = registerTools(
      ctx,
      defineTool,
      {
        getConfig: () => state.cfg,
        getStore: () => state.store,
        getNotifier: () => state.notifier,
        getRunner: () => state.runner,
        refresh: () => refreshConfig(),
        monitor: {
          get lastTickAt() {
            return state.lastTickAt;
          },
          get lastError() {
            return state.lastError;
          },
          tick: (options) => tick(options),
        },
        ui,
        logger: log,
      },
    );
    log.info('[mail-automation] 已注册工具：qq_notify / mail_automation_archive_read / mail_automation_archive_list / mail_automation_archive_clear / mail_automation_status / mail_automation_poll / mail_automation_config');
    return disposers;
  });

  // 6) skill：注册返回的 disposer 必须进 effect（否则重载后残留重复条目）
  registerSkills(ctx, log);

  // ───────────────────────── 配置与凭据 ─────────────────────────

  /** 配置（重新）加载：成功则重建依赖配置的部件，失败保留上一份 */
  function refreshConfig() {
    // 首次安装：默认 YAML 不存在时先落一份带默认「邮件总览」的配置，避免装完没有任何定时任务
    if (configFile) {
      try {
        ensureFirstInstallConfig(configFile, { dshHome });
      } catch (err) {
        log.warn(`[mail-automation] 创建首次安装配置失败：${err?.message ?? err}`);
      }
    }
    const result = loadConfig(configFile || undefined, {
      base: config,
      dshHome,
      secrets: state.secrets,
    });
    if (result.error) {
      state.setupRequired = false;
      state.lastError = result.error;
      state.lastErrorAt = Date.now();
      /*
       * 粘性配置错误（C6 的可见性）：`tick()` 结尾在 `failed === 0` 时会清掉 `lastError`，
       * 于是"配置写坏了、插件还在用上一份好配置跑"在设置页完全看不见。
       * 这里单独记一份，只在错误文本变化时 WARN，避免每拍刷日志。
       */
      if (state.configError !== result.error) {
        state.configError = result.error;
        log.warn(`[mail-automation] 配置无效，继续沿用上一份好配置（新配置未生效）：${result.error}`);
      }
      return state.cfg;
    }
    /*
     * 0 个来源是**有效配置**（内置默认值 + 空 sources），运行时保持空闲并由设置页引导绑定。
     * setupRequired 只影响状态灯/引导卡片，不影响参数、提示词、添加来源等操作。
     */
    state.setupRequired = result.config.sources.length === 0;
    if (state.setupRequired) {
      if (!state.setupLogged) {
        state.setupLogged = true;
        log.info('[mail-automation] 还没有邮箱来源：插件保持空闲，等待在设置页添加/绑定邮箱');
      }
    } else {
      state.setupLogged = false;
    }
    if (state.configError) {
      state.configError = '';
      log.info('[mail-automation] 配置已恢复有效');
    }
    state.cfg = result.config;
    // 没配提示词路径时，首次启动就把内置兜底复制成默认文件（设置页能直接看到并编辑）
    ensureDefaultPromptFiles(state.cfg);
    if (!state.store) {
      state.store = new Store(
        state.cfg,
        log,
        state.domainHandle ? { domain: state.domainHandle.domain, owned: state.domainHandle.owned } : {},
      );
    } else state.store.cfg = state.cfg;
    if (!state.runner) {
      state.runner = new MailAgentRunner({
        ctx,
        logger: log,
        state: state.store.state,
        persist: () => state.store.save(),
        getTurnTimeoutMs: () => (state.cfg?.agent?.turnTimeoutSeconds ?? 300) * 1000,
        // 省 token 的开关：运行时注册的极简预设 + 更低的思考强度（都读最新的 cfg，改 YAML 即生效）
        getMailPresetId: () => state.cfg?.agent?.preset ?? MAIL_PRESET_ID,
        // 子 agent 的工具白名单：空数组 = 真的不给任何工具
        getMailTools: () => state.cfg?.agent?.tools,
        getReasoningEffort: () => state.cfg?.agent?.reasoningEffort ?? '',
        // 处理邮件用的模型（成对才生效；留空则跟随部署默认）
        getProvider: () => state.cfg?.agent?.provider ?? '',
        getModel: () => state.cfg?.agent?.model ?? '',
        // 父会话开场白也是模型可见文本：配成空串表示不写（默认值在 defaults.js）
        getOpenerPrompt: () => state.cfg?.agent?.openerPrompt ?? '',
        // 静默模式（默认关）：父会话以 origin=subagent 创建、不挂工作区，不归档
        getSilent: () => state.cfg?.agent?.silent === true,
        // 会话体积预算（MB，0 = 不限制）：父会话/每日会话超过它就归档换代
        getSessionBudgetMb: () => state.cfg?.agent?.sessionBudgetMb ?? 8,
        // 单条提示词的字节上限（KB，0 = 不限制）：超过就拒绝发送
        getPromptMaxKb: () => state.cfg?.agent?.promptMaxKb ?? 512,
      });
    }
    if (!state.notifier) state.notifier = new QQNotifier({ ctx, cfg: state.cfg, logger: log });
    else state.notifier.cfg = state.cfg;
    // 手改 YAML 也算"配置变化"：签名没变就是空操作，变了才真正重注册
    void ensureMailPreset(state.cfg);
    return state.cfg;
  }

  /**
   * 按配置注册/更新「邮件子 agent 预设」（工具集来自 `agent.tools`）。
   *
   * 为什么在运行时注册而不是 bundle patch 里写死：用户要能改"邮件 agent 能用哪些工具"，
   * 而改 profile 的 patch 会触发 HMR 重载（unfixed-issues T1，破坏性）。`agentPresets.register()`
   * 是官方缝，返回 disposer；工具集变化时先 dispose 旧定义再注册新定义。
   *
   * 签名没变就不重注册：每次注册都是一个新的 preset revision，会让之后创建的 agent 换代。
   * 失败只 WARN：agent.js 的 `mailPresetId()` 会退回部署默认预设（只损失省 token）。
   */
  /**
   * 注册/重注册邮件预设（**单飞 + epoch 守卫**）。
   *
   * 这里踩的是 §3.3.1 的同一条坑：`register()` 是异步的，而注册结果（disposer）必须在
   * **已卸载**时立刻撤销。做法：
   *   - 所有调用串到一条 promise 链上（同一时刻只有一次注册在飞）；
   *   - 每次 await 之后复查 `state.disposed` 与 epoch（卸载/重注册会 `presetEpoch += 1`）；
   *   - 过期返回的 disposer **立即** await 掉，绝不留给"没人拿得到"的状态；
   *   - 另有一条 `ctx.effect` 只负责兜底撤销（双保险，safeDispose 可重入）。
   *
   * 失败退避 60 s（同一签名不反复刷 WARN）；注册失败时 `presetSig` 保持空，下一次配置变化会重试。
   */
  function ensureMailPreset(cfg) {
    const epoch = state.presetEpoch;
    state.presetTask = (state.presetTask ?? Promise.resolve())
      .then(() => registerMailPreset(cfg, epoch))
      .catch((err) => {
        log.warn(`[mail-automation] 注册邮件预设时出现异常：${err?.message ?? err}`);
      });
    return state.presetTask;
  }

  async function registerMailPreset(cfg, epoch) {
    if (state.disposed || epoch !== state.presetEpoch) return;
    const definition = buildMailPreset({ tools: cfg?.agent?.tools });
    const signature = mailPresetSignature(definition);
    if (signature === state.presetSig) return;
    if (state.presetFail && state.presetFail.signature === signature && Date.now() - state.presetFail.at < 60_000) return;
    const presets = presetsOf();
    if (!presets?.register) {
      if (!state.presetApiWarned) {
        state.presetApiWarned = true;
        log.warn(
          '[mail-automation] 宿主没有可用的 agentPresets 注册表（服务未就绪或该组合不挂它）：' +
            '邮件子 agent 使用部署默认预设（工具集暂不可配）',
        );
      }
      return;
    }
    // 同名冲突可见化：profile 里还留着同名静态 preset 行，或上一个实例没注销干净
    if (!state.presetDispose && !state.presetSig) {
      try {
        const existing = await presets.resolve?.(MAIL_PRESET_ID);
        if (existing && !existing.broken) {
          log.warn(
            `[mail-automation] 注册表里已存在同 id 预设 ${MAIL_PRESET_ID}（旧 cordis.patch.yml 的静态行 / 其它实例？）：` +
              '运行时注册会覆盖它；如果那是你的自定义预设，请改用 agent.tools 配置',
          );
        }
      } catch {
        // 不存在时 resolve 会抛/返回 broken，两种都可忽略
      }
    }
    try {
      await state.presetDispose?.();
    } catch {
      // 旧定义注销失败不影响新定义（下面会用新 disposer 覆盖）
    }
    state.presetDispose = null;
    if (state.disposed || epoch !== state.presetEpoch) return;
    try {
      const dispose = await presets.register(definition);
      if (state.disposed || epoch !== state.presetEpoch) {
        try {
          await dispose?.();
        } catch {
          // 过期 disposer 撤销失败也只能记在这里
        }
        return;
      }
      state.presetDispose = typeof dispose === 'function' ? dispose : null;
      state.presetSig = signature;
      state.presetError = '';
      state.presetFail = null;
      // register() 只证明定义进了注册表：装配失败是以 broken 挂在 roster 上的，必须再 resolve 一次
      try {
        const resolved = await presets.resolve?.(MAIL_PRESET_ID);
        if (resolved?.broken) {
          state.presetError = `装配失败：${JSON.stringify(resolved.broken).slice(0, 200)}`;
          log.warn(`[mail-automation] 邮件预设已注册但装配失败（${state.presetError}）：邮件子 agent 会退回部署默认预设`);
        }
      } catch {
        // 解析失败不影响已注册的定义
      }
      state.runner?.resetPresetCooldown?.();
      log.info(
        `[mail-automation] 邮件预设已注册：${MAIL_PRESET_ID}（` +
          (definition.plugins.length > 1 ? definition.plugins.slice(1).map((plugin) => plugin.name).join(' / ') : '无工具') +
          `）`,
      );
    } catch (err) {
      const message = err?.message ?? String(err);
      state.presetSig = '';
      state.presetError = message;
      state.presetFail = { signature, at: Date.now() };
      log.warn(`[mail-automation] 注册邮件预设失败（${message}）；邮件子 agent 退回部署默认预设，60 秒内不重试`);
    }
  }

  /**
   * 重读配置并按**新值**重排总览（G2 / A-N1）。
   *
   * 只给"用户刚改了配置"的两个入口用：设置页保存参数成功后、`loader/volatile-update`。
   * **不要**塞进 `refreshConfig()` —— 它被每一拍轮询、boot、ensureSecrets 反复调用，
   * 塞进去等于每拍重排一次、还会刷日志。
   */
  function refreshThenReschedule() {
    const fresh = refreshConfig() ?? state.cfg;
    // 模型换了：让下一封邮件用新模型重建并热身父会话（否则可能先被 pre-step 拒一次）
    if (fresh) {
      const key = `${fresh.agent?.provider ?? ''}/${fresh.agent?.model ?? ''}/${fresh.agent?.reasoningEffort ?? ''}`;
      if (state.modelKey && state.modelKey !== key) state.runner?.resetParentForModelChange?.();
      state.modelKey = key;
    }
    if (fresh) armSchedules(fresh);
    // 工具集/模型可能刚被改过：预设按需重注册（签名未变则是空操作）
    if (fresh) void ensureMailPreset(fresh).catch((err) => log.warn(`[mail-automation] 重注册邮件预设失败：${err?.message ?? err}`));
    return fresh;
  }

  /**
   * 补齐「已声明但还没解析到值」的来源密码（`passwordRef`）。
   *
   * 指南的凭据缝约定是**每次操作前重新解析**：`ctx.credentials.resolve()` 读的是当前值，
   * 所以轮换密钥应该在下一次轮询就生效。只在启动时解析一次的实现会退化成
   * 「改了密码必须重启 DSH」，所以这里在每轮轮询 / 每次基线之前补一次；
   * 解析不到的 ref 用 5 分钟退避（否则每 30 秒往日志里刷一条 WARN）。
   *
   * 只在「声明了 passwordRef 且当前没有值」时才走这条路，平时零开销。
   *
   * 另外还管「迟到的升级」：启动太早、`ctx.credentials` 还没装载完文档时，密码会来自
   * 本插件的文件兜底（层名 `credentials-file`）。值虽然一样，但那是**第二份解析实现**，
   * 不该长期顶着用——这类来源会被当成「待升级」，下一次轮询再试一次官方缝，
   * 成功后层名变成 `credentials:file`，重试自然停止。
   */
  /** 解析不到 passwordRef 时的退避（毫秒）：来自配置 `credentials.secretRetrySeconds` */
  const secretRetryMs = (cfg) => Math.max(30, Number(cfg?.credentials?.secretRetrySeconds ?? 300)) * 1000;

  async function ensureSecrets(cfg, { force = false } = {}) {
    const declared = (cfg?.sources ?? []).filter((source) => source.passwordRef);
    if (declared.length === 0) return cfg;
    const now = Date.now();
    // force 用于凭据变更事件：连已有值也重解，否则轮换/清空一个已在用的密码时，
    // 进程里会一直拿着旧值。平时只补「没有值」或「值来自兜底」的，并做退避。
    const targets = force
      ? declared
      : declared.filter((source) => {
          const hasValue = state.secrets[source.id] ?? state.secrets[source.name];
          const degraded = isFallbackLayer(state.secretLayers[source.id] ?? state.secretLayers[source.name]);
          if (hasValue && !degraded) return false;
          return now - (state.secretRetryAt[source.id] ?? 0) > secretRetryMs(cfg);
        });
    if (targets.length === 0) return cfg;
    for (const source of targets) state.secretRetryAt[source.id] = now;
    try {
      const { secrets: resolved, layers } = await resolveSourceSecretsDetailed(ctx, cfg.sources, { logger: log, dshHome });
      if (force) {
        // 以这次解析结果为准重建：ref 被删掉或清空后不能继续沿用旧值
        const next = {};
        for (const source of cfg.sources) {
          const value = resolved[source.id] ?? resolved[source.name];
          if (!value) continue;
          next[source.id] = value;
          if (source.name && source.name !== source.id) next[source.name] = value;
        }
        state.secrets = next;
        state.secretLayers = layers;
      } else {
        state.secrets = { ...state.secrets, ...resolved };
        state.secretLayers = { ...state.secretLayers, ...layers };
      }
    } catch (err) {
      log.warn(`[mail-automation] 重新解析来源凭据失败：${err?.message ?? err}`);
      return cfg;
    }
    // 解析结果要重新走一遍配置合并，来源密码才会被 normalizeSource 取到
    return refreshConfig() ?? cfg;
  }

  // ───────────────────────── 轮询 ─────────────────────────

  /**
   * 轮询一个来源。
   *
   * `persist: false` 时**不推进游标**——调用方要等这一批邮件真正落盘之后才提交。
   * 这是崩溃安全的要点：先推进游标再归档，一旦进程在归档中间被杀，这批邮件既没有存档
   * 也再不会被拉到（游标已越过），等于永久丢信。宁可下次重复拉一遍（同一封会命中
   * 同一个存档目录、覆盖自己），也不要丢。
   */
  async function pollSource(source, { persist = true } = {}) {
    const prev = state.store.sourceState(source.id);
    // G6：基线/快照取多少封来自配置；这里没有 tick 的 `c` 局部变量，必须从 state.cfg 现取
    const initialHeaders = state.cfg?.monitor?.initialHeaders ?? 10;
    const provider = mailSources.providerFor(source.type);
    const result = await provider.poll(source, prev, { initialHeaders });
    // 游标类异常（UIDVALIDITY 变化、游标超过服务器最新、historyId 过期）必须让人看得见
    for (const warning of result.warnings ?? []) log.warn(`[mail-automation] ${source.name}：${warning}`);
    if (persist) {
      commitSourceState(source, result.state, 'persist');
    }
    return result;
  }

  /**
   * 提交来源游标前确认"这个来源现在还在配置里，而且身份没变"。
   *
   * 删除来源不持轮询锁：一次网络轮询（可达数十秒）返回后，tick 会无条件
   * `setSourceState(source.id, …)` —— 刚删掉的来源游标又被写回，违背"删除时清游标"
   * 的语义（以后加回同 id 会接上一条指向别的账号的旧游标）。
   * 改文件夹/协议但 id 不变时，在途轮次也必须被拒绝，否则旧文件夹的游标会覆盖新基线。
   */
  function commitSourceState(source, next, reason = '') {
    const live = (state.cfg?.sources ?? []).find((item) => item.id === source.id);
    const sameIdentity = live
      && ['type', 'user', 'host', 'folder', 'mailbox'].every(
        (key) => String(live[key] ?? '') === String(source[key] ?? ''),
      );
    if (!sameIdentity) {
      log.warn(
        `[mail-automation] 来源「${source.name}」已被删除或身份已变更：本轮不提交它的游标` +
          `${reason ? `（${reason}）` : ''}，避免旧游标覆盖新基线`,
      );
      return false;
    }
    state.store.setSourceState(source.id, next);
    state.store.save();
    return true;
  }

  async function fetchBody(source, header) {
    return mailSources.providerFor(source.type).fetchBody(source, header);
  }

  /**
   * 回收"当前配置里已经不存在"的连接（改 id / 删来源之后旧键不会再被用到）。
   * 只有长连接协议（IMAP / POP3）有池；Gmail/Graph 是无状态 HTTP，传进来是无害的空操作。
   */
  function imapPrune(list) {
    return mailSources.pruneSources(new Set((list ?? []).map((source) => source.id)));
  }

  /** 提示词里用到的存档路径变量（目录布局见 store.js 注释） */
  function archiveVars(dir, value = {}) {
    return {
      source: value.source ?? '',
      subject: value.subject ?? '',
      from: value.from ?? '',
      date: value.date ?? '',
      // 「现在」由插件补：邮件 agent 用的是极简预设（`includeRuntimeContext: false`），
      // 宿主不会注入运行时上下文，没有这一行它就无法判断「24 小时内」这类紧急度。
      now: new Date().toLocaleString('zh-CN', { hour12: false }),
      // agent 只拿到目录，正文/HTML/预览图都通过 mail_automation_archive_read 按需取
      mail_dir: dir,
      mail_file: archiveFile.text(dir),
      conclusion_file: archiveFile.conclusion(dir),
      preview_file: archiveFile.preview(dir),
    };
  }

  /**
   * 渲染进程 runner：**优先走 `ctx.subprocess` 缝**（§6 扩展点表：进程执行交给 ctx.subprocess，
   * 由它统一处理超时/终止/回收），缝还没就绪时先用本地 spawn，`subprocess` 一旦出现就升级过去。
   */
  let runnerState = { seam: undefined, run: null };
  function getRenderRunner() {
    let seam;
    try {
      seam = ctx.get?.('subprocess');
    } catch {
      seam = undefined;
    }
    if (!runnerState.run || (seam && !runnerState.seam)) {
      runnerState = {
        seam,
        run: createProcessRunner(seam, { onFallback: (message) => log.warn(`[mail-automation] ${message}`) }),
      };
      // 一次一行，把「这次用的是缝还是本地 spawn」变成可核对的事实：没有这一行，
      // `subprocess` 服务缺席时插件会**静默**退回本地实现，事后无从判断到底走了哪条路。
      log.info(
        `[mail-automation] 预览图渲染进程：${seam ? 'ctx.subprocess 缝' : '本地 spawn（本组未挂载 subprocess 服务）'}`,
      );
    }
    return runnerState.run;
  }

  /**
   * HTML 正文先渲染成 preview.png（agent 可以直接看版式）。
   * 失败只记日志：没有预览图时 agent 还能读 body.txt / body.html。
   * 视口宽度 / 切片高度 / 重叠 / 最大高度 / 是否放行远程资源 / 浏览器路径全部来自配置 `render.*`
   * （不同模型看长图的能力不一样，浏览器装在哪里也因机器而异）。
   */
  async function makePreview(dir, render = {}) {
    const html = archiveFile.html(dir);
    if (!fs.existsSync(html)) return null;
    try {
      const preview = await renderHtmlPreview(html, archiveFile.preview(dir), {
        width: render.width,
        sliceHeight: render.sliceHeight,
        overlap: render.sliceOverlap,
        maxHeight: render.maxHeight,
        remoteImages: render.remoteImages,
        browser: render.browser,
        run: getRenderRunner(),
      });
      state.store.attachPreview(dir, 'preview.png', preview);
      const failed = Array.isArray(preview.failedSlices) ? preview.failedSlices : [];
      const sliced = Array.isArray(preview.slices) && preview.slices.length > 0 ? `（超长，切 ${preview.slices.length} 片）` : '';
      log.info(`[mail-automation] 预览图已渲染：${preview.width}×${preview.height}${sliced} → ${preview.file}`);
      if (failed.length > 0) {
        // U5：之前分片失败被空 catch 吞掉，调用方只看到"少了几片"当正常；这里必须让人知道预览不完整
        log.warn(
          `[mail-automation] 预览图分片缺失 ${failed.length}/${failed.length + preview.slices.length}：` +
            failed
              .slice(0, 5)
              .map((item) => `第 ${item.index} 片（${item.error}）`)
              .join('；') +
            '；agent 看到的分片不完整',
        );
      }
      return preview;
    } catch (err) {
      log.warn(`[mail-automation] 预览图渲染失败：${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * 阶段一：把一封新邮件**落盘**（原始报文 + HTML + 纯文本 + meta.json）。
   *
   * 与"交给 agent"分开，是为了实现「一次到多封时，列表先把它们全列出来」：
   * agent 处理是串行的（一封几秒到几十秒），如果边处理边落盘，设置页里就只会在
   * 第一封处理完之后才看到第二封。
   */
  async function archiveMail(source, header) {
    const body = await fetchBody(source, header);
    const mail = { sourceId: source.id, sourceName: source.name, header, body };
    const dir = state.store.writeMail(mail);
    state.store.save();
    const subject = body.subject || header.subject;
    log.info(`[mail-automation] 新邮件已存档：${source.name} | ${subject} → ${dir}`);
    return { header, body, dir, subject };
  }

  /** 阶段二：把一封**已落盘**的邮件交给 agent 处理，结论写成 conclusion.md */
  async function processArchived(c, source, item) {
    const { header, body, dir, subject } = item;

    // 有 HTML 正文：先出预览图，再用专门的 HTML 提示词（普通邮件完全不用这份）
    const preview = await makePreview(dir, c.render);
    const template = loadMailPrompt(c, Boolean(preview) || fs.existsSync(archiveFile.html(dir)));

    const prompt = fillTemplate(
      template,
      archiveVars(dir, {
        source: source.name,
        subject,
        from: body.from || header.from,
        date: body.date || header.date,
      }),
    );

    /*
     * 任何**抛出**的处理异常（而不是返回 ok:false）也要归到"处理失败"，
     * 写失败占位 + 进重试队列；否则邮件会停在"待处理"（没有 conclusion），
     * 只能等下次启动的 adoptOrphans 才被发现。
     */
    let result;
    try {
      result = await state.runner.run({
        prompt,
        workspace: c.agent.workspace,
        sessionMode: c.agent.sessionMode,
        label: `${source.name}｜${subject}`,
      });
    } catch (err) {
      result = { ok: false, error: `处理流程异常：${err?.message ?? err}` };
    }

    const turn = classifyTurn(result);
    if (turn.outcome === 'ok') {
      state.store.writeConclusion(dir, turn.text);
      log.info(`[mail-automation] agent 处理完成：${subject} → ${archiveFile.conclusion(dir)}`);
      return { dir, result, outcome: 'ok', error: '' };
    }

    // 失败 / 空回合：都写失败占位（前缀保留），并记一笔待重试（A2）
    log.warn(`[mail-automation] agent 处理失败（${subject}）：${turn.error}`);
    const written = state.store.writeConclusion(dir, turn.placeholder, { error: turn.error });
    if (!written) {
      // 目录刚被总览删掉：不要再造一条指向不存在目录的 retry
      return { dir, result, outcome: 'gone', error: turn.error };
    }
    const key = String(header?.id ?? header?.uid ?? `archive:${path.basename(dir)}`);
    // 域后端忌讳原地改对象：换一个新对象再放回去（见 store.js 的注释）
    state.store.state.retries[key] = {
      dir,
      file: dir,
      sourceId: source.id,
      attempts: (state.store.state.retries[key]?.attempts ?? 0) + 1,
      lastError: turn.error,
      at: new Date().toISOString(),
    };
    state.store.save();
    return { dir, result, outcome: turn.outcome, error: turn.error };
  }

  /** 重试之前失败的邮件（每封最多 `agent.retryAttempts` 次） */
  async function retryPending(c, me) {
    const retries = state.store.state.retries ?? {};
    const ids = Object.keys(retries);
    if (ids.length === 0) return 0;
    const maxAttempts = Math.max(1, Number(c?.agent?.retryAttempts ?? 3));
    let done = 0;
    /** 同一目录可能有多条 retry（旧 key + 新 key、手动重试 + 自动重试）：一拍只允许跑一次 */
    const seenDirs = new Set();
    for (const id of ids) {
      if (state.disposed || !lock.beat(me)) break;
      const entry = retries[id];
      if (!entry || entry.attempts >= maxAttempts) {
        // A3：预算耗尽（含把 retryAttempts 调小的情况）也要留可见痕迹，否则下次启动又白试一轮
        const spent = entry?.dir ?? entry?.file;
        if (spent && fs.existsSync(spent)) {
          state.store.markGivenUp(spent, {
            attempts: entry.attempts ?? 0,
            maxAttempts,
            error: entry.lastError || '重试次数已达上限',
          });
          log.error(`[mail-automation] 重试 ${maxAttempts} 次仍失败，已放弃自动重试（设置页可手动重试）：${spent}`);
        }
        delete retries[id];
        continue;
      }
      const dir = entry.dir ?? entry.file;
      if (!dir || !fs.existsSync(dir)) {
        delete retries[id];
        continue;
      }
      if (seenDirs.has(dir)) {
        delete retries[id];
        state.store.save();
        continue;
      }
      seenDirs.add(dir);
      /*
       * 已经有正常结论的不要再跑一次：`adoptOrphans` / 上一轮失败后成功重拉都可能留下
       * 一条陈旧 retry 记录，不清理就会出现"同一封跑两遍 agent"（重复 token + 重复 QQ）。
       */
      if (state.store.conclusionState(dir).outcome === 'ok') {
        delete retries[id];
        state.store.save();
        continue;
      }
      const meta = readMeta(dir) ?? {};
      /*
       * 来源 id 改过（B-N2）后，旧的 retries 记录匹配不到任何当前来源。
       * 以前回退 `c.sources[0]`，会把 `{{source}}` 和会话标签说成另一个邮箱；
       * 存档自己的 meta 才是正确来源。
       */
      const source = c.sources.find((s) => s.id === entry.sourceId)
        ?? { id: meta.source_id ?? '', name: meta.source || meta.source_id || '（来源已删除）' };
      if (lock.holds(me)) state.processingDir = dir;
      const prompt = fillTemplate(
        loadMailPrompt(c, fs.existsSync(archiveFile.html(dir))),
        archiveVars(dir, {
          source: source?.name ?? meta.source ?? '',
          subject: meta.subject ?? '',
          from: meta.from ?? '',
          date: meta.date ?? '',
        }),
      );
      const result = await state.runner.run({
        prompt,
        workspace: c.agent.workspace,
        sessionMode: c.agent.sessionMode,
        label: `${source?.name ?? ''}｜${meta.subject ?? id}`,
      });
      // 回合期间可能被接管（看门狗/卸载）：没锁就不要写回，否则会覆盖新轮的状态
      if (!lock.holds(me)) break;
      const turn = classifyTurn(result);
      if (turn.outcome === 'ok') {
        state.store.writeConclusion(dir, turn.text);
        delete retries[id];
        state.store.save();
        done += 1;
        log.info(`[mail-automation] 重试成功：${meta.subject ?? id}`);
      } else {
        // **不要原地改 entry**：domain 后端下这就是域里存的那条对象，storage.md 要求
        // "replace via put/update, never mutate in place"。换成新对象再放回去。
        const next = {
          ...entry,
          attempts: entry.attempts + 1,
          lastError: turn.error,
          at: new Date().toISOString(),
        };
        if (next.attempts >= maxAttempts) {
          // A3：放弃时写"已放弃"占位结论 + meta 标记，重启后 adoptOrphans 不会再白试
          state.store.markGivenUp(dir, { attempts: next.attempts, maxAttempts, error: next.lastError });
          delete retries[id];
          log.error(`[mail-automation] 重试 ${maxAttempts} 次仍失败，已放弃自动重试（设置页可手动重试）：${meta.subject ?? id}`);
        } else {
          retries[id] = next;
        }
        state.store.save();
      }
    }
    if (lock.holds(me)) state.processingDir = '';
    return done;
  }

  /**
   * 一批新邮件：**先全部落盘，再逐封交给 agent**。
   *
   * 顺序是有意的：agent 串行处理一封要几秒到几十秒，若边存档边处理，
   * 设置页的"待总览"列表只会在第一封处理完之后才出现第二封。先落盘则一次到 N 封
   * 就立刻列出 N 行（未打勾），随后逐行打勾。
   *
   * 返回 `{ processed, saved, lost, blocking, aborted }`（C1）：
   *   - `lost`     本批没落盘的邮件（主题，用于日志/状态文案）
   *   - `blocking` 还应该重试的失败（没到上限、也不是 UIDVALIDITY 变化）→ 调用方**不许提交游标**
   *   - `aborted`  卸载中途被打断 → 同样不许提交
   */
  async function handleNewHeaders(c, source, headers, me) {
    const saved = [];
    const lost = [];
    const blocking = [];
    let aborted = false;
    const maxAttempts = Math.max(1, Number(c?.monitor?.archiveRetryAttempts ?? 3));

    for (const header of headers) {
      // 卸载、或被看门狗/手动接管：从这一封起停止（不再归档、不提交游标）
      if (state.disposed || !lock.beat(me)) {
        aborted = true;
        break;
      }
      const key = String(header?.id ?? header?.uid ?? header?.subject ?? '');
      try {
        saved.push(await archiveMail(source, header));
        state.archiveAttempts.delete(key);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        state.lastError = message;
        // 逐封失败也要写时间：否则设置页只有一行文字、没有"什么时候失败的"
        state.lastErrorAt = Date.now();
        lost.push(header?.subject ?? key);
        const attempts = (state.archiveAttempts.get(key) ?? 0) + 1;
        state.archiveAttempts.set(key, attempts);
        /*
         * 三类失败分开处置（都不静默）：
         *   1. UIDVALIDITY 已变：重试永远失败，而且重试取到的是"另一封信"，立刻放弃；
         *   2. 连续失败超过上限：放弃这一封并 ERROR 留痕 —— 否则一封坏信会把整个来源
         *      永远卡在同一个游标上（IMAP 的 SEARCH 会一直返回它）；
         *   3. 其余（瞬时故障）：留在 blocking，本轮不提交游标，下一轮重来。
         */
        if (err?.code === 'EUIDVALIDITY' || err?.code === 'EGONE') {
          state.archiveAttempts.delete(key);
          log.error(`[mail-automation] ${source.name}｜${header?.subject ?? key}：${message}（已跳过该封）`);
        } else if (attempts > maxAttempts) {
          state.archiveAttempts.delete(key);
          state.lastError = `${message}（连续 ${attempts - 1} 次失败，已跳过该封）`;
          log.error(`[mail-automation] ${source.name}｜${header?.subject ?? key}：${state.lastError}`);
        } else {
          blocking.push(header);
          log.warn(`[mail-automation] 存档邮件失败（第 ${attempts} 次，下一轮重试；${header?.subject}）：${message}`);
        }
      }
    }
    if (saved.length === 0) return { processed: 0, saved: 0, lost, blocking, aborted };

    let processed = 0;
    if (lock.holds(me)) state.activity = 'processing';
    try {
      for (const item of saved) {
        if (state.disposed || !lock.beat(me)) {
          aborted = true;
          break;
        }
        /*
         * 上一轮没提交游标时，这一批会被重拉一遍：已经有结论（ok / failed）的不要再跑一次
         * agent —— 否则重复烧 token、还可能重复推 QQ。失败结论仍走 retries / adoptOrphans。
         */
        const verdict = state.store?.conclusionState?.(item.dir) ?? { outcome: 'pending' };
        if (verdict.outcome !== 'pending') {
          log.info(`[mail-automation] 跳过已处理过的邮件（${verdict.outcome}）：${item.subject}`);
          continue;
        }
        if (lock.holds(me)) state.processingDir = item.dir;
        try {
          const turn = await processArchived(c, source, item);
          // T9：只有真正拿到结论才算"本轮处理"；失败/空回合已进 retries，由下一拍 retryPending 接手
          if (lock.holds(me) && turn?.outcome === 'ok') processed += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (lock.holds(me)) {
            state.lastError = message;
            state.lastErrorAt = Date.now();
          }
          log.warn(`[mail-automation] 处理邮件失败（${item.subject}）：${message}`);
        }
      }
    } finally {
      if (lock.holds(me)) {
        state.processingDir = '';
        state.activity = 'polling';
      }
    }
    return { processed, saved: saved.length, lost, blocking, aborted };
  }

  async function tick({ manual = false } = {}) {
    if (state.disposed) return '插件已卸载';
    if (state.lockOwner) return '上一轮轮询还没结束，本次跳过';
    const loaded = refreshConfig();
    if (!loaded) return `配置不可用：${state.lastError || '未知原因'}`;
    const me = lock.acquire('poll');
    if (!me) return '上一轮轮询还没结束，本次跳过';
    const STOP = '本轮已被接管，停止提交';
    state.activity = 'polling';
    let processed = 0;
    let failed = 0;
    const lines = [];
    let c = loaded;
    try {
      // 游标来自状态后端（domain 或 state.json）：没装载完就轮询会把「有游标」误当成「首次」
      await state.store?.ready?.();
      if (!lock.beat(me)) return STOP;
      // 声明了 passwordRef 但还没解析到值（首次、或凭据页刚改过）→ 轮询前补一次
      c = (await ensureSecrets(loaded)) ?? loaded;
      if (!lock.beat(me)) return STOP;
      // 先补跑上一轮失败的 agent（瞬时故障不该丢掉一封邮件）
      try {
        if (Object.keys(state.store?.state?.retries ?? {}).length > 0 && lock.holds(me)) {
          state.activity = 'processing';
        }
        const retried = await retryPending(c, me);
        if (retried > 0) lines.push(`重试成功 ${retried} 封`);
        if (lock.holds(me)) state.activity = 'polling';
      } catch (err) {
        log.warn(`[mail-automation] 重试失败邮件时出错：${err?.message ?? err}`);
      }
      for (const [index, source] of c.sources.entries()) {
        // 每个来源开始前确认锁还在自己手里：被接管后不再拉取、不再提交任何游标
        if (!lock.beat(me)) return STOP;
        try {
          const result = await pollSource(source, { persist: false });
          if (result.mode === 'unbound') {
            // Graph/Gmail 还没绑定：跳过，不报错也不推进游标
            lines.push(`${source.name}：尚未绑定，跳过`);
            continue;
          }
          if (result.mode === 'baseline') {
            lines.push(`${source.name}：建立基线 ${result.headers.length} 封`);
            if (!lock.holds(me)) return STOP;
            commitSourceState(source, result.state, 'baseline');
            continue;
          }
          if (result.mode === 'idle' || result.headers.length === 0) {
            lines.push(`${source.name}：无新邮件`);
            if (!lock.holds(me)) return STOP;
            commitSourceState(source, result.state, 'idle');
            continue;
          }
          lines.push(`${source.name}：新邮件 ${result.headers.length} 封`);
          const outcome = await handleNewHeaders(c, source, result.headers, me);
          processed += outcome.processed;
          if (!lock.holds(me)) return STOP;
          if (!shouldAdvanceCursor(outcome)) {
            /*
             * 没全落盘 / 被卸载中断：**不提交游标**，下一拍从旧游标重来。
             * 这是"宁可重复拉一遍，也不丢一封"的落点：重复的那几封会被
             * `handleNewHeaders` 的"已有结论就跳过"挡住，不会重复烧 token。
             */
            failed += 1; // 否则下面 "整轮都成功" 的分支会把刚写下的 lastError 清掉
            state.lastErrorAt = Date.now();
            lines.push(`${source.name}：${outcome.lost.length} 封未能存档，游标未推进（下一轮重试）`);
            continue;
          }
          commitSourceState(source, result.state, 'new');
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          failed += 1;
          if (lock.holds(me)) {
            state.lastError = message;
            state.lastErrorAt = Date.now();
          }
          log.warn(`[mail-automation] 轮询 ${source.name} 失败：${message}`);
          lines.push(`${source.name}：失败（${message}）`);
        }
      }
      // 改过 source id 之后，旧键的 IMAP 长连接不会再被用到：按当前来源集合回收
      imapPrune(c.sources);
      if (!lock.holds(me)) return STOP;
      state.lastTickAt = Date.now();
      // 整轮都成功：把上一次的失败痕迹清掉（设置页的"上次失败"提示随之消失）。
      // 但配置错误是粘性的：还在用旧配置跑，清掉就等于把问题藏起来。
      if (failed === 0 && !state.configError) {
        state.lastError = '';
        state.lastErrorAt = 0;
      }
      if (manual) lines.push(`本轮处理 ${processed} 封`);
      return lines.join('\n');
    } finally {
      // 只释放自己的锁：被接管后这里必须是空操作，否则会清新轮的锁（L1）
      lock.release(me);
    }
  }

  /**
   * 手动"立即重试拉取"（设置页按钮 / `mail_automation_config` 的 retry_poll）。
   *
   * 除了正常跑一轮，它还负责**解开卡住的那一轮**：网络断开、休眠唤醒时宿主调用可能
   * 一直不返回，锁就一直是别人的，之后每一拍都被"上一轮还没结束"挡掉。
   *
   * 判定改成看**进度心跳**而不是总时长（L1）：
   *   - 定时任务轮永不抢占（任务可能正在删存档/发 QQ）；
   *   - 其余的给一个比自动看门狗更短的"确认窗"（max(2×轮询, 60s)），
   *     既保留用户自救能力，又不会在正常长批次中途被手滑点掉。
   */
  async function retryPoll() {
    if (state.disposed) return { ok: false, error: '插件已卸载' };
    const owner = state.lockOwner;
    if (owner) {
      const idle = lock.idleMs();
      if (state.lockKind === 'schedule') {
        return { ok: false, error: `正在执行定时任务（${Math.round(idle / 1000)}s 前有进展），本次不接管` };
      }
      const pollMs = Math.max(5, Number(state.cfg?.monitor?.pollSeconds ?? 30)) * 1000;
      const manualLimit = Math.max(60_000, pollMs * 2);
      if (idle < manualLimit) {
        return { ok: false, error: `上一轮还在进行（${Math.round(idle / 1000)}s 前有进展），请稍后再试` };
      }
      log.warn(
        `[mail-automation] 手动接管：上一轮已 ${Math.round(idle / 1000)}s 无进展` +
          `（阈值 ${Math.round(manualLimit / 1000)}s），作废该轮（旧轮不再提交）`,
      );
      lock.release(owner);
    }
    try {
      const text = await tick({ manual: true });
      return { ok: true, text, at: Date.now() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.lastError = message;
      state.lastErrorAt = Date.now();
      return { ok: false, error: message };
    }
  }

  /**
   * 启动基线：
   *   1. 先轮询一次——DSH 关着的时候到的新邮件在这里补处理
   *   2. 再取每个邮箱前 N 条邮件头，写快照（这就是「每次打开 DSH 自动拉前十封」）
   */
  async function baseline(loaded) {
    /*
     * 启动基线也会拉信、跑 agent（补处理关机期间到的邮件）。以前它完全不持锁，
     * 而 heartbeat 的"延迟基线"分支在 `baselined = true` 之后还会继续排拍，
     * 于是 5 秒后的 tick 会与它并发处理同一批 header —— L1 的第三个并发入口。
     */
    const me = lock.acquire('baseline');
    if (!me) {
      log.warn('[mail-automation] 已有轮次在跑，跳过本次启动基线（下一拍会重试）');
      return '';
    }
    try {
      return await runBaseline(loaded, me);
    } finally {
      lock.release(me);
    }
  }

  async function runBaseline(loaded, me) {
    // 游标必须先装载好（否则会把「已见」当成「首次」，重新建基线）
    await state.store?.ready?.();
    // 基线同样先补齐 passwordRef：启动早期凭据服务可能还没就绪，这里是第二次机会
    const c = (await ensureSecrets(loaded)) ?? loaded;
    const parts = [];
    for (const [index, source] of c.sources.entries()) {
      if (!lock.beat(me)) {
        log.warn('[mail-automation] 启动基线被接管，提前结束（未完成的来源下一拍重试）');
        break;
      }
      let missed = 0;
      try {
        const polled = await pollSource(source, { persist: false });
        // 还没绑定（Graph/Gmail）：跳过该来源，不当成失败
        if (polled.mode === 'unbound') continue;
        let outcome = null;
        if (polled.mode === 'new' && polled.headers.length > 0) {
          outcome = await handleNewHeaders(c, source, polled.headers, me);
          missed = outcome.processed;
        }
        // 与 tick 一样：这一批**落盘之后**才提交游标；没落全就不提交（C1）
        if (!lock.holds(me)) break;
        if (!shouldAdvanceCursor(outcome)) {
          state.lastError = `启动补处理：${outcome.lost.length} 封未能存档，游标未推进（下一轮重试）`;
          state.lastErrorAt = Date.now();
          parts.push(`【${source.name}】${outcome.lost.length} 封未能存档：游标未推进`);
          log.warn(`[mail-automation] ${source.name} 启动补处理：${outcome.lost.length} 封未能存档，游标保持不动`);
        } else {
          commitSourceState(source, polled.state, 'baseline');
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        state.lastError = message;
        parts.push(`【${source.name}】启动补处理失败：${message}`);
        log.warn(`[mail-automation] ${source.name} 启动补处理失败：${message}`);
      }
      try {
        const listed = await mailSources.providerFor(source.type).listHeaders(source, c.monitor.initialHeaders);
        const headers = (Array.isArray(listed) ? listed : listed.headers ?? [])
          .slice()
          .sort((a, b) => String(b.date).localeCompare(String(a.date)))
          .slice(0, c.monitor.initialHeaders);
        parts.push(`【${source.name}】前 ${headers.length} 条${missed > 0 ? `（另有 ${missed} 封新到的已交给 agent 处理）` : ''}`);
        headers.forEach((header, index) => {
          const stamp = String(header.date || '').replace('T', ' ').replace('Z', '').slice(0, 16);
          parts.push(`${index + 1}. ${stamp} ${header.from} — ${header.subject}`);
        });
        log.info(`[mail-automation] ${source.name} 启动快照 ${headers.length} 封`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        state.lastError = message;
        parts.push(`【${source.name}】启动拉取失败：${message}`);
        log.warn(`[mail-automation] ${source.name} 启动拉取失败：${message}`);
      }
    }
    imapPrune(c.sources);
    const text = parts.join('\n');
    try {
      // 只保留最新一份：每次启动覆盖 storage.root/startup.md
      const file = c.storage.snapshotFile;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `# 启动邮件头快照 · ${new Date().toLocaleString()}\n\n${text}\n`, 'utf8');
    } catch (err) {
      // 写快照失败不影响主流程，但要留痕（目录权限问题会表现为「快照莫名其妙没了」）
      log.warn(`[mail-automation] 写启动快照失败：${err?.message ?? err}`);
    }
    return text;
  }

  // ───────────────────────── 定时任务 ─────────────────────────

  /** 配置里 schedules 的签名：心跳据此发现"手改 YAML"并重排，不用重启 */
  function scheduleSignatureOf(cfg) {
    return JSON.stringify(
      (cfg?.schedules ?? []).map((task) => [
        task.id,
        task.enabled,
        task.schedule,
        task.promptFile,
        task.prompt,
      ]),
    );
  }

  function runRecordOf(task) {
    return state.store?.state?.scheduleRuns?.[task.id] ?? {};
  }

  function saveRunRecord(task, patch) {
    if (!state.store) return;
    const runs = (state.store.state.scheduleRuns ??= {});
    runs[task.id] = { ...(runs[task.id] ?? {}), ...patch };
    state.store.save();
  }

  /**
   * 进程退出时正在跑的任务不会留下收尾写入；启动后把孤立的 running 标成失败，
   * 否则界面会永远显示「运行中」（手动运行的历史字段同理）。
   */
  function recoverInterruptedRuns() {
    const runs = state.store?.state?.scheduleRuns ?? {};
    let changed = false;
    for (const [id, run] of Object.entries(runs)) {
      if (!run || typeof run !== 'object') continue;
      if (run.lastStatus === 'running') {
        run.lastStatus = 'failed';
        run.lastError = '上次运行未完成（DSH 已退出/重启）';
        changed = true;
        log.warn(`[mail-automation] 定时任务「${id}」上次运行未完成，已标记为失败`);
      }
      if (run.lastManualStatus === 'running') {
        run.lastManualStatus = 'failed';
        run.lastManualError = '上次手动运行未完成（DSH 已退出/重启）';
        changed = true;
        log.warn(`[mail-automation] 定时任务「${id}」上次手动运行未完成，已标记为失败`);
      }
    }
    if (changed) state.store.save();
  }

  /**
   * 重排所有定时任务（**单定时器槽**，lessons §4 的同一教训）。
   *
   * 每次重排都从配置 + 持久运行记录重新算一遍，所以保存配置、改 YAML、volatile 更新、
   * 重启都走同一条路径；旧的那些"今晚补发"句柄不会再各自存在、互相顶掉。
   * boot 完成前不排期（`state.baselined` 为假）：那时 store 可能还没 ready，
   * 到点执行会拿不到状态、也拿不到 agent 父会话。
   */
  function armSchedules(cfg) {
    if (state.disposed) return;
    if (state.scheduleTimer) {
      clearTimeout(state.scheduleTimer);
      state.scheduleTimer = null;
    }
    state.schedulePlan.clear();
    state.nextScheduleAt = 0;
    state.nextScheduleTask = '';
    const current = cfg ?? state.cfg;
    if (!current || !state.baselined || state.booting) {
      state.schedulesArmed = false;
      return;
    }
    const now = Date.now();
    const known = new Set((current.schedules ?? []).map((task) => task.id));
    const startupIds = new Set(
      (current.schedules ?? []).filter((task) => task.schedule?.type === 'startup').map((task) => task.id),
    );
    if (!state.startupBaselineReady) {
      state.startupKnown = startupIds;
      state.startupBaselineReady = true;
    } else {
      for (const id of startupIds) {
        if (!state.startupKnown.has(id)) state.startupDeferred.add(id);
      }
      state.startupKnown = startupIds;
    }
    for (const id of state.schedulePending.keys()) {
      // 任务被删/改 id 后，旧的 busy 退避条目要清掉，否则会一直在内存里等一个不存在的任务
      if (!known.has(id)) state.schedulePending.delete(id);
    }
    for (const id of state.intervalAnchors.keys()) {
      if (!known.has(id)) state.intervalAnchors.delete(id);
    }
    for (const task of current.schedules ?? []) {
      if (!task.enabled) continue;
      if (task.schedule?.type === 'startup' && state.startupDeferred.has(task.id)) continue;
      const pending = state.schedulePending.get(task.id);
      if (pending) {
        state.schedulePlan.set(task.id, { task, at: pending.at, slot: pending.slot });
        continue;
      }
      const run = runRecordOf(task);
      let planRun = run;
      if (task.schedule?.type === 'interval' && !run.lastRunAtMs && !run.lastRunAt) {
        // 第一次排 interval：用首次见到它的时刻作锚点，而不是每次重排都取 now。
        let anchor = state.intervalAnchors.get(task.id);
        if (!anchor) {
          anchor = now;
          state.intervalAnchors.set(task.id, anchor);
        }
        planRun = { ...run, lastRunAtMs: anchor };
      }
      const plan = planNextRun(task, planRun, now);
      if (plan.done || !plan.at) continue;
      state.schedulePlan.set(task.id, { task, at: plan.at, slot: plan.slot });
    }
    state.schedulesArmed = true;
    state.scheduleSignature = scheduleSignatureOf(current);
    if (state.schedulePlan.size === 0) {
      log.info('[mail-automation] 没有启用的定时任务（在设置页「定时任务」里添加）');
      return;
    }
    const first = [...state.schedulePlan.values()].sort((a, b) => a.at - b.at)[0];
    state.nextScheduleAt = first.at;
    state.nextScheduleTask = first.task.name;
    const delay = Math.max(0, first.at - now);
    // setTimeout 上限约 24.8 天：超长间隔分段等待，回调发现没到点会重新 arm（不会提前执行）
    const wait = Math.min(delay, 2 ** 31 - 1);
    state.scheduleTimer = setTimeout(() => {
      state.scheduleTimer = null;
      void fireScheduledTasks();
    }, wait);
    if (typeof state.scheduleTimer.unref === 'function') state.scheduleTimer.unref();
    log.info(
      `[mail-automation] 下次定时任务：「${first.task.name}」(${first.task.id}) ${describeSchedule(first.task.schedule)}` +
        ` → ${new Date(first.at).toLocaleString()}`,
    );
  }

  /** 定时器回调：把已经到点的任务串行跑完，再按新状态重排（同一时刻多个任务会排队） */
  async function fireScheduledTasks() {
    if (state.disposed) return;
    const now = Date.now();
    const due = [...state.schedulePlan.values()]
      .filter((entry) => entry.at <= now + 1_000)
      .sort((a, b) => a.at - b.at);
    for (const entry of due) {
      if (state.disposed) return;
      await runScheduledTask(entry.task, { slot: entry.slot });
    }
    if (state.disposed) return;
    armSchedules(refreshConfig() ?? state.cfg);
  }

  /**
   * 执行一条定时任务（定时触发与手动触发共用）。
   *
   * 失败处置：
   *   - 锁被轮询占着（busy）：什么都没做 → 60s 后重试，最多 3 次（`planBusyRetry`），
   *     用尽后记 `lastStatus=failed` 并等下一次排期；
   *   - 任务本身失败（agent 报错/空回复）：**不自动重跑**，只把 lastStatus/lastError 落盘，
   *     下一次排期照常。重跑只会再烧一遍 token，失败原因不会自己消失。
   *
   * at-most-once：非手动运行在开始前就把 `lastSlot` 写进状态，崩溃重启后同一槽不会重跑
   * （宁可漏一次，也不重复发 QQ）。
   */
  async function runScheduledTask(task, { slot = '', manual = false, day = '' } = {}) {
    if (!task) return { ok: false, unavailable: true, error: '任务不存在' };
    if (!state.cfg || !state.store || !state.runner) {
      return { ok: false, unavailable: true, error: '插件还没成功加载配置' };
    }
    const me = lock.acquire('schedule');
    if (!me) {
      if (!manual) {
        const current = state.schedulePending.get(task.id);
        // 轮询一般 1-5 秒结束；到点撞上轮询时快速重试，别为一次短轮询多等 60 秒。
        // 撞上 agent 处理邮件仍按 60s × 3（可能跑几分钟，重试太密只会刷日志）。
        const polling = state.activity === 'polling';
        const pollRetryMs = Math.max(1_000, Number(state.cfg?.scheduler?.busyRetrySeconds ?? 5) * 1_000);
        const pollRetryMax = Math.max(1, Math.trunc(Number(state.cfg?.scheduler?.busyRetryMax ?? 24) || 24));
        const plan = planBusyRetry({
          attempt: current?.attempt ?? 0,
          retryMs: polling ? pollRetryMs : undefined,
          maxAttempts: polling ? pollRetryMax : undefined,
        });
        if (plan.retry) {
          state.schedulePending.set(task.id, { at: plan.at, slot: current?.slot || slot, attempt: plan.attempt });
          log.warn(
            `[schedule:${task.id}] 到点但正在轮询/处理邮件：${Math.round((plan.at - Date.now()) / 1000)}s 后第 ${plan.attempt} 次重试`,
          );
        } else {
          state.schedulePending.delete(task.id);
          saveRunRecord(task, {
            lastRunAt: new Date().toISOString(),
            lastRunAtMs: Date.now(),
            lastSlot: slot,
            lastStatus: 'failed',
            lastError: 'busy：轮询/处理邮件占锁，重试次数用尽',
          });
          log.warn(`[schedule:${task.id}] 连续 ${plan.attempt} 次到点都被轮询/处理占锁：本次跳过（存档未动）`);
        }
        armSchedules(state.cfg);
      }
      return { ok: false, busy: true, error: '正在轮询/处理邮件，请稍后' };
    }

    const startedAt = Date.now();
    state.activity = 'task';
    if (!manual) {
      state.schedulePending.delete(task.id);
      saveRunRecord(task, {
        lastRunAt: new Date(startedAt).toISOString(),
        lastRunAtMs: startedAt,
        lastSlot: slot,
        lastStatus: 'running',
        lastError: '',
      });
    } else {
      // 手动运行只更新展示字段，不碰 lastRunAt/slot，因此不影响下一次排期
      saveRunRecord(task, {
        lastManualAt: new Date(startedAt).toISOString(),
        lastManualAtMs: startedAt,
        lastManualStatus: 'running',
        lastManualError: '',
      });
    }
    log.info(
      `[schedule:${task.id}] 开始执行「${task.name}」（${describeSchedule(task.schedule)}${manual ? '，手动' : ''}）`,
    );
    let result;
    try {
      await state.store.ready?.();
      const built = buildAgentTaskPrompt({ cfg: state.cfg, store: state.store, task });
      const out = await state.runner.run({
        prompt: built.prompt,
        workspace: state.cfg.agent.workspace,
        sessionMode: 'per_mail',
        label: `schedule:${task.id}`,
      });
      // 任务允许"只调工具、不写正文"（例如启动时发一条 QQ 快照）：只要回合 ok 就算成功
      // 不落任务输出文件：QQ 已由 agent 发出。
      result = {
        ok: Boolean(out.ok),
        error: out.error ?? '',
        count: built.count,
        skipped: built.skipped,
        file: '',
        text: out.text ?? '',
        removed: 0,
        decision: 'none',
      };
    } catch (err) {
      result = {
        ok: false,
        error: err?.message ?? String(err),
        count: 0,
        removed: 0,
        file: '',
        decision: 'failed',
      };
    } finally {
      lock.release(me);
      state.activity = '';
    }

    const finishedAt = Date.now();
    if (!manual) {
      saveRunRecord(task, {
        // 成功/失败展示的是"跑完"的时间，而不是开始时间（长任务差几十秒很常见）
        lastRunAt: new Date(finishedAt).toISOString(),
        lastRunAtMs: finishedAt,
        lastStatus: result.ok ? 'ok' : 'failed',
        lastError: result.ok ? '' : result.error || result.summaryError || '',
        lastFile: '',
        lastCount: Number(result.count ?? 0) || 0,
      });
    } else {
      saveRunRecord(task, {
        lastManualAt: new Date(finishedAt).toISOString(),
        lastManualAtMs: finishedAt,
        lastManualStatus: result.ok ? 'ok' : 'failed',
        lastManualError: result.ok ? '' : result.error || result.summaryError || '',
        lastManualCount: Number(result.count ?? 0) || 0,
      });
    }
    if (result.ok) {
      log.info(
        `[schedule:${task.id}] 完成「${task.name}」：${result.count ?? 0} 封` +
          `${result.removed ? `，清理 ${result.removed} 个存档` : ''}`,
      );
    } else {
      log.warn(
        `[schedule:${task.id}] 失败「${task.name}」：${result.error || result.summaryError || '未知原因'}`,
      );
    }
    return result;
  }

  // ───────────────────────── 异步引导 ─────────────────────────

  /** 启动步骤：任何一步失败都不该让轮询彻底不启动 */
  const bootStep = async (label, fn) => {
    try {
      await fn();
    } catch (err) {
      log.warn(`[mail-automation] 启动步骤「${label}」失败：${err?.message ?? err}`);
    }
  };

  /**
   * 启动时配置不可用（例如 `sources: []`）后的**延迟引导**。
   *
   * 正常启动路径在 boot IIFE 里一次性做完；但如果第一次读配置就失败，那个 IIFE 会提前 return，
   * 状态域、凭据、孤儿接管这些步骤就再也没人做——用户在设置页把第一个邮箱加回来之后，
   * 插件会以**文件后端**跑（域没打开）、并且不接管上次遗留的邮件。
   * 这里在心跳发现"配置可用了但还没基线"时，把同一套引导补齐（每步失败只 WARN）。
   */
  async function resumeBoot(current) {
    let c = current;
    await bootStep('延迟打开状态存储域', async () => {
      if (state.domainHandle) return;
      state.domainHandle = await openStateDomain(ctx, log);
      if (state.domainHandle && state.store) state.store.attachDomain(state.domainHandle);
    });
    await bootStep('延迟装载持久化状态', () => state.store?.ready?.());
    await bootStep('恢复中断的定时任务状态', () => recoverInterruptedRuns());
    await bootStep('延迟接管未处理完的邮件', () => adoptOrphans());
    if (c.sources.some((source) => source.passwordRef)) {
      await bootStep('延迟解析来源密码', async () => {
        const { secrets, layers } = await resolveSourceSecretsDetailed(ctx, c.sources, { logger: log, dshHome });
        state.secrets = secrets;
        state.secretLayers = layers;
      });
      c = refreshConfig() ?? c;
    }
    await bootStep('延迟注册邮件预设', () => ensureMailPreset(c));
    await bootStep('延迟准备 agent 环境', () => prepareAgent(c));
    await bootStep('延迟基线', () => baseline(c));
    await bootStep('延迟排定定时任务', () => armSchedules(c));
  }

  async function prepareAgent(current) {
    await state.runner?.ready?.();
    await state.runner?.cleanupChildren?.();
    await state.runner?.ensureParent?.(current.agent.workspace);
    warnIfBillionContextUnarmed();
  }

  /**
   * 提醒「装了 billion-context，但折叠没武装」。
   *
   * bili 的车道身份是「会话 id + system prompt 哈希」，system prompt 一变就开一条零折叠的新
   * 车道；只有在 `compress.externalSummary.enabled + autoFold` 打开时，它才会在超窗时先折叠
   * 再送，否则直接 fail-fast 成 413（2026-11-07 的 19.5 MB / 413 事故，详见 docs/lessons.md）。
   * 没装 bili 的人不该看到这条，装了就提示一次。
   *
   * 探测/读配置失败一律静默：这只是提示，不能因为读不到别人的目录就影响启动。
   */
  let billionContextWarned = false;
  function warnIfBillionContextUnarmed() {
    if (billionContextWarned) return;
    billionContextWarned = true;
    try {
      const biliPresent = detectBillionContext();
      if (!biliPresent) return;
      const verdict = billionContextFoldVerdict({ biliPresent, config: readBillionContextConfig() });
      if (verdict.needed) log.warn(`[mail-automation] ${verdict.reason}`);
    } catch {
      // 提示失败不影响启动
    }
  }

  /**
   * 接管"该处理却没处理完"的邮件（崩溃/关机的安全网，也是失败后的第二次机会）。
   *
   * 三种状态都算"没处理完"：
   *   - 没有 conclusion.md（进程在归档后、交给 agent 前被杀，或 agent 跑到一半）；
   *   - conclusion.md 是**失败占位**（agent 处理失败、重试耗尽后放弃）。
   * 这两类既不在 retries 里，也不会被下一次轮询发现（游标早已越过），不主动接管就会永远
   * 停在失败/空白状态。接管时清掉失败占位结论并重置 attempts（每次启动给一轮新预算），
   * 下一拍由 retryPending 处理。**已正常处理完的（ok）不动**，避免无意义重复烧 token。
   */
  async function adoptOrphans() {
    if (!state.store) return 0;
    const retries = (state.store.state.retries ??= {});
    let adopted = 0;
    const keptGivenUp = [];
    for (const item of state.store.listArchived()) {
      const dir = item.dir ?? item.file;
      if (!dir) continue;
      const verdict = state.store.conclusionState(dir);
      if (verdict.outcome === 'ok') continue;
      /*
       * A3：已经"放弃自动重试"的不要再接管。以前这里会把失败占位清掉、attempts 归零，
       * 于是每次重启又白烧 `agent.retryAttempts` 轮，连"试过几次"的证据都被抹掉。
       */
      if (state.store.givenUp(dir)) {
        keptGivenUp.push(item.subject || dir);
        continue;
      }
      const key = String(item.id || `adopt:${item.name || path.basename(dir)}`);
      if (retries[key]) continue;
      let lastError = '上次处理未完成（进程退出/重启）';
      if (verdict.outcome === 'failed') {
        // 失败占位结论先清掉：否则列表会一直显示"失败"，重试成功也看不出变化
        state.store.clearConclusion(dir);
        lastError = `上次处理失败：${verdict.error || '未知原因'}`;
      }
      retries[key] = {
        dir,
        file: dir,
        sourceId: item.source_id || item.sourceId || '',
        attempts: 0,
        lastError,
        at: new Date().toISOString(),
      };
      adopted += 1;
    }
    if (adopted > 0) {
      state.store.save();
      log.info(`[mail-automation] 接管 ${adopted} 封未处理完的邮件，下一拍重试`);
    }
    if (keptGivenUp.length > 0) {
      // 跳过也必须留痕，否则"不再自动重试"就变成新的静默
      log.warn(
        `[mail-automation] ${keptGivenUp.length} 封已放弃自动重试，启动时不再接管（设置页「重试失败邮件」可手动再来）：` +
          keptGivenUp.slice(0, 5).join('、') +
          (keptGivenUp.length > 5 ? '…' : ''),
      );
    }
    return adopted;
  }

  /** 心跳：到点才轮询；首次还没基线的，先补一次基线与总览排期 */
  async function heartbeat() {
    /*
     * 看门狗放在最前：`state.booting` 期间也要能作废"没进度"的轮次，
     * 否则 boot 卡住时监控会永久停摆（而且以前 `running && runningSince` 这个条件
     * 对总览恒假 —— 总览从不设 runningSince）。
     */
    const current = state.cfg ?? refreshConfig();
    if (current && state.lockOwner) {
      const limit = staleMsFor(current.monitor.pollSeconds, current.agent.turnTimeoutSeconds);
      const idle = lock.idleMs();
      if (idle > limit) {
        if (state.lockKind === 'schedule') {
          // 定时任务正在删存档/发 QQ：抢它只会制造半完成态。只告警，等人处理。
          if (!state.scheduleStaleWarned) {
            state.scheduleStaleWarned = true;
            log.warn(
              `[mail-automation] 定时任务已 ${Math.round(idle / 1000)}s 无进展（不自动抢占；若确实卡死请重启 DSH 或等待回合超时）`,
            );
          }
        } else {
          log.warn(
            `[mail-automation] 上一轮已 ${Math.round(idle / 1000)}s 无进展（阈值 ${Math.round(limit / 1000)}s），` +
              '作废该轮（旧轮不再提交）',
          );
          lock.release(state.lockOwner);
        }
      }
    }
    if (state.booting) return;
    if (!state.baselined) {
      const boot = current;
      if (!boot) return;
      state.baselined = true;
      // 配置从"无效"恢复（如零来源 -> 用户加了第一个邮箱）：补齐完整引导，而不是只跑基线
      await bootStep('延迟初始化', () => resumeBoot(boot));
      return;
    }
    if (!current) return;
    /*
     * 手改 YAML 的 schedules 不会发 loader 事件：心跳每拍比较签名，变了就重排。
     * 先判断再 arm —— arm 会清/建定时器并打一行日志，不能每拍都做。
     */
    const scheduleSig = scheduleSignatureOf(current);
    if (!state.schedulesArmed || scheduleSig !== state.scheduleSignature) armSchedules(current);
    const intervalMs = Math.max(5, Number(current.monitor.pollSeconds)) * 1000;
    if (Date.now() - state.lastTickAt < intervalMs) return;
    await tick();
  }

  void (async () => {
    // 凭据只走 passwordRef / ctx.credentials（旧版的 dsh-email 账号复用已删除）

    let current = refreshConfig();
    if (!current) {
      // 零来源已经在 refreshConfig 里按"待配置"记过 INFO；这里不再补一条吓人的 WARN
      if (!state.setupRequired) {
        log.warn(`[mail-automation] 启动时配置不可用（${configFile || 'cordis.yml'}）；心跳仍会启动，配置恢复后自动补基线`);
      }
      return;
    }

    /*
     * 老版本扫码只写了 YAML qq.app_id 和 QQ_BOT_SECRET；其它 QQ 插件按 QQ_BOT_APP_ID
     * 读不到 AppID。启动时补一次凭据（已有相同值则跳过），不必重新扫码。
     */
    await bootStep('同步 QQ_BOT_APP_ID 凭据', async () => {
      const appId = String(current.qq?.appId ?? '').trim();
      if (!appId) return;
      const service = (() => {
        try {
          const found = ctx.get?.('credentials');
          return found?.set ? found : undefined;
        } catch {
          return undefined;
        }
      })();
      if (!service) return;
      let existing;
      try {
        existing = await service.resolve?.('QQ_BOT_APP_ID');
      } catch {
        existing = undefined; // 还没写过/解析失败：当作空，继续写
      }
      if (String(existing?.value ?? '') === appId) return;
      await service.set('QQ_BOT_APP_ID', appId);
      log.info('[mail-automation] 已同步 QQ_BOT_APP_ID 到凭据（供其它 QQ 插件复用）');
    });

    /*
     * 状态后端：优先 DSH 的 domain KV 存储（ctx.storageDomain），拿不到就继续用 state.json。
     * 这一步必须在**基线/轮询之前**完成——它们要读游标，读到空游标会退化成重新建基线。
     */
    await bootStep('打开状态存储域', async () => {
      state.domainHandle = await openStateDomain(ctx, log);
      if (state.domainHandle && state.store) state.store.attachDomain(state.domainHandle);
    });
    await bootStep('装载持久化状态', () => state.store?.ready?.());
    await bootStep('恢复中断的定时任务状态', () => recoverInterruptedRuns());
    // 上次没跑完的邮件先接管（否则它们既不会被轮询发现，也永远没有结论）
    await bootStep('接管未处理完的邮件', () => adoptOrphans());

    // passwordRef 需要「合并后的来源列表」才能解析：先用无密码配置读一次，再解析、再读一次
    if (current.sources.some((source) => source.passwordRef)) {
      await bootStep('解析来源密码', async () => {
        const { secrets, layers } = await resolveSourceSecretsDetailed(ctx, current.sources, { logger: log, dshHome });
        state.secrets = secrets;
        state.secretLayers = layers;
      });
      current = refreshConfig();
      if (!current) return;
    }

    await bootStep('注册邮件预设', () => ensureMailPreset(current));
    await bootStep('准备 agent 环境', () => prepareAgent(current));
    // 只读一遍预设清单写日志（不 resolve mail-automation-agent）：出问题时能一眼看出预设有没有装上
    await bootStep('列出 agent 预设', () => state.runner?.logPresetsOnce?.(ctx.get?.('agentPresets')));
    await bootStep('启动基线', () => baseline(current));
    state.baselined = true;
    // 先解除 booting 再排期：armSchedules 会拒绝在 boot 期间建定时器（store/agent 可能还没就绪）
    state.booting = false;
    await bootStep('排定定时任务', () => armSchedules(current));
  })()
    .catch((err) => log.warn(`[mail-automation] 启动失败：${err?.message ?? err}`))
    .finally(() => {
      state.booting = false;
    });
}

/**
 * 把插件自带的 skill 注册给 agent（每个注册都包在 ctx.effect 里：
 * `skills.register()` 返回的是 Cordis effect disposer，不接管就会在重载后残留重复条目）。
 *
 * 注意 `source: 'runtime'` 是 `ctx.skills.get()` 的硬性字段：register() 只做宽松校验不补它，
 * get() 里的 validateDefinition 却要求字符串 —— 少了它 catalog 能列出条目，
 * 真正加载时才报 `source must be a string`（实测踩过，两个 skill 都中招）。
 */
function registerSkills(ctx, log) {
  const registerAll = (service) => {
    const disposers = [];
    for (const entry of SKILLS) {
      const dir = path.join(PLUGIN_DIR, 'skills', entry.name);
      const file = path.join(dir, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      try {
        const { description, content } = readSkillFile(file);
        const dispose = service.register({
          name: entry.name,
          description: description || entry.description,
          content,
          source: 'runtime',
          path: file,
          resourceBase: { kind: 'directory', path: dir },
        });
        if (typeof dispose === 'function') disposers.push(dispose);
      } catch (err) {
        log.warn(`[mail-automation] 注册 skill「${entry.name}」失败：${err?.message ?? err}`);
      }
    }
    return disposers;
  };

  const bind = (owner, target) => {
    owner.effect(() => {
      const disposers = registerAll(target);
      return () => {
        for (const disposer of disposers) safeDispose(disposer);
      };
    });
  };

  const direct = ctx.get?.('skills');
  if (direct?.register) {
    bind(ctx, direct);
    return;
  }
  // skills 服务晚到：用 ctx.inject 拿一个在该服务就绪后才激活的子 ctx（同样是 effect，随父 fiber 卸载）
  try {
    ctx.inject?.(['skills'], (child) => {
      const service = child?.get?.('skills') ?? child?.skills;
      if (service?.register) bind(child ?? ctx, service);
    });
  } catch {
    // 没有 skills 服务也能跑，只是 agent 少两份说明书
  }
}
