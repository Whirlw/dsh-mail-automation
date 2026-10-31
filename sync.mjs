#!/usr/bin/env node
/**
 * 把工作区里的插件源码同步到 profile 的安装副本。
 *
 * 两种装法（本脚本只对第二种有用）：
 *   1. **链接安装**（`link:` / junction，插件页"从本地目录安装"）：源码目录就是安装副本，
 *      本脚本直接提示"无需同步"并 exit 0 —— 改完源码重启 DSH 即可。
 *      （实测 dsh 0.2.1-rc.3：链接安装下 `@deepseek-ai/*` 依然解析成功，`schema=bare-import`。）
 *   2. **拷贝安装**（`file:`，或装了 tarball）：profile 里是副本，改源码不生效，必须跑本脚本。
 *
 * 用法（改完代码后跑一次，然后重启 DSH）：
 *   node sync.mjs
 *   node sync.mjs --profile web
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const profileArgIndex = process.argv.indexOf('--profile');
const profile = profileArgIndex > 0 ? process.argv[profileArgIndex + 1] : process.env.DSH_PROFILE || 'desktop';
const home = process.env.DSH_HOME && fs.existsSync(path.join(process.env.DSH_HOME, 'profiles'))
  ? process.env.DSH_HOME
  : path.join(os.homedir(), '.dsh');
const target = path.join(home, 'profiles', profile, 'node_modules', 'dsh-mail-automation');

if (!fs.existsSync(target)) {
  console.error(`目标不存在：${target}\n先执行：dsh plugin --profile ${profile} add file:${HERE}`);
  process.exit(1);
}
const stat = fs.lstatSync(target);
if (stat.isSymbolicLink()) {
  const linked = path.resolve(path.dirname(target), fs.readlinkSync(target));
  if (path.resolve(linked) === path.resolve(HERE)) {
    /*
     * 链接安装（`link:`，插件页的"从本地目录安装"就是这种）：源码目录**本身就是**安装副本，
     * 没有"拷贝"这一步可做 —— 改完源码直接重启 DSH 即可。
     *
     * 早先这里 `exit 1` 并让用户重装成真实目录，理由是"宿主只重写 profile 内模块的
     * @deepseek-ai/* 解析"。**实测 dsh 0.2.1-rc.3（2026-10-30）该结论不成立**：junction 安装下
     * 日志仍是 `schema=bare-import`、6 个工具全部注册、轮询正常。所以这里不再是错误，
     * 只提示"无需同步"，避免把唯一正常的开发装法判成故障。
     */
    console.log(`目标是本目录的链接（${target} → ${HERE}）：链接安装，源码即安装副本，无需同步。`);
    console.log('改完源码直接重启 DSH 即可（插件加载在启动阶段）。');
    process.exit(0);
  }
  console.error(`目标是指向别处的链接（${linked}），请先处理：预期指向 ${HERE}`);
  process.exit(1);
}

/**
 * 同步清单 = package.json `files` 覆盖的运行时内容（`test/` 与 `sync.mjs` 本身不需要进 profile）。
 * 多语 README 一起带上，免得安装副本里的文档与实际行为不一致。
 */
const ITEMS = [
  'src',
  // 浏览器半侧（设置页）：`dsh.client` 指向这个文件，profile 安装副本里必须同目录可见
  'client.js',
  'skills',
  'scripts',
  'locale',
  // 维护者文档（架构/配置/API/运维/经验/开发流程）：随包分发，README 只留使用入口
  'docs',
  'icon.svg',
  'cordis.patch.yml',
  'package.json',
  // 许可证也要进安装副本（npm 打包会自动带，sync.mjs 是手写清单，必须显式列）
  'LICENSE',
  'README.md',
  'README-zh.md',
  'README-es.md',
  'README-hi.md',
  'README-pt.md',
];
let copied = 0;
let pruned = 0;

/**
 * 删除目标目录里「源里已经没有」的文件。
 *
 * 只 cp 不删会让源里删掉/改名的文件永久留在安装副本里（例如删掉的 compat.js），
 * 下次有人读 profile 里那份还以为它还在用。只对**目录**项做，且只在
 * 该目录本身也存在于源里时做——避免把 profile 自己的东西扫掉。
 */
function prune(from, to) {
  if (!fs.existsSync(from) || !fs.existsSync(to)) return;
  for (const entry of fs.readdirSync(to, { withFileTypes: true })) {
    const srcPath = path.join(from, entry.name);
    const dstPath = path.join(to, entry.name);
    if (!fs.existsSync(srcPath)) {
      fs.rmSync(dstPath, { recursive: true, force: true });
      pruned += 1;
      continue;
    }
    if (entry.isDirectory()) prune(srcPath, dstPath);
  }
}

for (const item of ITEMS) {
  const from = path.join(HERE, item);
  const to = path.join(target, item);
  if (!fs.existsSync(from)) continue;
  fs.cpSync(from, to, { recursive: true, force: true });
  if (fs.statSync(from).isDirectory()) prune(from, to);
  copied += 1;
}
console.log(`已同步 ${copied} 项到 ${target}${pruned > 0 ? `，并清理了 ${pruned} 个源里已删除的条目` : ''}`);
console.log('重启 DSH 后生效（插件加载在启动阶段）。');
