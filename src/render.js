/**
 * 把存档里的 HTML 正文渲染成图片（给 agent 看版式用）。
 *
 * 用系统自带的 Edge/Chrome 无头模式，不引入额外依赖：
 *   1) 先跑 --dump-dom，读页面里自报的 scrollHeight（两趟才拿得到真实高度，
 *      否则固定 2400px 会留一大片空白，看图和存图都浪费）；
 *   2) 再按这个高度 --screenshot，输出到存档目录的 preview.png。
 *   3) **超长页面切片**：一张 1000×4300 的图喂给视觉模型会被压到看不清小字，
 *      agent 只能自己拿 Python 裁图（实测：17 次工具调用、70 秒、43k tokens）。
 *      所以高度超过 sliceHeight 时额外输出 preview-1.png … preview-N.png，
 *      每片不超过 sliceHeight，相邻片带一点重叠（避免把一行字切两半）。
 *      切片用「负 margin 把页面顶上去」重复截屏实现，不需要图像库。
 *
 * 三条与 dsh-plugin-guide 对齐的约束：
 *   - **进程走 `ctx.subprocess` 缝**（§6 扩展点表：进程执行交给 ctx.subprocess，由它统一
 *     沙箱/超时/回收）。`createSeamRunner()` 是主路径；没有该服务的组合（CLI、离线测试）
 *     用 `createLocalRunner()` 的 child_process 兜底。
 *   - **可调参数不硬编码**（§3.6）：浏览器路径、整页最大高度、是否允许远程资源都来自
 *     Config 的 `render.*`，本文件只留协议层的兜底常量。
 *   - **邮件 HTML 是不可信输入**：它是外部发件人写的页面。渲染前先消毒（去掉脚本、
 *     内联事件、iframe、javascript: URL），再用 CSP 关掉框架/表单/外链脚本；
 *     `render.remoteImages=false` 时连远程图片与样式也不放行（避免"打开即已读"的追踪像素）。
 *
 * 任何失败都抛异常，由调用方决定是否降级（没有预览图时 agent 仍可读 body.txt / body.html）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

/** 常见安装路径（`render.browser` 留空时按顺序探测） */
const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

const PROBE_TIMEOUT_MS = 25_000;
const SHOT_TIMEOUT_MS = 40_000;
/** 单片最大高度（px）；真正的值来自配置 render.sliceHeight */
const DEFAULT_SLICE_HEIGHT = 1_400;
/** 相邻切片的重叠高度（px），避免正好把一行切两半 */
const SLICE_OVERLAP = 120;
/** 子进程收集上限：--dump-dom 会回整份 DOM，留足空间 */
const STDOUT_MAX_BYTES = 16 * 1024 * 1024;
const STDERR_MAX_BYTES = 256 * 1024;

/**
 * 自用的页面高度测量脚本（写 `data-doc-h`，`renderHtmlPreview` 读它）。
 *
 * CSP 用它**文本内容**的 sha256 来放行（`script-src 'sha256-…'`），所以
 * 改脚本文本必须同时改 hash —— 这里 hash 由同一常量现算，不会漂移。
 * 邮件自己的 HTML 无法伪造这个属性：消毒器会删掉 `data-doc-h`。
 */
const MEASURE_SCRIPT = 'document.body.setAttribute("data-doc-h", String(Math.ceil(document.documentElement.scrollHeight)));';
const MEASURE_SCRIPT_HASH = `sha256-${createHash('sha256').update(MEASURE_SCRIPT, 'utf8').digest('base64')}`;

/** 找可用的 Chromium 内核浏览器；显式配了就只认它 */
export function findBrowser(configured = '') {
  const wanted = String(configured ?? '').trim();
  if (wanted) {
    if (fs.existsSync(wanted)) return wanted;
    throw new Error(`render.browser 指向的浏览器不存在：${wanted}`);
  }
  for (const candidate of BROWSERS) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // 继续试下一个
    }
  }
  return null;
}

