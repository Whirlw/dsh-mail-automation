/**
 * 让 agent 处理一封邮件 / 生成每日总览。
 *
 * 序列照抄 DSH headless 宿主的官方用法：
 *   agents.create({ sessionId, meta:{cwd}, agentOptions }) → agent.whenIdle()
 *   → agent.followup(createUserMessage(...)) → agent.whenIdle()
 *   → 从 firstSeq..seq 的 `assistant/message` 事件里取最终文本
 *
 * 会话复用：`session_mode: daily` 时同一天的所有邮件走同一个会话（省 token、上下文连贯）；
 * `per_mail` 时每封新会话（互不干扰）。
 */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadHost } from './host.js';
import { dayString } from './store.js';
import { DEFAULT_AGENT_WORKSPACE, expandPath } from './config.js';
import { MAIL_PRESET_ID, normalizeMailTools } from './preset.js';

/** 读取会话事件（宿主没有 snapshotEvents 时返回空数组） */
function eventsOf(agent) {
  try {
    return typeof agent?.session?.snapshotEvents === 'function' ? agent.session.snapshotEvents() : [];
  } catch {
    return [];
  }
}

/**
 * 每日会话的"今天"只前进不后退。
 *
 * `dayString()` 用的是**本地日**（与 `listArchived({day})` 同源，B-N1），
 * 代价是本地日会随时区/系统时钟变化倒退（跨换日线、校时）。倒退时保留旧 day、不换代：
 * 否则同一"天"里会换代两次，中间那个会话立刻变孤儿、上下文断掉。
 */
function laterDay(previous, today) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(previous ?? '')) && String(previous) > today ? String(previous) : today;
}

/**
 * 这一轮开局回合到底有没有产生回复（A4）。
 *
 * 只看 `before` 之后**新增**的事件：恢复出来的父会话本来就带着上次的历史 assistant 消息，
 * 扫全会话会把"这次失败"误判成"已就绪"。`text` 非空也算 —— 只调用工具、没有文本的
 * 成功回合同样说明这个会话跑通了。
 */
export function openerRoundProduced(before, events, text) {
  const list = Array.isArray(events) ? events : [];
  const fresh = list.slice(Math.max(0, Number(before) || 0)).some((event) => event?.type === 'assistant/message');
  return fresh || String(text ?? '').trim().length > 0;
}

/** 兜底回合超时：真正的值来自配置 `agent.turnTimeoutSeconds`（见 turnTimeout()） */
const TURN_TIMEOUT_MS = 5 * 60_000;

let sdkPromise;
/**
 * 从宿主拿 createUserMessage / SessionSeq / brandString。
 * 走 host.js 的 profile 内桥接，插件自身装成 junction 也能解析（见 host.js 注释）。
 */
function loadSdk() {
  sdkPromise ??= (async () => {
    const host = await loadHost();
    if (typeof host.createUserMessage !== 'function') throw new Error('宿主没有提供 createUserMessage');
    if (typeof host.SessionSeq !== 'function') throw new Error('宿主没有提供 SessionSeq');
    return {
      createUserMessage: host.createUserMessage,
      SessionSeq: host.SessionSeq,
      brandString: typeof host.brandString === 'function' ? host.brandString : (value) => value,
    };
  })();
  return sdkPromise;
}

