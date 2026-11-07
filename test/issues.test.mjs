#!/usr/bin/env node
/**
 * 当前功能的回归测试（清理旧版本适配后重建）。
 *
 * 只断言现版本契约：定时任务必须显式配置、提示词必须有文件、工具直接可用、
 * 不再有 digest 类型/旧迁移/旧游标/旧工具集。历史缺陷的逐条回归已随旧代码删除。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mail-automation-current-'));
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
let passed = 0;

const check = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    process.exitCode = 1;
    console.error(`  ✗ ${name}\n${err?.stack ?? err}`);
  }
};
const checkAsync = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    process.exitCode = 1;
    console.error(`  ✗ ${name}\n${err?.stack ?? err}`);
  }
};
const tmp = (name) => {
  const dir = path.join(work, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const seedMail = (archiveDir, name, meta = {}, files = {}) => {
  const dir = path.join(archiveDir, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), content, 'utf8');
  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({ id: name, subject: `subject-${name}`, from: 'a@b.c', to: 'me@x.com', date: '2026-10-31T10:00:00Z', source: '测试', ...meta }, null, 2),
    'utf8',
  );
  return dir;
};
const storeCfg = (root) => ({
  storage: {
    root,
    archiveDir: path.join(root, 'archive'),
    stateFile: path.join(root, 'state.json'),
    snapshotFile: path.join(root, 'startup.md'),
    logMaxBytes: 2 * 1024 * 1024,
  },
  archive: { archiveDir: path.join(root, 'archive') },
  agent: { workspace: root, retryAttempts: 3 },
});

const { normalizeConfig, loadConfig, ensureFirstInstallConfig, normalizeSchedules, stripPromptComments, defaultGraphTokenFile, DEFAULT_DIGEST_PROMPT, DEFAULT_MAIL_PROMPT } = await import('../src/config.js');
const { planBusyRetry, nextScheduleAt, normalizeSchedule, BUSY_RETRY_POLL_MS, BUSY_RETRY_POLL_MAX } = await import('../src/schedule.js');
const { Store } = await import('../src/store.js');
const { listArchives, clearArchives } = await import('../src/archiveadmin.js');
const { readArchivedMail } = await import('../src/archiveread.js');
const { normalizeMailTools, DEFAULT_MAIL_TOOLS } = await import('../src/preset.js');
const { readParams, statusSnapshot, PARAM_SPECS } = await import('../src/uiapi.js');

console.log('\n=== 配置与排期 ===');
{
  check('schedules 缺省为空；任务必须有 prompt_file；没有默认 digest 任务', () => {
    assert.deepEqual(normalizeConfig({ sources: [] }).schedules, []);
    assert.throws(() => normalizeSchedules([{ id: 'x', schedule: { type: 'startup' } }]), /prompt_file/);
    const home = tmp('cfg-home');
    const cfg = normalizeConfig(
      { sources: [], schedules: [{ id: 'x', schedule: { type: 'startup' }, prompt_file: 'x.md' }] },
      { dshHome: home, configFile: path.join(home, 'mail-automation', 'mail-automation.yaml') },
    );
    assert.equal(cfg.schedules.length, 1);
    assert.equal(cfg.schedules[0].promptFile, path.join(home, 'mail-automation', 'x.md'));
  });

  check('schedules 重复 id / 非法排期 fail loud', () => {
    assert.throws(() => normalizeSchedules([
      { id: 'a', schedule: { type: 'startup' }, prompt_file: 'a.md' },
      { id: 'a', schedule: { type: 'startup' }, prompt_file: 'b.md' },
    ]), /id 重复/);
    assert.throws(() => normalizeSchedule({ type: 'weekly', weekdays: [], times: ['09:00'] }, 'x'), /weekdays/);
  });

  check('首次安装：默认配置文件不存在时按空配置启动；自定义路径缺失仍报错', () => {
    const home = tmp('first-install');
    const defaultFile = path.join(home, 'mail-automation', 'mail-automation.yaml');
    const first = loadConfig(defaultFile, { dshHome: home });
    assert.equal(first.error, undefined);
    assert.deepEqual(first.config.sources, []);
    assert.equal(first.firstInstall, true);
    assert.equal(ensureFirstInstallConfig(defaultFile, { dshHome: home }), true);
    const seeded = loadConfig(defaultFile, { dshHome: home });
    assert.equal(seeded.config.schedules.length, 1);
    assert.equal(seeded.config.schedules[0].id, 'digest');
    assert.equal(seeded.config.schedules[0].schedule.type, 'daily');
    assert.match(seeded.config.schedules[0].promptFile, /digest-prompt\.md$/);
    const custom = loadConfig(path.join(home, 'wrong', 'mail-automation.yaml'), { dshHome: home });
    assert.match(custom.error, /配置文件不存在/);
  });

  check('busy 退避：轮询 5s × 24，处理 60s × 3', () => {
    const fast = planBusyRetry({ attempt: 0, now: 0, retryMs: BUSY_RETRY_POLL_MS, maxAttempts: BUSY_RETRY_POLL_MAX });
    assert.deepEqual(fast, { attempt: 1, at: 5_000, retry: true });
    assert.equal(planBusyRetry({ attempt: BUSY_RETRY_POLL_MAX, retryMs: BUSY_RETRY_POLL_MS, maxAttempts: BUSY_RETRY_POLL_MAX }).retry, false);
    assert.deepEqual(planBusyRetry({ attempt: 0, now: 0, retryMs: 60_000 }), { attempt: 1, at: 60_000, retry: true });
    assert.equal(planBusyRetry({ attempt: 3 }).retry, false);
  });

  check('daily 排期下一次严格晚于 from', () => {
    const from = new Date(2026, 9, 31, 21, 30, 0, 0).getTime();
    const at = nextScheduleAt({ type: 'daily', times: ['21:30'] }, from);
    assert.equal(new Date(at).getDate(), 1);
  });

  check('提示词注释：文件头 # 块与 <!-- --> 被剥掉，## 标题保留', () => {
    const text = stripPromptComments('# 说明\n#\n<!-- 行内 -->\n## 任务\n正文\n');
    assert.equal(text, '## 任务\n正文');
    assert.match(DEFAULT_DIGEST_PROMPT, /mail_automation_archive_list/);
    assert.match(DEFAULT_DIGEST_PROMPT, /mail_automation_archive_clear/);
    assert.doesNotMatch(DEFAULT_DIGEST_PROMPT, /mail-automation-archive/);
    assert.doesNotMatch(DEFAULT_MAIL_PROMPT, /^#(?:\s|$)/m);
  });

  await checkAsync('默认提示词文件只生成三份，不再从旧位置复制', async () => {
    const home = tmp('prompt-home');
    const legacy = path.join(home, 'mail-automation', 'prompt.md');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, '旧内容', 'utf8');
    const cfg = normalizeConfig({ sources: [] }, { dshHome: home, configFile: path.join(home, 'mail-automation', 'mail-automation.yaml') });
    const { ensureDefaultPromptFiles } = await import('../src/config.js');
    ensureDefaultPromptFiles(cfg);
    assert.match(fs.readFileSync(cfg.prompt.file, 'utf8'), /邮件助理/);
    assert.equal(fs.readFileSync(legacy, 'utf8'), '旧内容', '旧文件不再被读取或覆盖');
    assert.equal(fs.existsSync(path.join(home, 'mail-automation', 'prompt', 'digest-prompt.md')), true);
  });

  await checkAsync('Graph 默认令牌按来源生成；清空 token_file 后快照仍显示空（用默认路径）', async () => {
    const home = tmp('graph-home');
    const expected = path.join(home, 'mail-automation', 'tokens', 'graph-g.json');
    assert.equal(defaultGraphTokenFile(home, 'g'), expected);
    const cfg = normalizeConfig({ sources: [{ id: 'g', type: 'graph' }] }, { dshHome: home });
    assert.equal(cfg.sources[0].tokenFileRaw, '');
    assert.equal(cfg.sources[0].tokenFile, expected);
    assert.equal(cfg.sources[0].folderRaw, '', '空 folder 不能回显有效值');
    assert.equal(cfg.sources[0].folder, 'inbox');
    const snap = statusSnapshot({ state: {}, cfg, store: null, configFile: 'x.yaml' });
    assert.equal(snap.sources[0].folder, '', '编辑表单用原始覆盖值');
    assert.match(snap.sources[0].detail, /文件夹 inbox/);
    const { sourceDetail } = await import('../src/sources-config.js');
    assert.match(sourceDetail(cfg.sources[0]), /graph-g\.json/);
    const auto = normalizeConfig({ sources: [{ type: 'graph' }] }, { dshHome: home });
    assert.equal(auto.sources[0].id, 'graph-mailbox');
    assert.equal(auto.sources[0].tokenFile, path.join(home, 'mail-automation', 'tokens', 'graph-graph-mailbox.json'));
    const imap = normalizeConfig({ sources: [{ id: 'i', type: 'imap', host: 'h', user: 'u' }] }, { dshHome: home });
    assert.equal(imap.sources[0].mailboxRaw, '');
    assert.equal(imap.sources[0].mailbox, 'INBOX');
    const gmail = normalizeConfig({ sources: [{ id: 'gm', type: 'gmail', user: 'a@gmail.com' }] }, { dshHome: home });
    assert.equal(gmail.sources[0].folderRaw, '');
    assert.equal(gmail.sources[0].folder, 'INBOX');
    const { upsertSource } = await import('../src/sources-config.js');
    const file = path.join(home, 'mail-automation.yaml');
    fs.writeFileSync(file, 'sources:\n  - id: g\n    type: graph\n    folder: inbox\n', 'utf8');
    const moved = await upsertSource({
      configFile: file, base: {}, dshHome: home, previousId: 'g',
      source: { id: 'g', type: 'graph', folder: 'archive' },
    });
    assert.equal(moved.ok, true);
    assert.equal(moved.identityChanged, true, '改文件夹必须让调用方清掉旧游标');
    const pfile = path.join(home, 'password.yaml');
    fs.writeFileSync(pfile, 'sources:\n  - id: q\n    type: imap\n    host: h\n    user: u\n    password_ref: QQ_PASSWORD\n', 'utf8');
    const edited = await upsertSource({
      configFile: pfile, base: {}, dshHome: home, previousId: 'q',
      source: { id: 'q', type: 'imap', host: 'h', user: 'u' },
    });
    assert.equal(edited.ok, true);
    assert.match(fs.readFileSync(pfile, 'utf8'), /password_ref: QQ_PASSWORD/, '空密码输入不能把凭据引用抹掉');
    const qfile = path.join(home, 'qq-password.yaml');
    fs.writeFileSync(qfile, 'sources:\n  - id: qq\n    type: imap\n    host: imap.qq.com\n    user: a@qq.com\n', 'utf8');
    const defaulted = await upsertSource({
      configFile: qfile, base: {}, dshHome: home,
      source: { id: 'qq', type: 'imap', host: 'imap.qq.com', user: 'a@qq.com', provider: 'qq', credential_mode: 'ref' },
    });
    assert.equal(defaulted.ok, true);
    assert.match(fs.readFileSync(qfile, 'utf8'), /password_ref: QQ_MAIL_PASSWORD/, '引用留空应落到 QQ 默认 ref');
  });

  check('默认工具集 5 件；旧默认集不再自动迁移', () => {
    assert.deepEqual(DEFAULT_MAIL_TOOLS, [
      'mail_automation_archive_read',
      'mail_automation_archive_list',
      'mail_automation_archive_clear',
      'qq_notify',
      'read_image',
    ]);
    assert.deepEqual(normalizeMailTools(['mail_automation_archive_read', 'qq_notify', 'read_image']), [
      'mail_automation_archive_read',
      'qq_notify',
      'read_image',
    ]);
    assert.deepEqual(normalizeMailTools(undefined), DEFAULT_MAIL_TOOLS);
  });
}

console.log('\n=== 存档工具 ===');
{
  const root = tmp('archive');
  const cfg = storeCfg(root);
  fs.mkdirSync(cfg.storage.archiveDir, { recursive: true });
  const store = new Store(cfg, quiet);
  const m1 = seedMail(cfg.storage.archiveDir, 'm1', { subject: '主题一' }, { 'conclusion.md': '结论一\n第二行', 'body.txt': '正文一' });
  const m2 = seedMail(cfg.storage.archiveDir, 'm2', { subject: '主题二' }, { 'conclusion.md': '结论二' });
  seedMail(cfg.storage.archiveDir, 'm3', { subject: '主题三' }, { 'body.txt': '正文三' });

  check('archive_list：全量 id、fields、conclusion、ids 顺序与 missing', () => {
    const all = listArchives({ store });
    assert.deepEqual(all.items.map((item) => item.id), ['m1', 'm2', 'm3']);
    const detail = listArchives({ store, fields: ['subject', 'to', 'conclusion'], maxConclusionChars: 1000 });
    assert.match(detail.text, /^m1 \| 标题: 主题一/);
    assert.match(detail.text, /结论: 结论一/);
    assert.match(detail.text, /没有 conclusion\.md/);
    const picked = listArchives({ store, ids: ['m2', 'm1'], fields: [] });
    assert.deepEqual(picked.items.map((item) => item.id), ['m2', 'm1']);
    const missing = listArchives({ store, ids: ['m1', 'nope'] });
    assert.deepEqual(missing.missing, ['nope']);
  });

  check('archive_read 单封 conclusion', () => {
    const one = readArchivedMail({ file: 'm1', part: 'conclusion' }, { archiveDir: cfg.storage.archiveDir });
    assert.equal(one.ok, true);
    assert.match(one.text, /结论一/);
  });

  check('archive_clear：按 id 清理 + 清 retries；空 ids 拒绝；全量清理', () => {
    store.state.retries = {
      a: { dir: m1, file: m1, sourceId: 's', attempts: 1, lastError: 'x', at: new Date().toISOString() },
      b: { dir: m2, file: m2, sourceId: 's', attempts: 1, lastError: 'x', at: new Date().toISOString() },
    };
    const one = clearArchives({ store, ids: ['m1'] });
    assert.equal(one.removed, 1);
    assert.equal(one.retries_removed, 1);
    assert.equal(fs.existsSync(m2), true);
    assert.deepEqual(Object.keys(store.state.retries), ['b']);
    assert.equal(clearArchives({ store, ids: [] }).ok, false);
    const rest = clearArchives({ store });
    assert.equal(rest.removed, 2);
    assert.equal(store.listArchived().length, 0);
  });
}

console.log('\n=== 状态/快照/前端 ===');
{
  check('Store 文件后端保留 scheduleRuns', () => {
    const root = tmp('state');
    const cfg = storeCfg(root);
    const a = new Store(cfg, quiet);
    a.state.scheduleRuns.digest = { lastRunAt: '2026-10-31T13:00:00Z', lastRunAtMs: 1, lastSlot: 's', lastStatus: 'ok', lastError: '', lastFile: '', lastCount: 2 };
    a.save();
    const b = new Store(cfg, quiet);
    assert.equal(b.state.scheduleRuns.digest.lastSlot, 's');
  });

  check('快照不再下发 nextDigest/lastDigestDate', () => {
    const cfg = normalizeConfig({ sources: [], schedules: [] });
    const store = new Store(storeCfg(tmp('snap')), quiet);
    const state = { schedulesArmed: true, schedulePending: new Map() };
    const snap = statusSnapshot({ state, cfg, store, configFile: 'x.yaml' });
    assert.equal('nextDigestAt' in snap.status, false);
    assert.equal('lastDigestDate' in snap.status, false);
    assert.deepEqual(snap.schedules, []);
    const graphCfg = normalizeConfig({ sources: [{ id: 'g', type: 'graph' }] });
    const graphSnap = statusSnapshot({ state, cfg: graphCfg, store, configFile: 'x.yaml' });
    assert.equal(graphSnap.sources[0].tokenFile, '', 'UI 应显示原始覆盖值；空 = 用默认路径');
    const startupCfg = normalizeConfig({
      sources: [],
      schedules: [{ id: 'boot', schedule: { type: 'startup' }, prompt_file: 'boot.md' }],
    });
    const startupSnap = statusSnapshot({
      state: { ...state, startupDeferred: new Set(['boot']) },
      cfg: startupCfg, store, configFile: 'x.yaml',
    });
    assert.equal(startupSnap.schedules[0].deferred, true);
    assert.equal(startupSnap.schedules[0].nextAt, 0, '刚保存的 startup 任务不能显示为立即执行');
    const intervalCfg = normalizeConfig({
      sources: [],
      schedules: [{ id: 'tick', schedule: { type: 'interval', everyMinutes: 1 }, prompt_file: 'tick.md' }],
    });
    const anchor = Date.now();
    const intervalState = { ...state, intervalAnchors: new Map([['tick', anchor]]) };
    const firstTick = statusSnapshot({ state: intervalState, cfg: intervalCfg, store, configFile: 'x.yaml' });
    const secondTick = statusSnapshot({ state: intervalState, cfg: intervalCfg, store, configFile: 'x.yaml' });
    assert.equal(firstTick.schedules[0].nextAt, anchor + 60_000);
    assert.equal(secondTick.schedules[0].nextAt, firstTick.schedules[0].nextAt, 'interval 下次时间不能每次刷新都往后漂');
  });

  check('PARAM_SPECS 仍可读全部参数（含 busy 两项）', () => {
    const cfg = normalizeConfig({ sources: [] });
    const params = readParams(cfg);
    assert.equal(params.busy_retry_seconds, 5);
    assert.equal(params.busy_retry_max, 24);
    for (const key of Object.keys(PARAM_SPECS)) assert.notEqual(params[key], undefined, key);
  });

  check('client：页签顺序、无 digest 入口、指南/状态/删除按钮齐全', () => {
    const src = fs.readFileSync(path.join(HERE, '..', 'client.js'), 'utf8');
    const order = ["tabButton('status'", "tabButton('mail'", "tabButton('sources'", "tabButton('schedules'", "tabButton('prompts'", "tabButton('params'", "tabButton('guide'"];
    let last = -1;
    for (const marker of order) {
      const index = src.indexOf(marker);
      assert.ok(index > last, `${marker} 顺序不对`);
      last = index;
    }
    assert.doesNotMatch(src, /runDigest|mail\.digestNow|mail_automation_digest/);
    assert.match(src, /const deleteMail = async/);
    assert.match(src, /schedules\.statusRetry/);
    assert.match(src, /const GUIDE_ZH =/);
    assert.doesNotMatch(src, /withArchiveToolInstructions|digestNote/);
  });

  await checkAsync('schema 不再有 digest / prompt.inline', async () => {
    const { Config } = await import('../src/schema.js');
    const cfg = Config({});
    assert.equal(cfg.digest, undefined);
    assert.equal(cfg.prompt.inline, undefined);
    assert.deepEqual(cfg.schedules, []);
  });
}

console.log('\n=== 代码审查回归 ===');
await checkAsync('POP3 中途取头失败不推进；恢复后仍交付失败邮件', async () => {
  const { Pop3Client } = await import('../src/sources/pop3client.js');
  const pop3 = await import('../src/sources/pop3.js');
  const methods = ['connect', 'login', 'uidl', 'top', 'retr'];
  const original = Object.fromEntries(methods.map((key) => [key, Pop3Client.prototype[key]]));
  let failing = true;
  try {
    Pop3Client.prototype.connect = async function () { return this; };
    Pop3Client.prototype.login = async () => {};
    Pop3Client.prototype.uidl = async () => ['old', 'failed', 'good'].map((uidl, i) => ({ n: i + 1, uidl }));
    Pop3Client.prototype.top = async (n) => {
      if (n === 2 && failing) throw new Error('temporary failure');
      return 'Subject: test\r\n\r\n';
    };
    Pop3Client.prototype.retr = async (n) => Buffer.from(await Pop3Client.prototype.top(n));
    const prev = { initialized: true, seenIds: ['old'] };
    await assert.rejects(pop3.poll({ id: 'review-pop3' }, prev), /游标不推进/);
    assert.deepEqual(prev.seenIds, ['old']);
    failing = false;
    const result = await pop3.poll({ id: 'review-pop3' }, prev);
    assert.deepEqual(result.headers.map((h) => h.uidl), ['failed', 'good']);
    assert.deepEqual((await pop3.poll({ id: 'review-pop3' }, result.state)).headers, []);
  } finally {
    pop3.closeAll();
    Object.assign(Pop3Client.prototype, original);
  }
});

// 真实 provider + 假 REST：每轮经过状态白名单，验证重启后也能继续排空积压。
for (const giantRecord of [false, true]) {
  await checkAsync(`Gmail ${giantRecord ? '单条巨型记录' : '超过五页积压'}完整排空且不重复`, async () => {
    const gmail = await import('../src/sources/gmail.js');
    const { STATE_RECORD_SCHEMAS } = await import('../src/state-domain.js');
    const home = tmp(giantRecord ? 'gmail-giant' : 'gmail-pages');
    const tokenFile = path.join(home, 'token.json');
    fs.writeFileSync(tokenFile, JSON.stringify({ refresh_token: 'fake', access_token: 'fake', expires_at: Date.now() / 1000 + 3600 }));
    const count = giantRecord ? 550 : 1050;
    const entry = (id) => ({ message: { id: String(id) } });
    const records = giantRecord
      ? [{ id: '2', messagesAdded: Array.from({ length: count }, (_, i) => entry(i + 1)) }]
      : Array.from({ length: count }, (_, i) => ({ id: String(i + 2), messagesAdded: [entry(i + 1)] }));
    const originalFetch = globalThis.fetch;
    let rejectMetadata = false;
    globalThis.fetch = async (url) => {
      const u = new URL(url);
      let data;
      if (u.pathname.endsWith('/history')) {
        const remaining = records.filter((r) => Number(r.id) > Number(u.searchParams.get('startHistoryId')));
        const offset = Number(u.searchParams.get('pageToken') || 0);
        data = { historyId: '9999', history: remaining.slice(offset, offset + 100) };
        if (offset + 100 < remaining.length) data.nextPageToken = String(offset + 100);
      } else {
        if (rejectMetadata) return { ok: false, status: 503, json: async () => ({ error: { message: 'temporary' } }) };
        data = { id: u.pathname.split('/').pop(), internalDate: '1700000000000', payload: { headers: [] } };
      }
      return { ok: true, status: 200, json: async () => data };
    };
    try {
      const source = { id: 'review-gmail', tokenFile };
      let state = { initialized: true, historyId: 1, seenIds: [] };
      rejectMetadata = true;
      await assert.rejects(gmail.poll(source, state), /元数据失败/);
      assert.equal(state.historyId, 1);
      rejectMetadata = false;
      const delivered = new Set();
      for (let i = 0; i < 30 && state.historyId !== 9999; i += 1) {
        const result = await gmail.poll(source, state);
        assert.ok(result.headers.length <= 50);
        for (const h of result.headers) {
          assert.equal(delivered.has(h.gmailId), false, `重复交付 ${h.gmailId}`);
          delivered.add(h.gmailId);
        }
        state = STATE_RECORD_SCHEMAS.sources.parse(JSON.parse(JSON.stringify(result.state)));
      }
      assert.equal(delivered.size, count);
      assert.equal(state.historyId, 9999);
      assert.ok(state.seenIds.length <= 400);
      assert.deepEqual((await gmail.poll(source, state)).headers, []);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

await checkAsync('来源改 id 保留密码/secret/引用，显式新值生效，拒绝覆盖其它来源', async () => {
  const { upsertSource } = await import('../src/sources-config.js');
  const YAML = (await import('yaml')).default;
  const home = tmp('rename-source');
  for (const [type, field, value] of [
    ['imap', 'password', 'fake-password'], ['imap', 'password_ref', 'MAIL_REF'],
    ['gmail', 'client_secret', 'fake-secret'], ['gmail', 'client_secret_ref', 'CLIENT_REF'],
  ]) {
    const file = path.join(home, `${field}.yaml`);
    const source = { id: 'old', type, host: 'example.test', user: 'a@example.test', [field]: value };
    fs.writeFileSync(file, YAML.stringify({ sources: [source] }));
    const payload = { ...source, id: 'new' };
    delete payload[field];
    const input = { configFile: file, dshHome: home, base: {}, previousId: 'old', source: payload };
    assert.equal((await upsertSource(input)).ok, true);
    const saved = YAML.parse(fs.readFileSync(file, 'utf8')).sources;
    assert.equal(saved.length, 1);
    assert.equal(saved[0].id, 'new');
    assert.equal(saved[0][field], value);
    if (field === 'password' || field === 'client_secret') {
      const changed = await upsertSource({ ...input, previousId: 'new', source: { ...payload, id: 'again', [field]: 'replacement' } });
      assert.equal(changed.ok, true);
      assert.equal(YAML.parse(fs.readFileSync(file, 'utf8')).sources[0][field], 'replacement');
    }
    fs.writeFileSync(file, YAML.stringify({ sources: [source, { ...source, id: 'new' }] }));
    const before = fs.readFileSync(file, 'utf8');
    assert.equal((await upsertSource(input)).ok, false);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
});

await checkAsync('run-task HTTP 响应保留失败判别位和错误，也能返回成功', async () => {
  const { Readable } = await import('node:stream');
  const { registerUiRoute } = await import('../src/uiapi.js');
  let handler;
  let outcome;
  const ctx = { get(name) {
    if (name === 'webServer') return { register(route) { handler = route.handler; return () => {}; } };
    if (name === 'connection') return { requestRejection() { return null; } };
  } };
  const dispose = registerUiRoute(ctx, {
    getState: () => ({}), getConfig: () => ({ sources: [], schedules: [] }), getStore: () => null,
    runTask: async () => outcome,
  });
  try {
    for (const ok of [false, true]) {
      outcome = { ok, name: 'test', error: ok ? '' : 'agent failed', count: 0 };
      const req = Readable.from([Buffer.from(JSON.stringify({ action: 'run-task', id: 'test' }))]);
      req.method = 'POST';
      req.headers = { 'content-type': 'application/json' };
      let response;
      await handler(req, { writeHead() {}, end(body) { response = JSON.parse(body); } });
      assert.equal(response.ok, ok);
      assert.equal(response.error, outcome.error);
      assert.ok(Array.isArray(response.schedules));
    }
  } finally {
    dispose();
  }
});

// ── 会话体积预算（src/budget.js）：2026-11-07 的 413 事故留下的护栏 ──────────────
{
  const budget = await import('../src/budget.js');

  check('budget: 会话体量按 JSON 字节累加，非 JSON 事件算 0', () => {
    const events = [
      { type: 'user/message', data: { text: 'a'.repeat(100) } },
      { type: 'tool/result', data: { text: '中文' } },
      null,
      { big: undefined, fn: () => 1 },
    ];
    const footprint = budget.sessionFootprint(events);
    assert.equal(footprint.count, 4);
    // 第 3 条是 null → 0；第 4 条里的函数被 JSON.stringify 丢掉，仍能序列化
    assert.ok(footprint.bytes > 100);
    assert.equal(budget.sessionFootprint(null).bytes, 0);
  });

  check('budget: 超过上限才判 over；0 = 关闭预算但仍报体量', () => {
    const footprint = { count: 10, bytes: 9 * 1024 * 1024 };
    const over = budget.evaluateSessionBudget(footprint, { maxBytes: 8 * 1024 * 1024 });
    assert.equal(over.over, true);
    assert.equal(over.bytes, 9 * 1024 * 1024);
    assert.equal(over.limit, 8 * 1024 * 1024);
    assert.equal(budget.evaluateSessionBudget(footprint, { maxBytes: 0 }).over, false);
    assert.equal(budget.evaluateSessionBudget(footprint, { maxBytes: 16 * 1024 * 1024 }).over, false);
    // 边界：恰好等于上限不算超（换代是"必须换"的动作，别为 1 字节抖动）
    assert.equal(budget.evaluateSessionBudget({ count: 1, bytes: 8 }, { maxBytes: 8 }).over, false);
  });

  check('budget: 提示词按 UTF-8 字节量（中文 3 字节）', () => {
    assert.equal(budget.utf8Bytes('中文'), 6);
    assert.equal(budget.utf8Bytes(''), 0);
    assert.equal(budget.utf8Bytes(undefined), 0);
    const verdict = budget.evaluatePromptBudget('中'.repeat(400), { maxBytes: 1024 });
    assert.equal(verdict.bytes, 1200);
    assert.equal(verdict.over, true);
    assert.equal(budget.evaluatePromptBudget('ok', { maxBytes: 0 }).over, false);
  });

  check('budget: 安全阈值 = 窗口 × 7.5 字节，窗口未知时用兜底窗口', () => {
    assert.equal(budget.windowSafeBytes(1_000_000), 7_500_000);
    assert.equal(budget.windowSafeBytes(0), Math.floor(budget.MIN_ASSUMED_WINDOW_TOKENS * 7.5));
    assert.ok(budget.windowSafeBytes(0) > 5 * 1024 * 1024);
  });

  check('budget: bili 只在数据目录存在时算"在场"', () => {
    const seen = [];
    const exists = (p) => {
      seen.push(p);
      return p === path.join('/home/u', '.config', 'billion-context');
    };
    assert.equal(budget.detectBillionContext({ homedir: '/home/u', existsSync: exists }), true);
    assert.ok(seen.some((p) => p.includes('.local')));
    assert.equal(budget.detectBillionContext({ homedir: '/home/u', existsSync: () => false }), false);
    // 探测函数抛错时安静地当作没装
    assert.equal(
      budget.detectBillionContext({
        homedir: '/home/u',
        existsSync: () => {
          throw new Error('EACCES');
        },
      }),
      false,
    );
    assert.equal(budget.detectBillionContext({ homedir: '' }), false);
  });

  check('budget: 读 bili 配置（读不到 / 坏 JSON / 不是对象 一律 undefined）', () => {
    const read = (payload) =>
      budget.readBillionContextConfig({
        homedir: '/home/u',
        readFileSync: () => {
          if (payload instanceof Error) throw payload;
          return payload;
        },
      });
    assert.deepEqual(read('{"compress":{"externalSummary":{"enabled":true}}}'), {
      compress: { externalSummary: { enabled: true } },
    });
    assert.equal(read(new Error('ENOENT')), undefined);
    assert.equal(read('{not json'), undefined);
    assert.equal(read('[1,2]'), undefined);
    assert.equal(read('null'), undefined);
    // 没有 home 就不去拼路径
    assert.equal(budget.readBillionContextConfig({ homedir: '' }), undefined);
  });

  check('budget: bili 折叠没武装才提示（没装 bili 永远不提示）', () => {
    const verdict = (args) => budget.billionContextFoldVerdict(args);
    const armed = {
      compress: { externalSummary: { enabled: true, autoFold: true, targets: ['deepseek-official/deepseek-flash'] } },
    };
    assert.equal(verdict({ biliPresent: false }).needed, false);
    // 装了 bili 但配置读不到：按"没武装"提示（宁可多说一句，也不能让人以为折叠在）
    assert.equal(verdict({ biliPresent: true }).needed, true);
    // enabled 但没开 autoFold：仍然是 fail-fast 413，要提示
    assert.equal(
      verdict({ biliPresent: true, config: { compress: { externalSummary: { enabled: true, targets: ['a/b'] } } } }).needed,
      true,
    );
    // 开了 autoFold 但没 target：同样不武装
    assert.equal(
      verdict({ biliPresent: true, config: { compress: { externalSummary: { enabled: true, autoFold: true } } } }).needed,
      true,
    );
    assert.equal(verdict({ biliPresent: true, config: armed }).needed, false);
  });

  check('budget: 描述体量给人看（KB / MB 两档，不出现 0 KB）', () => {
    assert.equal(budget.describeFootprint({ count: 1234, bytes: 3 * 1024 * 1024 }), '1,234 条事件 / 3.0 MB');
    assert.equal(budget.describeFootprint({ count: 3, bytes: 100 }), '3 条事件 / 1 KB');
  });

  // runner 侧的三个读数：预算/提示词上限/会话体量判定（不建 agent，纯读配置 + 事件）
  const { MailAgentRunner } = await import('../src/agent.js');
  const makeRunner = (options = {}) =>
    new MailAgentRunner({ ctx: {}, logger: quiet, state: {}, ...options });

  check('budget: runner 读配置的 MB / KB，非法值退回默认（0 = 显式关闭）', () => {
    assert.equal(makeRunner({ getSessionBudgetMb: () => 4 }).sessionBudgetBytes(), 4 * 1024 * 1024);
    assert.equal(makeRunner({ getSessionBudgetMb: () => 0 }).sessionBudgetBytes(), 0);
    assert.equal(makeRunner({ getSessionBudgetMb: () => 'x' }).sessionBudgetBytes(), 8 * 1024 * 1024);
    assert.equal(makeRunner({ getSessionBudgetMb: () => -1 }).sessionBudgetBytes(), 8 * 1024 * 1024);
    assert.equal(makeRunner({}).sessionBudgetBytes(), 8 * 1024 * 1024);
    assert.equal(makeRunner({ getPromptMaxKb: () => 8 }).promptBudgetBytes(), 8 * 1024);
    assert.equal(makeRunner({ getPromptMaxKb: () => 0 }).promptBudgetBytes(), 0);
    assert.equal(makeRunner({}).promptBudgetBytes(), 512 * 1024);
  });

  check('budget: runner 用一个假会话判"是否该换代"', () => {
    const agent = { session: { snapshotEvents: () => [{ data: { text: 'x'.repeat(2 * 1024 * 1024) } }] } };
    assert.equal(makeRunner({ getSessionBudgetMb: () => 1 }).budgetStateOf(agent).over, true);
    assert.equal(makeRunner({ getSessionBudgetMb: () => 4 }).budgetStateOf(agent).over, false);
    // 0 = 关掉预算：即便体量惊人也不换代（用户显式选择）
    assert.equal(makeRunner({ getSessionBudgetMb: () => 0 }).budgetStateOf(agent).over, false);
    // 拿不到会话（null / 没有 snapshotEvents）按空会话处理，不能抛
    assert.equal(makeRunner({ getSessionBudgetMb: () => 1 }).budgetStateOf(null).bytes, 0);
  });
}

console.log(`\n=== 完成：${passed} 项通过${process.exitCode ? '，有失败' : ''} ===`);
try {
  fs.rmSync(work, { recursive: true, force: true });
} catch {
  // 临时目录删不掉不影响结论
}
process.exit(process.exitCode ?? 0);
