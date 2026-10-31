/**
 * 定时任务的**纯排期数学**：没有 fs、没有 ctx、没有定时器。
 *
 * 为什么单独一篇：
 *   - 排期是最容易写错、又最容易离线断言的部分（月末、多时刻、周几、间隔锚点、重启后的
 *     "这次到底该不该跑"）。把它从 `index.js` 的闭包里提出来，测试可以只喂时间戳。
 *   - `config.js` 只在这里做**校验与归一**，运行期只在这里算"下一次"；两边不各写一套。
 *
 * 支持的任务类型（`schedules[].schedule.type`）：
 *   - `daily`    每天 `times` 里的每个时刻；
 *   - `weekly`   每周 `weekdays`（ISO：1=周一 … 7=周日）的每个 `times`；
 *   - `monthly`  每月 `days`（1–31，月份没有该日时夹到当月最后一天）的每个 `times`；
 *   - `interval` 每 `everyMinutes` 分钟（从上次运行时刻起算）；
 *   - `startup`  每次插件启动后运行一次（每个进程一次，不跨启动去重）。
 *
 * 语义约定（写进 configuration.md）：
 *   - 时刻一律是**本机本地时间** `HH:MM`，秒与毫秒截断；
 *   - `nextScheduleAt()` 只返回**严格晚于 from** 的时刻：正好踩在触发点上（例如 21:30:00.000
 *     启动）会排到下一天，避免"重启一次又跑一遍"；
 *   - `interval` 用 `lastRunAtMs` 锚定，停机期间错过的只补跑**一次**（不补 N 次、不刷 token）；
 *   - 每个"槽"（`slot`）只会被认领一次：定时任务宁可漏一次，也不重复发 QQ。
 */

/** 允许的排期类型（设置页下拉与配置校验共用） */
export const SCHEDULE_TYPES = Object.freeze(['daily', 'weekly', 'monthly', 'interval', 'startup']);

/** 时间格式：`H:MM` / `HH:MM`（秒不允许：任务粒度是分钟） */
const CLOCK_RE = /^(\d{1,2}):(\d{2})$/;

/** 间隔上限 30 天：再长就该用 daily/monthly 表达，也避免 setTimeout 溢出语义 */
export const MAX_EVERY_MINUTES = 30 * 24 * 60;

/** 一次进程内的启动标识：`startup` 任务每个进程只跑一次，重启后自然换新值再跑 */
export const PROCESS_BOOT_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * 把单个时刻归一成 `HH:MM`；非法返回 `null`。
 * 允许 `9:05`（补成 `09:05`），拒绝 `24:00` / `12:60` / 带秒的写法。
 */
