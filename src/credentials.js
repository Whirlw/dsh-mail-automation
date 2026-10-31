/**
 * 凭据解析。
 *
 * 指南（dsh-plugin-guide §3.4 / `docs/subsystems/credentials.md`）规定：
 * 凭据该走 **`ctx.credentials`** 这个官方缝（`resolve(ref)` / `describe(ref)`），
 * 而不是像旧实现那样自己用正则扫 `$DSH_HOME/.credentials.yaml`。原因不是洁癖：
 * - 缝会按 provider 的层次解析（托管存储 > 启动环境 > .env），插件自己扫文件只看到一层；
 * - 缝在每次操作前重新解析，**热更换凭据立即生效**；扫文件必然要在某处缓存。
 * 文件兜底只保留一处（本文件的 `readCredentialFileRefs`），且在缝不可用时才走。
 *
 * **一条硬规则**：只有非空的值才算「解析到」。空值绝不能冒充已配置的密钥
 * （这正是「用户名能推断出来、密码却是空」把 IMAP 打断的那类故障）。
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { resolveDshHome, derivedSourceId } from './config.js';

/**
 * 读 `$DSH_HOME/.credentials.yaml` 的 `refs:` 块（与 dsh-email / qqbot 同一份文件）。
 * 只在 `ctx.credentials` 不可用时作为兜底。
 *
 * S4：这里曾经是自己用正则扫"两空格缩进的 KEY: value"，等于**第二份格式实现**。
 * 宿主一改写法就静默漏读，实测三类：CRLF 换行（`(.*)$` 不跨 `\r`）、小写 ref 名、
 * 带转义引号的密码（`"p@ss\"w"` 会留下反斜杠）。现在用与宿主同一个 YAML 解析器，
 * 只做"取 refs 这一层、只收标量"的收窄；`records:` 等其它段自然被忽略。
 */
export function readCredentialFileRefs(dshHome) {
  const file = path.join(resolveDshHome(dshHome), '.credentials.yaml');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {}; // 文件不存在 / 读不到：都当"没有 refs"
  }
  let parsed;
  try {
    parsed = YAML.parse(text) ?? {};
  } catch {
    return {}; // 坏 YAML 不抛，交给调用方按"未配置"处理
  }
  const refs = parsed?.refs;
  if (!refs || typeof refs !== 'object' || Array.isArray(refs)) return {};
  const out = {};
  for (const [name, value] of Object.entries(refs)) {
    // 空值不算「解析到」——空字符串绝不能冒充已配置的密钥
    if (typeof value === 'string' && value.trim()) out[name] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) out[name] = String(value);
  }
  return out;
}

/**
 * 解析一个凭据引用。
 * @returns {Promise<{value: string, source: string}>} 未配置时 `{ value: '', source: '' }`
 */
export async function resolveSecret(ctx, ref, { logger, dshHome, fileFallback = true } = {}) {
  const name = String(ref ?? '').trim();
  if (!name) return { value: '', source: '' };
  try {
    const provider = ctx?.get?.('credentials');
    const resolved = await provider?.resolve?.(name);
    if (resolved?.value) return { value: String(resolved.value), source: `credentials:${resolved.source ?? 'provider'}` };
  } catch (err) {
    logger?.warn?.(`[mail-automation] 解析凭据 ${name} 失败（改用文件兜底）：${err?.message ?? err}`);
  }
  if (fileFallback) {
    const refs = readCredentialFileRefs(dshHome);
    if (refs[name]) return { value: String(refs[name]), source: 'credentials-file' };
  }
  return { value: '', source: '' };
}

/**
 * 「来自哪个层」的取值约定（`resolveSecret()` 返回的 `source`）：
 *   `credentials:<layer>` —— 官方缝 `ctx.credentials.resolve()` 给的，`<layer>` 是 provider
 *                            自己的层名（本地 provider 用 env / file / project-env / user-env）；
 *   `credentials-file`    —— 本插件自己的兜底解析器，只在缝还没就绪或不可用时出现。
 * 两者差一个分隔符，调用方用下面的前缀判断自己是不是还停在兜底上。
 */
export const CREDENTIAL_FALLBACK_LAYER = 'credentials-file';

/** 这次解析是否走了本插件的文件兜底（说明官方缝没有给出值） */
export function isFallbackLayer(layer) {
  return String(layer ?? '') === CREDENTIAL_FALLBACK_LAYER;
}

/**
 * 同 `resolveSourceSecrets()`，但额外返回每个来源的「来自哪一层」：
 * `{ secrets, layers }`，二者的键一致（sourceId，若有独立 name 则 name 也有）。
 *
 * 为什么要层信息：启动早期 `credentials` 服务可能还没装载完文档，`resolve()` 返回空，
 * 插件会落到自己的文件兜底。值虽然一样，但兜底解析器是**第二份实现**，不该长期顶着用；
 * 调用方据此在后续轮询里再试一次官方缝，成功后层名变成 `credentials:file`，自然停止重试。
 */
export async function resolveSourceSecretsDetailed(ctx, sources, { logger, dshHome } = {}) {
  const secrets = {};
  const layers = {};
  for (const source of sources ?? []) {
    const ref = String(source?.passwordRef ?? '').trim();
    if (!ref) continue;
    const { value, source: layer } = await resolveSecret(ctx, ref, { logger, dshHome });
    if (!value) {
      logger?.warn?.(`[mail-automation] 来源「${source.name || source.id}」的 passwordRef=${ref} 没有解析到值（可用 dsh plugin 的凭据页写入，或改回 password）`);
      continue;
    }
    secrets[source.id] = value;
    layers[source.id] = layer;
    if (source.name && source.name !== source.id) {
      secrets[source.name] = value;
      layers[source.name] = layer;
    }
    const degraded = isFallbackLayer(layer) ? '（文件兜底：凭据服务就绪后会自动改用 ctx.credentials）' : '';
    logger?.info?.(`[mail-automation] 来源「${source.name || source.id}」的密码来自 ${ref}（${layer}）${degraded}`);
  }
  return { secrets, layers };
}

/**
 * 把每个来源声明的 `password_ref` 解析成实际密码，得到 `{ [sourceId | sourceName]: password }`。
 * 只记「来自哪一层」，绝不把值写进日志。
 */
export async function resolveSourceSecrets(ctx, sources, options = {}) {
  const { secrets } = await resolveSourceSecretsDetailed(ctx, sources, options);
  return secrets;
}

/**
 * 同步版：把来源声明里的 `password_ref` 按给定 refs 表解析成 `{ [sourceId|name]: password }`。
 * CLI / 补档脚本没有 ctx，用这个（插件运行时走 `resolveSourceSecrets()`）。
 */
export function resolveSecretsFromRefs(sourcesRaw, refs) {
  const out = {};
  const list = Array.isArray(sourcesRaw) ? sourcesRaw : [];
  list.forEach((raw, index) => {
    const ref = String(raw?.password_ref ?? raw?.passwordRef ?? '').trim();
    if (!ref) return;
    const value = refs?.[ref];
    if (!value) return;
    const type = String(raw?.type || 'imap').toLowerCase();
    // 必须与 config.js 用**同一条**缺省 id 规则，否则 CLI/补档脚本会在另一个键下找密码
    const id = String(raw?.id || derivedSourceId(type, raw, resolveDshHome()));
    out[id] = String(value);
    if (raw?.name) out[String(raw.name)] = String(value);
    void index;
  });
  return out;
}
