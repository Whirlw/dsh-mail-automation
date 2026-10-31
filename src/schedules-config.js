/**
 * 「定时任务」的增删改（写 YAML 覆盖层，不碰 profile 的 cordis.patch.yml）。
 *
 * 与 `sources-config.js` 同一套纪律：
 *   - **只改覆盖层**；写前用与启动完全相同的 `normalizeConfig(composeConfig(base, overlay))`
 *     校验整表，不通过就整份不写；
 *   - `schedules` 用 `YAML.parseDocument().set(...)` 整体写回，保留其它段与注释
 *     （该段自身的注释会被重排，文档已写明）；
 *   - 任务提示词可以内联（写进 YAML）或放在 `prompt_file`。带文件的先写文件、再写 YAML；
 *     任一步失败都会在返回值里说清楚，不静默。
 *
 * 提示词统一放文件：所有 prompt 都在 `$DSH_HOME/mail-automation/prompt/`；
 * 任务的 `prompt_file` 留空时自动创建 `prompt/<id>-prompt.md`，YAML 里只存路径。
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { canonicalizeConfig, composeConfig, normalizeConfig, resolveConfigPath, defaultPromptDir, slug } from './config.js';
import { normalizeSchedule } from './schedule.js';
import { atomicWriteFile } from './fsutil.js';

function readText(configFile) {
  try {
    return fs.readFileSync(configFile, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return '';
    throw new Error(`读取 ${configFile} 失败：${err?.message ?? err}`);
  }
}

function modeOf(file) {
  try {
    return fs.statSync(file).mode & 0o777;
  } catch {
    return undefined;
  }
}

/** 覆盖层里声明的任务（原始形状）；读不到/坏 YAML 一律返回空数组（只读快照容忍） */
export function readOverlaySchedules(configFile) {
  try {
    const parsed = YAML.parse(readText(configFile)) ?? {};
    return Array.isArray(parsed?.schedules) ? parsed.schedules.filter((item) => item && typeof item === 'object') : [];
  } catch {
    return [];
  }
}

/** 把 schedules 数组写回覆盖层（保留其它段与注释、BOM 与原换行符） */
export function setYamlSchedules(text, schedules) {
  const input = String(text ?? '');
  const bom = input.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = bom ? input.slice(1) : input;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const doc = YAML.parseDocument(body);
  if (Array.isArray(doc.errors) && doc.errors.length > 0) {
    throw new Error(`覆盖层 YAML 有语法错误：${doc.errors[0]?.message ?? '未知错误'}`);
  }
  doc.set('schedules', schedules);
  const rendered = doc.toString({ lineWidth: 0 }).replace(/\r\n/g, '\n');
  return bom + (eol === '\r\n' ? rendered.replace(/\n/g, '\r\n') : rendered);
}

/** 写盘前整表校验（与 loadConfig 同一条路径） */
function validate({ text, base, dshHome, configFile, secrets }) {
  const parsed = YAML.parse(text) ?? {};
  const merged = composeConfig(base ?? {}, canonicalizeConfig(parsed), { dshHome });
  return normalizeConfig(merged, { dshHome, configFile, secrets });
}

/**
 * 把绝对提示词路径写成可移植的 YAML 值：
 * 相对配置文件目录 → `prompt/x-prompt.md`；在 $DSH_HOME 内 → `$DSH_HOME/...`；否则保留绝对路径。
 */
function portablePromptRaw(file, configDir, dshHome) {
  const rel = path.relative(configDir, file);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  const fromHome = path.relative(dshHome, file);
  if (fromHome && !fromHome.startsWith('..') && !path.isAbsolute(fromHome)) {
    return `$DSH_HOME/${fromHome.split(path.sep).join('/')}`;
  }
  return file;
}

/**
 * 把设置页/工具传来的任务归一成"要写进 YAML 的 snake_case 形状"。
 *
 * 输入既可能是快照回传（camelCase、含额外展示字段），也可能是手写 payload；
 * 这里只保留认识的键，避免设置页顺手改配置结构。
 *
 * @returns {{raw:object, promptFile:string, promptText:string}}
 */
