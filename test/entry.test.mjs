#!/usr/bin/env node
/**
 * 入口级离线单测（不连邮箱、不需要 DSH 进程）。
 *
 * 覆盖这次重构里最容易回归的四条：
 *   1. **apply 是同步的、注册全部落在首个 await 之前**（§3.3.1）：
 *      apply 返回时 effect 已建立、心跳已启动；工具由 effect 接管，异步完成后可用。
 *   2. **卸载即撤销**：disposer 跑完后工具与 skill 都从注册表里消失（§3.3 注册即 effect）。
 *   3. **skill 契约**：两个 skill 都带 `source`、`resourceBase`，正文已剥掉 frontmatter。
 *   4. **密码只走两条来源**：`passwordRef` → `ctx.credentials`（或启动 secrets），
 *      或显式 `password`；旧的账号表复用已删除，空凭据绝不算"已配置"。
 *
 *   node test/entry.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

register('./stub-loader.mjs', import.meta.url);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-automation-test-'));

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err?.message ?? err}`);
    process.exitCode = 1;
  }
};

/** 一个最小 ctx：记录 effect/监听/定时器，注册表支持 disposer */
function makeCtx({ withSkills = true } = {}) {
  const state = { effects: [], listeners: [], tools: [], skills: [], intervals: [] };
  const disposeFrom = (list, entry) => () => {
    const index = list.indexOf(entry);
    if (index >= 0) list.splice(index, 1);
  };
  const ctx = {
    logger: {
      info: (...args) => console.log('    [info]', ...args),
      warn: (...args) => console.log('    [warn]', ...args),
      error: (...args) => console.log('    [error]', ...args),
    },
    effect(fn) {
      const disposer = fn();
      state.effects.push(typeof disposer === 'function' ? disposer : () => undefined);
      return disposer;
    },
    on(name) {
      state.listeners.push(name);
      return () => undefined;
    },
    get(name) {
      if (name === 'skills' && withSkills) {
        return {
          register(definition) {
            state.skills.push(definition);
            return disposeFrom(state.skills, definition);
          },
        };
      }
      // timer 服务：插件经 `ctx.get('timer').interval()` 建立心跳（不再裸访问 ctx.interval，
      // 那是对未声明服务取属性，K1）。假 ctx 故意**不**提供 ctx.interval，逼出这条契约。
      if (name === 'timer') {
        return {
          interval(fn) {
            state.intervals.push(fn);
            return () => undefined;
          },
        };
      }
      return undefined;
    },
    inject(_deps, callback) {
      callback?.(ctx);
    },
    tools: {
      register(tool) {
        state.tools.push(tool);
        return disposeFrom(state.tools, tool);
      },
    },
  };
  return { ctx, state };
}

const configPath = path.join(work, 'mail-automation.yaml');
fs.writeFileSync(
  configPath,
  [
    'monitor:',
    '  poll_seconds: 5',
    '  initial_headers: 3',
    'sources:',
    '  - id: offline',
    '    name: 离线来源',
    '    type: imap',
    '    host: 127.0.0.1',
    '    port: 1',
    '    secure: false',
    '    user: test@example.com',
    '    password: test-password',
    'storage:',
    `  root: ${JSON.stringify(work)}`,
    'agent:',
    `  workspace: ${JSON.stringify(work)}`,
    'qq:',
    '  enabled: false',
    '',
  ].join('\n'),
  'utf8',
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log('\n=== 1. apply 同步建立 effect / 心跳，注册异步完成 ===');
{
  const { apply } = await import('../src/index.js');
  const { ctx, state } = makeCtx();
  const returned = apply(ctx, { configFile: configPath });

  check('apply 是同步函数（返回 undefined，不是 Promise）', () => {
    assert.equal(returned, undefined);
  });
  check('apply 返回时 effect 已建立（≥4 个）', () => assert.ok(state.effects.length >= 4, `effects=${state.effects.length}`));
  check('apply 返回时心跳已启动、监听器已挂', () => {
    assert.equal(state.intervals.length, 1);
    assert.ok(state.listeners.includes('loader/volatile-update'), state.listeners.join(','));
    assert.ok(state.listeners.includes('credentials/reference-updated'), state.listeners.join(','));
  });

  await sleep(1500);
  check('工具已注册 7 个且名字齐全', () => {
    const names = state.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      'mail_automation_archive_clear',
      'mail_automation_archive_list',
      'mail_automation_archive_read',
      'mail_automation_config',
      'mail_automation_poll',
      'mail_automation_status',
      'qq_notify',
    ]);
  });
  check('skill 已注册 4 个', () => assert.equal(state.skills.length, 4));
  check('skill 契约字段齐全（source / resourceBase / 正文已剥 frontmatter）', () => {
    for (const skill of state.skills) {
      assert.equal(typeof skill.source, 'string');
      assert.ok(skill.source.length > 0);
      assert.equal(skill.resourceBase?.kind, 'directory');
      assert.ok(!String(skill.content).trimStart().startsWith('---'), `${skill.name} 正文仍有 frontmatter`);
      assert.ok(String(skill.content).length > 50);
    }
  });

  console.log('\n=== 2. 卸载即撤销 ===');
  for (const disposer of state.effects) disposer();
  await sleep(50);
  check('工具全部撤销', () => assert.equal(state.tools.length, 0));
  check('skill 全部撤销', () => assert.equal(state.skills.length, 0));
}

console.log('\n=== 3. 配置坏了也不抛（只响亮地记日志） ===');
{
  const { apply } = await import('../src/index.js');
  const bad = path.join(work, 'bad.yaml');
  fs.writeFileSync(bad, 'sources:\n  - id: x\n    type: imap\n    name: 缺服务器\n', 'utf8');
  const { ctx, state } = makeCtx();
  check('apply 不抛异常', () => assert.equal(apply(ctx, { configFile: bad }), undefined));
  await sleep(1200);
  check('工具仍注册（配置失败不影响工具面）', () => assert.equal(state.tools.length, 7));
  for (const disposer of state.effects) disposer();
}

