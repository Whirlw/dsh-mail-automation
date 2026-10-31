# 多邮箱来源：设计与避坑（IMAP / POP3 / OAuth2（IMAP）/ Gmail API / Microsoft Graph）

> 目标：支持"自由添加任意多个邮箱"，协议覆盖 IMAP、POP3、OAuth2（IMAP + XOAUTH2）、Gmail API、Microsoft Graph。
> 本文给**维护者**：架构现状、要遵守的契约与每种协议的坑。
> 配套阅读：[architecture.md §5](architecture.md)（一封邮件的一生）、[configuration.md §3.3](configuration.md)（sources 字段）、
> [lessons.md](lessons.md)（运行时语义）。

## 1. 现状（五种协议已全部实现）

| 模块 | 类型 | 列表 | 增量 | 拉正文 | 游标 |
|---|---|---|---|---|---|
| `src/sources/imap.js` | IMAP | `listHeaders(source, limit)` | `poll(source, prevState)`：STATUS 取 `UIDVALIDITY/UIDNEXT` + `UID SEARCH` | `fetchBody` | `{ uidValidity, uidNext }` |
| `src/sources/pop3.js` | POP3 | 同上 | `poll`：`UIDL` 全量列表，未见过的 UIDL 才算新 | `fetchBody`：`RETR` → mailparser | `{ initialized, seenIds }` |
| `src/sources/oauth2.js` | OAuth2（IMAP） | 复用 `imap.js`；`oauth2.js` 只负责设备码登录、令牌文件、刷新 | 同 IMAP（XOAUTH2 认证） | 同 IMAP | 同 IMAP（`uidValidity/uidNext`） |
| `src/sources/gmail.js` | Gmail | 同上 | `poll`：`users.history.list`（historyId），404 回落 `messages.list` 重建基线 | `fetchBody`：`format=raw` → base64url → mailparser | `{ initialized, historyId, seenIds, email }` |
| `src/sources/graph.js` | Graph | 同上 | `poll`：分页扫最近 ≤300 封 + 位置判据 | `fetchBody` | `{ initialized, seenIds }` |

调用方只有 `src/index.js` 的三处：`pollSource()`、基线里的 `listHeaders()`、`processArchived()` 的 `fetchBody()`；
另有 `scripts/backfill-day.mjs` 与 `src/cli.js` 也经 `src/sources/index.js` 的 `providerFor(type)` 分发（**不要**再写
`type === 'graph' ? … : …` 的三元判断，回归测试会拦）。

已存在、必须保留的语义（都有回归测试）：

- **`poll()` 返回** `{ mode, headers, lost, state }`，`mode ∈ { idle, new, baseline }`；`lost` 是本轮没能交付的邮件（调用方据此**不推进游标**）。
- **基线**：首次 / `UIDVALIDITY` 变化 / 游标越过服务端最新 / Gmail `historyId` 404 → 重建基线，**不归档历史邮件**。
- **交付后才提交游标**：`index.js` 的 `shouldAdvanceCursor()` 决定要不要写 `state`；写失败/被卸载打断就不写。
- **id 必须唯一且稳定**：`sources[].id` 是游标键 + 归档目录前缀；重复 id 在 `normalizeConfig` 里加载期报错。
- **`header.id` 用于去重与 `retries` 键**：IMAP=`imap:sourceId:uid`、POP3=`pop3:sourceId:uidl`、Gmail=`gmail:sourceId:messageId`、Graph=`graph:sourceId:id`——同一封邮件多次 poll 必须得到同一个 id。
- **`emptyState()` / `describeCursor()` / `verify()`**：新协议必须实现，设置页与 `mail_automation_status` 只看这三个。

## 2. provider 接口（已落地）

```js
// src/sources/<type>.js 必须导出
export async function listHeaders(source, limit)            // → Header[]（最新在前）
export async function poll(source, prevState, opts?)        // → { mode, headers, warnings?, state }
export async function fetchBody(source, header)             // → { raw, rawKind, text, html, subject, from, to, date, attachments, webLink? }
export function emptyState()                                // → 该协议的初始游标
export function describeCursor(state)                       // → 给设置页/工具看的一行人类可读文本
export async function verify(source)                        // → { ok, detail }（设置页「测试连接」）
```

