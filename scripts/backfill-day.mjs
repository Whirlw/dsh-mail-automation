#!/usr/bin/env node
/**
 * 补写某一天的邮件存档（从邮箱重新拉取），用于修复「存档丢了但邮件还在」的日期。
 *
 * 用法：
 *   node scripts/backfill-day.mjs 2026-10-21            # 两个来源都补
 *   node scripts/backfill-day.mjs 2026-10-21 school     # 只补某个来源
 *
 * 只写存档，不跑 agent：补完后让 agent 用 archive_list/archive_read 读取并处理。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { normalizeConfig, expandPath, DEFAULT_CONFIG_FILE } from '../src/config.js';
import { readCredentialFileRefs, resolveSecretsFromRefs } from '../src/credentials.js';
import { Store } from '../src/store.js';
import * as mailSources from '../src/sources/index.js';

const PLUGIN_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
/** 配置文件：MAIL_AUTOMATION_CONFIG > $DSH_HOME/mail-automation/ > 插件目录旁的 ../mail-automation/ */
function pickConfigFile() {
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
const [day, only] = process.argv.slice(2);

if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '')) {
  console.error('用法：node scripts/backfill-day.mjs <YYYY-MM-DD> [sourceId]');
  process.exit(2);
}

const raw = YAML.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
const cfg = normalizeConfig(raw, {
  configFile: CONFIG_FILE,
  secrets: resolveSecretsFromRefs(raw.sources, readCredentialFileRefs()),
});
const store = new Store(cfg, { warn: (m) => console.warn(m), info: (m) => console.log(m) });

const sameLocalDay = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return local === day;
};

let written = 0;
for (const source of cfg.sources) {
  if (only && source.id !== only) continue;
  try {
    const listed = await mailSources.providerFor(source.type).listHeaders(source, 50);
    const headers = (Array.isArray(listed) ? listed : listed.headers ?? []).filter((h) => sameLocalDay(h.date));
    console.log(`\n=== ${source.name}：${day} 命中 ${headers.length} 封 ===`);
    for (const header of headers) {
      try {
        const body = await fetch(source, header);
        const mail = { sourceId: source.id, sourceName: source.name, header, body };
        const file = store.writeMail(mail);
        console.log(`  ✓ ${body.subject || header.subject} → ${path.basename(file)}`);
        written += 1;
      } catch (err) {
        console.warn(`  ✗ ${header.subject}：${err?.message ?? err}`);
      }
    }
  } catch (err) {
    console.warn(`${source.name} 拉取失败：${err?.message ?? err}`);
  }
}

store.save();
console.log(`\n完成：补写 ${written} 封到 ${cfg.storage.archiveDir}（一封一个目录，平铺）`);

// imap.js / pop3.js 为了插件轮询保留长连接；脚本必须显式关掉，否则 Node 会一直等 socket 不退出
mailSources.closeAll();
process.exit(0);

async function fetch(source, header) {
  return mailSources.providerFor(source.type).fetchBody(source, header);
}