/**
 * 邮件 HTML 消毒：只保留"能画出来"的部分。
 *
 * 这段 HTML 来自**外部发件人**，会被塞进 `file://` 页面交给 Chromium 渲染。
 * 截图只需要版式，不需要对方的 JS / 嵌入对象 / 伪协议导航。
 *
 * 为什么不再用"几条正则"（S1）：HTML 里属性名前面的分隔符可以是空白**也可以不是**
 * （`<svg/onload=…>`、`<b title="x"onerror=…>`），URL 里的伪协议还能写成
 * `java&#9;script:` / `javascript&colon;` —— 这些都不是"多加一条正则"能补的。
 * 所以这里改成**逐标签重写属性**：
 *   - 属性名按名字删（`on*`、`srcdoc`、`ping`、`srcset`、`data-doc-h`）；
 *   - URL 属性先解数字实体、剥控制字符，再按**白名单**判协议（相对路径放行）；
 *   - 认不出就删掉那条属性（fail closed）。
 * 真正的执行闸门是 CSP（`script-src 'sha256-…'`，没有 `unsafe-inline'`）：
 * 即使这里漏了一个内联事件，浏览器也不会执行它。
 */
const DROP_ATTRS = new Set(['srcdoc', 'ping', 'srcset', 'imagesrcset', 'data-doc-h']);
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'poster', 'background', 'cite', 'longdesc', 'data', 'xlink:href']);
/** 允许的协议（不含协议的相对路径 / #anchor / //host 一律放行） */
const SAFE_SCHEMES = new Set(['http', 'https', 'mailto', 'tel', 'cid']);
/** data: 只放行常见位图（`data:text/html` / `data:image/svg+xml` 都是脚本容器） */
const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i;

/** 解数字实体（命名实体不查表：方案见 isDangerousUrl 的 '&' 判据） */
function decodeNumericEntities(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);?/gi, (all, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return all;
      }
    })
    .replace(/&#(\d+);?/g, (all, dec) => {
      try {
        return String.fromCodePoint(Number(dec));
      } catch {
        return all;
      }
    });
}

/**
 * 这个 URL 属性值是否危险。
 *
 * 判定顺序（对应用户浏览器解析 URL 前的动作）：
 *   1. 解数字实体、剥掉 C0 控制字符与空白（`java&#9;script:` → `javascript:`）；
 *   2. 取第一个 `:` 之前的 scheme；
 *   3. 冒号前出现 `&` ⇒ 是用**命名实体**拼出来的伪协议（`javascript&colon;`、
 *      `java&Tab;script:`），一律拒绝 —— 合法 URL 的 `&` 永远在冒号之后；
 *   4. scheme 不在白名单 ⇒ 拒绝（`javascript:` / `vbscript:` / `file:` / `ftp:` …）；
 *   5. `data:` 只接受位图 base64。
 */
export function isDangerousUrl(raw) {
  const decoded = decodeNumericEntities(raw)
    // 少数能拼出 scheme 的命名实体先还原，否则 `javascript&colon;x` 里根本没有冒号可判
    .replace(/&colon;?/gi, ':')
    .replace(/&tab;?/gi, '\t')
    .replace(/&newline;?/gi, '\n')
    .replace(/[\u0000-\u0020\u007f]+/g, '');
  const colon = decoded.indexOf(':');
  if (colon <= 0) return false;
  const head = decoded.slice(0, colon);
  // 冒号前还有 `&` ⇒ 用未知命名实体拼的伪协议（合法 URL 的 `&` 都在冒号之后）
  if (head.includes('&')) return true;
  const scheme = head.toLowerCase();
  if (SAFE_SCHEMES.has(scheme)) return false;
  if (scheme === 'data') return !DATA_IMAGE.test(decoded);
  return true;
}

/** 逐属性重写一个标签体（不含 `<name` 与结尾 `>`） */
function sanitizeAttributes(name, body) {
  // 属性名前的 `/` 也可能充当分隔符（`<svg/onload=…>`）；只处理 on*，避免破坏 https:// 这类值
  const normalized = String(body).replace(/\/(?=on[a-z]+\s*=)/gi, ' ');
  const cleaned = normalized.replace(
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]*))/g,
    (whole, attr, _value, doubleQuoted, singleQuoted, bare) => {
      const key = attr.toLowerCase();
      if (key.startsWith('on')) return ''; // onclick / onerror / onload …
      if (DROP_ATTRS.has(key)) return '';
      const value = doubleQuoted ?? singleQuoted ?? bare ?? '';
      if (URL_ATTRS.has(key) && isDangerousUrl(value)) return '';
      return whole;
    },
  );
  return `<${name}${cleaned}>`;
}