`Header` 形状沿用现在的：`{ id, uid?, uidValidity?, uidl?, gmailId?, graphId?, subject, from, to, date, unread, webLink? }`。
`poll()` 里的 `prevState` 是**该来源自己的游标对象**（存进 domain 的 `sources` 表，键 = source.id），
`emptyState()` 让新协议不必改 `state-domain.js` 的字段定义——但**新增字段必须同步改
`STATE_RECORD_SCHEMAS.sources.parse()`**（现在含 `uidValidity/uidNext/initialized/seenIds/historyId/email`），否则重启即丢。<!-- -->

## 3. 四种协议的关键差异与坑

### 3.1 IMAP（已有，作为基准）

- 游标是**服务端状态**（UIDVALIDITY + UIDNEXT），最可靠；不再沿用旧 key 的游标。
- `STATUS` 可能抽风（返回 0/1）→ 已有 `imapStatusSane()` 守卫；`SEARCH` 失败**必须抛**（不能吞成 idle）。
- 登录风控：保持长连接（`entries` Map），不要每轮新建 TLS；`pruneSources()` 回收改 id 后的旧连接。
- 多来源天然支持：每条目一张连接，`withSource()` 串行化同一来源上的操作。

### 3.2 POP3（已实现：`src/sources/pop3.js` + 手写 `pop3client.js`）

- **没有 UIDVALIDITY/UIDNEXT**：用 `UIDL`（每封邮件的唯一 ID，服务端持久）。会话级 `LIST` 的序号**不稳定**，绝不能当 id。
- POP3 的典型行为是"下载后删除/保留 N 天"：**如果用户同时在手机/网页端收信，邮件可能在你 poll 之前消失**。
  → 游标语义要改成"已见过的 UIDL 集合"（像 Graph 的 `seenIds`），并接受"服务器上已经没了"的邮件**永久错过**；
  文档里要对用户明确这一点（这是协议限制，不是 bug）。
- 没有"未读"概念（除非 `TOP`+`RETR` 自己解析）→ `unread` 恒 false，或干脆不显示未读。
- 没有增量检索：`UIDL` 拿全量列表（大邮箱几千封）→ 必须设上限（例如先取最近 N 个 UIDL 建立基线），
  否则首轮会拉几千条。基线策略与 Graph 一致：**首次只记 seen，不归档**。
- 连接复用/超时：POP3 会话有 `+OK` 状态机，用成熟库（如 `poplib`）而不是手写；`TOP n 0` 取头部省流量。
- 多来源：每个来源独立连接 + 串行，和 IMAP 一样。

### 3.3 Gmail API（已实现：`src/sources/gmail.js` + `oauth.js`）

- 官方推荐增量是 **`users.history.list`（historyId）**，但它**会过期**（一般几天到几周，取决于服务端）；
  过期会返回 404 `historyId is too old` → 必须**回落到 `messages.list` 全量/时间窗**并重建基线（这正是 Graph `seenIds` 窗口不匹配踩过的坑）。
- 推荐游标：`{ historyId, seenIds[] }`，两个一起用：historyId 拿增量，seenIds 兜底去重与"回退后不重放"。
- 认证：OAuth2（用户授权），需要 `gmail.readonly`；refresh_token 存哪里是**新问题**——
  不要自己发明凭据文件格式，优先复用 `ctx.credentials`（把 refresh_token 当 secret）或沿用 `dsh-graph-mail` 那种"令牌文件 + 文件锁"模式；
  **绝不要把 access token 写进 YAML**。
- 限流：`429` 带 `Retry-After`；`users.messages.get` 每封一次调用，`format=full` 比 `raw` 便宜但丢原始报文；
  若要 `raw.eml` 就 `format=raw`（base64url 解码后落盘，和 IMAP 的 `raw` 等价）。当前实现用 `format=metadata`
  取列表（只取需要的 header），`fetchBody` 才用 `format=raw`。