function withTimeout(promise, ms, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} 超时（${ms}ms）`)), ms);
    if (typeof timer.unref === 'function') timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export class MailAgentRunner {
  constructor({ ctx, logger, state, persist, getTurnTimeoutMs, getMailPresetId, getMailTools, getReasoningEffort, getOpenerPrompt, getSilent, getProvider, getModel }) {
    this.ctx = ctx;
    this.logger = logger;
    this.state = state;
    this.persist = persist ?? (() => undefined);
    /** 配置 `agent.turnTimeoutSeconds` 的读取器（每次取最新值，改配置不用重建 runner） */
    this.getTurnTimeoutMs = typeof getTurnTimeoutMs === 'function' ? getTurnTimeoutMs : null;
    /** 配置 `agent.preset`：处理邮件用的极简预设 id（留空 = 跟随部署默认） */
    this.getMailPresetId = typeof getMailPresetId === 'function' ? getMailPresetId : null;
    /** 配置 `agent.tools`：子 agent 的工具白名单（空数组 = 真·无工具） */
    this.getMailTools = typeof getMailTools === 'function' ? getMailTools : null;
    /** 配置 `agent.provider` / `agent.model`：处理邮件用的模型（成对才生效，留空 = 跟随部署默认） */
    this.getProvider = typeof getProvider === 'function' ? getProvider : null;
    this.getModel = typeof getModel === 'function' ? getModel : null;
    /** 配置 `agent.reasoningEffort`：处理邮件时的思考强度（留空 = 跟随部署默认） */
    this.getReasoningEffort = typeof getReasoningEffort === 'function' ? getReasoningEffort : null;
    /** 配置 `agent.openerPrompt`：父会话开场白（空串 = 不写） */
    this.getOpenerPrompt = typeof getOpenerPrompt === 'function' ? getOpenerPrompt : null;
    /** 配置 `agent.silent`：静默处理，不把会话露在侧边栏 */
    this.getSilent = typeof getSilent === 'function' ? getSilent : null;
    this.handles = new Map();
    this.chain = Promise.resolve();
    this.loaderReady = null;
    this.parentHandle = null;
    /** 本进程内是否已经让父会话跑过回合（见 ensureParent 的 priming 说明） */
    this.parentPrimed = false;
    /** 开局回合失败过（进程级）：用来决定"子会话被拒时要不要换一代父会话" */
    this.parentPrimeFailed = false;
    /** 开局回合已经放弃（进程级）：避免后续再跑开局回合 */
    this.parentPrimeExhausted = false;
    /** 本进程内确认过"模型/凭据不可用"（不是抖动），用于跳过后续热身与更准确的日志 */
    this.parentPrimeUnavailable = false;
    /**
     * "取消后仍没停稳"的会话（L2）：只放内存。
     * 它描述的是**活体 agent 在这个进程里的状态**，跨重启毫无意义（重启后回合不可能还活着），
     * 写进状态域反而会因时钟偏差造成"永远忙"。
     */
    this.stuckSessions = new Set();
    /** cancel 之后等回合停稳的上限；dispose 等待的上限（都可注入以便测试） */
    this.settleTimeoutMs = 15_000;
    this.disposeTimeoutMs = 20_000;
    /** 当前父会话是不是"恢复出来"的（沿用上次启动那个）；沿用失败时要能回退成新建 */
    this.parentResumed = false;
    /** 沿用失败后的兜底是否已经用过（每进程只重试一次，避免死循环） */
    this.parentRetryDone = false;
    /** 下次 ensureParent 强制换代（兜底重试用） */
    this.forceFreshParent = false;
    this.workspaceEntity = null;
    /** 最近一次 ensureWorkspace 的结果（按 requested 路径缓存）与**实际生效**的目录 */
    this.workspaceCache = null;
    this.workspaceCwd = '';
    /** 回退用的默认工作区（测试可注入；生产用 DSH 的默认模板） */
    this.defaultWorkspace = '';
    /** preset 解析结果缓存：id → 解析到的 id（失败时缓存 5 分钟，避免每封邮件重试） */
    this.presetCache = new Map();
    this.presetBadUntil = 0;
    this.defaultPreset = undefined;
    this.presetsLogged = false;
    this.warnedEffort = '';
  }

  /** 单封邮件的回合超时（毫秒）：配置值优先，非法值退回兜底 */
  turnTimeoutMs() {
    let configured;
    try {
      configured = Number(this.getTurnTimeoutMs?.());
    } catch {
      configured = undefined;
    }
    return Number.isFinite(configured) && configured >= 30_000 ? configured : TURN_TIMEOUT_MS;
  }

  /** 等 loader 装配完成（启动早期不能 create agent） */
  async ready() {
    this.loaderReady ??= (async () => {
      try {
        await this.ctx.get('loader')?.await?.();
      } catch {
        // 没有 loader 服务（测试环境）就继续
      }
    })();
    return this.loaderReady;
  }

  /** daily 模式下同一天复用同一个会话；per_mail 每封新建 */
  sessionIdFor(mode) {
    if (mode === 'per_mail') return `session-${randomUUID()}`;
    // 本地日 + 单调护栏（B-N1）：与 dayString() 同源，且时钟/时区倒退时不换代
    const today = laterDay(this.state.agent?.day, dayString());
    const record = this.state.agent ?? {};
    if (record.day === today && typeof record.sessionId === 'string' && record.sessionId) return record.sessionId;
    const sessionId = `session-${randomUUID()}`;
    /*
     * **合并**而不是整体替换（A1）：整体替换会丢掉 parentSessionId / bootSignature /
     * childSessions —— 下次启动 `ensureParent` 读到 bootSignature=null 就判"首次运行"，
     * 又因为 parentSessionId 是空的而**归档不了**旧父会话，于是每重启多一个。
     */
    this.state.agent = { ...record, day: today, sessionId };
    this.persist();
    return sessionId;
  }

  /**
   * 本次会话要用的模型选择。
   *
   * `agentDefaultModel` 服务在启动早期可能还没注册，此时 `agents.create` 不带
   * agentOptions 会让 persona-prefix 模板里的 `{{model}}` 没有值，整轮装配直接失败：
   *   prompt variable "{{model}}" has no value for this assembly (section "deployment:persona-prefix")
   * 旧实现去读 profile 的 `cordis.patch.yml` 兜底——那是**部署层的配置面**，不是本插件该读的，
   * 指南不允许。现在改成**有界等待**服务就绪：等不到就不指定模型，交给部署默认。
   */
  async agentOptions() {
    /*
     * 顺序：**配置的 provider/model** > 宿主默认选择 > 不指定（交给部署默认）。
     * 配置成对才生效：只写一半会让 session 的 `{{model}}` 拿不到完整值、整轮装配失败，
     * 这种情况按"没配"处理并留一条 WARN（只提示一次，避免每封邮件刷屏）。
     */
    const configured = this.configuredSelection();
    if (configured) return this.withEffort(configured);
    const selection = this.currentSelection();
    if (selection) return this.withEffort(selection);
    // 等过一次没等到：5 分钟内不再干等（否则部署里若没有这个服务，每封邮件都白等 10 秒）
    if (this.modelCooldownUntil && Date.now() < this.modelCooldownUntil) return undefined;
    if (!this.modelWait) {
      this.modelWait = (async () => {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const found = this.currentSelection();
          if (found) {
            this.logger?.info?.(`[mail-automation] agentDefaultModel 已就绪：${found.provider}/${found.model}`);
            return found;
          }
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, 500);
            if (typeof timer.unref === 'function') timer.unref();
          });
        }
        this.modelCooldownUntil = Date.now() + 5 * 60_000;
        this.logger?.warn?.('[mail-automation] 等 agentDefaultModel 超时（10s），5 分钟内不再等待；本次不指定模型，按部署默认创建');
        return undefined;
      })();
      // 只缓存成功结果；超时得到的 undefined 在冷却期过后还能重试
      this.modelWait
        .then((value) => {
          if (!value) this.modelWait = null;
        })
        .catch(() => {
          this.modelWait = null;
        });
    }
    const waited = await this.modelWait;
    return waited ? this.withEffort(waited) : waited;
  }

  /**
   * 按配置覆盖思考强度（`agent.reasoningEffort`）。
   *
   * 邮件助理是个短判断任务，部署默认的 `high` 会为每封邮件多烧几百到上千个推理 token；
   * 这里允许单独压低。只认 minimal/low/medium/high，别的一律忽略（跟随部署默认），
   * 免得把一个不认识的值塞给 adapter 导致整轮请求失败。
   */
  withEffort(selection) {
    const allowed = new Set(['minimal', 'low', 'medium', 'high']);
    let effort = '';
    try {
      effort = String(this.getReasoningEffort?.() ?? '').trim().toLowerCase();
    } catch {
      effort = '';
    }
    if (!effort) return selection;
    if (!allowed.has(effort)) {
      if (this.warnedEffort !== effort) {
        this.warnedEffort = effort;
        this.logger?.warn?.(`[mail-automation] agent.reasoningEffort=${effort} 不认识（只支持 minimal/low/medium/high），按部署默认走`);
      }
      return selection;
    }
    if (effort === selection.reasoningEffort) return selection;
    return { ...selection, reasoningEffort: effort };
  }

  /**
   * 配置里指定的模型（`agent.provider` + `agent.model`）。
   *
   * 只写一半时返回 undefined 并 WARN 一次：`{{model}}` 是宿主 persona 模板里的变量，
   * provider 或 model 缺一个都会让整轮装配失败（实测报 `prompt variable "{{model}}" has no value`），
   * 那比"跟随部署默认"糟得多。
   */
  configuredSelection() {
    let provider = '';
    let model = '';
    try {
      provider = String(this.getProvider?.() ?? '').trim();
      model = String(this.getModel?.() ?? '').trim();
    } catch {
      return undefined;
    }
    if (!provider && !model) return undefined;
    if (!provider || !model) {
      const key = `${provider}/${model}`;
      if (this.warnedHalfModel !== key) {
        this.warnedHalfModel = key;
        this.logger?.warn?.(
          `[mail-automation] agent.provider / agent.model 只填了一半（${provider || '(空)'} / ${model || '(空)'}），` +
            '按"跟随部署默认"处理；要么两个都填，要么都留空。',
        );
      }
      return undefined;
    }
    return { provider, model };
  }

  /** 读 `agentDefaultModel` 服务的当前选择（未注册/未选择时返回 undefined） */
  currentSelection() {
    try {
      const selection = this.ctx.get('agentDefaultModel')?.currentSelection?.();
      if (!selection?.provider || !selection?.model) return undefined;
      return {
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort !== undefined ? { reasoningEffort: selection.reasoningEffort } : {}),
      };
    } catch {
      return undefined;
    }
  }

  /**
   * 解析并挂载 agent preset。
   *
   * 这一步是**必须的**：`agents.create()` 不带 setup 时，新会话拿不到 preset 装配的工具集，
   * agent 连 read / shell 都没有（实测它会在输出里抱怨「我没有读取本地文件的工具」）。
   * 与 dsh-qqbot-bridge 的做法一致：`presets.resolve()` 拿 id，`presets.mount()` 在 setup 里挂上。
   *
   * @param {'session'|'mail'} kind `session` = 给用户看得见的会话（父会话）用部署默认预设；
   *   `mail` = 处理邮件用配置里的极简预设（见 cordis.patch.yml 的 `preset-mail-automation-agent`）。
   */
  async presetSetup(kind = 'session') {
    const presets = this.ctx.get('agentPresets');
    if (!presets?.resolve || !presets?.mount) return {};
    const presetId = kind === 'mail' ? await this.mailPresetId() : await this.defaultPresetId();
    if (!presetId) return {};
    return {
      presetId,
      setup: async (agentCtx) => {
        await presets.mount(agentCtx, presetId);
        /*
         * 邮件子 agent 只该"读信 + 发通知"。插件自己的管理面工具是全局注册的，preset 管不到，
         * 必须在这里按 agent 作用域 restrict 掉——否则一封恶意邮件就能诱导它调
         * `mail_automation_config` 去改下一封的工具集/提示词。restrict 只影响本 agent 作用域。
         */
        if (kind === 'mail') {
          try {
            /*
             * 管理面工具永远不给；另外两个插件自带工具（archive_read / qq_notify）也**按
             * agent.tools 的选择**放行：用户把工具列表删空，子 agent 就真的一个工具都没有。
             * 它们由插件全局注册，preset 的 plugins 管不到，只能在这里 restrict。
             */
            const selected = new Set(normalizeMailTools(this.getMailTools?.()));
            const deny = ['mail_automation_config', 'mail_automation_poll', 'mail_automation_status'];
            for (const id of ['mail_automation_archive_read', 'qq_notify']) {
              if (!selected.has(id)) deny.push(id);
            }
            agentCtx?.tools?.restrict?.({ deny });
          } catch (err) {
            this.logger?.warn?.(`[mail-automation] 收窄邮件子 agent 工具面失败：${err?.message ?? err}`);
          }
        }
      },
    };
  }

  /**
   * 父会话预设：优先用邮件助理自己的极简预设（省 token）。
   *
   * 与子会话不同：`agent.preset` 留空时**不退回部署默认的重型预设**，而是强制用内置
   * `MAIL_PRESET_ID`；取不到（未注册/装配 broken）才退回 `{}`（部署默认）。
   * 父会话只跑一次开局回合，用极简预设足够。
   */
  async parentPresetSetup() {
    const presets = this.ctx.get('agentPresets');
    if (!presets?.resolve || !presets?.mount) return {};
    let wanted = '';
    try {
      wanted = String(this.getMailPresetId?.() ?? '').trim();
    } catch {
      wanted = '';
    }
    const id = wanted || MAIL_PRESET_ID;
    try {
      const found = await presets.resolve(id);
      if (!found || found.broken) throw new Error('preset unavailable');
    } catch (err) {
      this.logger?.warn?.(`[mail-automation] 父会话邮件预设不可用（${id}）：${err?.message ?? err}；退回部署默认`);
      return {};
    }
    return {
      presetId: id,
      setup: async (agentCtx) => {
        await presets.mount(agentCtx, id);
      },
    };
  }

  /** 部署默认预设 id（父会话与兜底用） */
  async defaultPresetId() {
    if (this.defaultPreset !== undefined) return this.defaultPreset;
    const presets = this.ctx.get('agentPresets');
    if (!presets?.resolve) return undefined;
    try {
      this.defaultPreset = (await presets.resolve()).id;
    } catch (err) {
      this.logger?.warn?.(`[mail-automation] 解析默认 agent preset 失败：${err?.message ?? err}`);
      this.defaultPreset = undefined;
    }
    return this.defaultPreset;
  }

  /**
   * 处理邮件用的预设 id。
   *
   * 省 token 的主力：部署默认预设是完整的编码 agent（shell / 文件读写 / 搜索 / 计划 /
   * 子代理 / 技能目录 …），那套工具 schema 与技能清单是**每封邮件**都要付的固定前缀。
   * 本插件用 `cordis.patch.yml` 插了一个只含 `mail_automation_archive_read` + `read_image` +
   * `qq_notify` 的 `mail-automation-agent` 预设。
   *
   * 取不到（宿主没装这个 bundle、预设装配失败、id 写错）→ **退回默认预设**并记一条 WARN，
   * 只损失优化、不影响邮件处理；失败结果缓存 5 分钟，不会每封邮件重试。
   */
  async mailPresetId() {
    let wanted = '';
    try {
      wanted = String(this.getMailPresetId?.() ?? '').trim();
    } catch {
      wanted = '';
    }
    if (!wanted) return this.defaultPresetId();
    if (this.presetCache.has(wanted)) return this.presetCache.get(wanted);
    if (this.presetBadUntil && Date.now() < this.presetBadUntil) return this.defaultPresetId();

    const presets = this.ctx.get('agentPresets');
    await this.logPresetsOnce(presets);
    try {
      let found;
      try {
        found = await presets.resolve(wanted);
      } catch (err) {
        /*
         * 预设刚被"重注册"（dispose → register）时会出现一个极短的空窗：resolve 报不存在。
         * 这不是配置错误，等一拍再试一次即可——**不能**走 5 分钟冷却，否则改一次工具集
         * 会让接下来 5 分钟的邮件全部掉到重型默认预设。
         */
        if (!/not found|not registered|unknown|不存在/i.test(String(err?.message ?? err))) throw err;
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 250);
          if (typeof timer.unref === 'function') timer.unref();
        });
        found = await presets.resolve(wanted);
      }
      if (found?.broken) throw new Error(`装配失败：${JSON.stringify(found.broken).slice(0, 200)}`);
      this.presetCache.set(wanted, found.id);
      this.logger?.info?.(`[mail-automation] 邮件子 agent 使用预设 ${found.id}`);
      return found.id;
    } catch (err) {
      const fallback = await this.defaultPresetId();
      this.presetBadUntil = Date.now() + 5 * 60_000;
      this.logger?.warn?.(
        `[mail-automation] 预设 ${wanted} 不可用（${err?.message ?? err}），邮件子 agent 退回默认预设 ${fallback ?? '(未指定)'}；` +
          '5 分钟内不再重试。该预设由插件按 agent.tools 运行时注册，注册失败的详情见启动日志（"注册邮件预设失败"）。',
      );
      return fallback;
    }
  }

  /**
   * 模型选择变了（设置页保存）时调用：丢掉沿用的父会话与"本进程已尝试过 priming"的标记，
   * 让下一封邮件用**新模型**重建并热身父会话。
   *
   * 不这么做的话：启动时模型不可用 → 父会话 priming 失败并把 parentPrimeExhausted 置位；
   * 之后用户换成可用模型，父会话仍是旧的那一个，子会话可能先被 pre-step 拒一次
   * （白烧一次失败尝试），才走"换一代父会话"的兜底。
   */
  resetParentForModelChange() {
    const old = this.parentHandle;
    this.parentHandle = null;
    this.parentPrimed = false;
    this.parentPrimeFailed = false;
    this.parentPrimeExhausted = false;
    /** 本进程内确认过"模型/凭据不可用"（不是抖动），用于跳过后续热身与更准确的日志 */
    this.parentPrimeUnavailable = false;
    this.parentRetryDone = false;
    this.parentResumed = false;
    this.forceFreshParent = false;
    this.presetCache.clear();
    this.presetBadUntil = 0;
    try {
      const pending = old?.dispose?.();
      if (pending && typeof pending.catch === 'function') pending.catch(() => undefined);
    } catch {
      // 释放失败不影响下一封邮件新建父会话
    }
  }

  /** 预设重新注册成功后调用：清掉失败冷却与已解析缓存，让下一封邮件重新 resolve（避免 5 分钟仍走重型默认） */
  resetPresetCooldown() {
    this.presetBadUntil = 0;
    this.presetCache.clear();
  }

  /** 只记一次可用预设清单：出问题时一眼能看出 mail-automation-agent 有没有装上 */
  async logPresetsOnce(presets) {
    if (this.presetsLogged) return;
    this.presetsLogged = true;
    try {
      const list = await presets?.list?.();
      if (!Array.isArray(list)) return;
      const names = list.map((row) => (row?.id ? `${row.id}${row.broken ? '(装配失败)' : ''}` : '?')).join('、');
      this.logger?.info?.(`[mail-automation] 可用 agent 预设：${names}`);
    } catch {
      // 只是诊断信息，拿不到就算了
    }
  }

  /**
   * 取得可用的 agent 句柄，三级兜底：
   *   1. 本进程里已有的句柄 → 直接用
   *   2. 同进程的 live agent（agents.get）→ 复用
   *   3. create；若会话已存在于磁盘（跨重启复用当天会话的常见情形）→ resume
   *   4. create / resume 都失败 → 换一个新的 sessionId 重新建，并写回状态
   *
   * 少了 3、4 两步，重启后第一封新邮件必然报 `session "…" already exists`，
   * 而且会因为一直沿用这个坏 id 而永久失败。
   */
  async ensureAgent(sessionId, workspace) {
    const existing = this.handles.get(sessionId);
    if (existing) return existing;
    const agents = this.ctx.get('agents');
    if (!agents?.create) throw new Error('DSH 缺少 agents 服务，无法运行邮件 agent');
    const { brandString } = await loadSdk();
    // daily 分支不走 ensureParent：这里也要先把工作区目录准备好（meta.cwd 会被 realpath）
    await this.ensureWorkspace(workspace);
    const cwd = this.workspaceCwd || workspace;
    const agentOptions = await this.agentOptions();
    const { presetId, setup } = await this.presetSetup('mail');
    const baseOptions = {
      meta: { cwd, ...(presetId ? { agentPreset: presetId } : {}) },
      ...(agentOptions ? { agentOptions } : {}),
      ...(setup ? { setup } : {}),
    };

    const branded = brandString(sessionId);
    const live = agents.get?.(branded);
    if (live) {
      this.handles.set(sessionId, live);
      this.logger?.info?.(`[mail-automation] 复用 live agent 会话 ${sessionId}`);
      return live;
    }

    try {
      const handle = await agents.create({ sessionId: branded, ...baseOptions });
      this.handles.set(sessionId, handle);
      if (presetId) this.logger?.info?.(`[mail-automation] agent 会话 ${sessionId} 已挂载 preset=${presetId}`);
      return handle;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/already exists|already registered/i.test(message)) throw err;
      this.logger?.info?.(`[mail-automation] 会话 ${sessionId} 已存在，改为恢复`);
      try {
        const resumed = await agents.resume({ resumeSessionId: branded, ...(setup ? { setup } : {}) });
        this.handles.set(sessionId, resumed);
        return resumed;
      } catch (resumeError) {
        const detail = resumeError instanceof Error ? resumeError.message : String(resumeError);
        this.logger?.warn?.(`[mail-automation] 恢复会话 ${sessionId} 失败（${detail}），改用新会话`);
      }
    }

    // 最后兜底：全新会话，并把 id 写回状态，避免下次继续撞旧的（合并字段，见 sessionIdFor）
    const freshId = `session-${randomUUID()}`;
    const handle = await agents.create({ sessionId: brandString(freshId), ...baseOptions });
    this.handles.set(sessionId, handle);
    this.state.agent = {
      ...(this.state.agent ?? {}),
      day: laterDay(this.state.agent?.day, dayString()),
      sessionId: freshId,
    };
    this.persist();
    if (this.isSilent()) await this.archiveSession(freshId, { stopActivity: false });
    this.logger?.info?.(`[mail-automation] 已切换到新会话 ${freshId}`);
    return handle;
  }

  /** 串行化：同时只跑一个邮件回合，避免复用会话时上下文错乱 */
  run(options) {
    const task = this.chain.then(() => this.runInner(options));
    this.chain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  // ─────────────────────── 工作区归属 / 父会话 / 归档 ───────────────────────

  /** 通过 workspaceRegistry 找到（或创建）工作区实体；找不到就返回 null */
  /**
   * 准备好工作区目录并拿到 registry 实体（A5）。
   *
   * 之前这里**从不碰文件系统**：`workspaceRegistry.resolveByPath/create` 都会先 `realpath`，
   * 目录不存在就 ENOENT，异常被吞成一条 WARN、返回 null —— 会话于是带着一个不存在的 cwd
   * 跑，并且（非静默模式下）全部落进「未分组」。线上日志里那条
   * `解析工作区失败（…\.dsh\workspace\default）：ENOENT` 就是它。
   *
   * 现在的顺序：先确保目录存在 → 再注册。目录建不出来才退到默认工作区；两个都不行就
   * 不挂工作区（只影响会话归属，不该让邮件处理停摆），但 `workspaceCwd` 永远是**实际生效**
   * 的那个路径，`meta.cwd` 与启动签名都用它，避免"挂载用 A、会话 cwd 用 B"的分裂。
   */
  async ensureWorkspace(workspacePath) {
    const requested = String(workspacePath ?? '').trim();
    if (this.workspaceCache?.requested === requested) return this.workspaceCache.entity;

    let effective = requested || this.#defaultWorkspace();
    try {
      this.#ensureWorkspaceDir(effective, { explicit: Boolean(requested) });
    } catch (err) {
      const fallback = this.#defaultWorkspace();
      try {
        this.#ensureWorkspaceDir(fallback, { explicit: false });
        effective = fallback;
        this.logger?.warn?.(
          `[mail-automation] 工作区不可用（${requested}：${err?.message ?? err}），本次改用默认工作区 ${fallback}`,
        );
      } catch (fallbackError) {
        this.logger?.warn?.(
          `[mail-automation] 工作区与默认工作区都不可用（${requested} / ${fallback}）：` +
            `${fallbackError?.message ?? fallbackError}；会话照常运行，但不挂工作区`,
        );
        this.workspaceCache = { requested, entity: null };
        return null;
      }
    }
    this.workspaceCwd = effective;

    const registry = this.ctx.get('workspaceRegistry');
    if (!registry) {
      this.workspaceCache = { requested, entity: null };
      return null;
    }
    try {
      const existing = (await registry.resolveByPath?.(effective)) ?? null;
      const entity = existing ?? (await registry.create?.(effective)) ?? null;
      this.workspaceEntity = entity;
      this.workspaceCache = { requested, entity };
      if (entity) this.logger?.info?.(`[mail-automation] 已注册工作区 ${effective}`);
      return entity;
    } catch (err) {
      this.logger?.warn?.(`[mail-automation] 解析工作区失败（${effective}）：${err?.message ?? err}；会话照常运行，不挂工作区`);
      this.workspaceCache = { requested, entity: null };
      return null;
    }
  }

  /** 回退用的默认工作区：测试可注入 `defaultWorkspace`，生产走 DSH 的默认模板 */
  #defaultWorkspace() {
    const configured = String(this.defaultWorkspace || '').trim();
    return configured || expandPath(DEFAULT_AGENT_WORKSPACE);
  }

  /** 目录必须真的存在且是目录；显式配置的路径被新建时给一条 WARN（路径写错要看得见） */
  #ensureWorkspaceDir(dir, { explicit }) {
    const stat = (() => {
      try {
        return fs.statSync(dir);
      } catch (err) {
        if (err?.code === 'ENOENT') return null;
        throw err;
      }
    })();
    if (stat?.isDirectory()) return;
    if (stat) throw new Error('该路径存在但不是目录');
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.statSync(dir).isDirectory()) throw new Error('创建后仍不是目录');
    if (explicit) {
      this.logger?.warn?.(`[mail-automation] agent.workspace 不存在，已创建：${dir}（如果是路径写错了，请修正配置）`);
    }
  }

  /**
   * 把会话挂到工作区。
   * 不挂的话，WebUI 会把它放进「未分组」——这正是之前的现象。
   */
  async attachToWorkspace(workspace, sessionId) {
    if (!workspace || typeof workspace.attachSession !== 'function') return false;
    try {
      await workspace.attachSession(sessionId);
      return true;
    } catch (err) {
      this.logger?.warn?.(`[mail-automation] 挂载会话 ${sessionId} 到工作区失败：${err?.message ?? err}`);
      return false;
    }
  }

  /**
   * 静默模式：处理邮件用的会话不在侧边栏显示。
   *
   * 为什么是"归档"而不是"不建会话"：DSH 的 agent 回合必须落在会话上（会话日志是可回放的
   * 唯一记录），没有"无会话的回合"。所以做法是**建完立刻归档**——归档后的会话不出现在
   * 工作区列表里，但仍能从归档区打开、审计。
   */
  isSilent() {
    try {
      return this.getSilent ? this.getSilent() !== false : true;
    } catch {
      return true;
    }
  }

  /** 归档一个会话（子智能体处理完就收走，不出现在侧边栏） */
  async archiveSession(sessionId, { stopActivity = true } = {}) {
    const registry = this.ctx.get('workspaceRegistry');
    if (!registry?.archiveSession) return false;
    try {
      await registry.archiveSession(sessionId, { stopActivity });
      return true;
    } catch (err) {
      this.logger?.warn?.(`[mail-automation] 归档会话 ${sessionId} 失败：${err?.message ?? err}`);
      return false;
    }
  }

  /** 记住插件创建过的子会话，便于下次启动补归档（进程崩溃/重启时不会漏） */
  recordChild(sessionId) {
    const list = Array.isArray(this.state.agent?.childSessions) ? [...this.state.agent.childSessions] : [];
    if (!list.includes(sessionId)) list.push(sessionId);
    this.state.agent = { ...(this.state.agent ?? {}), childSessions: list.slice(-200) };
    this.persist();
  }

  forgetChild(sessionId) {
    const list = Array.isArray(this.state.agent?.childSessions) ? this.state.agent.childSessions.filter((id) => id !== sessionId) : [];
    this.state.agent = { ...(this.state.agent ?? {}), childSessions: list };
    this.persist();
  }

  /** 启动时补归档：上次没来得及归档的子会话 */
  async cleanupChildren() {
    let archived = 0;
    const leftovers = Array.isArray(this.state.agent?.childSessions) ? [...this.state.agent.childSessions] : [];
    /*
     * 正在用的会话绝不归档：归档父会话/每日会话会让它名下所有子会话的第一步被
     * `agent/pre-step` 拒绝（turn 直接 blocked），而且 `forgetChild` 会把记录删掉、无法自愈。
     * 今天 daily 会话 id 不会进 childSessions，这个守卫是防止以后有别的路径把它写进去。
     */
    const active = new Set(
      [this.state.agent?.parentSessionId, this.state.agent?.silentParentSessionId, this.state.agent?.sessionId].filter(
        (id) => typeof id === 'string' && id,
      ),
    );
    for (const sessionId of leftovers) {
      if (active.has(sessionId)) continue;
      if (await this.archiveSession(sessionId)) {
        this.forgetChild(sessionId);
        archived += 1;
      }
    }
    if (archived > 0) this.logger?.info?.(`[mail-automation] 已归档 ${archived} 个遗留子会话`);
    return archived;
  }

  /**
   * 邮件助理的「父会话」：长期存在的会话，每封邮件的处理都是它的子会话（`parentAgent`）。
   *
   * 两种可见性：
   * - 默认（`agent.silent: false`）：挂到工作区、出现在侧边栏，方便调试。
   * - 静默（默认关）：**不挂工作区、也不归档**。归档这条路走过一次，结果所有子会话的第一步
   *   都被 `agent/pre-step` 拒（`turn/end blocked`，一个 step 都没开）——归档父会话会让
   *   它的子会话不可用。不挂工作区的会话不会出现在侧边栏，效果一样而不伤子会话。
   */
  async ensureParent(workspacePath) {
    if (this.parentHandle) return this.parentHandle;
    await this.ready();
    const agents = this.ctx.get('agents');
    if (!agents?.create) throw new Error('DSH 缺少 agents 服务，无法运行邮件 agent');
    const { brandString } = await loadSdk();
    const workspace = await this.ensureWorkspace(workspacePath);
    // 实际生效的目录（原路径 / 被建出来的原路径 / 回退后的默认工作区）：签名与 cwd 都用它
    const effectiveCwd = this.workspaceCwd || workspacePath;
    const { presetId, setup } = await this.parentPresetSetup();
    const agentOptions = await this.agentOptions();
    const record = this.state.agent ?? {};
    const silent = this.isSilent();
    /*
     * 父会话的"沿用 / 换代"规则：只有**会话怎么建**的输入变了才换代。
     *
     * 拿本次启动的 (工作区, 是否静默) 和上一次启动记下的签名对比：
     *   - 变了 → 先归档旧父会话，再新建一个；
     *   - 没变 → 沿用（恢复）上一次那个，避免在侧边栏/未分组里越堆越多。
     * 签名和 id 一起持久化在状态域里（见 state-domain.js 的 agent 记录——漏写字段就会被丢掉）。
     *
     * 注意约束：静默模式（不挂工作区）下**沿用恢复出来的会话**曾经让子会话被
     * `agent/pre-step` 拒（turn/end blocked）。现在沿用路径有兜底：一旦发现这种失败，
     * 会丢掉父会话、强制新建并重试一次（见 retryWithFreshParentIfBlocked）。
     */
    const signature = { workspace: String(effectiveCwd ?? ''), silent: Boolean(silent) };
    const previous = record.bootSignature ?? null;
    const previousParentId = String(record.parentSessionId ?? '');
    const changed =
      this.forceFreshParent ||
      !previous ||
      previous.workspace !== signature.workspace ||
      Boolean(previous.silent) !== signature.silent;
    this.forceFreshParent = false;
    if (changed && previousParentId) {
      // 先归档再建：旧父会话已经没用了，留着只会在侧边栏里堆一串
      const archived = await this.archiveSession(previousParentId, { stopActivity: false }).catch(() => false);
      if (archived) {
        const before = previous ? `${previous.silent ? '静默' : '挂工作区'}／${previous.workspace || '(空)'}` : '首次运行';
        this.logger?.info?.(
          `[mail-automation] 已归档上一代父会话 ${previousParentId}（${before} → ${silent ? '静默' : '挂工作区'}／${signature.workspace || '(空)'}）`,
        );
      }
    }
    const wanted = changed || !previousParentId ? `session-${randomUUID()}` : previousParentId;
    /*
     * 现读 `this.state.agent` 再合并：`record` 是 `ensureParent` 开头抓的**陈旧快照**，
     * 中间隔了 `ready()`/`agentOptions()`/`archiveSession` 数个 await；用旧快照回写
     * 与"整体替换"是同一类丢字段缺陷（A1 的同族）。
     */
    this.state.agent = {
      ...(this.state.agent ?? {}),
      bootSignature: signature,
      ...(silent ? { silentParentSessionId: wanted } : {}),
    };
    this.persist();

    /**
     * 建会话。
     *
     * 静默模式带 `origin: 'subagent'`：DSH 里 subagent 来源的会话不进侧边栏（每封邮件的
     * 子会话从不出现就是这个原因），`delegationDepth: 0` 让派生的子会话深度仍是 1，
     * 不撞 `maxDepth: 1`。若宿主拒绝这种 meta，退回普通会话并记 WARN——宁可在侧边栏
     * 多一个会话，也不能让邮件处理停摆。
     */
    const spawn = async (sessionId) => {
      const options = (meta) => ({
        sessionId: brandString(sessionId),
        meta,
        ...(agentOptions ? { agentOptions } : {}),
        ...(setup ? { setup } : {}),
      });
      const base = { cwd: effectiveCwd, ...(presetId ? { agentPreset: presetId } : {}) };
      if (!silent) return agents.create(options(base));
      try {
        return await agents.create(options({ ...base, origin: 'subagent', delegationDepth: 0 }));
      } catch (err) {
        const message = String(err?.message ?? err);
        if (/already exists|already registered/i.test(message)) throw err;
        this.logger?.warn?.(`[mail-automation] 静默父会话以 origin=subagent 创建失败（${message}），退回普通会话`);
        return agents.create(options(base));
      }
    };

    let handle = agents.get?.(brandString(wanted)) ?? null;
    if (!handle) {
      try {
        handle = await spawn(wanted);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/already exists|already registered/i.test(message)) throw err;
        // 跨重启：先恢复原来那个父会话，别急着换代
        try {
          handle = await agents.resume({
            resumeSessionId: brandString(wanted),
            ...(agentOptions ? { agentOptions } : {}),
            ...(setup ? { setup } : {}),
          });
          this.parentResumed = true;
          this.logger?.info?.(`[mail-automation] 父会话 ${wanted} 已恢复（沿用上次启动的）`);
        } catch (resumeError) {
          this.logger?.warn?.(`[mail-automation] 恢复父会话失败（${resumeError?.message ?? resumeError}），换代`);
        }
        if (!handle) {
          const fresh = `session-${randomUUID()}`;
          handle = await spawn(fresh);
          this.parentResumed = false;
          this.logger?.info?.(`[mail-automation] 父会话已换代：${fresh}`);
          await this.archiveSession(wanted).catch(() => false);
        }
      }
    }

    let parentAgent = handle?.agent ?? handle;

    /*
     * 只剩失败回合的父会话（有 user/message、没有 assistant/message）不能用：
     * 例如早先 agentOptions 缺失导致的 "{{model}} has no value" 会把每条消息都变成失败消息，
     * 反复复用只会越积越多。这里换一个干净会话，并把坏的归档。
     */
    const broken =
      eventsOf(parentAgent).some((e) => e?.type === 'user/message') &&
      !eventsOf(parentAgent).some((e) => e?.type === 'assistant/message');
    if (broken) {
      const oldId = String(parentAgent?.session?.id ?? wanted);
      this.logger?.warn?.(`[mail-automation] 父会话 ${oldId} 只有失败回合，换新会话`);
      await this.archiveSession(oldId).catch(() => false);
      const fresh = `session-${randomUUID()}`;
      handle = await spawn(fresh);
      parentAgent = handle?.agent ?? handle;
    }

    this.parentHandle = handle;
    const parentId = String(parentAgent?.session?.id ?? wanted);
    this.state.agent = { ...(this.state.agent ?? {}), parentSessionId: parentId };
    /*
     * 沿用的父会话如果**上次已经成功跑过开局回合**，不必每个进程再跑一次；
     * 新建/切换（id 变化）时自然不匹配，第一次真正处理邮件时会补一次。
     */
    this.parentPrimed = Boolean(parentId && this.state.agent.primedSessionId === parentId);
    /*
     * 老状态没有 primedSessionId（升级前记录的）：恢复出来的会话只要**已经有过成功的
     * assistant 回合**，就视为已就绪，本次启动不再补跑——用户明确说过上次跑的回合仍然有效。
     * 没有历史回合才在第一次处理邮件时补一次。
     */
    if (!this.parentPrimed && parentAgent?.session) {
      const hasAssistantTurn = eventsOf(parentAgent).some((event) => event?.type === 'assistant/message');
      if (hasAssistantTurn) {
        this.parentPrimed = true;
        this.state.agent.primedSessionId = parentId;
        this.logger?.info?.(`[mail-automation] 沿用已就绪的父会话 ${parentId}：本次启动不再重跑就绪检查`);
      }
    }
    this.persist();
    // 静默模式**不挂工作区**（靠创建时的 `origin: 'subagent'` 让它不进侧边栏），
    // 并且**不归档任何会话**——归档父会话会让它名下所有子会话被 pre-step 拒。
    if (silent) {
      this.logger?.info?.(`[mail-automation] 静默模式：父会话 ${parentId}（origin=subagent）不挂工作区`);
    } else {
      await this.attachToWorkspace(workspace, parentId);
    }

    // 标题：别让它在侧边栏里叫「新会话」
    try {
      const titles = this.ctx.get('sessionTitle');
      if (titles?.rename && parentAgent?.session) await titles.rename(parentAgent.session, '邮件自动化');
    } catch (err) {
      this.logger?.warn?.(`[mail-automation] 设置父会话标题失败：${err?.message ?? err}`);
    }

    /*
     * 启动时判断一次：父会话已就绪（primedSessionId 匹配 / 已有 assistant 回合）就跳过；
     * 否则补一次开局回合。静默模式也在这里补——它同样需要父会话先跑过回合，
     * 只是会话本身不进侧边栏；同一个父会话下次启动不会再跑。
     */
    await this.primeParent(handle);

    // 静默模式在这里**不再归档父会话**：归档会让它的子会话第一步就被 pre-step 拒绝。
    // 隐藏靠上面的"不挂工作区"完成。

    if (presetId) this.logger?.info?.(`[mail-automation] 父会话 ${parentId}（preset=${presetId}）就绪`);
    return handle;
  }

  /**
   * 开局回合（priming）：**每个父会话（新建/切换）跑一次**，在 `ensureParent` 启动时调用。
   *
   * 硬约束（踩出来的）：父会话必须先成功跑过一个回合，否则子会话第一步可能被
   * `agent/pre-step` 拒绝（turn/end blocked）。这个回合**可以是上次进程跑的**：
   * 已就绪的会话 id 记在 `state.agent.primedSessionId`，沿用同一个会话时直接跳过。
   * 非静默模式下它也让新父会话不再是 blank（blank 会话在侧边栏不可见）。
   */
  async primeParent(handle) {
    if (this.parentPrimed || this.parentPrimeExhausted) return;
    const parentAgent = handle?.agent ?? handle;
    if (!parentAgent?.session) return;

    // 开场白是模型可见文本，所以从配置读（`agent.openerPrompt`，默认值在 defaults.js）。
    let openerText = '';
    try {
      openerText = String(this.getOpenerPrompt?.() ?? '').trim();
    } catch {
      openerText = '';
      }
      if (!openerText) {
        this.logger?.info?.('[mail-automation] agent.openerPrompt 为空：父会话不写开场白（可能导致子会话被拒）');
      }
      if (!this.parentPrimed && !this.parentPrimeExhausted && openerText && parentAgent?.session) {
        const before = eventsOf(parentAgent).length;
        let produced = false;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          let text = '';
          try {
            text = await this.runInSession(parentAgent, openerText);
          } catch (err) {
            this.logger?.warn?.(`[mail-automation] 父会话开局回合第 ${attempt} 次失败：${err?.message ?? err}`);
            // 超时不是"抖动"：再跑一次只会再等一整个 turnTimeout，直接把本次 priming 判失败
            if (err?.timedOut) break;
          }
          await new Promise((resolve) => setTimeout(resolve, 1200));
          /*
           * 只看**本次回合新增**的事件：恢复出来的父会话本来就带着上次的历史
           * assistant 消息，用 `some()` 扫全会话会把"这次失败"误判成"已就绪"（A4）。
           * 文本也认：只调用工具、没有文本的成功回合同样算跑通了。
           */
          if (openerRoundProduced(before, eventsOf(parentAgent), text)) {
            produced = true;
            break;
          }
          /*
           * 判"这个回合本身就失败了"，两条判据（都不依赖具体字段名，宿主版本间更稳）：
           *   1. 一条新事件都没有 → 装配/路由级失败（没有模型、没 adapter、凭据缺失）；
           *   2. 有 `turn/end` 但其 data 里出现 error/fail/blocked/refus/abort 字样
           *      → 回合被拒或失败（模型报错、pre-step 拒绝）。这两种都不是抖动，再试两次只是白等。
           */
          const fresh = eventsOf(parentAgent).slice(before);
          if (fresh.length === 0) {
            this.parentPrimeUnavailable = true;
            this.logger?.warn?.('[mail-automation] 父会话开局回合没有产生任何事件（模型/凭据不可用的典型表现），跳过后续尝试');
            break;
          }
          const ended = [...fresh].reverse().find((event) => event?.type === 'turn/end');
          if (ended && /error|fail|blocked|refus|abort/i.test(JSON.stringify(ended.data ?? {}))) {
            this.parentPrimeUnavailable = true;
            this.logger?.warn?.(
              `[mail-automation] 父会话开局回合失败（${String(JSON.stringify(ended.data ?? {})).slice(0, 200)}），跳过后续尝试`,
            );
            break;
          }
          if (attempt === 3) this.logger?.warn?.('[mail-automation] 父会话开局回合始终没有产生回复');
        }
        if (produced) {
          this.parentPrimed = true;
          this.parentPrimeFailed = false;
          // 这次热身成功了：复位"模型/凭据不可用"标志，否则将来偶发失败会打出误导性提示
          this.parentPrimeUnavailable = false;
          // 记住是哪个父会话已经就绪：下次启动沿用同一个会话时不再重复跑
          this.state.agent = {
            ...(this.state.agent ?? {}),
            primedSessionId: String(parentAgent?.session?.id ?? ''),
          };
          this.persist();
          this.logger?.info?.(
            `[mail-automation] 父会话已就绪（本进程内完成开局回合，事件 ${before} → ${eventsOf(parentAgent).length}）`,
          );
        } else {
          /*
           * 不伪造就绪（A4）：记录失败，但**保持 handle 不清**——清了会让下一封邮件重进
           * ensureParent 的 broken 判据，变成"归档旧父 + 新建父"的换代风暴。
           * 子会话真被拒时由 retryWithFreshParentIfBlocked 换一代重试一次。
           */
          this.parentPrimeFailed = true;
          this.parentPrimeExhausted = true;
          this.logger?.warn?.(
            this.parentPrimeUnavailable
              ? '[mail-automation] 模型/凭据不可用：本进程跳过父会话热身（修好凭据或换模型后重启即恢复；期间每封邮件仍会尝试并如实记录失败原因）'
              : '[mail-automation] 父会话开局回合未成功：本进程内不再重试；子会话若被 pre-step 拒会换一代父会话重试一次',
          );
        }
      }
    
  }

  /** 在父会话下建一个子会话（子智能体），挂 preset 与工作区 */
  async createChild(parentHandle, workspacePath, label = '邮件') {
    const agents = this.ctx.get('agents');
    const { brandString } = await loadSdk();
    const workspace = await this.ensureWorkspace(workspacePath);
    const effectiveCwd = this.workspaceCwd || workspacePath;
    const { presetId, setup } = await this.presetSetup('mail');
    const agentOptions = await this.agentOptions();
    const sessionId = `session-${randomUUID()}`;
    const parentAgent = parentHandle?.agent ?? parentHandle;
    const handle = await agents.create({
      sessionId: brandString(sessionId),
      ...(parentAgent ? { parentAgent } : {}),
      meta: { cwd: effectiveCwd, ...(presetId ? { agentPreset: presetId } : {}) },
      ...(agentOptions ? { agentOptions } : {}),
      ...(setup ? { setup } : {}),
    });
    const childAgent = handle?.agent ?? handle;

    // 注意：这里**不能**手工 append 'subagent/catalog'。
    // 本分支只在 `ctx.subagents` 服务缺席时才走到，那时没有任何读方注册该事件类型；
    // 而 Session.append 写不了 `ignorable: true` 标记，未知类型会让整个会话打不开。
    // 正确做法（正常路径）是 ctx.subagents.startActivation()，见 runInner。
    await this.attachToWorkspace(workspace, sessionId);

    this.handles.set(sessionId, handle);
    this.recordChild(sessionId);
    return { handle, sessionId };
  }

  /** 在给定 agent 上跑一个回合，返回最终文本 */
  /**
   * 中止一个超时的回合（L2）。
   *
   * `withTimeout` 只让**等待**失败，回合本身还在跑：它继续烧 token、继续调 `qq_notify`，
   * 而且下一次 `runInSession` 的 `whenIdle()` 会一直等它（60s 硬上限，之后每封都失败）。
   * 宿主的 `agent.cancel(cause, options?)` 是同步信号；`{keepInbox:true}` 只中止当前回合，
   * 这里**故意不传** —— 超时那次 `followup` 若还留在队列里，会运行成一个过期回合，
   * 它的输出落在下一封邮件的区间里，被当成那封的结论（错误结论比卡死更难查）。
   *
   * cancel 只是信号，是否停稳要看 `whenIdle()`：停不稳就把会话记成脏的，后续不再复用它。
   */
  async cancelTurn(agent, why) {
    const sessionId = String(agent?.session?.id ?? '');
    try {
      if (typeof agent?.cancel === 'function') {
        agent.cancel({ kind: 'hook', reason: `mail-automation: ${why}` });
      } else {
        this.logger?.warn?.(`[mail-automation] ${why}：宿主 agent 没有 cancel()，无法中止该回合`);
      }
    } catch (err) {
      this.logger?.warn?.(`[mail-automation] ${why}：取消回合失败（${err?.message ?? err}）`);
    }
    try {
      await withTimeout(Promise.resolve(agent?.whenIdle?.()), this.settleTimeoutMs, '等待超时回合停止');
      return true;
    } catch {
      if (sessionId) this.stuckSessions.add(sessionId);
      this.logger?.warn?.(
        `[mail-automation] ${why}：取消后 ${Math.round(this.settleTimeoutMs / 1000)}s 仍未停稳，会话 ${
          sessionId || '(未知)'
        } 标记为脏（不再复用）`,
      );
      return false;
    }
  }

  async runInSession(agent, prompt) {
    const sessionId = String(agent?.session?.id ?? '');
    if (sessionId && this.stuckSessions.has(sessionId)) {
      throw new Error('上一回合超时后仍未停稳，本会话已弃用（本轮跳过）');
    }
    const { createUserMessage, SessionSeq } = await loadSdk();
    await withTimeout(Promise.resolve(agent.whenIdle()), 60_000, '等待 agent 空闲');
    const firstSeq = agent.session.seq;
    const message = createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    });
    agent.followup(message);
    try {
      await withTimeout(Promise.resolve(agent.whenIdle()), this.turnTimeoutMs(), '等待 agent 处理邮件');
    } catch (err) {
      // 超时不是"再等等就好了"：把回合停掉，别让它继续占着会话（L2）
      await this.cancelTurn(agent, '回合超时');
      if (err && typeof err === 'object') err.timedOut = true;
      throw err;
    }

    let text = '';
    for (let seq = firstSeq; seq < agent.session.seq; seq += 1) {
      let event;
      try {
        event = agent.session.eventAt(SessionSeq(seq));
      } catch {
        continue;
      }
      if (event?.type !== 'assistant/message') continue;
      const content = event.data?.message?.content;
      if (!Array.isArray(content)) continue;
      const piece = content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('');
      if (piece) text = piece;
    }
    return text;
  }

  async runInner({ prompt, workspace, sessionMode = 'per_mail', label = 'mail' }) {
    await this.ready();

    // 每日会话模式：复用同一个会话（不建子智能体）
    if (sessionMode === 'daily') {
      let sessionId = this.sessionIdFor('daily');
      /*
       * 上一回合超时、取消后仍没停稳：这个会话已经脏了，继续用会让每封都"等待空闲超时"。
       * 旧句柄留在 handles 里到卸载时统一释放（它可能还在后台收敛），但不再接新回合。
       */
      if (this.stuckSessions.has(sessionId)) {
        this.stuckSessions.delete(sessionId);
        this.state.agent = { ...(this.state.agent ?? {}), sessionId: '' };
        sessionId = this.sessionIdFor('daily');
        this.logger?.warn?.('[mail-automation] 今天的会话因上一回合超时未停稳而弃用，已改用新会话');
      }
      let agent;
      try {
        const handle = await this.ensureAgent(sessionId, workspace);
        agent = handle?.agent ?? handle;
        if (typeof agent?.followup !== 'function') throw new Error('agent 句柄不可用（缺少 followup）');
      } catch (err) {
        return { ok: false, error: `创建 agent 会话失败：${err instanceof Error ? err.message : String(err)}`, sessionId, label };
      }
      try {
        const text = await this.runInSession(agent, prompt);
        return { ok: true, text: text.trim(), sessionId, label };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err), sessionId, label };
      }
    }

    let parent;
    try {
      parent = await this.ensureParent(workspace);
    } catch (err) {
      return { ok: false, error: `准备父会话失败：${err instanceof Error ? err.message : String(err)}`, sessionId: '', label };
    }
    const parentAgent = parent?.agent ?? parent;

    /*
     * 每封邮件 = 一个**受管子智能体**，走官方 ctx.subagents.startActivation()：
     * 只有这条通道会写 header.origin='subagent'、header.parentSession、subagent/descriptor
     * 以及父会话的 subagent/catalog。自己 agents.create + 手写 catalog 只能让 UI 列出条目，
     * 一打开就报 "subagent does not belong to the supplied parent"（实测）。
     */
    const subs = this.ctx.get('subagents');
    if (subs?.startActivation && parentAgent) {
      const controller = new AbortController();
      let run;
      try {
        const { presetId } = await this.presetSetup('mail');
        const agentOptions = await this.agentOptions();
        run = await subs.startActivation({
          provider: 'spawn',
          label: String(label || '邮件').slice(0, 80),
          request: {
            parent: parentAgent,
            prompt: [{ type: 'text', text: String(prompt ?? '') }],
            maxDepth: 1,
            ...(presetId ? { agentPreset: presetId } : {}),
            ...(agentOptions ? { agentOptions } : {}),
          },
          signal: controller.signal,
          delivery: 'caller',
        });
      } catch (err) {
        return { ok: false, error: `创建子智能体失败：${err instanceof Error ? err.message : String(err)}`, sessionId: '', label };
      }

      const childId = String(run?.childId ?? '');
      try {
        const outcome = await withTimeout(Promise.resolve(run.result), this.turnTimeoutMs(), '等待子智能体完成');
        const stopReason = String(outcome?.stopReason ?? 'error');
        const text = (Array.isArray(outcome?.output) ? outcome.output : [])
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('')
          .trim();
        if (stopReason !== 'completed') {
          /*
           * 只报 stopReason 等于把真实原因吞掉：模型凭据缺失（MISSING_CREDENTIAL）、
           * 没有 adapter（NO_ADAPTER）、模型路由不可用时，stopReason 都是笼统的 error。
           * 这里把 outcome 里可能携带的详情找出来（字段名随宿主版本不同），并记下 childId，
           * 便于直接打开子会话看完整报错。
           */
          const detail =
            [outcome?.error, outcome?.message, outcome?.failure, outcome?.reason, outcome?.stopReasonMessage]
              .map((value) => (typeof value === 'string' ? value.trim() : ''))
              .filter(Boolean)[0] ?? '';
          if (detail) {
            this.logger?.warn?.(
              `[mail-automation] 子智能体失败：child=${childId || '(未知)'} stopReason=${stopReason} detail=${detail.slice(0, 300)}`,
            );
          }
          return this.retryWithFreshParentIfBlocked(
            {
              ok: false,
              error:
                `子智能体未正常完成（${stopReason}）` +
                `${detail ? `：${detail.slice(0, 300)}` : text ? `：${text.slice(0, 200)}` : ''}`,
              sessionId: childId,
              label,
            },
            { prompt, workspace, sessionMode, label },
          );
        }
        return { ok: true, text, sessionId: childId, label };
      } catch (err) {
        try {
          controller.abort();
        } catch {
          // ignore
        }
        return { ok: false, error: err instanceof Error ? err.message : String(err), sessionId: childId, label };
      } finally {
        // 释放本次 activation：否则驻留子级会占满 maxActiveSubagents（默认 8），
        // 之后的新邮件会被 ACTIVATION_LIMIT_REACHED 拒绝。
        // dispose() 内部会 cancel + await whenIdle + flush，**必须封顶**：不封顶时它一旦不
        // 收敛，this.chain 就永远不前进，之后每一封都排在这条死链上（L2）。
        try {
          await withTimeout(Promise.resolve(run.dispose?.()), this.disposeTimeoutMs, '释放子智能体');
        } catch (err) {
          this.logger?.warn?.(`[mail-automation] 释放子智能体失败/超时：${err?.message ?? err}`);
        }
        // 静默模式：子会话也归档，别在（已归档的）父会话目录里越积越多。
        // 这里用 stopActivity:false —— 结果是刚 settle 的，没必要再发一次停止信号。
        if (childId && this.isSilent()) {
          await this.archiveSession(childId, { stopActivity: false });
        }
      }
    }

    // 兜底：部署里没有 subagents 服务时，退回「直接建会话」，并挂到工作区保证可见
    let child;
    try {
      child = await this.createChild(parent, workspace, label);
    } catch (err) {
      return { ok: false, error: `创建子会话失败：${err instanceof Error ? err.message : String(err)}`, sessionId: '', label };
    }
    const { handle, sessionId } = child;
    const agent = handle?.agent ?? handle;
    try {
      if (typeof agent?.followup !== 'function') throw new Error('agent 句柄不可用（缺少 followup）');
      const text = await this.runInSession(agent, prompt);
      return { ok: true, text: text.trim(), sessionId, label };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), sessionId, label };
    } finally {
      this.handles.delete(sessionId);
      const archived = await this.archiveSession(sessionId).catch(() => false);
      if (archived) this.forgetChild(sessionId);
    }
  }

  /**
   * 沿用的父会话（恢复出来的那个）有时会让子会话第一步就被 `agent/pre-step` 拒
   * （turn 以 `blocked` / `refusal` 结束、一个 step 都没开）。遇到这种失败就：
   * 丢掉父会话 → 标记强制换代 → 重跑一次。每进程只重试一次，不会死循环。
   */
  async retryWithFreshParentIfBlocked(result, args) {
    if (!result || result.ok) return result;
    if (this.parentRetryDone) return result;
    /*
     * 以前这里还有 `!this.parentResumed`：只救"沿用/恢复出来的父会话"。可新建的父会话
     * 在开局回合失败时同样会让子会话第一步被拒，却永久没有兜底（A4）。现在两种都认，
     * 仍然每进程只换一代（`parentRetryDone`），不会死循环。
     */
    if (!this.parentResumed && !this.parentPrimeFailed) return result;
    if (!/blocked|refusal|未正常完成/.test(String(result.error ?? ''))) return result;
    /*
     * 凭据/模型类失败换父会话毫无用处（没 key、没 adapter、模型不存在，换谁都一样），
     * 只会白建一个会话、把真正的错误盖到第二轮。直接判失败，让结论与重试保留原因。
     */
    if (/MISSING_CREDENTIAL|NO_ADAPTER|no adapter|api[ _-]?key|unauthori[sz]ed|not authenticated/i.test(String(result.error ?? ''))) {
      return result;
    }
    this.parentRetryDone = true;
    this.parentResumed = false;
    this.parentPrimeFailed = false;
    this.parentPrimeExhausted = false;
    /** 本进程内确认过"模型/凭据不可用"（不是抖动），用于跳过后续热身与更准确的日志 */
    this.parentPrimeUnavailable = false;
    this.forceFreshParent = true;
    this.parentPrimed = false;
    const old = this.parentHandle;
    this.parentHandle = null;
    try {
      const pending = old?.dispose?.();
      if (pending && typeof pending.catch === 'function') pending.catch(() => undefined);
    } catch {
      // 关掉旧句柄失败不该影响重试
    }
    this.logger?.warn?.('[mail-automation] 沿用的父会话让子会话被拒（blocked），已换成新父会话并重试一次');
    return this.runInner(args);
  }

  /**
   * 卸载时释放本插件创建过的 agent（含长期存在的父会话），逐个 await。
   * 由插件主 effect 的单个 disposer 串行调用（§3.2：跨 disposer 没有完成顺序保证）。
   */
  async dispose() {
    const handles = [...this.handles.values()];
    this.handles.clear();
    if (this.parentHandle) {
      handles.push(this.parentHandle);
      this.parentHandle = null;
    }
    for (const handle of handles) {
      try {
        // 卸载路径同样封顶：某个 handle 的 dispose 卡住不该让整个插件卸载挂死
        await withTimeout(Promise.resolve(handle?.dispose?.()), this.disposeTimeoutMs, '释放 agent');
      } catch (err) {
        this.logger?.warn?.(`[mail-automation] 释放 agent 失败/超时：${err?.message ?? err}`);
      }
    }
  }
}
