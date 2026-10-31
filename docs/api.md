# 接口参考：工具 / 技能 / 设置页 HTTP / CLI

> 面向 agent 与前端调用方。内部实现见 [architecture.md](architecture.md)。

## 1. Agent 工具（`src/tools.js`，7 个）

所有工具都是 `ctx.tools.register(defineTool(...))` 注册的 **Cordis effect**，插件卸载时整套消失。
`execute()` 只返回 `output.schema` 声明的规范 JSON 值；人类可读文案在 `output.render`。
两个写操作的工具（poll / config）遵循"取消点只在不可逆边界之前"：越过边界后被取消，返回
`{ ok:false, cancelled:true, error:'…副作用可能已经发生（结果未回报），不要重跑' }`。

### 1.1 `qq_notify`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `text` | string | ✔ | 正文；长文本自动分片 |
| `markdown` | boolean | — | 默认跟随 `qq.markdown` |

返回：`{ ok, sent, chunks }` 或 `{ ok:false, error }`。
`render`：成功 → `已通过 QQ 发送 N/M 段消息。`；失败 → `qq_notify 失败：<error>`。

### 1.2 `mail_automation_archive_read`

读取**本地存档**（不碰邮箱）。这是邮件 agent 读信的唯一通道——它不受宿主文件沙箱与预设工具集限制。

| 参数 | 类型 | 说明 |
|---|---|---|
| `id` | string | 存档 id（`archive_list` 返回的目录名）；与 `file` 二选一 |
| `file` | string | 存档目录；可给绝对路径、目录名，或目录里的某个文件 |
| `query` | string | 没有路径时按主题/发件人关键词搜当前存档（命中多封会返回 `candidates` 让你选） |
| `part` | string | `text`（默认）/ `html` / `image` / `raw` / `conclusion` / `meta` |
| `offset` | integer | 从第几个字开始（默认 0） |
| `maxChars` | integer | 本次最多返回多少字（默认 6000，硬上限 20000，最小 200） |

返回：`{ ok, dir, part, file, note, subject, from, date, source, files, links, total, offset, next, truncated, text }`；
`part=image` 时额外 `image:true, bytes, width, height, images[], slices[]`；
`part=html`/`image` 还会带 `links: [{host, count, text}]`（钓鱼判断用）。
失败：`{ ok:false, error, candidates?, dir? }`。

**安全**：只允许存档根内的路径（`isInsideArchive`，realpath + 平台大小写 + 拒绝 `..`/绝对路径越界）；
越界判定在 `query` 兜底**之前**——否则"越界路径 + 关键词"会静默改读另一封邮件。

`part: "conclusion"` 就是读单封的 `conclusion.md`：传 `file: "<存档 id>"` 即可；文件不存在时返回 `ok:false`，空文件返回空 `text`。

### 1.3 `mail_automation_archive_list`

批量列存档。一次最多 2000 封，默认 1000；不触碰邮箱，只读本地存档。

| 参数 | 类型 | 说明 |
|---|---|---|
| `ids` | string[] | 只返回这些邮件：存档目录名（推荐）或 `meta.id`；按输入顺序返回。不传 = 全部 |
| `fields` | string[] | 同一行附加字段，可任意组合：`subject`（标题）/ `date`（时间）/ `from`（发件人）/ `to`（收件人）/ `conclusion`（conclusion.md，另起缩进行） |
| `limit` | integer | 最多返回多少封（默认 1000，上限 2000） |
| `max_conclusion_chars` | integer | 每封 conclusion 最多多少字（默认 4000；`0` = 不截断） |

返回 `{ ok, total, returned, fields, items, missing, truncated, text }`；`items[]` 含 `id`（存档目录名）、
`mail_id`（协议 id）、`subject/date/from/to`，选 `conclusion` 时还有 `conclusion` / `conclusion_exists` /
`conclusion_truncated`。`text` 每封一行：`<id> | 标题: … | 时间: … | …`，结论在下一行缩进。
`ids` 中找不到的放在 `missing`（不猜测内容）。

### 1.4 `mail_automation_archive_clear`

清理存档（**破坏性**）。只删存档根内、有 `meta.json` 的目录，并顺手清掉指向这些目录的 `retries`。

| 参数 | 类型 | 说明 |
|---|---|---|
| `ids` | string[] | 要删的存档 id（目录名或 `meta.id`）。**不传 = 清理全部**；显式 `[]` 会被拒绝 |

