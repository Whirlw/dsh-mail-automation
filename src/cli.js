#!/usr/bin/env node
/**
 * 开发/排障用 CLI：不依赖 DSH 进程，直接验证配置、IMAP/Graph 取信是否正常。
 *
 *   node src/cli.js headers [sourceId]     # 列前 N 条邮件头（默认 initialHeaders）
 *   node src/cli.js poll                   # 跑一轮轮询，打印新邮件与状态变化
 *   node src/cli.js read <mailId>          # 取单封全文并打印前 2000 字
 *   node src/cli.js config                 # 打印解析后的配置（密码脱敏）
 *
 * 账号凭据解析优先级：配置文件显式值 > password_ref（凭据文件/凭据页）>
 * 密码只来自配置的 password 或凭据引用（password_ref），不读别的插件。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeConfig, expandPath, DEFAULT_CONFIG_FILE } from './config.js';
import { readCredentialFileRefs, resolveSecretsFromRefs } from './credentials.js';
import YAML from 'yaml';
import fs from 'node:fs';
import * as mailSources from './sources/index.js';
import { atomicWriteFile } from './fsutil.js';

const PLUGIN_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONFIG_ARG = process.argv[2] && process.argv[2].endsWith('.yaml') ? process.argv[2] : '';
/**
 * 配置文件顺序：命令行参数 > MAIL_AUTOMATION_CONFIG > $DSH_HOME/mail-automation/ >
 * 插件目录旁的 ../mail-automation/（本机开发布局）。代码里不写机器绝对路径。
 */
function pickConfigFile() {
  if (CONFIG_ARG) return CONFIG_ARG;
  const candidates = [
    process.env.MAIL_AUTOMATION_CONFIG,
    DEFAULT_CONFIG_FILE,
    path.join(PLUGIN_DIR, '..', 'mail-automation', 'mail-automation.yaml'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const resolved = expandPath(candidate);
      if (fs.existsSync(resolved)) return resolved;
    } catch {
      // 看下一个
    }
  }
  return DEFAULT_CONFIG_FILE;
}
const CONFIG_FILE = pickConfigFile();
const ARGV = process.argv.slice(CONFIG_ARG ? 3 : 2);

function load() {
  const file = fs.existsSync(CONFIG_FILE) ? CONFIG_FILE : undefined;
  if (!file) throw new Error(`找不到配置文件：${CONFIG_FILE}（用 MAIL_AUTOMATION_CONFIG 指定，或作为第一个参数传入）`);
  const raw = YAML.parse(fs.readFileSync(file, 'utf8')) || {};
  // CLI 没有 ctx：password_ref 用凭据文件兜底（插件运行时走 ctx.credentials）
  const refs = readCredentialFileRefs();
  const secrets = resolveSecretsFromRefs(raw.sources, refs);
  const cfg = normalizeConfig(raw, { configFile: file, secrets });
  return cfg;
}

function mask(source) {
  const copy = { ...source };
  if (copy.password) copy.password = '***';
  return copy;
}

/** 打印配置时把 QQ 凭据也挡住（app_secret 等价于密码） */
function maskConfig(cfg) {
  return {
    ...cfg,
    sources: cfg.sources.map(mask),
    qq: { ...cfg.qq, appSecret: cfg.qq?.appSecret ? '***' : '' },
  };
}

function sourceFor(cfg, id) {
  const source = id ? cfg.sources.find((s) => s.id === id || s.name === id) : cfg.sources[0];
  if (!source) throw new Error(`没有匹配的来源：${id}（可选：${cfg.sources.map((s) => s.id).join(', ')}）`);
  return source;
}

const [cmd = 'headers', arg, ...rest] = ARGV;

try {
  const cfg = load();

  if (cmd === 'config') {
    console.log(JSON.stringify(maskConfig(cfg), null, 2));
    process.exit(0);
  }

  if (cmd === 'headers') {
    for (const source of cfg.sources) {
      if (arg && source.id !== arg) continue;
      const limit = cfg.monitor.initialHeaders;
      const listed = await mailSources.providerFor(source.type).listHeaders(source, limit);
      const headers = Array.isArray(listed) ? listed : listed.headers;
      console.log(`\n=== ${source.name}（${source.type}）前 ${headers.length} 条 ===`);
      for (const h of headers) {
        console.log(`${h.unread ? '*' : ' '} ${h.date}  ${h.from}`);
        console.log(`    ${h.subject}`);
        console.log(`    id=${h.id}`);
      }
    }
    process.exit(0);
  }

  if (cmd === 'poll') {
    for (const source of cfg.sources) {
      const stateFile = cfg.storage.stateFile;
      const all = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
      if (!all.sources || typeof all.sources !== 'object') all.sources = {};
      const prev = all.sources[source.id] ?? {};
      const result = await mailSources.providerFor(source.type).poll(source, prev);
      console.log(`\n=== ${source.name}（${source.type}）mode=${result.mode} 新增=${result.headers.length} ===`);
      for (const h of result.headers) console.log(`  ${h.date}  ${h.subject}  (${h.id})`);
      all.sources[source.id] = result.state;
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      // CLI 是 state.json 的**第二个写者**：必须和插件一样原子写，否则补档能把监控刚写的文件截断
      atomicWriteFile(stateFile, JSON.stringify(all, null, 2));
    }
    process.exit(0);
  }

  if (cmd === 'read') {
    const wantId = arg || rest[0];
    let source;
    let header;
    for (const s of cfg.sources) {
      const listed = await mailSources.providerFor(s.type).listHeaders(s, 20);
      const headers = Array.isArray(listed) ? listed : listed.headers;
      const hit = headers.find((h) => h.id === wantId);
      if (hit) {
        source = s;
        header = hit;
        break;
      }
    }
    if (!header) throw new Error(`没找到邮件 ${wantId}`);
    const body = await mailSources.providerFor(source.type).fetchBody(source, header);
    console.log(`来源：${source.name}`);
    console.log(`主题：${body.subject}`);
    console.log(`发件人：${body.from}`);
    console.log(`时间：${body.date}`);
    console.log(`附件：${body.attachments.length ? body.attachments.map((a) => a.name).join('、') : '无'}`);
    console.log('--- 正文 ---');
    console.log(body.text.slice(0, 2000));
    process.exit(0);
  }

  console.error(`未知命令：${cmd}`);
  process.exit(2);
} catch (err) {
  console.error(`ERR=${err instanceof Error ? err.stack || err.message : String(err)}`);
  process.exit(1);
}