- 附件：`parts[].body.attachmentId` 要单独取；`mail_automation_archive_read` 目前只列附件元数据，不下载，保持一致。
- 标签/线程：一封"邮件"在 Gmail 里可能有多条消息（同 thread）→ id 用 **message id**，不要用 threadId。
- **元数据必须整批成功**：`poll` 里只要有任意一封 `messages.get` 失败就抛（调用方不提交 `historyId`）。
  若"跳过失败的那封、仍推进 historyId"，那封会被永久越过——这是"宁可重复，不丢信"的落点。
- **积压按完整记录推进**：分页或单轮 50 封上限触发时，只提交完整交付的 history 记录 id。
  单条记录未完成且游标未推进时保留全部去重项，完成后恢复通常上限；不能靠固定 400 项集合无限重查同一批分页。

### 3.4 Microsoft Graph（已有）

- 现在用"位置判据 + seenIds"是因为 delta token 会过期且窗口不匹配会**批量重放历史**（2026-10-29 事故）。
  如果改成 delta：`@odata.deltaLink` 存起来，同样要处理 410 gone → 重建基线。
- 令牌文件被 `dsh-graph-mail` 与本插件**同时刷新**过 → 必须走 `proper-lockfile`（已有），且写回要原子（已有）。
- `top` 只影响扫描窗口，不改变"位置判据"。

### 3.5 OAuth2（IMAP + XOAUTH2，已实现：`src/sources/oauth2.js`）

面向 **Microsoft 365 / Outlook**：Exchange Online 已停用 IMAP 基本认证，只能用 OAuth2 access token。

- 认证：IMAP 的 `AUTH XOAUTH2`（imapflow 的 `auth: { user, accessToken }`），**邮件仍走 IMAP**；与 Graph 来源不同
  （Graph 走 `graph.microsoft.com` REST）。
- 登录：设备码（device code）。scope 只申请 `offline_access` +
  `https://outlook.office.com/IMAP.AccessAsUser.All`（只读，不发信）。Azure 应用需允许**公共客户端流**。
- 令牌：每个来源一个文件 `$DSH_HOME/mail-automation/oauth2/<id>.json`（0600、原子写），保存
  `refresh_token / access_token / expires_at / client_id / tenant / user`；`getFreshAccessToken()` 在剩余寿命
  < 2 分钟时才刷新，并对同一账号**单飞**（refresh_token 会轮换，并发刷新会把彼此写旧）。
- 未登录（没有令牌文件）时 `poll/listHeaders/verify` 都按"未绑定"处理：轮询**静默跳过**、不推进游标，
  设置页显示「未绑定」并给「登录」按钮；登录完成后下一拍自动建基线。
- 与 IMAP 共用连接池、游标语义（`uidValidity/uidNext`）与 `state-domain` 白名单。

## 4. 配置方向（建议）

```yaml
sources:
  - id: work-imap          # 必须唯一、稳定；改 id = 新邮箱（旧游标不再复用）
    name: 工作邮箱
    type: imap
    host: imap.example.com
    user: me@example.com
    password_ref: WORK_PASSWORD
  - id: personal-pop3
    name: 老邮箱
    type: pop3
    host: pop3.example.com
    user: me@example.com
    password_ref: OLD_PASSWORD
  - id: gmail-main
    name: Gmail
    type: gmail
    user: me@gmail.com
    client_id: <oauth desktop-app client id>
    client_secret_ref: GMAIL_CLIENT_SECRET
    # token_file 默认 $DSH_HOME/mail-automation/tokens/gmail-<slug(id)>.json（0600，原子写）
  - id: school
    name: 学校
    type: graph
    client_id: <azure public client id>
    tenant: common
    token_file: $DSH_HOME/mail-automation/tokens/graph-<id>.json
```

要点：

- **`id` 缺省由身份派生**（现有 `derivedSourceId()`）：IMAP=`imap-<user>-<mailbox>`、POP3=`pop3-<user>`、OAuth2=`oauth2-<user>`、
  Gmail=`gmail-<user>`、Graph=`graph-<clientId>`（显式 `token_file` 时用 `graph-<令牌文件基名>`），**绝不要用数组下标**（B-N2：插一个来源让后面全部平移、游标全丢）。
