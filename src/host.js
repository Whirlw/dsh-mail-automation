/**
 * 从「宿主」拿 DSH 的框架模块（dsh-llm / dsh-session / dsh-tools / dsh-brand）。
 *
 * 解析规则：DSH 只对**物理位于 profile 目录树内**的模块重写 `@deepseek-ai/*` 的解析
 * （app-boot 的 profile interception layer）。本插件装进 profile 时是
 * `profiles/<name>/node_modules/dsh-mail-automation/` 下的真实目录，所以**裸 import 就够了**，
 * 这就是唯一的主路径。
 *
 * 早期版本在这条路失败时会往 `profile/node_modules/.dsh-mail-automation-host.mjs` 写一个
 * 六行桥接模块再 import 它。这条路已经删掉：往 profile 里写文件是官方明令禁止的动作
 * （install_bundle 之外每次手写 profile 都要单独审批），而它只覆盖「插件被装成指向
 * profile 外的 junction」这一种边缘形态——那种形态本来就该重装成真实目录。
 *
 * 现在失败就**响亮报错**，并把「怎么修」写进错误信息：`dsh web` 下插件激活失败可能
 * 完全没有日志 sink（guide/unfixed-issues.md T3），这条 message 往往就是唯一线索。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProfileDir } from './config.js';

/** 本模块所在的物理目录（真实路径，pnpm 的链接已由 Node 解开） */
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));

let cached;

/** 失败时给出可执行的排查步骤（只含路径与命令，不含任何凭据） */
function diagnostics(errors) {
  const profile = resolveProfileDir();
  const profileName = process.env.DSH_PROFILE || 'desktop';
  const rel = path.relative(profile, SELF_DIR);
  const insideProfile = Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
  const lines = [`无法加载 DSH 宿主模块（${errors.join('；')}）。`];
  if (insideProfile) {
    lines.push(
      `插件位于 profile 内（${SELF_DIR}），解析本应被宿主重写；请确认这版 DSH 自带 @deepseek-ai/dsh-llm、dsh-session、dsh-tools。`,
    );
  } else {
    lines.push(
      `插件的真实路径在 profile 之外（${SELF_DIR}）——常见于 pnpm 的 link:/junction 安装。`,
      '注意：**这不一定是原因**。dsh 0.2.1-rc.3 实测链接安装仍能解析 @deepseek-ai/*（日志 schema=bare-import），',
      '所以先确认 profile 里真的装了这些包（只放 peerDependencies 时由宿主提供）：',
      '  @deepseek-ai/dsh-llm、dsh-session、dsh-tools（可选 dsh-brand）。',
      '确认装法有问题时，改成 profile 内的真实目录（装 pnpm pack 出的 tarball），',
      `desktop profile 只能走应用内插件页 —— dsh CLI 会拒绝：error: profile "${profileName}" is managed exclusively by the Electron application。`,
      '不会被 Electron 独占的 profile 可用：',
      `  dsh plugin --profile ${profileName} remove dsh-mail-automation`,
      `  dsh plugin --profile ${profileName} add file:${SELF_DIR}`,
    );
  }
  try {
    if (!fs.existsSync(path.join(profile, 'package.json'))) {
      lines.push(`注意：${profile} 下没有 package.json，profile 目录可能不完整。`);
    }
  } catch {
    // 目录读不到就算了：上面的信息已经够定位
  }
  return lines.join('\n');
}

/**
 * 加载宿主模块。裸 import 是唯一路径；失败抛出带排查步骤的错误。
 */
export async function loadHost() {
  if (cached) return cached;
  const errors = [];

  try {
    const [llm, session, tools] = await Promise.all([
      import('@deepseek-ai/dsh-llm'),
      import('@deepseek-ai/dsh-session'),
      import('@deepseek-ai/dsh-tools'),
    ]);
    let brand = {};
    try {
      brand = await import('@deepseek-ai/dsh-brand');
    } catch {
      // ignore：某些组合没有单独暴露 dsh-brand
    }
    cached = {
      createUserMessage: llm.createUserMessage,
      SessionSeq: session.SessionSeq,
      brandString: typeof brand.brandString === 'function' ? brand.brandString : (value) => value,
      defineTool: tools.defineTool,
    };
    return cached;
  } catch (err) {
    errors.push(`bare: ${err?.message ?? err}`);
  }

  throw new Error(diagnostics(errors));
}