返回 `{ ok, removed, ids, missing, remaining, retries_removed, total_before, text }`；`remaining` 是删不掉的
（权限/占用），`missing` 是 id 列表里不存在的。

### 1.5 `mail_automation_status`

| 参数 | 类型 | 说明 |
|---|---|---|
| `day` | string | `YYYY-MM-DD`，默认今天（只影响"那天存档了多少封"的统计） |

返回 `{ ok, text }`：轮询间隔、定时任务列表（排期/上次状态）、各来源游标、已存档列表（前 20）、最近一次轮询与最近错误。

### 1.6 `mail_automation_poll`

无参数。走 `ui.retryPoll()`（会顺手解开"卡住的那一轮"），不是裸 `tick()`。返回 `{ ok, text }`。

### 1.7 `mail_automation_config`

| 参数 | 类型 | 说明 |
|---|---|---|
| `action` | string | `read` / `save_params` / `save_prompts` / `retry_failed` / `retry_poll`（必填） |
| `params` | object | `save_params` 用：`{ poll_seconds: 30, "agent.silent": true, ... }`（键见 [configuration.md §5](configuration.md)；**定时任务不走这里**） |
| `prompts` | object | `save_prompts` 用：`{ mail: "…", html: "…" }`，只提交要改的键 |

返回 `{ ok, text, changed?, written? }`。**与设置页共用同一份实现**（`src/uiapi.js`）——一个操作两个调用方。
定时任务的增删改/立即运行只从设置页走 HTTP（`save-schedules` / `run-task`），不给 agent 工具，避免它误改排期。

## 2. 技能（`src/index.js:registerSkills`）

| 技能 | 何时被选中 | 内容 |
|---|---|---|
| `qq-notify` | agent 需要给用户发 QQ 通知时 | 什么时候该发/不该发、格式规矩、频控边界 |
| `mail-automation-archive` | agent 要读单封存档时 | `part` 的读取顺序（text → image → html → raw/meta/conclusion）与"只读"纪律 |
| `mail-automation-archive-batch` | agent 要批量看存档/总览时 | `archive_list` 的 ids/fields/limit 用法、id 定义、missing 处理 |
| `mail-automation-archive-clear` | agent 要清理存档时 | `archive_clear` 的破坏性边界：发送成功后才清、按 id 或全量、空数组拒绝 |

注册字段：`{ name, description, content, source: 'runtime', path, resourceBase: {kind:'directory', path} }`。
`description` 优先取 `SKILL.md` frontmatter（容忍 CRLF）；`source` 是 `ctx.skills.get()` 校验的硬字段（漏了目录能列、加载才炸）。

## 3. 设置页 HTTP 通道（`src/uiapi.js`）

**路由**：`GET|POST /plugins/dsh-mail-automation/api`（`UI_ROUTE_PATH`）。

| 层 | 规则 |
|---|---|
| 鉴权 | `ctx.connection.requestRejection(req)`；无该服务 → 退化同源检查 + WARN 一次；缝抛错 → **fail closed 403**；返回值无法识别 → 403 |
| 方法 | `GET` 返回快照；`POST` 必须是 `application/json`（否则 415）；其它方法 405 |
| 体积 | 请求体上限 64 KiB（超限 413，并先 `resume()` 排空再回复） |
| 错误 | 4xx 附带 `{ ok:false, code, error }`；5xx 只记日志 |

### 3.1 快照（GET / 任何成功 POST 的响应）

