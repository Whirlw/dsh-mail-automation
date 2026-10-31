/**
 * 原子写小工具（C8 / C10）。
 *
 * 为什么需要：`meta.json` / `conclusion.md` / `state.json` / Graph 令牌文件都是
 * **原地截断写**（`writeFileSync`）。写到一半断电、被杀、磁盘满，就会留下半截文件：
 *   - `meta.json` 半截 → `readMeta()` 返回 null → 这封邮件对 `listArchived` / `adoptOrphans`
 *     永久隐形；
 *   - `conclusion.md` 半截 → 失败前缀匹配不到 → 被判成"已处理"，agent 永不重跑；
 *   - Graph 令牌半截 → `JSON.parse` 失败，整个来源挂掉（而 refresh_token 可能已被轮换）。
 *
 * 做法：**同目录**写临时文件 → `rename` 覆盖。
 *   - 同目录保证同一个卷，rename 才是原子的（跨卷会退化成 copy）；
 *   - 只保证"不撕裂"（读者看到旧文件或新文件），**不保证掉电后内容已落盘**；
 *   - Node 在 Windows 上用 `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`，是覆盖语义；
 *   - 目标被杀软 / 预览 / 索引器占用时 rename 会 `EPERM/EBUSY/EACCES`：**有界重试后上抛**，
 *     绝不退回 copy —— copy 到目标就是我们要消灭的那种截断写。
 */
import fs from 'node:fs';
import path from 'node:path';

let sequence = 0;

/** 同步小睡（rename 失败重试用）；Atomics.wait 不占 CPU */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // 环境不支持就算了，直接重试
  }
}

/**
 * @param {string} file 目标文件
 * @param {string|Buffer} data 内容
 * @param {{encoding?: string, mode?: number, retries?: number, io?: typeof fs}} [options]
 * @returns {boolean} 成功为 true（失败会抛）
 */
export function atomicWriteFile(file, data, { encoding = 'utf8', mode, retries = 3, io = fs } = {}) {
  const dir = path.dirname(file);
  io.mkdirSync(dir, { recursive: true });
  // 唯一后缀：attachPreview 与写结论可能并发，固定名字会互相踩（A rename 发了 B 的字节）
  const tmp = path.join(dir, `.${path.basename(file)}.tmp.${process.pid}.${(sequence += 1)}`);
  try {
    io.writeFileSync(tmp, data, mode === undefined ? { encoding } : { encoding, mode });
    for (let attempt = 0; ; attempt += 1) {
      try {
        io.renameSync(tmp, file);
        return true;
      } catch (err) {
        const code = err?.code;
        if (attempt < retries && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
          sleepSync(20 + attempt * 30);
          continue;
        }
        throw err;
      }
    }
  } finally {
    // rename 成功后这里是无害的 ENOENT；失败时把 tmp 清掉，别留在邮件目录里
    try {
      io.rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
  }
}
