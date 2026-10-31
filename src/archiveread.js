/**
 * 按需读邮件存档（`mail_automation_archive_read` 工具的实现）。
 *
 * 存档是「一封邮件一个目录」（见 store.js）：
 *   meta.json / body.txt / body.html / raw.eml|raw.json / conclusion.md
 * 这个模块负责：把用户给的名字/路径/关键词解析到目录，再按 part 读出其中一份。
 *
 * 为什么要这条通道：子智能体拿到的工具集来自 preset，偶尔没有 read 工具，
 * 或者存档路径被文件沙箱挡住。插件在宿主进程里直接读盘，不受这些限制；
 * 正文也不预先塞进提示词，省掉每封邮件 4000 字的重复开销。
 */
import fs from 'node:fs';
import path from 'node:path';
import { archiveFile, readMeta } from './store.js';

const DEFAULT_MAX_CHARS = 6000;
const HARD_MAX_CHARS = 20000;
const MIN_MAX_CHARS = 200;

const PARTS = ['text', 'html', 'image', 'raw', 'conclusion', 'meta'];

const isDir = (target) => {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
};

const isFile = (target) => {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
};

/** 一个路径是不是（或属于）一封邮件的存档目录 */
function dirOf(target) {
  if (isDir(target) && isFile(path.join(target, 'meta.json'))) return target;
  if (isFile(target)) {
    const parent = path.dirname(target);
    if (isFile(path.join(parent, 'meta.json'))) return parent;
  }
  return null;
}

/** realpath 解析（不存在就退回归一化后的路径）：用来抓符号链接/junction 逃逸 */
function canonical(value) {
  const resolved = path.resolve(String(value ?? ''));
  try {
    /*
     * 必须用 `.native`：JS 版 realpath 在 Windows 上**不解析 junction**
     * （实测 junction 目录会被原样返回，指到存档外的目录照样能读）。
     * 长路径时 native 会带 `\\?\` 前缀，不去掉 `path.relative` 会算错。
     */
    const real = typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
    // 长路径前缀要剥掉，否则 path.relative 会算错；UNC 形式要还原成 \\server\share
    if (/^\\\\\?\\UNC\\/i.test(real)) return `\\\\${real.slice(8)}`;
    return /^\\\\\?\\/.test(real) ? real.slice(4) : real;
  } catch {
    return resolved;
  }
}

/**
 * 目标是不是落在存档根之内（C9）。
 *
 * `mail_automation_archive_read` 是给模型用的：不校验的话，随便一个绝对路径或 `../` 就能把
 * "只能读邮件存档"变成"能读整台机器"。这里按**解析后**的路径比较，
 * 存在时再走 `realpath`（防符号链接跳出去）。
 */
export function isInsideArchive(archiveDir, target) {
  // 安全谓词必须 fail-closed：空值/空串不能因为 canonical('')→cwd 而返回 true
  if (!String(archiveDir ?? '').trim() || !String(target ?? '').trim()) return false;
  const root = canonical(archiveDir);
  const real = canonical(target);
  const fold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const rel = path.relative(fold(root), fold(real));
  if (rel === '') return true;
  // `..` 本身、或 `..\<...>` 才算逃逸；否则名叫 `..foo` 的目录也会被误杀
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** 错误文案里的用户输入：截断并去掉换行，别让邮件内容借着回显做提示注入 */
const clip = (value) => String(value ?? '').slice(0, 200).replace(/[\r\n\t]+/g, ' ');

/** 把用户给的路径落到存档目录上：绝对路径直接用，相对/纯名字按存档目录补全 */
export function locateMail(value, archiveDir) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  // 相对名只按存档根补全：按 cwd 解析是唯一以 `../` 为起点的入口，生产里也用不到
  const tries = path.isAbsolute(raw) ? [raw] : [path.join(archiveDir, raw)];
  for (const candidate of tries) {
    // 越界的候选一律不认：否则工具就变成任意文件读取（C9）
    if (!isInsideArchive(archiveDir, candidate)) continue;
    const dir = dirOf(candidate);
    if (dir) return dir;
  }
  return null;
}

/**
 * 按关键词找邮件（没有路径时兜底）。存档是平铺的，一层目录一封邮件；
 * 命中主题、发件人或目录名都算。
 */
export function searchArchive(archiveDir, query, { limit = 10 } = {}) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) return [];
  let names;
  try {
    names = fs
      .readdirSync(archiveDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const hits = [];
  for (const name of names) {
    const dir = path.join(archiveDir, name);
    // junction/符号链接指向存档外时，连 meta.json 都不该读（C9）
    if (!isInsideArchive(archiveDir, dir)) continue;
    const meta = readMeta(dir);
    if (!meta) continue; // 不是邮件目录（例如写到一半、缺 meta.json 的目录）
    const haystack = `${name} ${meta.subject ?? ''} ${meta.from ?? ''}`.toLowerCase();
    if (!haystack.includes(needle)) continue;
    hits.push({ dir, day: String(meta.date ?? '').slice(0, 10), name, subject: meta.subject ?? '', from: meta.from ?? '', date: meta.date ?? '' });
    if (hits.length >= limit) break;
  }
  return hits;
}

const clamp = (value, fallback, min, max) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
};