/**
 * 逐标签扫描（引号内的 `>` 不算标签结束）。
 *
 * 不能用一个 `<[^>]*>` 正则：属性值里完全可能有 `>`（`<a title="a>b">`、
 * `href="data:image/svg+xml,<svg …>"`），那样会把标签切一半、漏掉后半截的属性。
 */
function rewriteTags(html) {
  const input = String(html ?? '');
  let out = '';
  let i = 0;
  while (i < input.length) {
    const lt = input.indexOf('<', i);
    if (lt < 0) {
      out += input.slice(i);
      break;
    }
    out += input.slice(i, lt);
    if (!/[a-zA-Z]/.test(input[lt + 1] ?? '')) {
      out += '<';
      i = lt + 1;
      continue;
    }
    let j = lt + 1;
    let quote = '';
    while (j < input.length) {
      const ch = input[j];
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      j += 1;
    }
    if (j >= input.length) {
      /*
       * 未闭合标签（`<img src=x` 结尾）：浏览器会把后面的字节当成属性继续吃，
       * 而我们把测量脚本追加在正文之后 —— 不转义就会被吞掉、高度测量静默失效。
       * 余下内容一律按文本转义，让它不可能再开标签。
       */
      out += input.slice(lt).replace(/&/g, '&amp;').replace(/</g, '&lt;');
      break;
    }
    const raw = input.slice(lt, j + 1);
    const match = /^<([a-zA-Z][\w:-]*)([\s\S]*?)\/?>$/.exec(raw);
    out += match ? sanitizeAttributes(match[1], match[2]) : raw;
    i = j + 1;
  }
  return out;
}