```jsonc
{
  "ok": true,
  "now": 1761...,
  "status": { "disposed","booting","baselined","running","activity","processingDir",
              "lastTickAt","lastTickAtIso","lastError","lastErrorAt","lastErrorAtIso",
              "nextScheduleAt","nextScheduleAtIso","nextScheduleTask","schedulesArmed",
              "nextScheduleAt","nextScheduleAtIso","nextScheduleTask","schedulesArmed","backend","configFile","archiveDir" },
  "schedules": [{ "id","name","enabled","schedule": { "type","times","weekdays","days","everyMinutes" },
                  "description","nextAt","nextAtIso","lastRunAt","lastRunAtMs","lastStatus","lastError","lastFile","lastCount",
                  "retryAt","retryAttempt",
                  "prompt","prompt_file","has_prompt_file","source" }],
  "sources": [{ "id","name","type","typeLabel","cursor","detail","editable","canBind","bound", … }],
  "pending": { "count": 3, "items": [{ "dir","name","subject","from","date","day","source",
                                       "hasConclusion","outcome","error" }] },   // outcome: ok|failed|pending
  "params":  { "poll_seconds": 60, "heartbeat_seconds": 5, "busy_retry_seconds": 5, "busy_retry_max": 24,
               "agent.provider": "", "agent.model": "", "agent.reasoning_effort": "low",
               "agent.tools": ["mail_automation_archive_read","mail_automation_archive_list","mail_automation_archive_clear","qq_notify","read_image"],
               "qq.enabled": true, "qq.app_id": "", "qq.openid": "", "qq.markdown": true, … },
  "prompts": { "mail": { "path","text","exists" }, "html": … },
  "catalog": { "tools": [{ "id","label","hint" }], "efforts": ["inherit","minimal","low","medium","high"],  "sourceTypes": [{ "type","label" }] },
  "preset": { "id": "mail-automation-agent", "registered": true, "error": "", "tools": ["mail_automation_archive_read","mail_automation_archive_list","mail_automation_archive_clear","qq_notify","read_image"] },
  "qq": { "enabled": true, "appId": "", "openid": "", "markdown": true, "bound": false },
  "models": { "default": { "provider","model" }, "providers": [{ "id","models": ["…"] }] }   // 仅 GET 附带；宿主拿不到时为 null
}
```

`retryAt` / `retryAttempt` 来自内存里的 busy 退避：`retryAt > now` 时前端显示「n 秒后重试」；
`lastStatus=ok` 时显示「x 秒/分钟前运行成功」，`failed` 红色，从未运行灰色。`lastRunAtMs` 用于前端算相对时间。

### 3.2 动作（POST body 的 `action`）

| `action` | 额外 body | 成功 | 失败 |
|---|---|---|---|
| `save-params` | `params: {…}` | `{ ok:true, changes:[{name,value}], ...snapshot }` | 400 `{ ok:false, error }`（校验不过整份不写） |
| `save-prompts` | `prompts: {mail?,html?}` | `{ ok:true, written:[path], ...snapshot }` | 400 |
| `retry-poll` | — | `{ ok:true, text, ...snapshot }` | 409（正在跑/忙） |
| `retry-failed` | — | `{ ok:true, queued:N, ...snapshot }` | 400 |
| `delete-mail` | `{ id }`（存档目录名 / `archive_list` 的 id） | `{ ok:true, removed, id, ...snapshot }`（只删本地存档，不碰邮箱） | 400（缺 id / 删除失败） |
| `save-schedules` | `{ schedules: [ { id,name,enabled,schedule,prompt,prompt_file } ] }` | `{ ok:true, ids, written, ...snapshot }`（整份数组；删除任务 = 不传它） | 400（坏排期/重复 id/无提示词/写盘失败，整份不写） |
| `run-task` | `{ id }` | `{ ok, text, count, removed, ...snapshot }`（手动跑一次，不认领排期槽；不写输出文件） | 400（任务不存在）/409（正在轮询/处理） |
| `save-source` | `{ source:{type,name,id?,host?,user?…}, secret?, clientSecret?, previousId? }` | `{ ok:true, id, created, warnings, ...snapshot }` | 400（整表校验失败/凭据写入失败） |
| `delete-source` | `{ id, deleteArchives?: boolean }` | `{ ok:true, id, removedArchives, ...snapshot }` | 400（来源在 cordis 配置里/找不到） |
| `verify-source` | `{ id }` | `{ ok:true, detail, ...snapshot }` | 400（登录/取信失败，`detail` 在 `error`） |
| `mail-bind-start` | `{ sourceId }` | `{ ok:true, bind:{id,provider,status,url?/userCode?…} }` | 400（缺 clientId/网络失败） |
| `mail-bind-poll` | `{ id }` | `{ ok:true, bind, ...snapshot }` | 400（会话不存在） |
| `mail-bind-complete` | `{ id, code }` | `{ ok:true, bind, ...snapshot }` | 400 |
| `mail-bind-cancel` | `{ id }` | `{ ok:true, bind }` | 400 |
| `qq-bind-start` | — | `{ ok:true, bind, qr }`（`qr` 是 `data:image/svg+xml;base64`） | 400（q.qq.com 不可用） |
| `qq-bind-poll` | `{ id }` | `{ ok:true, bind, saved, warnings, ...snapshot }`（**不含 secret**；`saved:false` 表示本次没有可保存的 client_secret，需要重扫或手填） | 400 |
| `qq-bind-cancel` | `{ id }` | `{ ok:true, bind }` | 400 |
| `save-secret` | `{ ref, value }` | `{ ok:true, ref }` | 400（无凭据缝/引用名非法） |