/** HTML → 纯文本的兜底（只有 body.txt 缺失/为空时才用） */
export function htmlToText(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * 汇总邮件里所有链接的**主机名**（去重，按出现次数降序）。
 *
 * 为什么需要它：判断钓鱼的动作是「对比图片里的品牌和链接实际指向」，而拿到这条信息
 * 原先得让 agent 自己 `part: "html"` 再写 PowerShell/Python 抠 href（实测 3 次额外工具调用）。
 * 这里在宿主里算好 10 来个主机名，agent 一眼就能看出「全部指向 mailings.example.edu」。
 */
export function linkHosts(dir) {
  const file = archiveFile.html(dir);
  let html = '';
  try {
    if (isFile(file)) html = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  if (!html) return [];
  const counts = new Map();
  const samples = new Map();
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const href = match[1].trim();
    if (!/^https?:/i.test(href)) continue;
    let host = '';
    try {
      host = new URL(href).host.toLowerCase();
    } catch {
      continue;
    }
    if (!host) continue;
    counts.set(host, (counts.get(host) ?? 0) + 1);
    if (!samples.has(host)) {
      const text = htmlToText(match[2]).slice(0, 40);
      if (text) samples.set(host, text);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([host, count]) => ({ host, count, text: samples.get(host) ?? '' }));
}

/** 找出这封邮件的预览分片（preview-1.png … preview-N.png），按序号排序 */
export function previewSlices(dir) {
  const out = [];
  try {
    const names = fs
      .readdirSync(dir)
      .filter((name) => /^preview-\d+\.png$/i.test(name))
      .sort((a, b) => Number(/(\d+)/.exec(a)?.[1] ?? 0) - Number(/(\d+)/.exec(b)?.[1] ?? 0));
    for (const name of names) {
      const file = path.join(dir, name);
      const meta = readMeta(dir) ?? {};
      const recorded = (Array.isArray(meta.preview_slices) ? meta.preview_slices : []).find((slice) => slice?.name === name);
      out.push({ file, width: recorded?.width ?? null, height: recorded?.height ?? null });
    }
  } catch {
    // 目录读不到就没有分片
  }
  return out;
}

/** 读出 part 对应的文件路径与内容 */
function readPart(dir, part) {
  const want = PARTS.includes(part) ? part : 'text';
  const eml = archiveFile.rawEml(dir);
  const json = archiveFile.rawJson(dir);
  switch (want) {
    case 'html': {
      const file = archiveFile.html(dir);
      if (!isFile(file)) return { error: '这封邮件没有 HTML 正文（只有纯文本）' };
      return {
        part: 'html',
        file,
        text: fs.readFileSync(file, 'utf8'),
        note: 'body.html：原始 HTML，原样保存',
        links: linkHosts(dir),
      };
    }
    case 'image': {
      const file = archiveFile.preview(dir);
      if (!isFile(file)) return { error: '这封邮件没有预览图（不是 HTML 邮件，或渲染失败）' };
      // 超长页面会有 preview-1.png … preview-N.png 分片：整页图给不了细节，分片才是可读的
      const slices = previewSlices(dir);
      return {
        part: 'image',
        file,
        text: '',
        note: slices.length > 0
          ? `preview.png：整页图；另有 ${slices.length} 张分片（preview-1..${slices.length}.png），细节以分片为准`
          : 'preview.png：body.html 的整页渲染图',
        slices,
        // 钓鱼判断要「品牌 vs 链接实际指向」：顺手把主机名汇总带上，省一次 html + 脚本调用
        links: linkHosts(dir),
      };
    }
    case 'raw': {
      if (isFile(eml)) {
        return { part: 'raw', file: eml, text: fs.readFileSync(eml, 'utf8'), note: 'raw.eml：原始 RFC822 报文（含 MIME 头，可能有 base64/编码）' };
      }
      if (isFile(json)) return { part: 'raw', file: json, text: fs.readFileSync(json, 'utf8'), note: 'raw.json：Graph 接口返回的原始 JSON' };
      return { error: '这封邮件没有保存原始报文' };
    }
    case 'conclusion': {
      const file = archiveFile.conclusion(dir);
      if (!isFile(file)) return { error: '这封邮件还没有处理结论（agent 尚未完成或失败）' };
      return { part: 'conclusion', file, text: fs.readFileSync(file, 'utf8'), note: 'conclusion.md：agent 的处理结论' };
    }
    case 'meta': {
      return { part: 'meta', file: archiveFile.meta(dir), text: fs.readFileSync(archiveFile.meta(dir), 'utf8'), note: 'meta.json：元数据与文件清单' };
    }
    default: {
      const file = archiveFile.text(dir);
      if (isFile(file)) {
        const text = fs.readFileSync(file, 'utf8');
        if (text.trim()) return { part: 'text', file, text, note: 'body.txt：纯文本正文' };
      }
      // body.txt 空/缺失：退回 HTML 转文本
      const html = archiveFile.html(dir);
      if (isFile(html)) {
        return { part: 'text', file: html, text: htmlToText(fs.readFileSync(html, 'utf8')), note: 'body.txt 为空，这份是从 body.html 临时转出来的' };
      }
      return { part: 'text', file, text: '', note: 'body.txt 为空' };
    }
  }
}

/**
 * 读一段内容。返回结构直接给工具用：
 *   { ok, dir, part, file, note, subject, from, date, source, files, total, offset, next, truncated, text }
 *   / { ok:false, error, candidates? }
 */
export function readArchivedMail({ file, query, part, offset, maxChars }, { archiveDir } = {}) {
  const limit = clamp(maxChars, DEFAULT_MAX_CHARS, MIN_MAX_CHARS, HARD_MAX_CHARS);
  /*
   * 越界必须在 query 兜底**之前**判定：否则 `file: 越界路径 + query: 某关键词` 会
   * 静默改读另一封邮件（实测越界被 query 吞掉、返回 ok:true），比报错更糟。
   */
  const asked = String(file ?? '').trim();
  if (asked) {
    const target = path.isAbsolute(asked) ? asked : path.join(archiveDir, asked);
    if (!isInsideArchive(archiveDir, target)) {
      return {
        ok: false,
        error: `只能读存档目录里的邮件：${archiveDir}（这个路径不在其中：${clip(asked)}）`,
        candidates: [],
      };
    }
  }
  let dir = file ? locateMail(file, archiveDir) : null;
  let candidates = [];

  if (!dir && query) {
    candidates = searchArchive(archiveDir, query);
    if (candidates.length === 1) dir = candidates[0].dir;
    else if (candidates.length === 0) return { ok: false, error: `没找到匹配「${query}」的邮件存档`, candidates: [] };
    else {
      return {
        ok: false,
        error: `匹配「${query}」的有 ${candidates.length} 封，请用其中一个 file（存档目录）再读`,
        candidates: candidates.map((item) => ({ dir: item.dir, subject: item.subject, from: item.from, date: item.date })),
      };
    }
  }

  if (!dir) {
    return {
      ok: false,
      error: file ? `找不到这个邮件存档：${clip(file)}` : '需要 file 或 query 其中之一',
      candidates: [],
    };
  }

  // 最后一道闸门：不论 dir 是 locateMail 还是 searchArchive 给的，读盘前再确认一次
  if (!isInsideArchive(archiveDir, dir)) {
    return { ok: false, error: `只能读存档目录里的邮件：${archiveDir}（这个路径不在其中：${clip(dir)}）`, candidates: [] };
  }

  const meta = readMeta(dir) ?? {};
  let picked;
  try {
    picked = readPart(dir, part);
  } catch (err) {
    return { ok: false, error: `读存档失败：${err?.message ?? err}`, candidates: [] };
  }
  if (picked.error) return { ok: false, error: picked.error, candidates: [], dir };
  // part 指向的具体文件也可能是指向存档外的链接（目录在根内 ≠ 文件在根内）
  if (picked.file && !isInsideArchive(dir, picked.file)) {
    return { ok: false, error: `存档里的 ${path.basename(picked.file)} 指向存档外，已拒绝`, candidates: [], dir };
  }

  const common = {
    ok: true,
    dir,
    part: picked.part,
    file: picked.file,
    note: picked.note ?? '',
    subject: meta.subject ?? '',
    from: meta.from ?? '',
    date: meta.date ?? '',
    source: meta.source ?? '',
    files: Array.isArray(meta.files) ? meta.files : [],
    links: Array.isArray(picked.links) ? picked.links : [],
  };

  // 图片不是文本：原样返回路径与尺寸，由工具渲染层告诉 agent 用 read_image 打开
  if (picked.part === 'image') {
    let size = null;
    try {
      size = fs.statSync(picked.file).size;
    } catch {
      size = null;
    }
    const slices = Array.isArray(picked.slices) ? picked.slices : [];
    return {
      ...common,
      total: 0,
      offset: 0,
      next: 0,
      truncated: false,
      text: '',
      image: true,
      bytes: size,
      width: meta.preview_width ?? null,
      height: meta.preview_height ?? null,
      // 整页图在前，可读分片在后：细节一律以分片为准
      images: [picked.file, ...slices.map((slice) => slice.file)],
      slices,
    };
  }

  const body = String(picked.text ?? '');
  const start = clamp(offset, 0, 0, Math.max(0, body.length));
  const slice = body.slice(start, start + limit);
  const end = start + slice.length;
  return {
    ...common,
    total: body.length,
    offset: start,
    next: end,
    truncated: end < body.length,
    text: slice,
  };
}