- 未知 `type`：加载期**报错并列出支持的类型**，不要静默当 imap。
- 每种类型的必填字段用 `normalizeSource()` 校验，缺字段报"缺什么、去哪填"。
- **设置页提供「添加/编辑/删除邮箱」表单**（`src/sources-config.js`）：写的是 YAML 覆盖层，写前做与启动
  完全相同的 `normalizeConfig(mergeConfig(base, overlay))` 整表校验；非法整份不写。base（cordis.patch.yml）里
  定义的来源在 UI 里是**只读**的，删除会明确拒绝。
- 删除来源默认**不删存档**（勾选框才会删未总览的存档）；游标记录随来源一起删除，避免以后加回同 id 时沿用旧游标。
- 来源变更后**下一步就是基线**：首轮只记已见、不归档历史。UI/文档都要说清这一点。

## 4b. 绑定（OAuth / 扫码）的实现与坑

`src/bind.js` 是唯一做授权流程的模块，`src/qr.js` 只负责把 URL 变成 SVG 二维码。

| 协议 | 流程 | 落盘 |
|---|---|---|
| Microsoft Graph | device code：`/oauth2/v2.0/devicecode` → 轮询 `/token`（`authorization_pending/slow_down/expired_token/declined` 分开处理） | `{client_id,tenant,scope,access_token,refresh_token,expires_at}` → `token_file`（0600，原子写），`graph.js` 原样读取 |
| Gmail | 回环回调 `http://127.0.0.1:<随机端口>/`（desktop OAuth client 允许任意端口）；起不来就退化成"手动粘贴 code" | `{client_id,client_secret?,refresh_token,access_token,expires_at,scope,email}` → `token_file` |
| QQ 官方机器人 | `POST q.qq.com/lite/create_bind_task`（带 32 字节随机 key）→ 二维码 = `connect.html?task_id=…` → 轮询 `/lite/poll_bind_result`；status=2 时用 **AES-256-GCM** 解 `bot_encrypt_secret`（布局 `iv(12)‖ct‖tag(16)`） | `qq.app_id` / `qq.openid` 写入 YAML；`QQ_BOT_APP_ID` / `QQ_BOT_SECRET` 写 `ctx.credentials`（无凭据缝才退回 YAML 明文并给出 warnings） |

> **QQ 这一行不是腾讯公开承诺的协议**：端点、请求头、`status` 0/1/2/3 语义来自第三方开源实现
> （hermes-agent 的 qqbot onboard 模块，2026-10-31 抓取）。返回非 JSON（反爬 HTML）、字段改名、
> 网关 5xx 都可能发生；实现只承诺"失败时降级为手填 AppID/openid/appSecret"，不承诺自动恢复。
> 真实扫码一次仍未验证（见 [development.md §6](development.md)）。

纪律：

- 绑定会话有 **10 分钟 TTL**、最多 8 个；完成/失败/取消/卸载都会关掉本地回调端口（`bind.disposeAll()` 在 shutdown 里）。
- **secret 只在宿主侧流转**：`pollBind()` 只回不敏感的 `{account,email,appId,openid,tokenFile}`；QQ 的
  `client_secret` 由 `bind.peekQqCredentials(id)` 读取、**所有落盘成功之后**才 `consumeQqCredentials(id)` 擦除。
  HTTP 响应只回 `{appId, openid, saved}`；快照里永远没有 secret。写入失败时 secret 保留，可直接重试而不必重扫。
  （早期实现把 secret 塞进 `bind.result`，而 `finish()` 的 `resultView` 会把它过滤掉，导致 appSecret 永远落不了盘；
  后来又一度"读即擦"，写失败就只能重扫——两个方向都有回归钉住。）
- 二维码必须**白底黑码**（`client.js` 里显式 `background:'#fff'`）：主题 token 在深色模式下会把码反色，扫不出来。
  这是唯一允许的字面色例外，已写注释。
- 令牌刷新必须走文件锁 + 读-改-写（`proper-lockfile`）：Google/Microsoft 都会轮换 refresh_token，两个进程同时刷新
  会把对方的新值写旧（下一次 `invalid_grant`）。
