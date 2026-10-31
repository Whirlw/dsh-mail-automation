/**
 * 插件自有状态的持久化：优先用 DSH 的 domain KV 存储（`ctx.storageDomain`），
 * 拿不到才退回本地的 `state.json`。
 *
 * 为什么这么改（对齐 dsh-plugin-guide）：指南要求「插件状态从既有事件推导，或放进
 * inspection 找到的 storage 服务」。游标（IMAP 的 uidNext、Graph 的 seenIds）、重试队列、
 * 父会话 id 都不是会话事件能推导出来的东西，所以它们属于 storage 服务：
 *
 *   - 域（domain）= `mail_automation_state`，版本 1，四张表：
 *       sources  键 = 来源 id    一条游标
 *       retries  键 = 邮件 id    一条「agent 处理失败待重试」
 *       agent    键 = 'main'     父会话 / 每日会话
 *       meta     键 = 'main'     上次总览日期
 *   - 读是**同步**的（`table.get()` / `entries()`，内存权威）；
 *   - 写是**异步且持久**的（`table.put()` 在解析前就已经落盘），所以 Store 的 `save()`
 *     保持同步语义、把真正的写入排进一条串行链（见 store.js 的 #queueFlush）。
 *
 * 三条纪律：
 *   1. **不在模块顶层 import**：`@deepseek-ai/dsh-storage-domain` 是随宿主提供的包，
 *      老宿主上没有。动态 import + try/catch，失败就静默退回文件（不影响邮箱功能）。
 *   2. **记录结构只做宽松校验**：`domainTable()` 只需要一个带 `parse()` 的对象（宿主的
 *      实现只调 `tableSpec.valueSchema.parse(raw)`），所以这里不拖 zod 依赖。
 *      缺字段补默认、类型不对就抛（宿主会按我们声明的 `invalidRecords: 'backup-and-skip'`
 *      把坏记录备份后跳过，不至于让整个域打不开）。
 *   3. **域被别的实例开着时复用**（`already-open` 是重载窗口里的常见竞态），并且只关闭
 *      自己打开的域。
 */

/** 域名单调：`UNIT_NAME_RE` = ^[a-z][a-z0-9_]*$ */
export const STATE_DOMAIN_NAME = 'mail_automation_state';
export const STATE_TABLES = { sources: 'sources', retries: 'retries', agent: 'agent', meta: 'meta' };

const str = (value, fallback = '') => (typeof value === 'string' ? value : fallback);
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const bool = (value) => value === true;
const strList = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);

function expectObject(raw, table) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`mail_automation_state.${table}: 记录必须是对象`);
  }
  return raw;
}

/**
 * 一条定时任务运行记录。
 *
 * **必须列进 meta 的 parse 白名单**：否则 `lastSlot` 会在重启后消失，
 * 同一个"启动时任务"或同一分钟的任务就会重复跑（重复发 QQ）。
 */
function scheduleRunRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return {
    lastRunAt: str(raw.lastRunAt),
    // 排期数学用毫秒数（不依赖 Date 解析字符串，避开格式差异）
    lastRunAtMs: num(raw.lastRunAtMs),
    // 手动运行只影响展示，不参与 interval/at-most-once 的排期计算
    lastManualAt: str(raw.lastManualAt),
    lastManualAtMs: num(raw.lastManualAtMs),
    lastManualStatus: str(raw.lastManualStatus),
    lastManualError: str(raw.lastManualError),
    lastManualCount: num(raw.lastManualCount),
    // 已认领的槽：同一槽只跑一次（at-most-once）
    lastSlot: str(raw.lastSlot),
    lastStatus: str(raw.lastStatus),
    lastError: str(raw.lastError),
    lastFile: str(raw.lastFile),
    lastCount: num(raw.lastCount),
  };
}

function scheduleRunsOf(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, entry] of Object.entries(raw)) {
    const key = str(id);
    if (!key) continue;
    const record = scheduleRunRecord(entry);
    if (record) out[key] = record;
  }
  return out;
}

/**
 * 四张表的记录校验器。只需要 `.parse()`（见文件头第 2 条），不依赖 zod。
 * 造型刻意与 Store.state 的字段一一对应，避免两套形状互相翻译。
 */
