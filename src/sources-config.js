/**
 * 「邮箱来源」的增删改（写 YAML 覆盖层，不碰 profile 的 cordis.patch.yml）。
 *
 * 为什么允许 UI 改来源：
 *   用户要能"自由添加/删除多个邮箱"，而手改 YAML 的代价是缩进/字段名/凭据引用三处都容易错，
 *   错一次就断轮询。这里把「表单 → snake_case → 整表校验 → 原子写」收口到一处。
 *
 * 安全边界：
 *   - **只改覆盖层**。来源如果写在 `cordis.patch.yml`（profile 层），设置页显示为只读，
 *     删除会明确拒绝并告诉用户去哪改 —— 不写一个"看起来生效、其实被 base 盖住"的假 override。
 *   - 写前用与启动完全相同的 `normalizeConfig(mergeConfig(base, overlay))` 校验整表；
 *     不通过就整份不写（含 id 重复、缺必填字段、未知 type）。
 *   - 密码/客户端 secret 优先写凭据缝（`ctx.credentials.set`）；没有缝且用户没给 ref 时
 *     才退回 YAML 明文，并在返回值里 warnings 明说 —— 不静默把密钥写进配置文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { canonicalizeConfig, canonicalizeSource, composeConfig, derivedSourceId, normalizeConfig } from './config.js';
import { atomicWriteFile } from './fsutil.js';

/** 允许写进 YAML 的来源键（其余字段一律丢弃：表单不能顺手改配置结构）——见 sanitizeSource */