- Graph 的 `client_id` 必须是**允许公共客户端流**的应用注册；Gmail 的 OAuth client 类型必须是「桌面应用」
  （回环重定向 + 任意端口）。类型不对时错误文案要指向这一点。

## 5. 测试策略（离线优先）

- 现有测试全部离线：`src/sources/*` 的协议细节用**假客户端对象**测（`test/issues.test.mjs` 里 `searchNewUids(client, prev)` 就是范例）。
  新协议同样把"纯逻辑"抽成导出函数（游标合并、seenIds 截断、位置判据），协议 I/O 留在薄壳里。
- 必须覆盖的用例（每种新协议至少）：
  1. 首次运行 → 基线，不归档旧邮件；
  2. 有新邮件 → 归档、游标提交；
  3. 交付失败（`poll` 返回 `lost`）→ 游标**不**前进；
  4. 游标失效/过期（POP3 邮件消失、Gmail historyId 404、Graph 410）→ 重建基线且**不重放**；
  5. 同一封邮件被 poll 两次 → 同一个 `header.id`（幂等）；
  6. 服务器返回异常（空列表、乱序、重复 UIDL）→ 不崩、不丢游标。
- `test/harness.mjs` 的 `test-config.yaml` 现在同时起四种来源（IMAP/POP3 指向 `127.0.0.1:1`、Gmail/Graph 指向不存在的
  令牌文件）：冒烟关心的是"每种协议失败都只拖住自己那一条来源"。


## 6. 实施顺序（已完成）

1. ✅ 抽公共接口：`index.js` 三处三元判断改成 `providerFor(type)`，四个模块都实现 `emptyState/describeCursor`。
2. ✅ POP3：验证 seenIds 型游标能承载"没有服务端序号"的协议。
3. ⏳ Graph 改 delta（可选）：仍用 seenIds 窗口；delta 作为增强，注意 410/过期回落。
4. ✅ Gmail OAuth：令牌文件 + 回环/手动授权 + 设置页绑定。
5. ✅ 每加一种协议都更新了 `docs/configuration.md`、`docs/operations.md`、README 支持列表。

## 7. 这一轮踩出来的、最容易重犯的坑

1. **`state-domain.js` 的 sources 表是白名单**：游标加字段（如 `historyId`）必须同步 `parse()`，否则重启后字段消失、
   表现为"每次启动都重建基线"。
2. **`config.js` 的 `canonicalizeConfig` 不认识新键**：snake/camel 双写时，漏映射等于"YAML 改了不生效"（G1 同类）。
   0.4 新增 `client_id/client_secret/client_secret_ref → clientId/clientSecret/clientSecretRef`。
3. **别让协议细节泄漏到 `index.js`**：`mode/lost/state` 三件套是调用方唯一需要知道的契约；vendor 差异（POP3 没有 validity）要藏在 provider 内。
4. **失败必须可见**：新协议的错误要带协议名与来源 id 进日志（`[来源「学校邮箱」] …`），否则多来源时根本分不清是谁挂了。
5. **不要用 `console.warn`**：`dsh web` 下没有 sink（唯一的正面例子是 `logger` 注入；`graph.js` 里那行历史遗留可作反例）。
6. **凭据只走 `ctx.credentials`**（或既有令牌文件模式），空值绝不算"已配置"；日志只打层名，不打值。
7. **UI 里不要写死"只有 IMAP/Graph"**：设置页的来源列表、`mail_automation_status` 的输出、`describeCursor()` 都要按 `type` 泛化，
   否则加协议时前端会显示成"未知"。
8. **设置页删来源 ≠ 删存档**：`deleteArchives` 必须显式勾选并二次确认；游标随来源删除，存档默认保留。
9. **YAML 改数组用 `YAML.parseDocument().set()`**，不要正则拼列表：缩进/引号/注释三个坑一次踩全。`sources` 段内的注释
   会被重排（其它段保留），文档里已说明。
10. **OAuth 绑定不是纯前端**：回环端口、文件锁、令牌轮换、secret 只进不出，任何一条偷懒都会变成"绑定成功但取不到信"
    或"密钥出现在浏览器/日志里"。