console.log('\n=== 4. 密码解析（只有 passwordRef / 显式 password 两条来源） ===');
{
  const { resolveSourceSecrets, resolveSourceSecretsDetailed } = await import('../src/credentials.js');
  const { normalizeConfig } = await import('../src/config.js');

  await (async () => {
    // 4.1 passwordRef → secrets → 来源密码（没有 ctx.credentials 时不报错，只解析不到）
    const noProviderCtx = { get: () => undefined };
    const secrets = await resolveSourceSecrets(noProviderCtx, [
      { id: 'private', name: '私人邮箱', passwordRef: 'MAIL_PRIVATE_PASSWORD' },
    ], {});
    check('没有凭据服务时不抛异常（只解析不到）', () => assert.equal(typeof secrets, 'object'));

    const cfg = normalizeConfig(
      {
        sources: [{ id: 'private', name: '私人邮箱', type: 'imap', host: 'imap.qq.com', user: 'a@qq.com', password_ref: 'MAIL_PRIVATE_PASSWORD' }],
      },
      { configFile: path.join(work, 'x.yaml'), secrets: { private: 'from-ref' } },
    );
    check('secrets 注入的密码被采用', () => assert.equal(cfg.sources[0].password, 'from-ref'));

    const noPassword = normalizeConfig(
      { sources: [{ id: 'private', type: 'imap', host: 'imap.qq.com', user: 'a@qq.com' }] },
      { configFile: path.join(work, 'x.yaml') },
    );
    check('没有任何密码来源时 password 为空（行为可见，不静默冒充已配置）', () => assert.equal(noPassword.sources[0].password, ''));

    // 4.2 不再有「复用别的插件账号」这条路：account 字段已删除，配置里写了也不生效
    const withAccount = normalizeConfig(
      {
        sources: [{ id: 'private', type: 'imap', account: '私人邮箱', user: 'a@qq.com', password: 'p' }],
      },
      { configFile: path.join(work, 'x.yaml') },
    );
    check('account 字段不再被解析（来源只认自己声明的 host/user/password）', () => {
      assert.equal(withAccount.sources[0].accountName, undefined);
      assert.equal(withAccount.sources[0].password, 'p');
    });

    const detailed = await resolveSourceSecretsDetailed(noProviderCtx, [], {});
    check('空来源列表返回空结果（不炸）', () => {
      assert.deepEqual(detailed.secrets, {});
      assert.deepEqual(detailed.layers, {});
    });
  })();
}

console.log('\n=== 5. YAML 覆盖层与 schema 默认值合并 ===');
{
  const { loadConfig } = await import('../src/config.js');
  const base = { pollSeconds: 30, initialHeaders: 10, sources: [], storage: { root: '', archiveSubdir: 'archive' } };
  const merged = loadConfig(configPath, { base });
  check('覆盖层能提供 sources', () => assert.equal(merged.config?.sources.length, 1));
  check('覆盖层只覆盖写到的字段（没写 archive_subdir → 用默认 archive）', () =>
    assert.equal(merged.config?.storage.archiveDir, path.join(work, 'archive')));
  check('合法配置不返回 error', () => assert.equal(merged.error, undefined));
  check('覆盖层的 snake_case 能覆盖 schema 默认值（轮询间隔；schedules 缺省为空）', () => {
    const base2 = { pollSeconds: 30, sources: [], storage: { root: '', archiveSubdir: 'archive' } };
    const merged2 = loadConfig(configPath, { base: base2 });
    assert.equal(merged2.config?.monitor.pollSeconds, 5); // YAML 里写的是 poll_seconds: 5
    assert.deepEqual(merged2.config?.schedules, []);
  });

  // 新加的可调项同样要「覆盖层 > schema 默认」：嵌套对象的 snake_case 必须在合并前
  // 规范成 camelCase，否则 schema 的默认值会挡住用户写的值（旧实现踩过这个坑）。
  const overlay = path.join(work, 'overlay-tunables.yaml');
  fs.writeFileSync(
    overlay,
    [
      'monitor:',
      '  heartbeat_seconds: 2',
      'render:',
      '  slice_height: 900',
      '  slice_overlap: 40',
      'agent:',
      '  turn_timeout_seconds: 600',
      'sources:',
      '  - id: s1',
      '    type: imap',
      '    host: h',
      '    user: u',
      '    password: p',
      '',
    ].join('\n'),
    'utf8',
  );
  const tunables = loadConfig(overlay, {
    base: {
      heartbeatSeconds: 5,
      sources: [],
      render: { width: 1000, sliceHeight: 1400, sliceOverlap: 120 },
      agent: { turnTimeoutSeconds: 300 },
    },
  });
  check('心跳 / 切片高度 / 切片重叠 / 回合超时 都能只改 YAML 生效', () => {
    assert.equal(tunables.error, undefined);
    assert.equal(tunables.config.monitor.heartbeatSeconds, 2);
    assert.equal(tunables.config.render.width, 1000); // 没写的沿用 schema 默认
    assert.equal(tunables.config.render.sliceHeight, 900);
    assert.equal(tunables.config.render.sliceOverlap, 40);
    assert.equal(tunables.config.agent.turnTimeoutSeconds, 600);
  });
  check('越界的可调项被夹到合法区间', () => {
    const clamped = loadConfig(overlay, {
      base: { sources: [], render: { sliceHeight: 1400, sliceOverlap: 120 }, agent: { turnTimeoutSeconds: 300 } },
    });
    const file = path.join(work, 'overlay-clamp.yaml');
    fs.writeFileSync(
      file,
      ['render:', '  slice_height: 10', 'agent:', '  turn_timeout_seconds: 1', 'sources:', '  - id: s1', '    type: imap', '    host: h', '    user: u', '    password: p', ''].join('\n'),
      'utf8',
    );
    const tight = loadConfig(file, { base: { sources: [] } });
    assert.equal(tight.config.render.sliceHeight, 600, '切片高度下限 600');
    assert.equal(tight.config.agent.turnTimeoutSeconds, 30, '回合超时下限 30s');
    assert.ok(clamped.config);
  });
}

console.log('\n=== 6. Schemastery schema（宿主加载期就会跑，坏了解析都进不来） ===');
{
  const { Config } = await import('../src/schema.js');
  const cfgModule = await import('../src/config.js');
  const value = Config({});
  check('空配置能补出默认值', () => {
    assert.deepEqual(value.sources, []);
    assert.equal(value.configFile.endsWith('mail-automation.yaml'), true);
  });
  check('volatile 字段是 { get() }，并给出默认值', () => {
    assert.equal(typeof value.pollSeconds.get, 'function');
    assert.equal(value.pollSeconds.get(), 30);
  });
  check('sources 结构校验：type 接受 imap/pop3/gmail/graph，其余拒绝', () => {
    const ok = Config({ sources: [{ type: 'imap', host: 'h', user: 'u' }] });
    assert.equal(ok.sources.length, 1);
    // 0.4 起支持四种协议（POP3 / Gmail API 是这一轮新增的）；未知类型仍必须 fail loud
    for (const type of ['imap', 'pop3', 'gmail', 'graph']) {
      assert.equal(Config({ sources: [{ type }] }).sources[0].type, type);
    }
    assert.throws(() => Config({ sources: [{ type: 'imapx' }] }));
    assert.throws(() => Config({ sources: [{ type: 'smtp' }] }));
  });
  check('未知字段被保留但会被 normalize 忽略（不会让加载失败）', () => {
    const value2 = Config({ somethingUnknown: 1 });
    assert.equal(value2.somethingUnknown, 1);
    const { normalizeConfig } = cfgModule;
    const cfg = normalizeConfig(
      { ...value2, sources: [{ id: 's', type: 'imap', host: 'h', user: 'u', password: 'p' }] },
      { configFile: path.join(work, 'x.yaml') },
    );
    assert.equal(cfg.sources.length, 1);
    assert.equal(cfg.somethingUnknown, undefined);
  });
}