function readText(configFile) {
  try {
    return fs.readFileSync(configFile, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return '';
    throw new Error(`读取 ${configFile} 失败：${err?.message ?? err}`);
  }
}

/** 覆盖层里声明的来源（原始 snake_case 形状）；读不到/坏 YAML 一律返回空数组 */
export function readOverlaySources(configFile) {
  try {
    const parsed = YAML.parse(readText(configFile)) ?? {};
    return Array.isArray(parsed?.sources) ? parsed.sources.filter((item) => item && typeof item === 'object') : [];
  } catch {
    return [];
  }
}

/** 覆盖层里一个原始来源的规范化 id（与 config.js 的缺省 id 规则同一份实现） */
export function sourceIdOfRaw(raw, dshHome) {
  const explicit = String(raw?.id ?? '').trim();
  if (explicit) return explicit;
  const type = String(raw?.type ?? 'imap').toLowerCase();
  return derivedSourceId(type, canonicalizeSource(raw), dshHome);
}

/** 覆盖层里的来源 id 列表（设置页据此判断"可编辑/只读"） */
export function overlaySourceIds(configFile, dshHome) {
  return readOverlaySources(configFile).map((raw) => sourceIdOfRaw(raw, dshHome));
}

/** 把候选文本写盘前做整表校验（与启动同一条路径） */
function validate({ text, base, dshHome, configFile, secrets }) {
  const parsed = YAML.parse(text) ?? {};
  // 与 loadConfig 共用 composeConfig：base 的 sources 按 id 合并，而不是被覆盖层整表顶掉
  const merged = composeConfig(base ?? {}, canonicalizeConfig(parsed), { dshHome });
  return normalizeConfig(merged, { dshHome, configFile, secrets });
}

/** 保留原文件权限（配置里可能存着 secret，原子写 rename 会丢 mode） */
function modeOf(file) {
  try {
    return fs.statSync(file).mode & 0o777;
  } catch {
    return undefined;
  }
}

function writeText(configFile, text) {
  const mode = modeOf(configFile);
  // 新建文件默认 0600：YAML 里可能存明文密码；已有文件保留原 mode（原子写 rename 会丢权限）
  atomicWriteFile(configFile, text, mode === undefined ? { mode: 0o600 } : { mode });
}

/**
 * 写路径的严格解析：语法坏掉就**拒绝写入**。
 *
 * `readOverlaySources()` 对坏 YAML 返回空数组（只读快照可以容忍），但写路径不能：那会把用户
 * 手写的半坏文件按"空 sources"重写，可能连带丢掉其它段。写前必须先确认整份文件可解析。
 */
function overlayForWrite(text, configFile) {
  let parsed;
  try {
    parsed = YAML.parse(text) ?? {};
  } catch (err) {
    throw new Error(`覆盖层 YAML 解析失败（${configFile}）：${err?.message ?? err}；为避免破坏文件，已拒绝写入`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`覆盖层不是 YAML 映射（${configFile}）：已拒绝写入`);
  }
  return Array.isArray(parsed.sources) ? parsed.sources.filter((item) => item && typeof item === 'object') : [];
}

/** 把 sources 数组写回覆盖层（保留其它段与注释、BOM 与原换行符；sources 段自身的注释会被重排） */
export function setYamlSources(text, sources) {
  const input = String(text ?? '');
  const bom = input.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = bom ? input.slice(1) : input;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const doc = YAML.parseDocument(body);
  if (Array.isArray(doc.errors) && doc.errors.length > 0) {
    throw new Error(`覆盖层 YAML 有语法错误：${doc.errors[0]?.message ?? '未知错误'}`);
  }
  doc.set('sources', sources);
  const rendered = doc.toString({ lineWidth: 0 }).replace(/\r\n/g, '\n');
  return bom + (eol === '\r\n' ? rendered.replace(/\n/g, '\r\n') : rendered);
}

/** 凭据回滚：恢复旧值；没有旧值时 unset（都尽力而为，失败不抛） */
async function rollbackCredentials(credentials, entries) {
  let ok = true;
  for (const entry of [...entries].reverse()) {
    try {
      if (entry.before?.value) await credentials?.set?.(entry.ref, entry.before.value);
      else await credentials?.unset?.(entry.ref);
    } catch {
      ok = false;
    }
  }
  return ok;
}

/** 空引用名时的默认凭据 ref（按服务商/域名推断） */
function defaultPasswordRef(type, raw) {
  if (type !== 'imap' && type !== 'pop3') return '';
  const provider = String(raw?.provider ?? '').trim().toLowerCase();
  const user = String(raw?.user ?? '').trim().toLowerCase();
  if (provider === 'qq' || provider === 'foxmail' || /@(qq|foxmail)\.com$/.test(user)) return 'QQ_MAIL_PASSWORD';
  if (provider === 'gmail' || /@gmail\.com$/.test(user)) return 'GMAIL_PASSWORD';
  if (provider === '163' || /@163\.com$/.test(user)) return 'MAIL_163_PASSWORD';
  if (provider === '126' || /@126\.com$/.test(user)) return 'MAIL_126_PASSWORD';
  if (provider === 'outlook' || /@(outlook|hotmail|live)\.com$/.test(user)) return 'OUTLOOK_PASSWORD';
  if (provider === 'icloud' || /@(icloud|me)\.com$/.test(user)) return 'ICLOUD_PASSWORD';
  return 'MAIL_PASSWORD';
}

/** 只把认识的键写进 YAML（统一 snake_case）；空字符串代表"删掉这个键" */
function sanitizeSource(raw) {
  const read = (snake, camel) => (raw?.[snake] !== undefined ? raw[snake] : raw?.[camel]);
  const out = {};
  const put = (key, value) => {
    if (value === undefined || value === null) return;
    if (typeof value === 'string' && value.trim() === '') return;
    out[key] = value;
  };
  put('id', read('id', 'id'));
  put('name', read('name', 'name'));
  put('type', read('type', 'type'));
  put('host', read('host', 'host'));
  put('port', read('port', 'port'));
  put('secure', read('secure', 'secure'));
  put('user', read('user', 'user'));
  put('password', read('password', 'password'));
  put('password_ref', read('password_ref', 'passwordRef'));
  put('mailbox', read('mailbox', 'mailbox'));
  put('provider', read('provider', 'provider'));
  put('token_file', read('token_file', 'tokenFile'));
  put('folder', read('folder', 'folder'));
  put('top', read('top', 'top'));
  put('client_id', read('client_id', 'clientId'));
  put('client_secret', read('client_secret', 'clientSecret'));
  put('client_secret_ref', read('client_secret_ref', 'clientSecretRef'));
  put('tenant', read('tenant', 'tenant'));
  return out;
}

/**
 * 新增或更新一个来源。
 *
 * @param {{
 *   configFile: string, base: object, dshHome: string, secrets?: object,
 *   source: object, secret?: string, clientSecret?: string,
 *   previousId?: string, credentials?: { set?: (ref: string, value: string) => Promise<void> },
 *   logger?: object,
 * }} input
 * @returns {Promise<{ok:boolean, id?:string, written?:string[], created?:boolean, identityChanged?:boolean, warnings?:string[], error?:string}>}
 */
export async function upsertSource({
  configFile,
  base,
  dshHome,
  secrets = {},
  source,
  secret = '',
  clientSecret = '',
  previousId = '',
  credentials,
  logger,
} = {}) {
  if (!configFile) return { ok: false, error: '没有可写的 configFile（当前只用 cordis.yml 配置）：无法在界面里改来源' };
  const raw = canonicalizeSource({ ...source });
  const type = String(raw.type ?? 'imap').toLowerCase();
  if (!['imap', 'pop3', 'oauth2', 'gmail', 'graph'].includes(type)) {
    return { ok: false, error: `不认识的邮箱类型：${type}（只支持 imap / pop3 / oauth2 / gmail / graph）` };
  }
  const wantedId = String(raw.id ?? '').trim() || derivedSourceId(type, raw, dshHome);
  raw.id = wantedId;
  const warnings = [];

  // ── 凭据路由：先决定"写到哪"，真正的凭据写入放到整表校验通过之后（避免"凭据改了、配置没写成"）──
  const wantsRef = raw.credential_mode === 'ref' || raw.credentialMode === 'ref';
  let passwordRef = String(raw.password_ref ?? raw.passwordRef ?? '').trim();
  if (!passwordRef && wantsRef) passwordRef = defaultPasswordRef(type, raw);
  if (passwordRef) raw.password_ref = passwordRef;
  delete raw.credential_mode;
  delete raw.credentialMode;
  const passwordValue = String(secret || raw.password || '').trim();
  const passwordToSeam = Boolean(passwordValue && passwordRef);
  if (passwordToSeam && typeof credentials?.set !== 'function') {
    return {
      ok: false,
      error:
        `这版宿主没有可写的凭据服务，无法把密码写进 ${passwordRef}。` +
        '请到 DSH 凭据页手动写入，或清空「密码引用名」让密码以明文写入 YAML。',
    };
  }
  if (passwordValue) {
    if (passwordToSeam) delete raw.password;
    else {
      raw.password = passwordValue;
      warnings.push('没有填写「密码引用名」：密码以明文写进了 mail-automation.yaml（建议改到凭据页）');
    }
  }

  const clientSecretRef = String(raw.client_secret_ref ?? raw.clientSecretRef ?? '').trim();
  const clientSecretValue = String(clientSecret || raw.client_secret || raw.clientSecret || '').trim();
  const clientSecretToSeam = Boolean(clientSecretValue && clientSecretRef);
  if (clientSecretValue && type !== 'gmail') {
    /*
     * Graph 走公共客户端 device code，不需要 client_secret；早期实现会把它静默写进 YAML 却永不使用。
     * 这里显式丢弃并告警，避免"配了 secret 以为生效"。
     */
    delete raw.client_secret;
    delete raw.clientSecret;
    delete raw.client_secret_ref;
    delete raw.clientSecretRef;
    warnings.push('Graph 用公共客户端 device code，client_secret 不参与认证：已忽略该值');
  } else if (clientSecretValue) {
    if (clientSecretToSeam && typeof credentials?.set !== 'function') {
      return {
        ok: false,
        error:
          `这版宿主没有可写的凭据服务，无法把客户端 secret 写进 ${clientSecretRef}。` +
          '请到 DSH 凭据页手动写入，或清空「secret 的凭据引用名」让 secret 以明文写入 YAML。',
      };
    }
    if (clientSecretToSeam) {
      delete raw.client_secret;
      delete raw.clientSecret;
    } else {
      raw.client_secret = clientSecretValue;
      warnings.push('没有填写「客户端 secret 引用名」：secret 以明文写进了 mail-automation.yaml（建议改到凭据页）');
    }
  }

  const text = readText(configFile);
  let list;
  try {
    list = overlayForWrite(text, configFile);
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
  // 改了 id = 新邮箱：把旧 id 那条删掉，避免同一次保存留下两条定义
  const previousKey = String(previousId ?? '').trim();
  const previousRaw = list.find((item) => sourceIdOfRaw(item, dshHome) === (previousKey || wantedId));
  if (previousKey && previousKey !== wantedId) {
    if (list.some((item) => sourceIdOfRaw(item, dshHome) === wantedId)) {
      return { ok: false, error: `来源 id「${wantedId}」已存在，不能覆盖另一个邮箱` };
    }
    list = list.filter((item) => sourceIdOfRaw(item, dshHome) !== previousKey);
  }
  const index = list.findIndex((item) => sourceIdOfRaw(item, dshHome) === wantedId);
  const created = index < 0;
  const next = sanitizeSource(raw);
  let identityChanged = false;
  if (previousRaw) {
    /*
     * 编辑时"密码留空 = 不改"：快照里故意不下发密码，所以表单回传空值时不能把原来的
     * 明文 password / client_secret 抹掉（那等于静默丢凭据）。只有用户显式改成引用名
     * 或填了新值时才替换。
     */
    const previous = sanitizeSource(previousRaw);
    // 密码/secret 留空 = 不改（包括原来用的是凭据引用的情况，不能把 ref 当成空丢掉）
    if (!next.password && !next.password_ref) {
      if (previous.password_ref) next.password_ref = previous.password_ref;
      else if (previous.password) next.password = previous.password;
    }
    if (!next.client_secret && !next.client_secret_ref) {
      if (previous.client_secret_ref) next.client_secret_ref = previous.client_secret_ref;
      else if (previous.client_secret) next.client_secret = previous.client_secret;
    }
    const previousType = String(previous.type ?? type).toLowerCase();
    const mailboxOf = (item, itemType) => {
      if (itemType === 'pop3') return '';
      if (itemType === 'graph') return String(item.folder ?? 'inbox').trim();
      return String(item.mailbox ?? item.folder ?? 'INBOX').trim();
    };
    identityChanged =
      previousType !== type || mailboxOf(previous, previousType) !== mailboxOf(next, type);
  }
  if (index >= 0) list[index] = next;
  else list.push(next);

  let nextText;
  try {
    nextText = setYamlSources(text, list);
  } catch (err) {
    return { ok: false, error: `改写 YAML 失败：${err?.message ?? err}` };
  }
  try {
    validate({ text: nextText, base, dshHome, configFile, secrets });
  } catch (err) {
    return { ok: false, error: `来源没通过整表校验，已放弃写入：${err?.message ?? err}` };
  }
  /*
   * 凭据写入放在整表校验**之后**：校验失败、YAML 写失败都不该先改凭据
   * （早期实现先 set 再校验，漏填 host 也会把别的来源正在用的 ref 改掉）。
   * 写入失败时尽力回滚到旧值；回滚不了就在错误里如实说明。
   */
  const rollback = [];
  try {
    if (passwordToSeam) {
      const before = await credentials.resolve?.(passwordRef).catch(() => undefined);
      await credentials.set(passwordRef, passwordValue);
      rollback.push({ ref: passwordRef, before });
    }
    if (clientSecretToSeam && clientSecretValue && type === 'gmail') {
      const before = await credentials.resolve?.(clientSecretRef).catch(() => undefined);
      await credentials.set(clientSecretRef, clientSecretValue);
      rollback.push({ ref: clientSecretRef, before });
    }
  } catch (err) {
    await rollbackCredentials(credentials, rollback);
    return { ok: false, error: `写入凭据失败：${err?.message ?? err}；YAML 未改动` };
  }
  try {
    writeText(configFile, nextText);
  } catch (err) {
    const restored = await rollbackCredentials(credentials, rollback);
    return {
      ok: false,
      error:
        `写入 ${configFile} 失败：${err?.message ?? err}` +
        (rollback.length > 0 ? (restored ? '（凭据已回滚）' : '（凭据可能已更新，请到凭据页核对）') : ''),
    };
  }
  logger?.info?.(
    `[mail-automation] ${created ? '新增' : '更新'}邮箱来源 ${wantedId}（${type}）` +
      (warnings.length > 0 ? `；注意：${warnings.join('；')}` : ''),
  );
  return { ok: true, id: wantedId, created, identityChanged, written: [configFile], warnings };
}

/**
 * 删除一个来源（只删覆盖层里的定义；游标与存档由调用方决定）。
 * 来源定义在 cordis.patch.yml 时**拒绝**：那里删不掉，写一个同 id 的覆盖项只会更迷惑。
 */
export function removeSource({ configFile, base, dshHome, id, secrets = {}, logger } = {}) {
  if (!configFile) return { ok: false, error: '没有可写的 configFile（当前只用 cordis.yml 配置）' };
  const wanted = String(id ?? '').trim();
  if (!wanted) return { ok: false, error: '缺少要删除的来源 id' };
  const text = readText(configFile);
  let list;
  try {
    list = overlayForWrite(text, configFile);
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
  const index = list.findIndex((item) => sourceIdOfRaw(item, dshHome) === wanted);
  if (index < 0) {
    return {
      ok: false,
      error: `覆盖层里没有来源「${wanted}」：它可能定义在 cordis.patch.yml（profile 配置）里，请到那里删除`,
    };
  }
  const nextList = list.slice();
  nextList.splice(index, 1);
  let nextText;
  try {
    nextText = setYamlSources(text, nextList);
  } catch (err) {
    return { ok: false, error: `改写 YAML 失败：${err?.message ?? err}` };
  }
  try {
    validate({ text: nextText, base, dshHome, configFile, secrets });
  } catch (err) {
    const message = String(err?.message ?? err);
    if (/没有 sources/.test(message)) {
      return {
        ok: false,
        error:
          '删除后会一个来源都不剩：插件至少要保留一个邮箱。' +
          '（base 里还有来源时不会走到这里；要彻底清空请直接删掉 configFile 或改 YAML）',
      };
    }
    return { ok: false, error: `删除后配置不合法，已放弃写入：${message}` };
  }
  try {
    writeText(configFile, nextText);
  } catch (err) {
    return { ok: false, error: `写入 ${configFile} 失败：${err?.message ?? err}` };
  }
  logger?.info?.(`[mail-automation] 已删除邮箱来源 ${wanted}（存档与游标由调用方处理）`);
  return { ok: true, id: wanted, written: [configFile] };
}

/** 表单里"来源身份"给 UI 看的一行（host/user/folder，不含密码） */
export function sourceDetail(source) {
  const type = String(source?.type ?? 'imap');
  if (type === 'graph') {
    const token = path.basename(String(source.tokenFile ?? '')) || '默认令牌文件';
    return `文件夹 ${source.folder || 'inbox'} · 令牌 ${token}`;
  }
  if (type === 'gmail') return `标签 ${source.folder || 'INBOX'} · ${source.user || '(未填账号)'}`;
  if (type === 'pop3') return `${source.user || '(未填账号)'} @ ${source.host}:${source.port}`;
  if (type === 'oauth2') {
    return `${source.user || '(未填账号)'} @ ${source.host}:${source.port} · ${source.mailbox || 'INBOX'} · 租户 ${source.tenant || 'common'}`;
  }
  return `${source.user || '(未填账号)'} @ ${source.host}:${source.port} · ${source.mailbox || 'INBOX'}`;
}
