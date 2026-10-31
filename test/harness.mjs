#!/usr/bin/env node
/**
 * 离线冒烟测试：用一个假的 ctx 把插件跑起来，验证
 *   1. 配置加载 / 启动基线（前十条邮件头）
 *   2. 轮询能发现「新邮件」并把全文写进存档
 *   3. 每日总览能生成文件
 *
 * 不测 agent 处理（那需要真实的 DSH 进程与 agents 服务）：假 ctx 里没有 agents，
 * 处理会走失败分支并把失败原因写进存档，正好也能验证错误路径不崩。
 *
 *   node test/harness.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

register('./stub-loader.mjs', import.meta.url);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(HERE, 'test-config.yaml');
const OUT = path.join(HERE, 'out');

const tools = new Map();
const services = {};
const disposers = [];
const events = [];
// skills 服务的最小替身：验证插件把 SKILL.md 注册进去（frontmatter 已剥掉）
const skills = [];
services.skills = { register: (entry) => skills.push(entry) };

const fakeCtx = {
  logger: {
    info: (...args) => console.log('[info]', ...args),
    warn: (...args) => console.log('[warn]', ...args),
    error: (...args) => console.log('[error]', ...args),
    debug: () => undefined,
  },
  effect(fn) {
    const dispose = fn();
    if (typeof dispose === 'function') disposers.push(dispose);
  },
  on(name) {
    events.push(name);
    return () => undefined;
  },
  get(name) {
    return services[name];
  },
  inject() {
    return undefined;
  },
  tools: {
    register(tool) {
      tools.set(tool.name, tool);
    },
  },
};

function resetOutput() {
  if (fs.existsSync(OUT)) fs.rmSync(OUT, { recursive: true, force: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const stateFile = path.join(OUT, 'state.json');
  if (fs.existsSync(stateFile)) {
    // 第二次运行时：把游标退一格，制造一封「新邮件」来验证处理链路
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (state.sources?.private?.uidNext > 1) {
      state.sources.private.uidNext -= 1;
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
      console.log('已把 IMAP 游标退一格，制造一封新邮件');
    }
  } else {
    resetOutput();
  }

  const { apply } = await import('../src/index.js');
  await apply(fakeCtx, { configFile: CONFIG });

  console.log('\n=== 工具注册 ===');
  console.log([...tools.keys()].join(', ') || '(无)');

  console.log('\n=== skill 注册 ===');
  if (skills.length === 0) console.log('(无)');
  for (const entry of skills) {
    const clean = !entry.content.trimStart().startsWith('---') && !entry.content.includes('{{');
    // get() 的 validateDefinition 要求 source 是字符串：缺了它 catalog 能列、加载会炸
    const sourceOk = typeof entry.source === 'string' && entry.source.length > 0;
    console.log(`- ${entry.name}｜${entry.description}\n  正文 ${entry.content.length} 字，frontmatter 已剥掉：${clean}；source=${entry.source}（合法：${sourceOk}）`);
  }

  // 等启动基线完成
  await sleep(6000);

  /*
   * 合成一封「新邮件」直接走 store：不依赖邮箱里真的有没读过的信
   * （实测邮箱里那封测试邮件后来被删了，uid 缺口会让 uidNext-1 的回绕试探落空）。
   * 这样无论邮箱什么状态，存档布局 / mail_automation_archive_read / 总览链路都能被验证。
   */
  console.log('\n=== 合成一封测试邮件（走 store，不依赖邮箱） ===');
  const { Store } = await import('../src/store.js');
  const { loadConfig } = await import('../src/config.js');
  const { config: harnessCfg } = loadConfig(CONFIG);
  const harnessStore = new Store(harnessCfg, { warn: console.log, info: console.log });
  const nowIso = new Date().toISOString();
  const synthetic = {
    sourceId: 'private',
    sourceName: '私人邮箱',
    header: { id: 'imap:private:990001', uid: 990001, subject: '【测试】归档布局与 HTML', from: 'Tester <t@example.com>', date: nowIso, unread: true },
    body: {
      raw: Buffer.from('From: Tester <t@example.com>\r\nSubject: =?utf-8?B?0JrQvtC00LjRgNC+0LLQutCw?=\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nhello 原始报文\r\n', 'utf8'),
      rawKind: 'eml',
      text: 'hello 纯文本正文：链接 https://example.com/a?x=1&y=2',
      html: '<div>hello <b>HTML</b> 正文 <a href="https://example.com/a?x=1&amp;y=2">链接</a></div>',
      subject: '【测试】归档布局与 HTML',
      from: 'Tester <t@example.com>',
      date: nowIso,
      attachments: [{ name: '报价.pdf', size: 12, contentType: 'application/pdf' }],
    },
  };
  const syntheticDir = harnessStore.writeMail(synthetic);
  harnessStore.writeConclusion(syntheticDir, '【分类】知会\n【摘要】合成测试邮件\n【动作】无需动作');
  // 有 HTML 就渲染预览图（和 processNewMail 里做的是同一件事）
  try {
    const { renderHtmlPreview } = await import('../src/render.js');
    const preview = await renderHtmlPreview(path.join(syntheticDir, 'body.html'), path.join(syntheticDir, 'preview.png'));
    harnessStore.attachPreview(syntheticDir, 'preview.png', preview);
    console.log(`预览图：${preview.width}×${preview.height} → preview.png`);
  } catch (err) {
    console.log(`预览图渲染失败：${err?.message ?? err}`);
  }
  harnessStore.save();
  console.log(`已写入：${syntheticDir}`);
  console.log(`目录内容：${fs.readdirSync(syntheticDir).join('、')}`);

  // 提示词分支：有 HTML 走 prompt-html.md（提到 preview），纯文本走 prompt.md（完全不提 html/image）
  const { loadMailPrompt } = await import('../src/config.js');
  const htmlPrompt = loadMailPrompt(harnessCfg, true);
  const plainPrompt = loadMailPrompt(harnessCfg, false);
  console.log('\n=== 提示词分支 ===');
  console.log(`有 HTML：${htmlPrompt.includes('preview.png') ? '✅ 提到 preview.png' : '❌ 没提到 preview.png'}（${htmlPrompt.length} 字）`);
  console.log(`纯文本：${!plainPrompt.includes('preview') && !plainPrompt.includes('html') ? '✅ 不涉及 html/预览图' : '❌ 仍然提到了 html/预览图'}（${plainPrompt.length} 字）`);

  console.log('\n=== 状态（基线之后） ===');
  const status = await tools.get('mail_automation_status').execute({});
  console.log(status.text);

  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  console.log('\n=== state.json ===');
  console.log(JSON.stringify(state.sources, null, 2));

  // 人为制造一封「新邮件」：把 IMAP 游标退回 1
  if (state.sources.private?.uidNext) {
    state.sources.private.uidNext -= 1;
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
    console.log('\n=== 制造新邮件（uidNext -1）后轮询 ===');
    const poll = await tools.get('mail_automation_poll').execute({});
    console.log(poll.text ?? poll.error);

    // 存档已改成平铺：archive/ 下一层目录就是一封邮件
    const archiveDir = path.join(OUT, 'archive');
    const mailDirs = fs.existsSync(archiveDir)
      ? fs.readdirSync(archiveDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(archiveDir, e.name))
      : [];
    console.log('\n=== 存档目录（每封一个文件夹） ===');
    if (mailDirs.length === 0) {
      console.log('(没有存档)');
    } else {
      for (const dir of mailDirs) {
        console.log(path.basename(dir));
        console.log(`  文件：${fs.readdirSync(dir).join('、')}`);
        const metaPath = path.join(dir, 'meta.json');
        if (fs.existsSync(metaPath)) {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          console.log(`  ${meta.subject}｜${meta.from}｜raw=${meta.raw_kind || '无'}｜html=${meta.body_html_chars} 字｜text=${meta.body_text_chars} 字`);
        }
        const textPath = path.join(dir, 'body.txt');
        if (fs.existsSync(textPath)) console.log(`  正文前 80 字：${fs.readFileSync(textPath, 'utf8').replace(/\s+/g, ' ').slice(0, 80)}`);
      }
    }

    console.log('\n=== mail_automation_archive_read 工具 ===');
    if (mailDirs.length === 0) {
      console.log('(没有存档，跳过)');
    } else {
      const target = mailDirs[0];
      const first = await tools.get('mail_automation_archive_read').execute({ file: target, maxChars: 120 });
      console.log('第一页：', JSON.stringify({ ...first, text: first.text?.slice(0, 60) }));
      if (first.ok && first.truncated) {
        const second = await tools.get('mail_automation_archive_read').execute({ file: target, offset: first.next, maxChars: 120 });
        console.log('续页：', JSON.stringify({ ok: second.ok, offset: second.offset, next: second.next, truncated: second.truncated }));
      }
      // 只给目录名（不带完整路径）也应该能找到
      const byName = await tools.get('mail_automation_archive_read').execute({ file: path.basename(target), maxChars: 40 });
      console.log('按目录名：', byName.ok ? `找到 ${byName.dir}` : `失败 ${byName.error}`);
      const byQuery = await tools.get('mail_automation_archive_read').execute({ query: (first.subject || path.basename(target)).slice(0, 6), maxChars: 40 });
      console.log('按关键词：', byQuery.ok ? `找到 ${byQuery.dir}` : `${byQuery.error}｜候选 ${byQuery.candidates?.length ?? 0}`);
      for (const part of ['html', 'image', 'raw', 'conclusion', 'meta']) {
        const got = await tools.get('mail_automation_archive_read').execute({ file: target, part, maxChars: 80 });
        if (!got.ok) {
          console.log(`part=${part}：失败 ${got.error}`);
        } else if (part === 'image') {
          console.log(`part=image：ok → ${path.basename(got.file)}（${got.width ?? '?'}×${got.height ?? '?'}，${Math.round((got.bytes ?? 0) / 1024)}KB）`);
        } else {
          console.log(`part=${part}：ok ${got.total} 字 ← ${path.basename(got.file)}`);
        }
      }
      const missing = await tools.get('mail_automation_archive_read').execute({ file: path.join(archiveDir, '不存在的邮件') });
      console.log('读不到时：', JSON.stringify({ ok: missing.ok, error: missing.error }));
      const nothing = await tools.get('mail_automation_archive_read').execute({});
      console.log('没给参数：', JSON.stringify({ ok: nothing.ok, error: nothing.error }));
    }
  }

  // 放在最后查：baseline 是异步的（要连两个邮箱），早些查可能还没写完
  console.log('\n=== 启动快照（只保留一份） ===');
  const snapFile = path.join(OUT, 'startup.md');
  console.log(fs.existsSync(snapFile) ? `startup.md（${fs.statSync(snapFile).size} 字节）` : '(没有 startup.md)');
  const dated = fs.readdirSync(OUT).filter((name) => name.startsWith('startup-'));
  console.log(`root 里 startup-*.md 残留：${dated.length === 0 ? '无' : dated.join(', ')}`);

  for (const dispose of disposers) {
    try {
      dispose();
    } catch {
      // ignore
    }
  }
  console.log('\n=== 完成 ===');
  process.exit(0);
}

main().catch((err) => {
  console.error('HARNESS FAILED:', err);
  process.exit(1);
});