console.log('\n=== 7. 预览图切片（长 HTML 邮件要切成可读的几片） ===');
{
  const { renderHtmlPreview } = await import('../src/render.js');
  const dir = path.join(work, 'slice');
  fs.mkdirSync(dir, { recursive: true });
  const html = path.join(dir, 'body.html');
  fs.writeFileSync(html, '<p>hello</p>', 'utf8');

  const fakeBrowser = (documentHeight) => async (_exe, args) => {
    if (args.includes('--dump-dom')) return { out: `<body data-doc-h="${documentHeight}"></body>`, err: '', code: 0 };
    const shot = args.find((arg) => String(arg).startsWith('--screenshot='));
    if (shot) fs.writeFileSync(shot.slice('--screenshot='.length), 'fake-png');
    return { out: 'ok', err: '', code: 0 };
  };

  const long = await renderHtmlPreview(html, path.join(dir, 'preview.png'), {
    exe: 'fake-browser',
    run: fakeBrowser(4326),
  });
  check('整页高度取页面自报的 scrollHeight', () => assert.equal(long.height, 4326));
  check('超长页面切多片（每片 ≤1400，文件名 preview-1..N）', () => {
    assert.ok(long.slices.length >= 3, `slices=${long.slices.length}`);
    for (const slice of long.slices) assert.ok(slice.height <= 1400, `height=${slice.height}`);
    assert.ok(long.slices[0].file.endsWith('preview-1.png'), long.slices[0].file);
    assert.ok(long.slices[1].file.endsWith('preview-2.png'), long.slices[1].file);
  });
  check('分片文件真的落盘', () => {
    for (const slice of long.slices) assert.ok(fs.existsSync(slice.file), slice.file);
  });

  const short = await renderHtmlPreview(html, path.join(dir, 'preview-short.png'), {
    exe: 'fake-browser',
    run: fakeBrowser(900),
  });
  check('短页面不切片', () => assert.equal(short.slices.length, 0));
}