`agent.silent` / `agent.workspace` 的改动**重启生效**（影响父会话怎么建）；其余参数下一次心跳/下一封邮件生效。
`save-schedules` 写的是**整份任务数组**：设置页把当前列表 + 草稿（或删除后的列表）整体提交，后端只做白名单键、
整表校验与原子写；`prompt_file` 留空时自动创建 `prompt/<id>-prompt.md`；提示词正文必填，空正文整份不保存（YAML 只存路径）。
`run-task` 与设置页「立即运行」是同一个操作，失败只影响这一次（不写 `lastSlot`，也不会打乱排期）。
任务执行失败时 HTTP 200 的响应保留 `ok:false` 与 `error`，快照不覆盖操作结果，设置页显示失败提示。
`save-source` / `delete-source` / `verify-source` 与三种绑定属于设置页；**来源管理与绑定只从设置页调用**，
`mail_automation_config` 工具仍只做 read/save_params/save_prompts/retry_*（避免 agent 误改邮箱结构）。

### 3.3 `sources[]` 快照

```jsonc
{ "id","name","type","typeLabel","cursor","detail","editable","canBind","bound",
  "clientId","tenant","host","port","secure","user","mailbox","folder","provider",
  "tokenFile","clientSecretRef","passwordRef" }   // 永远不含 password / clientSecret
```

`cursor` 由各协议的 `describeCursor()` 生成（IMAP / OAuth2（IMAP）=UID、POP3=UIDL 数、Gmail=historyId、Graph=seen 数）；
`editable=false` 表示来源定义在 `cordis.patch.yml`，界面只读。

## 4. 离线 CLI（`src/cli.js`）

不依赖 DSH 进程，直接验证配置与取信。配置路径优先级：命令行第一个 `*.yaml` 参数 → `MAIL_AUTOMATION_CONFIG` →
`$DSH_HOME/mail-automation/mail-automation.yaml` → 插件目录旁的 `../mail-automation/`。

| 命令 | 作用 |
|---|---|
| `node src/cli.js config` | 打印解析后的配置（密码脱敏）——看清"每个值来自哪一层"最快的办法 |
| `node src/cli.js headers [sourceId]` | 列前 N 条邮件头（默认 `monitor.initial_headers`） |
| `node src/cli.js poll` | 用 `storage.state_file` 跑一轮轮询并写回游标（第二个写者：必须原子写） |
| `node src/cli.js read <mailId>` | 取单封全文并打印前 2000 字 |

## 5. 补档脚本

```powershell
node scripts/backfill-day.mjs 2026-10-21            # 两个来源都补
node scripts/backfill-day.mjs 2026-10-21 school     # 只补某个来源
```

只写存档、**不跑 agent**；补完后让 agent 用存档工具处理。
脚本结束会显式 `imap.closeAll()`，否则 Node 会因长连接不退出。

## 6. 设置页（浏览器半侧，`client.js`）

- 形态：`settings.section` slot 的一条设置页（id `mail-automation`，order 56）。
- 页签：**概览 / 已存档 / 邮箱 / 定时任务 / 提示词 / 参数 / 指南**。已存档页每封邮件有「删除」按钮（第一次点变确认）；
  邮箱页签里含 QQ 扫码绑定卡片、来源列表与增删改表单、绑定对话框；
  定时任务页签含任务列表、排期/提示词编辑表单、立即运行与删除确认。
- `inject: ['slots', 'locale']`（**静态数组**——函数形式会被 cordis 拒绝并可能让整个 bundle 被自愈机制禁用）。
- 词典：`locale.register('mail-automation', 'en'|'zh'|'zh-CN', {...})`，优先用 `locale.bind()`；`getLocale().active` 是语言字段（不是 `id`）。
- 轮询：每 5 s `GET` 一次快照；保存中暂停刷新；`dirty{Params,Prompts}` 保证编辑中的草稿不被冲掉。
- 绑定：`start` 后每 2.5 s `poll` 一次，完成/失败/过期即停；二维码用 `<img src="data:image/svg+xml;base64,…">` 显示
  （**白底黑码**是扫码硬要求，这里是全文件唯一一个字面色例外）。
- 样式：只用 `--dsw-alias-*` 主题 token（无字面颜色、无 shadow）；提示统一带 `{ok,text}` 判别位（成功 `✓`/`role=status`，失败 `⚠`/`role=alert`）。