export const STATE_RECORD_SCHEMAS = {
  /**
   * 一条来源游标：IMAP 用 uidValidity/uidNext，Graph/POP3 用 initialized/seenIds，
   * Gmail 用 initialized/historyId/seenIds —— 共用一条记录。
   * **新增字段必须列在这里**，否则 hydrate 时会被静默丢掉（表现为"每次重启都重建基线"）。
   */
  sources: {
    parse(raw) {
      const value = expectObject(raw, 'sources');
      return {
        uidValidity: num(value.uidValidity),
        uidNext: num(value.uidNext),
        initialized: bool(value.initialized),
        seenIds: strList(value.seenIds),
        // Gmail API：用户邮箱的 historyId（增量游标）
        historyId: num(value.historyId),
        // Gmail 账号地址（只用于显示；不是秘密）
        email: str(value.email),
      };
    },
  },
  /** 一条待重试记录（agent 处理失败、下一轮再试） */
  retries: {
    parse(raw) {
      const value = expectObject(raw, 'retries');
      const attempts = num(value.attempts);
      return {
        dir: str(value.dir),
        file: str(value.file) || str(value.dir),
        sourceId: str(value.sourceId),
        attempts: attempts === null ? 0 : attempts,
        lastError: str(value.lastError),
        at: str(value.at),
      };
    },
  },
  /** 父会话 / 每日会话（整个插件只有一条） */
  agent: {
    parse(raw) {
      const value = expectObject(raw, 'agent');
      return {
        parentSessionId: str(value.parentSessionId),
        // 静默模式专用父会话 id。**必须在这里列出来**：记录解析器只保留它认识的字段，
        // 漏一个就会在装载时被丢掉——上一版因此每次启动都新建一个父会话（还在侧边栏堆积）。
        silentParentSessionId: str(value.silentParentSessionId),
        // 上一次启动时父会话是按什么建的（工作区 + 是否静默）：启动时对比它决定"沿用还是换代"。
        // 同样**必须在这里列出来**，否则装载时会丢，于是每次都判成"首次运行"→ 每次重启都归档+新建。
        bootSignature: (() => {
          const raw = value.bootSignature;
          if (!raw || typeof raw !== 'object') return null;
          return { workspace: str(raw.workspace), silent: Boolean(raw.silent) };
        })(),
        // 已经成功跑过开局回合的父会话 id：沿用它时不必每次启动都再跑一遍
        primedSessionId: str(value.primedSessionId),
        childSessions: strList(value.childSessions),
        day: str(value.day),
        sessionId: str(value.sessionId),
      };
    },
  },
  /** 每条定时任务的运行记录（整个插件只有一条 meta） */
  meta: {
    parse(raw) {
      const value = expectObject(raw, 'meta');
      return {
        // 定时任务的 lastRun/slot/status。**漏列会在装载时被丢掉**，
        // 表现为重启后同一槽重跑（启动任务每拍重跑一次）。
        scheduleRuns: scheduleRunsOf(value.scheduleRuns),
      };
    },
  },
};

let specCache;

/** 构造（并缓存）域声明；`defineDomain` / `domainTable` 由调用方动态 import 后传进来 */
function buildSpec(defineDomain, domainTable) {
  if (specCache) return specCache;
  specCache = defineDomain({
    name: STATE_DOMAIN_NAME,
    version: 1,
    // 坏记录备份后跳过：宁可丢一条游标（下一轮重新建基线），也不要让整个域打不开
    invalidRecords: 'backup-and-skip',
    tables: {
      [STATE_TABLES.sources]: domainTable(STATE_RECORD_SCHEMAS.sources),
      [STATE_TABLES.retries]: domainTable(STATE_RECORD_SCHEMAS.retries),
      [STATE_TABLES.agent]: domainTable(STATE_RECORD_SCHEMAS.agent),
      [STATE_TABLES.meta]: domainTable(STATE_RECORD_SCHEMAS.meta),
    },
  });
  return specCache;
}

/**
 * 打开状态域。返回 `{ domain, owned }` 或 `null`（null = 这个宿主没有可用的 storage-domain，
 * 调用方应继续用 `state.json`）。
 */
export async function openStateDomain(ctx, logger) {
  let facility;
  try {
    facility = ctx?.get?.('storageDomain');
  } catch {
    facility = undefined;
  }
  if (!facility?.open) return null;

  let defineDomain;
  let domainTable;
  try {
    ({ defineDomain, domainTable } = await import('@deepseek-ai/dsh-storage-domain'));
  } catch (err) {
    logger?.warn?.(`[mail-automation] 这版宿主没有 @deepseek-ai/dsh-storage-domain（${err?.message ?? err}），状态继续写 state.json`);
    return null;
  }
  if (typeof defineDomain !== 'function' || typeof domainTable !== 'function') {
    logger?.warn?.('[mail-automation] storage-domain 的导出形状不符合预期，状态继续写 state.json');
    return null;
  }

  const spec = buildSpec(defineDomain, domainTable);
  const existing = (() => {
    try {
      return facility.get?.(spec.name) ?? null;
    } catch {
      return null;
    }
  })();
  if (existing) return { domain: existing, owned: false };

  try {
    const domain = await facility.open(spec);
    return { domain, owned: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 重载窗口里旧实例还开着同一个域：复用，不要退回文件
    const reused = (() => {
      try {
        return facility.get?.(spec.name) ?? null;
      } catch {
        return null;
      }
    })();
    if (reused) {
      logger?.info?.(`[mail-automation] 状态域已被打开（${message}），直接复用`);
      return { domain: reused, owned: false };
    }
    logger?.warn?.(`[mail-automation] 打开状态存储域失败（${message}），状态继续写 state.json`);
    return null;
  }
}