console.log('\n=== 8. 链接主机汇总（钓鱼判断用，省掉 agent 自己抠 href） ===');
{
  const { readArchivedMail, linkHosts } = await import('../src/archiveread.js');
  const archiveDir = path.join(work, 'archive');
  const mailDir = path.join(archiveDir, 'mail-1');
  fs.mkdirSync(mailDir, { recursive: true });
  fs.writeFileSync(
    path.join(mailDir, 'meta.json'),
    JSON.stringify({ id: 'x', subject: '测试链接', from: 'a@b.c', date: '2026-10-25', files: ['body.html'] }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(mailDir, 'body.html'),
    [
      '<a href="https://mailings.example.edu/a">查看详情</a>',
      '<a href="https://mailings.example.edu/b">报名</a>',
      '<a href="https://etrack05.com/pixel.gif">退订</a>',
      '<a href="mailto:x@y.z">邮件</a>',
    ].join('\n'),
    'utf8',
  );
  check('按主机去重、按次数降序、忽略 mailto', () => {
    const hosts = linkHosts(mailDir);
    assert.equal(hosts.length, 2);
    assert.equal(hosts[0].host, 'mailings.example.edu');
    assert.equal(hosts[0].count, 2);
    assert.equal(hosts[1].host, 'etrack05.com');
  });
  check('part=html 的返回值里带上 links', () => {
    const result = readArchivedMail({ file: mailDir, part: 'html', maxChars: 100 }, { archiveDir });
    assert.equal(result.ok, true);
    assert.equal(result.links.length, 2);
  });
}

console.log('\n=== 10. 注入面与凭据缝（这次重构的两条契约） ===');
{
  const { inject } = await import('../src/index.js');
  const { schemaSource } = await import('../src/schema.js');

  check('inject 是静态数组（cordis 只接受数组形式）', () => assert.ok(Array.isArray(inject)));
  check('inject 只声明真正必需的服务：tools（timer 是可选优化，不进 inject）', () => {
    assert.deepEqual([...inject].sort(), ['tools']);
    assert.ok(!inject.includes('timer'), 'timer 回到 inject 会让没有 timer 的组合永久 PENDING');
  });
  check('schemastery 有明确的来源标记（bare-import / profile-require，便于排障）', () => {
    assert.ok(['bare-import', 'profile-require'].includes(schemaSource), schemaSource);
  });

  // 凭据缝：声明 passwordRef 时经 ctx.credentials 解析；凭据变更事件会强制重解
  const refCalls = [];
  const handlers = new Map();
  const handlersFor = (name) => {
    if (!handlers.has(name)) handlers.set(name, []);
    return handlers.get(name);
  };
  const credentialCtx = {
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    effect(fn) {
      const disposer = fn();
      return typeof disposer === 'function' ? disposer : () => undefined;
    },
    on(name, handler) {
      handlersFor(name).push(handler);
      return () => undefined;
    },
    get(name) {
      if (name === 'credentials') {
        return {
          resolve(ref) {
            refCalls.push(ref);
            return Promise.resolve({ value: 'resolved-by-provider', source: 'file' });
          },
        };
      }
      return undefined;
    },
    inject() {
      return undefined;
    },
    tools: { register: () => () => undefined },
  };

  const refConfig = path.join(work, 'ref.yaml');
  fs.writeFileSync(
    refConfig,
    [
      'sources:',
      '  - id: private',
      '    name: 私人邮箱',
      '    type: imap',
      '    host: 127.0.0.1',
      '    port: 1',
      '    secure: false',
      '    user: test@example.com',
      '    password_ref: MAIL_PRIVATE_PASSWORD',
      'storage:',
      `  root: ${JSON.stringify(path.join(work, 'ref-out'))}`,
      'agent:',
      `  workspace: ${JSON.stringify(work)}`,
      'qq:',
      '  enabled: false',
      '',
    ].join('\n'),
    'utf8',
  );

  const { apply } = await import('../src/index.js');
  apply(credentialCtx, { configFile: refConfig });
  await sleep(1200);

  check('启动时经 ctx.credentials 解析 passwordRef', () => {
    assert.ok(refCalls.includes('MAIL_PRIVATE_PASSWORD'), refCalls.join(','));
  });

  const before = refCalls.length;
  for (const handler of handlersFor('credentials/reference-updated')) await handler();
  await sleep(600);
  check('credentials/reference-updated 触发强制重解（热轮换不必重启）', () => {
    assert.ok(refCalls.length > before, `before=${before} after=${refCalls.length}`);
  });

  // 层名决定「要不要在后续轮询里再试一次官方缝」：兜底（credentials-file）才重试
  const { resolveSourceSecretsDetailed, isFallbackLayer } = await import('../src/credentials.js');
  const sources = [{ id: 'private', name: '私人邮箱', passwordRef: 'MAIL_PRIVATE_PASSWORD' }];
  const providerCtx = (value) => ({ get: (name) => (name === 'credentials' ? { resolve: () => Promise.resolve(value ? { value, source: 'file' } : undefined) } : undefined) });
  const withProvider = await resolveSourceSecretsDetailed(providerCtx('from-seam'), sources, {});
  check('官方缝给出值时层名是 credentials:<layer>（不触发重试）', () => {
    assert.equal(withProvider.layers.private, 'credentials:file');
    assert.equal(withProvider.secrets.private, 'from-seam');
    assert.equal(isFallbackLayer(withProvider.layers.private), false);
  });
  const withoutProvider = await resolveSourceSecretsDetailed({ get: () => undefined }, sources, {});
  check('官方缝缺席时层名是 credentials-file（会被当成待升级重试）', () => {
    const layer = withoutProvider.layers.private;
    assert.ok(layer === undefined || layer === 'credentials-file', String(layer));
    assert.equal(isFallbackLayer('credentials-file'), true);
    assert.equal(isFallbackLayer('credentials:file'), false);
  });
}

console.log('\n=== 11. 状态后端：storageDomain 优先，state.json 兜底 ===');
{
  const { Store } = await import('../src/store.js');
  const { openStateDomain, STATE_RECORD_SCHEMAS } = await import('../src/state-domain.js');

  check('宿主没有 storageDomain 时 openStateDomain 返回 null（继续用 state.json）', async () => {
    assert.equal(await openStateDomain({ get: () => undefined }, null), null);
    assert.equal(await openStateDomain(null, null), null);
  });

  check('记录校验器：字段补默认、造型与 Store.state 一致', () => {
    assert.deepEqual(STATE_RECORD_SCHEMAS.sources.parse({ uidNext: 42, uidValidity: 7 }), {
      uidValidity: 7,
      uidNext: 42,
      initialized: false,
      seenIds: [],
      // Gmail 的增量游标与账号显示名：漏列会在 hydrate 时被丢掉（表现为每次重启重建基线）
      historyId: null,
      email: '',
    });
    // Gmail 记录必须能往返：historyId 是"不重放历史"的唯一证据
    assert.deepEqual(
      STATE_RECORD_SCHEMAS.sources.parse({ initialized: true, historyId: 987654, seenIds: ['a'], email: 'me@gmail.com' }),
      { uidValidity: null, uidNext: null, initialized: true, seenIds: ['a'], historyId: 987654, email: 'me@gmail.com' },
    );
    assert.deepEqual(STATE_RECORD_SCHEMAS.agent.parse({ childSessions: ['a', 1, 'b'] }), {
      parentSessionId: '',
      // 静默模式的父会话 id 必须能往返：漏掉它会让每次启动都换一个新父会话
      silentParentSessionId: '',
      // 启动签名同理：漏掉它会让每次启动都判成"首次运行"→ 每次重启都归档+新建
      bootSignature: null,
      // 已就绪的父会话 id：漏掉它会让每次启动都重跑一遍开局回合
      primedSessionId: '',
      childSessions: ['a', 'b'],
      day: '',
      sessionId: '',
    });
    // 签名必须能往返，否则"设置没变就沿用"永远不成立
    assert.deepEqual(
      STATE_RECORD_SCHEMAS.agent.parse({ bootSignature: { workspace: 'E:\\ws', silent: true } }).bootSignature,
      { workspace: 'E:\\ws', silent: true },
    );
    assert.equal(
      STATE_RECORD_SCHEMAS.agent.parse({ silentParentSessionId: 'session-x' }).silentParentSessionId,
      'session-x',
    );
    assert.equal(
      STATE_RECORD_SCHEMAS.agent.parse({ primedSessionId: 'session-ready' }).primedSessionId,
      'session-ready',
    );
    assert.throws(() => STATE_RECORD_SCHEMAS.meta.parse('nope'), /记录必须是对象/);
  });

  /** 最小假域：table(name) → { get, entries, put, delete }，并记录写入顺序 */
  const makeDomain = (initial = {}) => {
    const tables = {
      sources: new Map(Object.entries(initial.sources ?? {})),
      retries: new Map(Object.entries(initial.retries ?? {})),
      agent: new Map(Object.entries(initial.agent ?? {})),
      meta: new Map(Object.entries(initial.meta ?? {})),
    };
    const writes = [];
    return {
      tables,
      writes,
      table(name) {
        const map = tables[name];
        return {
          get: (key) => map.get(key),
          entries: () => map.entries(),
          put: async (key, value) => {
            writes.push(`put:${name}:${key}`);
            map.set(key, value);
          },
          delete: async (key) => {
            writes.push(`delete:${name}:${key}`);
            map.delete(key);
          },
        };
      },
      close: async () => {
        writes.push('close');
      },
    };
  };

  const root = path.join(work, 'domain-test');
  const stateFile = path.join(root, 'state.json');
  fs.mkdirSync(root, { recursive: true });
  const cfg = {
    storage: { root, archiveDir: path.join(root, 'archive'), stateFile },
  };
  const quiet = { info: () => undefined, warn: () => undefined };

  // 11.1 域为空、磁盘上还留着一份旧 state.json → **以域为准**，文件被忽略（不再导入）
  const oldStateFile = {
    sources: { private: { uidValidity: 7, uidNext: 42 } },
    agent: { parentSessionId: 'session-old', childSessions: [] },
    retries: {},
  };
  const oldStateText = JSON.stringify(oldStateFile, null, 2);
  fs.writeFileSync(stateFile, oldStateText, 'utf8');
  const domain = makeDomain({ sources: { private: { uidValidity: 7, uidNext: 42 } } });
  const store = new Store(cfg, quiet);
  const identity = store.state;
  store.attachDomain({ domain, owned: true });
  await store.ready();
  await store.flushChain;

  check('装载后 state 对象身份不变（runner 持有的引用不会被换掉）', () => assert.equal(store.state, identity));
  check('以域里的游标为准', () => {
    assert.equal(store.state.sources.private.uidNext, 42);
    assert.equal(store.state.sources.private.uidValidity, 7);
  });
  check('域为空表时不读旧文件（空域就是空状态，不是导入）', async () => {
    const emptyDomain = makeDomain();
    const probe = new Store(cfg, quiet);
    probe.attachDomain({ domain: emptyDomain, owned: true });
    await probe.ready();
    assert.deepEqual(probe.state.sources, {});
    assert.equal(probe.state.agent.parentSessionId, undefined);
    await probe.close();
  });
  check('残留的 state.json 原样不动（既不导入、也不改名归档）', () => {
    assert.equal(fs.existsSync(stateFile), true);
    assert.equal(fs.readFileSync(stateFile, 'utf8'), oldStateText);
  });

  // 11.2 只写变了的那几条
  const before = domain.writes.length;
  store.save();
  await store.flushChain;
  check('没有改动时 save() 不产生写入（差量）', () => assert.equal(domain.writes.length, before));

  store.state.sources.private.uidNext = 99;
  store.state.retries['imap:private:99'] = { dir: '/tmp/x', file: '/tmp/x', sourceId: 'private', attempts: 1, lastError: 'boom', at: '2026-10-28' };
  store.save();
  await store.flushChain;
  check('改了游标只写这一条 + 新增重试写一条', () => {
    const fresh = domain.writes.slice(before);
    assert.deepEqual(fresh.sort(), ['put:retries:imap:private:99', 'put:sources:private']);
    assert.equal(domain.tables.sources.get('private').uidNext, 99);
    assert.equal(domain.tables.retries.get('imap:private:99').attempts, 1);
  });

  delete store.state.retries['imap:private:99'];
  store.save();
  await store.flushChain;
  check('删掉的重试记录会被删除（不是留着旧值）', () => {
    assert.equal(domain.tables.retries.has('imap:private:99'), false);
  });

  await store.close();
  check('close() 关闭自己打开的域', () => assert.ok(domain.writes.includes('close')));

  // 11.3 域里已有记录时文件完全不参与
  const secondDomain = makeDomain({ sources: { school: { uidValidity: null, uidNext: null, initialized: true, seenIds: ['a', 'b'] } } });
  fs.writeFileSync(stateFile, JSON.stringify({ sources: { private: { uidNext: 1 } } }), 'utf8');
  const store2 = new Store(cfg, quiet);
  store2.attachDomain({ domain: secondDomain, owned: true });
  await store2.ready();
  check('域里有记录时文件里的来源不会出现', () => {
    assert.deepEqual(store2.state.sources.school.seenIds, ['a', 'b']);
    assert.equal(store2.state.sources.private, undefined);
  });
  await store2.close();

  // 11.4 早到的调用先按兜底文件装载过内存，之后 attachDomain 仍要切到域（否则整轮都停在文件后台上）
  const lateDomain = makeDomain({ sources: { private: { uidValidity: null, uidNext: 500 } } });
  fs.writeFileSync(stateFile, JSON.stringify({ sources: { private: { uidNext: 7 } } }), 'utf8');
  const store3 = new Store(cfg, quiet);
  await store3.ready(); // 模拟 boot 还没打开域、就有工具调用了状态
  check('文件后端先装载成功', () => assert.equal(store3.state.sources.private.uidNext, 7));
  store3.attachDomain({ domain: lateDomain, owned: true });
  await store3.ready();
  await store3.flushChain;
  check('已装载过文件后 attachDomain 会切到域，并以域里的值为准', () => {
    assert.equal(store3.backend, 'domain');
    assert.equal(store3.state.sources.private.uidNext, 500);
  });
  await store3.close();
}

console.log('\n=== 12. 省 token 的两个开关：极简预设 + 思考强度 ===');
{
  const { MailAgentRunner } = await import('../src/agent.js');
  const silent = { info: () => undefined, warn: () => undefined };

  /** 假 preset 服务：`known` 里的 id 能解析，其余抛 not-found（和宿主行为一致） */
  const fakePresets = (known) => ({
    async resolve(id) {
      const wanted = id ?? 'standard';
      if (!known.includes(wanted)) throw new Error(`Unknown agent preset: ${wanted}`);
      return { id: wanted };
    },
    async list() {
      return known.map((id) => ({ id }));
    },
    async mount() {
      return undefined;
    },
  });
  const ctxWith = (presets) => ({ get: (name) => (name === 'agentPresets' ? presets : undefined), logger: silent });

  check('预设存在时，邮件子 agent 用它（mail-automation-agent）', async () => {
    const runner = new MailAgentRunner({
      ctx: ctxWith(fakePresets(['standard', 'mail-automation-agent'])),
      logger: silent,
      state: {},
      getMailPresetId: () => 'mail-automation-agent',
    });
    assert.equal(await runner.mailPresetId(), 'mail-automation-agent');
  });

  check('预设不存在时退回部署默认（并记 WARN，不抛异常）', async () => {
    const runner = new MailAgentRunner({
      ctx: ctxWith(fakePresets(['standard'])),
      logger: silent,
      state: {},
      getMailPresetId: () => 'mail-automation-agent',
    });
    assert.equal(await runner.mailPresetId(), 'standard');
  });

  check('配置留空 = 跟随部署默认（不指定预设）', async () => {
    const runner = new MailAgentRunner({
      ctx: ctxWith(fakePresets(['standard'])),
      logger: silent,
      state: {},
      getMailPresetId: () => '',
    });
    assert.equal(await runner.mailPresetId(), 'standard');
  });

  check('父会话仍然用部署默认预设（不能被邮件预设拖成精简会话）', async () => {
    const runner = new MailAgentRunner({
      ctx: ctxWith(fakePresets(['standard', 'mail-automation-agent'])),
      logger: silent,
      state: {},
      getMailPresetId: () => 'mail-automation-agent',
    });
    const session = await runner.presetSetup('session');
    const mail = await runner.presetSetup('mail');
    assert.equal(session.presetId, 'standard');
    assert.equal(mail.presetId, 'mail-automation-agent');
  });

  const base = { provider: 'p', model: 'm', reasoningEffort: 'high' };
  const withEffort = (value) =>
    new MailAgentRunner({
      ctx: ctxWith(fakePresets(['standard'])),
      logger: silent,
      state: {},
      getReasoningEffort: () => value,
    });

  check('思考强度：配置 low 会覆盖部署的 high', () => {
    assert.equal(withEffort('low').withEffort(base).reasoningEffort, 'low');
    assert.equal(withEffort('MINIMAL').withEffort(base).reasoningEffort, 'minimal');
  });
  check('思考强度：留空/写 inherit 时保持部署值', () => {
    assert.deepEqual(withEffort('').withEffort(base), base);
    assert.deepEqual(withEffort('inherit').withEffort(base), base);
  });
  check('思考强度：不认识的值被忽略（不把脏值塞给 adapter）', () => {
    assert.deepEqual(withEffort('turbo').withEffort(base), base);
  });
  check('思考强度：没有部署选择时仍可单独指定', () => {
    assert.equal(withEffort('low').withEffort({ provider: 'p', model: 'm' }).reasoningEffort, 'low');
  });

  // 配置层：snake_case 覆盖层也能改这两个开关
  const { loadConfig } = await import('../src/config.js');
  const file = path.join(work, 'agent-tunables.yaml');
  fs.writeFileSync(
    file,
    ['agent:', '  preset: ""', '  reasoning_effort: inherit', 'sources:', '  - id: s1', '    type: imap', '    host: h', '    user: u', '    password: p', ''].join('\n'),
    'utf8',
  );
  const tuned = loadConfig(file, { base: { sources: [], agent: { preset: 'mail-automation-agent', reasoningEffort: 'low' } } });
  check('YAML 能把预设关掉、把思考强度交还部署（写成空/inherit）', () => {
    assert.equal(tuned.error, undefined);
    assert.equal(tuned.config.agent.preset, '');
    assert.equal(tuned.config.agent.reasoningEffort, '');
  });
}

console.log('\n=== 13. 启动接管：失败占位的邮件会被重新排队 ===');
{
  // 回归：失败时写的那份"（agent 处理失败：…）"占位结论，一度让 adoptOrphans 误判成
  // "已处理"，导致崩溃/失败过的邮件既不在重试队列、也永远不再被处理。
  const { Store } = await import('../src/store.js');
  const { loadConfig } = await import('../src/config.js');
  const root = path.join(work, 'adopt-case');
  const archiveDir = path.join(root, 'archive');
  fs.mkdirSync(archiveDir, { recursive: true });
  const cfgFile = path.join(root, 'mail-automation.yaml');
  fs.writeFileSync(
    cfgFile,
    ['sources:', '  - id: offline', '    type: imap', '    host: 127.0.0.1', '    port: 1', '    secure: false', '    user: t@example.com', '    password: p',
      'storage:', `  root: ${JSON.stringify(root)}`, 'agent:', `  workspace: ${JSON.stringify(root)}`, 'qq:', '  enabled: false', ''].join('\n'),
    'utf8',
  );
  const { config } = loadConfig(cfgFile);
  const seeding = new Store(config, { warn() {}, info() {} });
  const failedDir = seeding.writeMail({
    sourceId: 'offline', sourceName: '离线来源',
    header: { id: 'imap:offline:1', uid: 1 },
    body: { text: 'hi', subject: '失败过的邮件', from: 'a@b', date: new Date().toISOString() },
  });
  seeding.writeConclusion(failedDir, '（agent 处理失败：blocked）', { error: 'blocked' });
  seeding.save();

  const { apply } = await import('../src/index.js');
  const { ctx, state: adoptState } = makeCtx({ withSkills: false });
  apply(ctx, { configFile: cfgFile });
  await sleep(2500);
  const persisted = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
  const queued = Object.entries(persisted.retries ?? {}).filter(([, v]) => v && v.dir === failedDir);
  check('启动时把失败占位的邮件重新排队', () => assert.equal(queued.length, 1, JSON.stringify(persisted.retries)));
  check('排队时清掉了失败占位结论（状态回到待处理）', () => assert.equal(fs.existsSync(path.join(failedDir, 'conclusion.md')), false));
  for (const disposer of adoptState.effects) disposer();
}

console.log('\n=== 14. 设置页参数读取：每个白名单参数都要读到值 ===');
{
  // 回归：readParams 曾经只给 monitor/digest/storage 写映射，agent.* 两个新参数落到
  // cfg.storage 上，界面上永远读不到值（显示为空）。
  const { loadConfig, normalizeConfig } = await import('../src/config.js');
  const { readParams, PARAM_SPECS } = await import('../src/uiapi.js');
  const loaded = loadConfig(undefined, { base: { sources: [{ id: 's', type: 'imap', host: 'h', user: 'u', password: 'p' }] } });
  const params = readParams(loaded.config);
  check('每个 PARAM_SPECS 参数都有非 null 值', () => {
    for (const key of Object.keys(PARAM_SPECS)) {
      assert.ok(params[key] !== null && params[key] !== undefined, `${key} 读不到值`);
    }
  });
  check('agent.workspace 缺省展开到 $DSH_HOME/workspace/default', () => {
    assert.match(String(params['agent.workspace']), /workspace[\\/]default$/);
  });
  check('agent.silent 缺省为 false（默认挂工作区）', () => {
    assert.equal(params['agent.silent'], false);
  });
  check('定时任务 busy 退避参数：默认 5s / 24 次，可改并夹在范围内', () => {
    const home = path.join(work, 'scheduler-params');
    assert.equal(params['busy_retry_seconds'], 5);
    assert.equal(params['busy_retry_max'], 24);
    const custom = normalizeConfig(
      { scheduler: { busy_retry_seconds: 7, busy_retry_max: 9 } },
      { dshHome: home, configFile: path.join(home, 'mail-automation', 'mail-automation.yaml') },
    );
    assert.equal(custom.scheduler.busyRetrySeconds, 7);
    assert.equal(custom.scheduler.busyRetryMax, 9);
    const low = normalizeConfig(
      { scheduler: { busy_retry_seconds: 0, busy_retry_max: 0 } },
      { dshHome: home, configFile: path.join(home, 'mail-automation', 'mail-automation.yaml') },
    );
    assert.equal(low.scheduler.busyRetrySeconds, 1);
    assert.equal(low.scheduler.busyRetryMax, 1);
  });

  // ── 0.3.0：模型 / 思考强度 / 工具集 ────────────────────────────────────────
  const { normalizeParam } = await import('../src/uiapi.js');
  const { buildMailPreset, normalizeMailTools, MAIL_TOOL_CATALOG, MAIL_PRESET_ID, resolveToolSpec } = await import('../src/preset.js');

  check('工具集缺省 = 两个批量工具 + archive_read + qq_notify + read_image（都可删、可改）', () => {
    assert.deepEqual(params['agent.tools'], [
      'mail_automation_archive_read',
      'mail_automation_archive_list',
      'mail_automation_archive_clear',
      'qq_notify',
      'read_image',
    ]);
  });
  check('模型缺省为空（跟随部署默认）', () => {
    assert.equal(params['agent.provider'], '');
    assert.equal(params['agent.model'], '');
  });
  check('思考强度缺省为 low（交接部署默认时 readParams 显示 inherit）', () => {
    assert.equal(params['agent.reasoning_effort'], 'low');
    assert.equal(normalizeParam('agent.reasoning_effort', 'inherit').value, 'inherit');
    assert.equal(normalizeParam('agent.reasoning_effort', 'HIGH').value, 'high');
    assert.match(normalizeParam('agent.reasoning_effort', 'turbo').error ?? '', /只能是/);
  });
  check('工具集校验：无法解析的条目报错；目录 id 与工具名都放行', () => {
    assert.match(normalizeParam('agent.tools', ['read_img']).error ?? '', /无法解析/);
    assert.deepEqual(normalizeParam('agent.tools', ['read_image', 'fs']).value, ['read_image', 'fs']);
    assert.deepEqual(normalizeParam('agent.tools', ['todo', 'web']).value, ['todo', 'web']);
  });
  check('工具集归一化：未配置→默认；显式空数组→空；自由条目保留去重；字符串按逗号拆', () => {
    const defaults = [
      'mail_automation_archive_read',
      'mail_automation_archive_list',
      'mail_automation_archive_clear',
      'qq_notify',
      'read_image',
    ];
    assert.deepEqual(normalizeMailTools(undefined), defaults);
    assert.deepEqual(normalizeMailTools(null), defaults);
    // 旧默认列表不再自动迁移（旧版本适配已删除）；未配置才用当前默认
    assert.deepEqual(normalizeMailTools(['mail_automation_archive_read', 'qq_notify', 'read_image']), [
      'mail_automation_archive_read',
      'qq_notify',
      'read_image',
    ]);
    assert.deepEqual(normalizeMailTools([]), []);
    assert.deepEqual(normalizeMailTools(['mail_automation_archive_read']), ['mail_automation_archive_read']);
    // 自由列表：目录 id / 工具名 / 模块名都原样保留（解析发生在 buildMailPreset）
    assert.deepEqual(normalizeMailTools(['nope', 'web']), ['nope', 'web']);
    assert.deepEqual(normalizeMailTools('web, todo'), ['web', 'todo']);
  });
  check('工具名映射到宿主工具包（read / grep / web_fetch / 自定义模块）', () => {
    assert.equal(resolveToolSpec('grep').pkg, '@deepseek-ai/dsh-tool-fs-search');
    assert.equal(resolveToolSpec('read').pkg, '@deepseek-ai/dsh-tool-fs');
    assert.equal(resolveToolSpec('web_fetch').pkg, '@deepseek-ai/dsh-tool-web');
    assert.equal(resolveToolSpec('@scope/other-plugin').pkg, '@scope/other-plugin');
    assert.equal(resolveToolSpec('read_img'), null);
  });
  check('预设无内置人设：工具只来自 agent.tools，空列表就是空预设', () => {
    const definition = buildMailPreset({ tools: ['read_image'] });
    assert.equal(definition.id, MAIL_PRESET_ID);
    assert.deepEqual(definition.plugins.map((p) => p.name), ['@deepseek-ai/dsh-tool-fs']);
    assert.equal(definition.plugins[0].config.readImage, true);
    assert.equal(definition.plugins[0].config.write, false);
    assert.deepEqual(buildMailPreset({ tools: [] }).plugins, []);
    assert.equal(buildMailPreset({}).plugins.some((p) => p.name === '@deepseek-ai/dsh-persona'), false);
  });
  check('预设按工具集生成子插件，未知工具被忽略', () => {
    const definition = buildMailPreset({ tools: ['web', 'skill', 'nope'] });
    assert.deepEqual(
      definition.plugins.map((p) => p.name),
      ['@deepseek-ai/dsh-tool-web', '@deepseek-ai/dsh-tool-skill'],
    );
    assert.equal(MAIL_TOOL_CATALOG.length >= 5, true);
  });
}

console.log('\n=== 15. 定时任务：排期数学 / 配置 / 持久化 / 幂等 ===');
{
  const { nextScheduleAt, intervalNextAt, planNextRun, describeSchedule, normalizeSchedule, planBusyRetry, BUSY_RETRY_POLL_MS, BUSY_RETRY_POLL_MAX } = await import('../src/schedule.js');
  const {
    normalizeConfig,
    loadConfig,
    defaultGraphTokenFile,
    derivedSourceId,
    DEFAULT_MAIL_PROMPT,
    DEFAULT_HTML_PROMPT,
    DEFAULT_DIGEST_PROMPT,
  } = await import('../src/config.js');
  const { Config } = await import('../src/schema.js');
  const { saveSchedules } = await import('../src/schedules-config.js');
  const { STATE_RECORD_SCHEMAS } = await import('../src/state-domain.js');
  const { Store } = await import('../src/store.js');

  // 2026-10-31 是周六（本地时区）
  const sat = new Date(2026, 9, 31, 10, 0, 0, 0).getTime();
  const at = (ms) => new Date(ms).toLocaleString();

  check('daily：多个时刻取最近一个，过了最后一个排到明天', () => {
    assert.equal(at(nextScheduleAt({ type: 'daily', times: ['12:00', '21:00'] }, sat)), at(new Date(2026, 9, 31, 12, 0).getTime()));
    const late = new Date(2026, 9, 31, 22, 0).getTime();
    assert.equal(at(nextScheduleAt({ type: 'daily', times: ['12:00', '21:00'] }, late)), at(new Date(2026, 10, 1, 12, 0).getTime()));
  });
  check('weekly：周三/周五 15:00 从周六算，落在下周三', () => {
    assert.equal(at(nextScheduleAt({ type: 'weekly', weekdays: [3, 5], times: ['15:00'] }, sat)), at(new Date(2026, 10, 4, 15, 0).getTime()));
  });
  check('monthly：31 号在没有 31 号的月份按最后一天', () => {
    const feb = new Date(2027, 1, 1, 0, 0, 0, 0).getTime();
    assert.equal(at(nextScheduleAt({ type: 'monthly', days: [31], times: ['09:00'] }, feb)), at(new Date(2027, 1, 28, 9, 0).getTime()));
  });
  check('interval：以 lastRunAt 锚定；停机错过只补一次（返回 now）', () => {
    const step = 90 * 60_000;
    assert.equal(intervalNextAt({ type: 'interval', everyMinutes: 90 }, sat, sat - step), sat);
    assert.equal(intervalNextAt({ type: 'interval', everyMinutes: 90 }, sat, sat - 10_000), sat + step - 10_000);
    assert.equal(intervalNextAt({ type: 'interval', everyMinutes: 90 }, sat, 0), sat + step);
  });
  check('startup：同一进程只排一次（换进程 = 新 slot）', () => {
    const first = planNextRun({ schedule: { type: 'startup' } }, {}, sat);
    assert.equal(first.done, false);
    assert.equal(planNextRun({ schedule: { type: 'startup' } }, { lastSlot: first.slot }, sat).done, true);
  });
  check('busy 退避：轮询 5s × 24、处理 60s × 3', () => {
    const one = planBusyRetry({ attempt: 0, now: 0, retryMs: 60_000 });
    assert.deepEqual(one, { attempt: 1, at: 60_000, retry: true });
    assert.equal(planBusyRetry({ attempt: 3, now: 0 }).retry, false);
    const fast = planBusyRetry({ attempt: 0, now: 0, retryMs: BUSY_RETRY_POLL_MS, maxAttempts: BUSY_RETRY_POLL_MAX });
    assert.deepEqual(fast, { attempt: 1, at: 5_000, retry: true });
    assert.equal(planBusyRetry({ attempt: BUSY_RETRY_POLL_MAX - 1, retryMs: BUSY_RETRY_POLL_MS, maxAttempts: BUSY_RETRY_POLL_MAX }).retry, true);
    assert.equal(planBusyRetry({ attempt: BUSY_RETRY_POLL_MAX, retryMs: BUSY_RETRY_POLL_MS, maxAttempts: BUSY_RETRY_POLL_MAX }).retry, false);
  });
  check('排期描述：每天/每周/每月/间隔/启动', () => {
    assert.equal(describeSchedule({ type: 'daily', times: ['12:00', '21:00'] }), '每天 12:00、21:00');
    assert.equal(describeSchedule({ type: 'weekly', weekdays: [3, 5], times: ['15:00'] }), '每周三、五 15:00');
    assert.equal(describeSchedule({ type: 'monthly', days: [1, 15], times: ['09:00'] }), '每月 1、15 日 09:00');
    assert.equal(describeSchedule({ type: 'interval', everyMinutes: 90 }), '每 90 分钟');
    assert.equal(describeSchedule({ type: 'startup' }), '每次启动时');
  });
  check('加载期 fail loud：坏时刻 / 空 weekdays / 重复 id / 任务无 prompt_file', () => {
    assert.throws(() => normalizeSchedule({ type: 'daily', times: ['25:00'] }, 'x'), /非法时刻/);
    assert.throws(() => normalizeSchedule({ type: 'weekly', weekdays: [], times: ['09:00'] }, 'x'), /weekdays/);
    assert.throws(
      () => normalizeConfig({ schedules: [{ id: 'a', schedule: { type: 'startup' }, prompt_file: 'a.md' }, { id: 'a', schedule: { type: 'startup' }, prompt_file: 'b.md' }] }),
      /id 重复/,
    );
    assert.throws(
      () => normalizeConfig({ schedules: [{ id: 'a', schedule: { type: 'startup' } }] }),
      /没有 prompt_file/,
    );
  });
  check('schedules 缺省/空数组 = 不跑任何任务（没有默认任务）', () => {
    assert.deepEqual(normalizeConfig({ schedules: [] }).schedules, []);
    const base = Config({ sources: [{ type: 'imap', host: 'h', user: 'u' }] });
    const implicit = loadConfig(undefined, { base });
    assert.equal(implicit.error, undefined);
    assert.deepEqual(implicit.config.schedules, []);
  });
  check('meta 白名单保留 scheduleRuns（漏列会让启动任务重启后重跑）', () => {
    const parsed = STATE_RECORD_SCHEMAS.meta.parse({
      scheduleRuns: {
        boot: { lastRunAt: '2026-10-31T09:00:00Z', lastRunAtMs: 1, lastSlot: 'boot:x', lastStatus: 'ok', lastError: '', lastFile: '', lastCount: 2 },
        bad: 'nope',
      },
    });
    assert.equal(parsed.scheduleRuns.boot.lastSlot, 'boot:x');
    assert.equal(parsed.scheduleRuns.boot.lastStatus, 'ok');
    assert.equal(parsed.scheduleRuns.bad, undefined, '坏记录被跳过，不影响其它任务');
    assert.deepEqual(STATE_RECORD_SCHEMAS.meta.parse({}).scheduleRuns, {});
  });

  // save-schedules：整份任务数组 → YAML → 再加载（含 prompt_file）
  const dir = path.join(work, 'sched-save');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'mail-automation.yaml');
  fs.writeFileSync(file, '# keep me\nsources:\n  - id: s\n    type: imap\n    host: h\n    user: u\n    password: p\n', 'utf8');
  const saved = await saveSchedules({
    configFile: file,
    dshHome: dir,
    schedules: [
      { id: 'digest', name: '总览', schedule: { type: 'daily', times: ['12:00', '21:00'] }, prompt: '汇总并发 QQ' },
      { id: 'boot', name: '启动快照', schedule: { type: 'startup' }, prompt: '把快照发我' },
      { id: 'file-task', name: '文件提示词', schedule: { type: 'interval', everyMinutes: 30 }, prompt_file: 'task-prompt.md', prompt: '写到文件里' },
      { id: 'auto-task', name: '自动提示词文件', schedule: { type: 'daily', times: ['08:00'] }, prompt: '自动写入的提示词' },
    ],
  });
  check('save-schedules 写入成功且保留原有注释/来源', () => {
    assert.equal(saved.ok, true, saved.error);
    assert.deepEqual(saved.ids, ['digest', 'boot', 'file-task', 'auto-task']);
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /# keep me/);
    assert.match(text, /schedules:/);
    assert.match(text, /every_minutes: 30/);
    assert.equal(fs.readFileSync(path.join(dir, 'task-prompt.md'), 'utf8'), '写到文件里');
  });
  check('prompt_file 留空 = 自动创建 prompt/<id>-prompt.md，并写进 YAML', () => {
    const autoFile = path.join(dir, 'mail-automation', 'prompt', 'auto-task-prompt.md');
    assert.equal(fs.existsSync(autoFile), true);
    assert.equal(fs.readFileSync(autoFile, 'utf8'), '自动写入的提示词');
    assert.match(fs.readFileSync(file, 'utf8'), /prompt_file: .*auto-task-prompt\.md/);
  });
  const reloaded = loadConfig(file).config;
  check('写回后能按原语义加载（任务数/类型/提示词）', () => {
    assert.equal(reloaded.schedules.length, 4);
    assert.deepEqual(reloaded.schedules[0].schedule.times, ['12:00', '21:00']);
    assert.equal(reloaded.schedules[1].schedule.type, 'startup');
    assert.equal(reloaded.schedules[2].schedule.everyMinutes, 30);
    assert.equal(reloaded.schedules[2].promptFile, path.join(dir, 'task-prompt.md'));
    assert.equal(reloaded.schedules[3].promptFile, path.join(dir, 'mail-automation', 'prompt', 'auto-task-prompt.md'));
  });
  {
    const before = fs.readFileSync(file, 'utf8');
    const bad = await saveSchedules({ configFile: file, dshHome: dir, schedules: [{ id: 'x', name: '坏', schedule: { type: 'weekly', weekdays: [9], times: ['09:00'] }, prompt: 'p' }] });
    const missingPrompt = await saveSchedules({
      configFile: file,
      dshHome: dir,
      schedules: [{ id: 'x', name: '空提示词', schedule: { type: 'daily', times: ['08:00'] }, prompt_file: 'empty.md' }],
    });
    check('坏任务整份不写（YAML 保持原样）', () => {
      assert.equal(bad.ok, false);
      assert.equal(missingPrompt.ok, false);
      assert.match(missingPrompt.error, /还没有填入提示词/);
      assert.equal(fs.readFileSync(file, 'utf8'), before);
    });
  }

  check('所有提示词默认落在 <home>/mail-automation/prompt/', () => {
    const home = path.join(work, 'prompt-home');
    const cfg = normalizeConfig({ sources: [] }, { dshHome: home, configFile: path.join(home, 'mail-automation', 'mail-automation.yaml') });
    const dir = path.join(home, 'mail-automation', 'prompt');
    assert.equal(cfg.prompt.file, path.join(dir, 'prompt.md'));
    assert.equal(cfg.prompt.htmlFile, path.join(dir, 'prompt-html.md'));
  });
  check('三个默认提示词不含 # 注释块或 <!-- --> 注释', () => {
    for (const text of [DEFAULT_MAIL_PROMPT, DEFAULT_HTML_PROMPT, DEFAULT_DIGEST_PROMPT]) {
      assert.doesNotMatch(text, /^#(?:\s|$)/m);
      assert.doesNotMatch(text, /<!--/);
    }
  });
  check('Graph 默认令牌按来源生成：graph-<id>.json（无文件夹后缀）；自动 id 不带文件夹', () => {
    const home = path.join(work, 'graph-home');
    fs.mkdirSync(home, { recursive: true });
    assert.equal(
      defaultGraphTokenFile(home, 'uoe_mail'),
      path.join(home, 'mail-automation', 'tokens', 'graph-uoe_mail.json'),
    );
    assert.equal(derivedSourceId('graph', {}, home), 'graph-mailbox');
    const cfg = normalizeConfig({ sources: [{ id: 'uoe_mail', type: 'graph' }] }, { dshHome: home });
    assert.equal(cfg.sources[0].tokenFile, path.join(home, 'mail-automation', 'tokens', 'graph-uoe_mail.json'));
  });

  // 文件后端：scheduleRuns 重启后仍在
  const root = path.join(work, 'sched-state');
  fs.mkdirSync(root, { recursive: true });
  const stateCfg = { storage: { root, archiveDir: path.join(root, 'archive'), stateFile: path.join(root, 'state.json') } };
  const storeA = new Store(stateCfg, { warn() {}, info() {} });
  storeA.state.scheduleRuns.digest = { lastRunAt: '2026-10-31T10:00:00Z', lastRunAtMs: 1, lastSlot: '2026-10-31T10:00', lastStatus: 'ok', lastError: '', lastFile: '', lastCount: 3 };
  storeA.save();
  const storeB = new Store(stateCfg, { warn() {}, info() {} });
  check('重启后 scheduleRuns 仍在（Store 文件后端往返）', () => {
    assert.equal(storeB.state.scheduleRuns.digest.lastSlot, '2026-10-31T10:00');
    assert.equal(storeB.state.scheduleRuns.digest.lastCount, 3);
  });
}

try {
  fs.rmSync(work, { recursive: true, force: true });
} catch {
  // 临时目录删不掉不影响结论
}
console.log(`\n=== 完成：${passed} 项通过${process.exitCode ? '，有失败' : ''} ===`);
process.exit(process.exitCode ?? 0);