export function normalizeClock(value) {
  const m = CLOCK_RE.exec(String(value ?? '').trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return `${pad2(hour)}:${pad2(minute)}`;
}

/** 归一化 times：去重 + 排序；接受字符串或数组（字符串里也允许逗号分隔） */
export function normalizeTimes(raw, label = 'times') {
  const list = Array.isArray(raw)
    ? raw
    : raw === undefined || raw === null || raw === ''
      ? []
      : String(raw).split(/[,，\s]+/).filter(Boolean);
  const out = [];
  for (const item of list) {
    const text = String(item ?? '').trim();
    if (!text) continue;
    const clock = normalizeClock(text);
    if (!clock) throw new Error(`${label} 里有非法时刻「${text}」（需要 HH:MM，00:00–23:59）`);
    if (!out.includes(clock)) out.push(clock);
  }
  out.sort();
  return out;
}

/** 归一化整数列表（周几 / 每月第几天）；去重 + 升序 */
function normalizeIntList(raw, min, max, label) {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null || raw === '' ? [] : [raw];
  const out = [];
  for (const item of list) {
    const n = Math.trunc(Number(item));
    if (!Number.isFinite(n) || n < min || n > max) {
      throw new Error(`${label} 里非法取值「${String(item)}」（需要 ${min}–${max} 的整数）`);
    }
    if (!out.includes(n)) out.push(n);
  }
  out.sort((a, b) => a - b);
  return out;
}

/**
 * 校验并归一一个 schedule。
 *
 * 失败**抛错**（由 `normalizeConfig` 冒泡成"配置无效"）：静默修正会让用户以为
 * "每周三"保存成功，实际跑在别的时间。
 *
 * @param {object} raw `{type, times, weekdays, days, every_minutes|everyMinutes}`
 * @param {string} label 错误文案里的任务名
 * @returns {{type:string, times?:string[], weekdays?:number[], days?:number[], everyMinutes?:number}}
 */
export function normalizeSchedule(raw, label = '定时任务') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${label} 缺少 schedule（需要 { type: daily|weekly|monthly|interval|startup, … }）`);
  }
  const type = String(raw.type ?? raw.kind ?? '').trim().toLowerCase();
  if (!SCHEDULE_TYPES.includes(type)) {
    throw new Error(`${label} 的 schedule.type 不支持：${type || '(空)'}（只支持 ${SCHEDULE_TYPES.join(' / ')}）`);
  }
  if (type === 'startup') return { type: 'startup' };
  if (type === 'interval') {
    const rawEvery = raw.everyMinutes ?? raw.every_minutes ?? raw.minutes;
    const every = Math.trunc(Number(rawEvery));
    if (!Number.isFinite(every) || every < 1) {
      throw new Error(`${label} 的间隔必须是 ≥1 的整数分钟（收到：${String(rawEvery ?? '') || '(空)'}）`);
    }
    return { type: 'interval', everyMinutes: Math.min(MAX_EVERY_MINUTES, every) };
  }

  const times = normalizeTimes(raw.times ?? raw.time, `${label} 的 times`);
  if (times.length === 0) throw new Error(`${label} 没有写 times（例如 times: ["12:00", "21:00"]）`);
  if (type === 'daily') return { type: 'daily', times };
  if (type === 'weekly') {
    const weekdays = normalizeIntList(raw.weekdays ?? raw.week_days ?? raw.days, 1, 7, `${label} 的 weekdays`);
    if (weekdays.length === 0) throw new Error(`${label} 没有写 weekdays（1=周一 … 7=周日）`);
    return { type: 'weekly', weekdays, times };
  }
  const days = normalizeIntList(raw.days ?? raw.month_days, 1, 31, `${label} 的 days`);
  if (days.length === 0) throw new Error(`${label} 没有写 days（1–31，月份没有该日时按当月最后一天）`);
  return { type: 'monthly', days, times };
}

/** `HH:MM` → `{hour, minute}`（`normalizeClock` 之后一定成功） */
function clockParts(clock) {
  const [hour, minute] = clock.split(':').map(Number);
  return { hour, minute };
}

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/**
 * 下一次触发时刻（ms）；没有下一次返回 0。
 *
 * 只对 `daily/weekly/monthly` 有意义：
 *   - `interval` 需要锚点，用 `intervalNextAt()`；
 *   - `startup` 由 `planNextRun()` 按进程启动标识决定。
 */
export function nextScheduleAt(schedule, fromMs = Date.now()) {
  if (!schedule || typeof schedule !== 'object') return 0;
  const from = Number(fromMs);
  const base = Number.isFinite(from) ? from : Date.now();
  const times = Array.isArray(schedule.times) ? schedule.times : [];
  if (times.length === 0) return 0;

  if (schedule.type === 'daily') {
    // 最多看两天：今天剩下的时刻 + 明天全部时刻
    for (let offset = 0; offset <= 1; offset += 1) {
      const day = new Date(base);
      day.setHours(0, 0, 0, 0);
      day.setDate(day.getDate() + offset);
      for (const clock of times) {
        const { hour, minute } = clockParts(clock);
        const at = new Date(day);
        at.setHours(hour, minute, 0, 0);
        if (at.getTime() > base) return at.getTime();
      }
    }
    return 0;
  }

  if (schedule.type === 'weekly') {
    const weekdays = Array.isArray(schedule.weekdays) ? schedule.weekdays : [];
    // 最多看 8 天：今天 + 未来 7 天（覆盖"今天这个时刻已过"的同一周几）
    for (let offset = 0; offset <= 7; offset += 1) {
      const day = new Date(base);
      day.setHours(0, 0, 0, 0);
      day.setDate(day.getDate() + offset);
      const iso = ((day.getDay() + 6) % 7) + 1; // JS 0=周日 → ISO 1=周一 … 7=周日
      if (!weekdays.includes(iso)) continue;
      for (const clock of times) {
        const { hour, minute } = clockParts(clock);
        const at = new Date(day);
        at.setHours(hour, minute, 0, 0);
        if (at.getTime() > base) return at.getTime();
      }
    }
    return 0;
  }

  if (schedule.type === 'monthly') {
    const days = Array.isArray(schedule.days) ? schedule.days : [];
    const start = new Date(base);
    // 最多看 13 个月：当月剩余 + 未来 12 个月
    for (let offset = 0; offset <= 12; offset += 1) {
      const year = start.getFullYear();
      const month = start.getMonth() + offset;
      const dim = daysInMonth(year, month);
      for (const wantedDay of [...days].sort((a, b) => a - b)) {
        // 31 号在 2 月按 28/29 号跑：宁可当天跑，也不要两个月都不跑
        const day = Math.min(wantedDay, dim);
        for (const clock of times) {
          const { hour, minute } = clockParts(clock);
          const at = new Date(year, month, day, hour, minute, 0, 0);
          if (at.getTime() > base) return at.getTime();
        }
      }
    }
    return 0;
  }

  return 0;
}

/**
 * `interval` 的下一次：从**上次运行**起算。
 * - 没跑过：`from + interval`（首次启动不立刻跑，避免"刚装好就发一条"）；
 * - 已过期（停机/休眠错过的）：返回 `from`，即"现在补跑一次"；补完 `lastRunAt` 刷新，
 *   下一次自然从新锚点起算，不会连刷多次。
 */
export function intervalNextAt(schedule, fromMs = Date.now(), lastRunAtMs = 0) {
  if (!schedule || schedule.type !== 'interval') return 0;
  const every = Math.trunc(Number(schedule.everyMinutes ?? schedule.every_minutes ?? 0));
  if (!Number.isFinite(every) || every < 1) return 0;
  const from = Number(fromMs) || Date.now();
  const step = every * 60_000;
  const last = Number(lastRunAtMs) || 0;
  if (!last) return from + step;
  const next = last + step;
  return next > from ? next : from;
}

/**
 * 槽标识：同一个"排期位置"只允许认领一次。
 * 定时任务用本地日期+时刻；interval 用目标时间戳；startup 用进程启动标识。
 */
export function slotKeyOf(schedule, atMs) {
  const type = schedule?.type;
  if (type === 'startup') return `boot:${PROCESS_BOOT_ID}`;
  if (type === 'interval') return `interval:${Number(atMs) || 0}`;
  const d = new Date(Number(atMs) || Date.now());
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 算一个任务"下一次该在什么时候跑"。
 *
 * @param {{schedule:object}} task
 * @param {{lastRunAtMs?:number, lastSlot?:string}} run 该任务的持久运行记录
 * @param {number} now
 * @returns {{at:number, slot:string, done?:boolean}} `done:true` = 本进程已经跑过（startup）
 */
export function planNextRun(task, run = {}, now = Date.now()) {
  const schedule = task?.schedule;
  const lastRunAtMs = Number(run?.lastRunAtMs ?? run?.lastRunAt ?? 0) || 0;
  if (!schedule) return { at: 0, slot: '', done: true };
  if (schedule.type === 'startup') {
    const slot = slotKeyOf(schedule, now);
    // 本进程跑过就不再排（lastSlot 在认领前就已落盘，崩溃重启后是新进程、新 slot）
    if (String(run?.lastSlot ?? '') === slot) return { at: 0, slot, done: true };
    return { at: now, slot, done: false };
  }
  if (schedule.type === 'interval') {
    const at = intervalNextAt(schedule, now, lastRunAtMs);
    return at ? { at, slot: slotKeyOf(schedule, at), done: false } : { at: 0, slot: '', done: true };
  }
  const at = nextScheduleAt(schedule, now);
  return at ? { at, slot: slotKeyOf(schedule, at), done: false } : { at: 0, slot: '', done: true };
}

const WEEKDAY_CN = ['一', '二', '三', '四', '五', '六', '日'];

/** 人类可读的一行（设置页任务列表、日志、工具文本共用） */
export function describeSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object') return '未配置';
  const times = Array.isArray(schedule.times) ? schedule.times.join('、') : '';
  if (schedule.type === 'startup') return '每次启动时';
  if (schedule.type === 'daily') return `每天 ${times}`;
  if (schedule.type === 'weekly') {
    const days = (schedule.weekdays ?? []).map((n) => WEEKDAY_CN[n - 1] ?? String(n)).join('、');
    return `每周${days} ${times}`;
  }
  if (schedule.type === 'monthly') {
    return `每月 ${(schedule.days ?? []).join('、')} 日 ${times}`;
  }
  if (schedule.type === 'interval') {
    const minutes = Number(schedule.everyMinutes ?? 0) || 0;
    if (minutes > 0 && minutes % (24 * 60) === 0) return `每 ${minutes / (24 * 60)} 天`;
    if (minutes > 0 && minutes % 60 === 0) return `每 ${minutes / 60} 小时`;
    return `每 ${minutes} 分钟`;
  }
  return '未配置';
}

/**
 * 一个槽认领失败（锁被轮询占着）后要不要推迟重试。
 *
 * 教训（lessons §4）：只重试"什么都没做"的 busy，并且有预算、有上限——
 * 失败原因是 agent 回合本身时重跑只会再烧一遍 token。
 */
export const BUSY_RETRY_MS = 60_000;
export const BUSY_RETRY_MAX = 3;
/** 轮询通常几秒结束：到点撞上轮询时 5s 试一次，最多约 2 分钟；撞上 agent 处理仍按 60s×3 */
export const BUSY_RETRY_POLL_MS = 5_000;
export const BUSY_RETRY_POLL_MAX = 24;

export function planBusyRetry({
  attempt = 0,
  now = Date.now(),
  retryMs = BUSY_RETRY_MS,
  maxAttempts = BUSY_RETRY_MAX,
} = {}) {
  const next = Math.max(1, Math.trunc(Number(attempt) || 0) + 1);
  const cap = Math.max(1, Math.trunc(Number(maxAttempts) || BUSY_RETRY_MAX));
  return { attempt: next, at: now + Math.max(1_000, Number(retryMs) || BUSY_RETRY_MS), retry: next <= cap };
}