export function sanitizeEmailHtml(html) {
  const stripped = String(html ?? '')
    // 1) 脚本与可执行嵌入对象：成对写法连内容一起删
    .replace(/<(script|iframe|object|embed|frame|frameset|applet|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    // 2) 自闭合 / 未闭合写法（含 base 与 meta：base 会改相对 URL 的语义，meta 能 refresh 跳走）
    .replace(/<\/?(script|iframe|object|embed|frame|frameset|applet|template|noscript|base|meta)\b[^>]*\/?>/gi, '')
    // 3) svg / math 整棵子树丢：`<svg><foreignObject>` / `<math><mtext>` 是 mXSS 的经典入口
    //    （同一段文本在"XML 命名空间"与"HTML 命名空间"下解析结果不同）。丢的是少量矢量 logo，
    //    留 img 兜底；预览图的用途是读内容，不是复刻视觉。
    .replace(/<(svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(svg|math)\b[^>]*\/?>/gi, '')
    // 4) link 只留样式表
    .replace(/<link\b[^>]*>/gi, (tag) => (/rel\s*=\s*(["']?)stylesheet\1/i.test(tag) ? tag : ''));
  // 5) 逐标签重写属性
  return rewriteTags(stripped);
}

/** 子进程 stdout/stderr 的收集式读取（ctx.subprocess 的 collect 模式） */
function readCollected(reader) {
  try {
    return String(reader?.readFrom?.(0)?.text ?? '');
  } catch {
    return '';
  }
}

/** 本地 child_process 实现：CLI / 离线测试 / 宿主没有 subprocess 缝时用 */
export function createLocalRunner() {
  return function localRun(exe, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // ignore
        }
        reject(new Error(`浏览器渲染超时（${timeoutMs}ms）`));
      }, timeoutMs);
      child.stdout.on('data', (chunk) => {
        out += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk) => {
        err += chunk.toString('utf8');
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 || out.length > 0) resolve({ out, err, code });
        else reject(new Error(`浏览器退出码 ${code}：${err.slice(0, 300)}`));
      });
    });
  };
}

/**
 * `ctx.subprocess` 缝的实现（主路径）：主进程里不再自己 spawn，进程的创建、超时、
 * 终止、回收都交给宿主统一的实现去做。
 */
export function createSeamRunner(seam) {
  if (!seam || typeof seam.spawn !== 'function') return null;
  return async function seamRun(exe, args, timeoutMs) {
    let command = exe;
    try {
      command = (await seam.resolveExecutable?.(exe)) || exe;
    } catch {
      // provider 也可能直接接受绝对路径，解析失败就原样传
    }
    const controller = new AbortController();
    const handle = seam.spawn({
      argv: [command, ...args],
      cwd: os.tmpdir(),
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: STDOUT_MAX_BYTES },
        stderr: { maxBytes: STDERR_MAX_BYTES },
      },
      graceMs: 2_000,
      signal: controller.signal,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        controller.abort();
      } catch {
        // ignore
      }
      try {
        handle.terminate();
      } catch {
        // ignore
      }
    }, timeoutMs);
    try {
      const outcome = await handle.done;
      if (timedOut) throw new Error(`浏览器渲染超时（${timeoutMs}ms）`);
      const out = readCollected(handle.collected?.stdout);
      const err = readCollected(handle.collected?.stderr);
      const code = outcome?.exitCode ?? 0;
      if (code === 0 || out.length > 0) return { out, err, code };
      throw new Error(`浏览器退出码 ${code}：${err.slice(0, 300)}`);
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * 组合出最终使用的 runner：有 `ctx.subprocess` 走缝合实现，缝失败时**退回一次**本地实现
 * 并回调 `onFallback` 记日志。超时不回退（已经等过一次，再等一次只会更慢）。
 */
export function createProcessRunner(seam, { onFallback } = {}) {
  const local = createLocalRunner();
  const viaSeam = createSeamRunner(seam);
  if (!viaSeam) return local;
  let warned = false;
  return async function run(exe, args, timeoutMs) {
    try {
      return await viaSeam(exe, args, timeoutMs);
    } catch (err) {
      if (/超时/.test(String(err?.message ?? err))) throw err;
      if (!warned) {
        warned = true;
        onFallback?.(`ctx.subprocess 渲染失败（${err?.message ?? err}），改用本地 spawn；后续不再重复提示`);
      }
      return local(exe, args, timeoutMs);
    }
  };
}

/** 统一的页面外壳：CSP + 白底 + 固定视口；`offsetPx` > 0 时把内容整体上移（切片用） */
export function wrapPage(html, width, offsetPx = 0, { remoteImages = true } = {}) {
  const offset = offsetPx > 0 ? `margin-top:-${offsetPx}px;` : '';
  const remote = remoteImages ? ' https: http:' : '';
  // 我们的测量脚本是内联的，所以 script-src 必须允许 inline；邮件自己的 <script> 已被剥掉。
  const csp = [
    "default-src 'none'",
    // 只放行**自家测量脚本**的 sha256（没有 'unsafe-inline'）：邮件里漏网的内联事件、
    // javascript: 导航、内嵌 <script> 因此都拿不到执行许可（CSP 才是真正的栅栏）。
    `script-src '${MEASURE_SCRIPT_HASH}'`,
    "script-src-attr 'none'",
    // 不再放行 file:：页面本身是 file://，放行等于允许邮件把本机任意图片渲进截图
    `style-src 'unsafe-inline' data:${remote}`,
    `img-src data:${remote}`,
    `font-src data:${remote}`,
    `media-src data:${remote}`,
    "frame-src 'none'",
    "object-src 'none'",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
  return [
    '<!DOCTYPE html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    `<meta name="viewport" content="width=${width}">`,
    '</head>',
    `<body style="margin:0;padding:16px;background:#ffffff;${offset}">`,
    html,
    `<script>${MEASURE_SCRIPT}</script>`,
    '</body></html>',
  ].join('');
}

/**
 * 渲染 HTML → PNG（必要时附带切片）。
 * @param {string} htmlPath 存档里的 body.html
 * @param {string} pngPath  输出路径（整页 preview.png）
 * @param {{width?: number, maxHeight?: number, sliceHeight?: number, overlap?: number,
 *          browser?: string, remoteImages?: boolean, slices?: boolean, exe?: string, run?: Function}} options
 * @returns {Promise<{file: string, width: number, height: number, slices: {file: string, width: number, height: number}[], failedSlices: {index: number, file: string, error: string}[]}>}
 */
export async function renderHtmlPreview(htmlPath, pngPath, options = {}) {
  const width = Number(options.width) || 1000;
  const maxHeight = Number(options.maxHeight) || 12000;
  const sliceHeight = Math.max(600, Number(options.sliceHeight) || DEFAULT_SLICE_HEIGHT);
  const overlap = Math.max(0, Number(options.overlap ?? SLICE_OVERLAP) || 0);
  const remoteImages = options.remoteImages !== false;
  const wantSlices = options.slices !== false;
  // 测试用注入点：宿主里是 ctx.subprocess 或本地 spawn，测试里可以塞一个假浏览器
  const exec = typeof options.run === 'function' ? options.run : createLocalRunner();
  const exe = options.exe ?? findBrowser(options.browser);
  if (!exe) throw new Error('没找到 Edge/Chrome：在配置 render.browser 里写可执行文件路径，或安装其中一个');
  if (!fs.existsSync(htmlPath)) throw new Error(`没有 HTML 正文：${htmlPath}`);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-preview-'));
  try {
    const html = sanitizeEmailHtml(fs.readFileSync(htmlPath, 'utf8'));
    const profile = path.join(work, 'profile');
    const common = [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      `--user-data-dir=${profile}`,
      '--virtual-time-budget=3000',
      `--window-size=${width},1200`,
    ];
    const pageOf = (offsetPx) => {
      const file = path.join(work, `page-${offsetPx}.html`);
      fs.writeFileSync(file, wrapPage(html, width, offsetPx, { remoteImages }), 'utf8');
      return pathToFileURL(file).href;
    };

    // 第一趟：量真实高度
    const probe = await exec(exe, [...common, '--dump-dom', pageOf(0)], PROBE_TIMEOUT_MS);
    const match = /data-doc-h="(\d+)"/.exec(probe.out);
    const height = Math.min(maxHeight, Math.max(240, match ? Number(match[1]) : 1800));

    // 第二趟：整页图（留档 / 给人看）
    fs.rmSync(pngPath, { force: true });
    await exec(exe, [...common, '--hide-scrollbars', `--window-size=${width},${height}`, `--screenshot=${pngPath}`, pageOf(0)], SHOT_TIMEOUT_MS);
    if (!fs.existsSync(pngPath)) throw new Error('截图没有生成');

    // 第三趟起：超长页面切成可读的几片
    const slices = [];
    /** 失败片（U5）：以前 catch 空吞，调用方只看到"少了几片"，当成正常 */
    const failedSlices = [];
    if (wantSlices && height > sliceHeight) {
      const step = Math.max(400, sliceHeight - overlap);
      const count = Math.ceil((height - overlap) / step);
      const stem = path.basename(pngPath, path.extname(pngPath));
      for (let index = 0; index < count; index += 1) {
        const offset = index * step;
        const slicePx = Math.min(sliceHeight, height - offset);
        if (slicePx <= 0) break;
        const sliceFile = path.join(path.dirname(pngPath), `${stem}-${index + 1}.png`);
        fs.rmSync(sliceFile, { force: true });
        try {
          await exec(
            exe,
            [...common, '--hide-scrollbars', `--window-size=${width},${slicePx}`, `--screenshot=${sliceFile}`, pageOf(offset)],
            SHOT_TIMEOUT_MS,
          );
          if (fs.existsSync(sliceFile)) slices.push({ file: sliceFile, width, height: slicePx });
          else failedSlices.push({ index: index + 1, file: sliceFile, error: '截图没有生成' });
        } catch (err) {
          /*
           * 某一片失败不影响整页图与其它片，但**必须交回调用方**：
           * 失败片覆盖的正文区间在整页图里被压缩到不可读，调用方要能提示"预览不完整"。
           * 先删掉可能写了一半的 PNG，否则它会留在磁盘上被当成真图读（U5）。
           */
          try {
            fs.rmSync(sliceFile, { force: true });
          } catch {
            // 清不掉也不影响其它片
          }
          failedSlices.push({ index: index + 1, file: sliceFile, error: String(err?.message ?? err) });
        }
      }
    }
    return { file: pngPath, width, height, slices, failedSlices };
  } finally {
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch {
      // 临时目录删不掉不影响结果
    }
  }
}