function sanitizeTask(raw, index, { configDir, dshHome }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`schedules[${index}] 必须是对象`);
  }
  const id = String(raw.id ?? '').trim() || `task-${index + 1}`;
  const name = String(raw.name ?? '').trim() || id;
  const label = `定时任务「${name}」`;

  // 排期：复用运行时同一份校验，YAML 落成 snake_case（every_minutes）
  const schedule = normalizeSchedule(raw.schedule, label);
  const scheduleRaw = { type: schedule.type };
  if (schedule.times) scheduleRaw.times = schedule.times;
  if (schedule.weekdays) scheduleRaw.weekdays = schedule.weekdays;
  if (schedule.days) scheduleRaw.days = schedule.days;
  if (schedule.everyMinutes) scheduleRaw.every_minutes = schedule.everyMinutes;

  // 提示词字段留空 = 自动创建 `prompt/<id>-prompt.md`；正文必须填写（空文件不能算任务）
  const givenFileRaw = String(raw.prompt_file ?? raw.promptFile ?? '').trim();
  const promptText = String(raw.prompt ?? raw.prompt_inline ?? '').trim();
  if (!promptText) throw new Error(`${label} 还没有填入提示词`);

  const asFlag = (value, fallback) => {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'string') return value.trim().toLowerCase() !== 'false' && value.trim() !== '0';
    return Boolean(value);
  };
  const promptPath = givenFileRaw
    ? resolveConfigPath(givenFileRaw, configDir, dshHome)
    : path.join(defaultPromptDir(dshHome), `${slug(id)}-prompt.md`);
  const out = {
    id,
    name,
    enabled: asFlag(raw.enabled, true),
    schedule: scheduleRaw,
    prompt_file: givenFileRaw || portablePromptRaw(promptPath, configDir, dshHome),
  };
  return {
    raw: out,
    promptFile: promptPath,
    promptText,
  };
}

/**
 * 保存整套定时任务（设置页「保存」/ 工具都走这里）。
 *
 * @param {{configFile:string, base:object, dshHome:string, secrets?:object,
 *          schedules:object[], logger?:object}} input
 * @returns {{ok:boolean, ids?:string[], written?:string[], error?:string}}
 */
export function saveSchedules({ configFile, base, dshHome, secrets = {}, schedules, logger } = {}) {
  if (!configFile) return { ok: false, error: '没有可写的 configFile（当前只用 cordis.yml 配置）：无法在界面里改定时任务' };
  if (!Array.isArray(schedules)) return { ok: false, error: 'schedules 必须是数组（删除全部任务就传 []）' };
  const configDir = path.dirname(configFile);

  let prepared;
  try {
    prepared = schedules.map((raw, index) => sanitizeTask(raw, index, { configDir, dshHome }));
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
  const seen = new Map();
  for (const [index, item] of prepared.entries()) {
    const id = item.raw.id;
    if (seen.has(id)) return { ok: false, error: `任务 id 重复：第 ${seen.get(id) + 1} 个与第 ${index + 1} 个都是「${id}」` };
    seen.set(id, index);
  }

  let text;
  try {
    text = readText(configFile);
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
  let nextText;
  try {
    nextText = setYamlSchedules(text, prepared.map((item) => item.raw));
  } catch (err) {
    return { ok: false, error: `改写 YAML 失败：${err?.message ?? err}` };
  }
  try {
    validate({ text: nextText, base, dshHome, configFile, secrets });
  } catch (err) {
    return { ok: false, error: `定时任务没通过整表校验，已放弃写入：${err?.message ?? err}` };
  }

  /*
   * 提示词文件在 YAML 写入**之前**写：先写 YAML 再写文件的话，文件失败会让配置指向
   * 旧的提示词，而界面以为已保存。文件失败直接中止，YAML 保持原样（旧任务继续可用）。
   */
  const written = [];
  for (const item of prepared) {
    if (!item.promptFile) continue;
    if (!item.promptText && fs.existsSync(item.promptFile)) continue;
    try {
      fs.mkdirSync(path.dirname(item.promptFile), { recursive: true });
      const mode = modeOf(item.promptFile);
      atomicWriteFile(item.promptFile, item.promptText, mode === undefined ? { mode: 0o600 } : { mode });
      written.push(item.promptFile);
    } catch (err) {
      return { ok: false, error: `写入提示词文件 ${item.promptFile} 失败：${err?.message ?? err}；YAML 未改动` };
    }
  }
  try {
    const mode = modeOf(configFile);
    atomicWriteFile(configFile, nextText, mode === undefined ? { mode: 0o600 } : { mode });
    written.push(configFile);
  } catch (err) {
    return { ok: false, error: `写入 ${configFile} 失败：${err?.message ?? err}` };
  }
  const ids = prepared.map((item) => item.raw.id);
  logger?.info?.(`[mail-automation] 定时任务已保存：${ids.join('、') || '(无任务)'}`);
  return { ok: true, ids, written };
}
