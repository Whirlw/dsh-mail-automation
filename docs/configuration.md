# 配置参考

> 三层配置、全部字段、路径展开与已知边界。安装与最小示例见 [README](../README.md)。

## 1. 三层，后层覆盖前层

```
① cordis.patch.yml 的 config（Schemastery 校验；profile 里按 id 整行覆盖）
② configFile 指向的 YAML 覆盖层（默认 $DSH_HOME/mail-automation/mail-automation.yaml，每轮轮询重读）
③ 代码兜底默认值（src/defaults.js + normalizeConfig 的 fallback）
```

- 覆盖是**整行 config 替换，不是深合并**（loader 语义）：在 profile 里覆盖 `mail-automation` 那一行时，要重述它需要的全部键。
- **覆盖层不需要重启**：`loadConfig()` 每轮重读；提示词文件每封邮件重读；凭据每次操作重解析。
- 字段名两种写法都认：`cordis.patch.yml` 用 camelCase（`pollSeconds`），手写 YAML 用 snake_case（`poll_seconds`）。
  `canonicalizeConfig()` 会把 snake 归一成 camel —— 不做这一步，`poll_seconds` 与 `pollSeconds` 就是两个 key，YAML 改了不生效。

## 2. 路径展开

| 写法 | 结果 |
|---|---|
| `$DSH_HOME/x`、`${DSH_HOME}/x`、`%DSH_HOME%/x` | 展开到 DSH 主目录 |
| `%VAR%` | 环境变量；未定义时原样保留 |
| `~`、`~/x`、`~\x` | 用户主目录 |
| 绝对路径 | normalize 后原样 |
| 其它相对路径 | **提示词/存档相对配置文件所在目录**；Graph 令牌相对 `$DSH_HOME` |

`$DSH_HOME` 的解析不能只信 `process.env.DSH_HOME`（Electron 宿主里它可能指向 profile 目录）：
`resolveDshHome()` 依次尝试 `DSH_HOME` → `DSH_PROFILE_DIR` 的祖父目录 → `~/.dsh`，取第一个"看起来像 DSH 主目录"的
（含 `.credentials.yaml` 或 `profiles/`）。

## 3. 字段总表

### 3.1 顶层

| 键（YAML / cordis） | 默认 | 说明 |
|---|---|---|
| `config_file` / `configFile` | `$DSH_HOME/mail-automation/mail-automation.yaml` | YAML 覆盖层路径；留空 = 只用 schema 配置。**相对路径按 `$DSH_HOME` 展开** |

### 3.2 `monitor`

| 键 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `poll_seconds` | 30 | ≥5 | 轮询间隔。**volatile**：改完下一次心跳生效，不用重载 |
| `heartbeat_seconds` | 5 | ≥1 | 心跳粒度（"到点该轮询了吗"）。改完需重载 |
| `initial_headers` | 10 | 1–50 | 启动快照抓多少条邮件头（超出按 50 处理） |
| `archive_retry_attempts` | 3 | 1–10 | 单封取正文/落盘失败最多重试几轮；超过就跳过并记 ERROR |

#### `scheduler`（定时任务 busy 退避）

| 键 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `busy_retry_seconds` | 5 | 1–300 | 到点撞上**轮询**占锁时，隔多少秒重试 |
| `busy_retry_max` | 24 | 1–1000 | 撞上轮询时最多重试多少次（默认约 2 分钟） |

撞上 **agent 处理邮件**仍走 `BUSY_RETRY_MS=60s × BUSY_RETRY_MAX=3`，这两项只影响轮询占锁。
调度器有独立 `setTimeout`，退避不依赖 `heartbeat_seconds`（心跳只负责轮询和配置变更检查）。
`heartbeat_seconds` 在插件启动时读取一次（改完需重载），即使设为 600 秒，5 秒后的 busy 重试仍由调度器自己的
定时器触发；它只影响“多久检查一次配置/开始下一次轮询”，不影响重试时刻。

### 3.3 `sources`（数组，可为空）

五种协议共用一张表，按 `type` 取用各自字段。设置页「邮箱」页签可以直接增删改（`src/sources-config.js`），
也可以手写 YAML；设计背景见 [multi-source.md](multi-source.md)。

| 键 | 默认 | 用于 | 说明 |
|---|---|---|---|
| `id` | 由身份派生 | 全部 | 游标键、连接池键、存档目录前缀。**必须唯一**（重复时加载期响亮失败）；改 id = 新邮箱 |
| `name` | = `id` | 全部 | 显示名（提示词、总览、日志） |
| `type` | `imap` | — | `imap` / `pop3` / `oauth2` / `gmail` / `graph`；未知类型加载期报错并列出支持项 |
| `host` `port` `secure` `user` `password` `password_ref` `provider` | — / 按预设 / true / — / — / — / — | IMAP/POP3 | `host` 可留空：按 `provider` 或邮箱域名推断（qq/163/126/gmail/outlook/icloud/foxmail，两张预设表按协议分开） |
| `mailbox` | `INBOX` | IMAP/OAuth2 | 邮件文件夹（留空 = INBOX；POP3 没有这个字段） |
| `token_file` | graph: `$DSH_HOME/mail-automation/tokens/graph-<id>.json`；gmail: `$DSH_HOME/mail-automation/tokens/<id>.json`；oauth2: `$DSH_HOME/mail-automation/oauth2/<id>.json` | Gmail/Graph/OAuth2 | OAuth 令牌文件（0600，原子写） |
| `folder` | graph `inbox` / gmail `INBOX` | Gmail/Graph | Graph 文件夹 / Gmail **标签 id**（留空 = 默认；填名字会 400 Invalid label） |
| `top` | 20 | Gmail/Graph | 每轮比对最近多少封（另受内部窗口上限约束） |
| `client_id` | — | Gmail/Graph/OAuth2 | OAuth 客户端 id；OAuth2 必须是**公共客户端**（允许设备码流） |
| `client_secret` / `client_secret_ref` | — / — | Gmail | 「桌面应用」OAuth 客户端的 secret；**优先用 ref**（`ctx.credentials`） |
| `tenant` | `common` | Graph/OAuth2 | Microsoft 租户（common / 租户 id / 域名） |

OAuth2（IMAP）的默认连接参数：`host=outlook.office365.com`、`port=993`、`secure=true`；scope 只申请
`offline_access` + `https://outlook.office.com/IMAP.AccessAsUser.All`（只读，不发信），通过设置页「登录」走设备码流程。

缺省 `id` 由**邮箱身份**派生：`imap-<user>-<mailbox>` / `pop3-<user>` / `oauth2-<user>` / `gmail-<user>` / `graph-<clientId>`（Graph 显式写 `token_file` 时用 `graph-<令牌文件基名>`）；设置页编辑时为空表示用默认文件夹，输入框不回显默认值。
**不用数组下标**——在下标派生时代，在 `sources` 开头插一个来源会让后面所有 id 平移、游标全丢、静默重建基线。

改 id、文件夹或协议视为新邮箱：旧游标会被删除，下一拍重新建基线；旧存档仍在磁盘上。
设置页编辑时改 id 会同时删除旧 id 的定义（`previousId`），不会留下两条；改文件夹/协议同样清掉旧游标。

### 3.4 `prompt`

| 键 | 默认 | 说明 |
|---|---|---|
| `file` | `$DSH_HOME/mail-automation/prompt/prompt.md` | 普通邮件提示词（Markdown）。文件开头连续的 `#` 注释与任意 `<!-- … -->` 会被剥掉；正文标题请从 `##` 起 |
| `html_file` | `$DSH_HOME/mail-automation/prompt/prompt-html.md` | 带 HTML 正文的邮件用这份（留空 = 复用 `file`） |

### 3.5 `schedules`

数组，可以为空。**每条任务都必须显式配置**；没有默认任务、没有 `digest.*` 回落。触发时就是一个 agent 回合
（QQ 由 agent 自己用 `qq_notify` 发）。

| 键 | 默认 | 说明 |
|---|---|---|
| `id` | `task-<n>` | 任务标识；运行记录（上次运行/槽）的键。**同一份配置里必须唯一**（重复加载期报错） |
| `name` | = `id` | 显示名（日志、设置页、`[schedule:<id>]` 行） |
| `enabled` | true | `false` = 不排期（手动仍可运行） |
| `schedule.type` | — | `daily` / `weekly` / `monthly` / `interval` / `startup`（必填，未知值加载期报错） |
| `schedule.times` | — | `daily/weekly/monthly` 用：本地时刻 `HH:MM` 数组（如 `["12:00", "21:00"]`），也接受单个字符串 |
| `schedule.weekdays` | — | `weekly` 用：ISO 周几，`1`=周一 … `7`=周日 |
| `schedule.days` | — | `monthly` 用：1–31；**月份没有该日时按当月最后一天**（31 号在 2 月 = 28/29 号） |
| `schedule.every_minutes` | — | `interval` 用：≥1 的整数分钟；从上次运行时刻锚定，停机错过的只补跑一次 |
| `prompt_file` | — | 提示词文件（相对配置文件目录；每次触发现读）。路径留空会自动创建 `prompt/<id>-prompt.md`；**提示词正文必填**，空正文不能保存 |

提示词里可用的模板变量（未知占位符原样保留）：

| 变量 | 值 |
|---|---|
| `{{now}}` / `{{date}}` | 本地时间 / `YYYY-MM-DD` |
| `{{task_id}}` / `{{task_name}}` | 任务 id / 显示名 |
| `{{pending_count}}` / `{{pending_list}}` / `{{pending_omitted}}` | 待总览封数 / 逐封清单（≤80 封）/ 未展开封数 |
| `{{archive_dir}}` / `{{snapshot_file}}` | 对应路径 |
| `{{startup_snapshot}}` | 启动快照文本（`startup.md`，截到 8000 字），给 `startup` 任务用 |

- 所有任务都是普通 agent 任务；不会自动把清单塞进提示词。需要清单时在提示词里写
  `{{pending_list}}`，或直接调用 `mail_automation_archive_list`。
- 任务失败（agent 报错/空回复）不会自动重跑，只把 `lastStatus/lastError` 写进状态并在设置页显示；
  下一次排期照常。锁被轮询占着时调度器 5 s 后重试（最多 24 次）；撞上 agent 处理则 60 s × 3。
- 显式 `schedules: []` = 不跑任何任务；没有默认任务。
- `startup` 任务在插件启动时跑；**运行中新增/编辑并保存的 `startup` 任务不会立刻跑**，
  等下一次 DSH 启动（同一进程里只认领一次启动槽）。

### 3.6 `storage`

| 键 | 默认 | 说明 |
|---|---|---|
| `root` | `$DSH_HOME/mail-automation` | 存档根 |
| `archive_subdir` | `archive` | 一封邮件一个目录，平铺 = "待总览"队列 |
| `snapshot_file` | `startup.md` | 启动邮件头快照（每次覆盖） |
| `state_file` | `state.json` | **只在宿主没有 storage-domain 时使用**；否则状态在 `$DSH_HOME/storages` 的域里 |
| `log_max_bytes` | 2 MiB | 插件自落日志轮转阈值（≥64 KiB）。改完需重载 |

### 3.7 `agent`

| 键 | 默认 | 说明 |
|---|---|---|
| `workspace` | `$DSH_HOME/workspace/default` | 会话落点；留空用默认。支持模板（设置页显示/回写的是**原文**，运行用展开值） |
| `session_mode` | `per_mail` | `per_mail` = 每封一个受管子智能体；`daily` = 当天复用同一会话 |
| `preset` | `mail-automation-agent` | 处理邮件用的预设 id。**默认由插件按 `agent.tools` 运行时注册**（见 [architecture.md §7](architecture.md)）；父会话也用它（留空时父会话强制内置 `mail-automation-agent`，子会话留空则跟随部署默认）；取不到会退回并 WARN |
| `provider` | — | 处理邮件用的模型 provider（与 `model` **成对**生效；只填一半按"跟随部署默认"处理并 WARN） |
| `model` | — | 处理邮件用的模型 id（同上） |
| `tools` | `[mail_automation_archive_read, mail_automation_archive_list, mail_automation_archive_clear, qq_notify, read_image]` | 邮件/定时任务子 agent 的**工具集**（目录见 `src/preset.js`：`read_image` / `fs` / `search` / `web` / `skill` / `todo` + 插件自带的 read/list/clear/qq_notify）。默认五件；**显式 `[]` = 不给任何工具**。未配置时用当前默认；旧列表原样保留，不自动迁移。未知 id 被丢弃并在启动时 WARN；`fs` 已含 `read_image`，同时勾选只保留 `fs` |
| `reasoning_effort` | `low` | `minimal/low/medium/high`；留空、`inherit`、`default`、`off` 都表示跟随部署默认 |
| `turn_timeout_seconds` | 300 | 单封交给 agent 的超时（≥30）。超时按失败处理并进重试队列 |
| `retry_attempts` | 3 | agent 处理失败后最多重试几次，到上限就"已放弃" |
| `opener_prompt` | 内置 | 父会话开场白；**允许显式空串**表示不写（但会导致子会话可能被 `pre-step` 拒）。启动时每个父会话（新建/切换）跑一次；沿用已就绪的会话不重复；静默模式也在启动时跑一次 |
| `silent` | false | 静默处理：父会话以 `origin=subagent` 创建、不挂工作区、不进侧边栏。**重启生效** |

### 3.8 `credentials`

| 键 | 默认 | 说明 |
|---|---|---|
| `secret_retry_seconds` | 300 | `password_ref` 解析不到时的退避（≥30），避免每轮刷同一条 WARN |

### 3.9 `render`（HTML 邮件预览图）

| 键 | 默认 | 说明 |
|---|---|---|
| `width` | 1000 | 视口宽度（≥320） |
| `slice_height` | 1400 | 超长页面每片最大高度（≥600）；太高小字会被压糊 |
| `slice_overlap` | 120 | 相邻切片重叠（避免切到半行字） |
| `max_height` | 12000 | 整页图/切片最大高度；超过的内容**不会**进图片 |
| `remote_images` | true | 是否放行远程图片/样式（关掉可避免"打开即已读"的追踪像素） |
| `browser` | — | Chromium 内核可执行文件；留空按常见路径探测 Edge/Chrome（**候选路径是 Windows 的**，其它系统请显式配） |

### 3.10 `qq`

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 是否允许 QQ 推送 |
| `app_id` | — | 留空则经 `ctx.credentials` 解析 `QQ_BOT_APP_ID`；**扫码绑定会同时写入 YAML 与凭据 `QQ_BOT_APP_ID`**（供其它 QQ 插件复用） |
| `app_secret` | — | 同上（`QQ_BOT_SECRET`；`role: secret`）。扫码绑定优先写 `ctx.credentials`，没有凭据缝才写这里 |
| `openid` | — | **接收人 openid**；扫码绑定会自动写入；空时发送会明确报错 |
| `markdown` | true | 用 `msg_type=2` 发 Markdown；被平台拒绝时自动退回纯文本 |

「邮箱」页签还提供 `qq.app_id` / `qq.openid` / `appSecret` 的手填兜底；`appSecret` 走 `save-secret` 动作写进
`ctx.credentials`，**永远不会**出现在快照里（`readParams` 不含 `qq.app_secret` 是有意的）。

## 4. volatile 字段

`poll_seconds` 标了 Schemastery `.volatile()`。运行时它们是 `{ get() }` 包装：

- `normalizeConfig` 用 `deepUnwrap()` 在收口点统一解包；
- 宿主改完发 `loader/volatile-update` → 插件重读配置并**按新值**重排定时任务（`refreshThenReschedule()`）；
- 直接 `String(field)` / `Number(field)` 会得到 `"[object Object]"` / `NaN`。

`schedules` 不是 volatile 字段，但**心跳每拍比较它的签名**：手改 YAML 后最迟一个心跳（`heartbeat_seconds`）
就会重排，不需要重启，也不需要等 `loader` 事件。

## 5. 已知边界（改这里之前先读 [lessons.md](lessons.md)）

1. **YAML 覆盖层不经 Schemastery**：`schema.js` 的 `.min/.max` 只对 `cordis.patch.yml` 生效；真正的夹紧在 `normalizeConfig`
   （例如 `initial_headers` 夹到 1–50）。所以 schema 里**故意不写** `.max()`——写了只会让 cordis 里填 999 变成加载失败。
2. **设置页只改白名单里的标量**（`poll_seconds / heartbeat_seconds / busy_retry_seconds / busy_retry_max / initial_headers / agent.silent /
   agent.workspace / agent.provider / agent.model / agent.reasoning_effort / agent.tools / render.* / qq.enabled /
   qq.app_id / qq.openid / qq.markdown`）。它用正则就地改写 YAML 并保留注释，写前做**整表校验**
   （`normalizeConfig(composeConfig(base, overlay))`），校验不过整份不写。
   非块状段落（行内 map、锚点）会被明确拒绝；`render: null` 这类"段存在但值为空"会被归一成空块再插键。
   数组（`agent.tools`）写成 flow 序列 `["mail_automation_archive_read", "mail_automation_archive_list", "mail_automation_archive_clear", "qq_notify", "read_image"]`。
3. **`schedules` 由「定时任务」页签管理**：整份任务数组 → `YAML.parseDocument().set('schedules', …)`
   → 整表校验 → 原子写。任务提示词带 `prompt_file` 时先写文件（原子写、保留 mode），再写 YAML。
   - 运行时 `schedules` 是 **base(cordis.patch.yml) 与覆盖层按 id 合并** 的结果：覆盖层同 id 覆盖 base，
     覆盖层没提到的 base 任务**保留**（与 sources 同一条教训：数组整体替换会让 base 任务静默消失）。
   - 只改**覆盖层**；定义在 `cordis.patch.yml` 里的任务会在保存时被同 id 的覆盖项取代（想只读就放 profile 里，
     并避免在界面里编辑它）。
   - 写 `schedules` 段会重排该段（注释不保证保留在原来的行），其它段与注释保留。
   - **允许 0 个任务**：`schedules: []` 是有效配置（不跑任何定时任务）。
   - 坏任务（未知 type、空 times/weekdays/days、重复 id、任务没有 prompt_file）**加载期报错**，整份不写。
4. **`sources` 由「邮箱」页签管理**：表单 → snake_case → `YAML.parseDocument().set('sources', …)` → 整表校验 → 原子写。
   - 运行时 `sources` 是 **base(cordis.patch.yml) 与覆盖层按 id 合并** 的结果：覆盖层同 id 覆盖 base，
     覆盖层没提到的 base 来源**保留**（在界面里新增一个来源不会把 base 的顶掉）。
   - 只改**覆盖层**；定义在 `cordis.patch.yml` 里的来源在界面里只读，删除会明确拒绝。
   - 写 `sources` 段会重排该段（注释不保证保留在原来的行），其它段与注释保留。
   - 密码/客户端 secret 优先写 `ctx.credentials.set(ref, …)`；没有凭据缝时**拒绝**写入 ref（不静默丢密钥），
     只有用户不填 ref 才退回 YAML 明文，并在响应里 `warnings` 明说。
   - 编辑时"密码留空 = 不改"：包括修改来源 id，不填新密码不会抹掉已有明文密码、客户端 secret 或凭据引用；新 id 与其它来源冲突时拒绝保存。
   - 删除来源默认**保留存档**；勾选"同时删除未总览存档"并二次确认才删。
   - **允许 0 个来源**：`sources: []` 会按内置默认值生成一份**有效配置**，插件保持空闲（不轮询），
     状态灯显示「等待绑定邮箱」、概览给出绑定引导；参数/提示词页照常显示默认值并可保存，
     添加第一个邮箱后下一拍自动建基线。设置页也允许删除最后一个来源。
   - 凭据不在设置页暴露：改错会直接断轮询。
5. **改字段三处同步**：`schema.js`（文档与 cordis 校验）→ `config.js` 的 `canonicalizeConfig`/`normalizeConfig`（snake↔camel、
   夹紧、默认）→ `uiapi.js` 的 `PARAM_SPECS` + `client.js` 表单（若要在设置页暴露）。`schedules` 的字段同步改
   `schedule.js`（归一/排期）+ `schedules-config.js`（写盘）+ 设置页表单；状态字段同步改 `state-domain.js` 的
   `meta.parse()` 白名单。

## 6. 最小示例

```yaml
# $DSH_HOME/mail-automation/mail-automation.yaml
monitor:
  poll_seconds: 60
  initial_headers: 10
sources:
  - id: private
    name: 私人邮箱
    type: imap
    host: imap.qq.com
    user: me@qq.com
    password_ref: MAIL_PRIVATE_PASSWORD
schedules:
  - id: digest
    name: 邮件总览
    schedule:
      type: daily                      # daily / weekly / monthly / interval / startup
      times: ["12:00", "21:00"]
    prompt_file: prompt/digest-prompt.md
  - id: boot
    name: 启动快照
    schedule:
      type: startup                    # 每次启动、基线完成后运行一次
    prompt_file: prompt/boot-prompt.md
storage:
  root: $DSH_HOME/mail-automation
agent:
  silent: true
  workspace: $DSH_HOME/workspace/mail
qq:
  enabled: true
  openid: <你的 openid>
```

只改这份文件即可生效；`cordis.patch.yml` 的 `config` 只在需要"整行覆盖"（例如换 `configFile` 路径）时用。

## 7. 内部安全上限（写死在代码里，不可配）

这些是**协议/安全不变式**，不属于"可调参数"（指南允许的例外）。要改就得改代码：

| 常量 | 值 | 位置 | 作用 |
|---|---|---|---|
| `MAX_NEW_PER_POLL` | 50 | `sources/imap.js`、`sources/graph.js`、`sources/pop3.js`、`sources/gmail.js` | 单轮最多处理多少封新邮件 |
| `MAX_HEADERS` / `MAX_INITIAL_HEADERS` | 50 | `sources/imap.js`、`config.js` | 启动快照上限（`initial_headers` 被夹到 1–50） |
| `PAGE_TOP` / `MAX_PAGES` | 50 / 6 | `sources/graph.js` | Graph 单轮扫描窗口（≈300 封） |
| `SEEN_CAP` | 400 | `sources/graph.js`、`sources/pop3.js`、`sources/gmail.js` | `seenIds` 通常上限（超出丢最老的）；Gmail 单条 history 记录未完成且游标未推进时暂不截断 |
| `HISTORY_MAX` | 100 | `sources/gmail.js` | 一次 `history.list` 拉多少条变更 |
| `INVENTORY_LIMIT` | 80 | `digest.js` | 任务提示词里逐封清单上限 |
| `BUSY_RETRY_MS` / `BUSY_RETRY_MAX` | 60 s / 3 | `schedule.js` | 定时任务撞上 agent 处理时的退避与预算（轮询占锁另用 5 s × 24） |
| `PROCESS_BOOT_ID` | 每个进程一个 | `schedule.js` | `startup` 任务的槽标识（同一进程只跑一次） |
| `PROBE_TIMEOUT_MS` / `SHOT_TIMEOUT_MS` | 25 s / 40 s | `render.js` | 预览图测量/截图超时 |
| `USER_QPM` | 20 | `notify.js` | QQ 单关系每分钟上限 |
| 分片长度 | 3500 / 1500 字 | `notify.js` | Markdown / 纯文本单片上限 |
| `MAX_BODY_BYTES` | 64 KiB | `uiapi.js` | 设置页 POST 体积上限 |
| 忙等/停稳/释放 | 15 s / 20 s | `agent.js` | `cancel` 收敛等待、`dispose` 封顶 |
| 绑定会话 TTL / 上限 | 10 min / 8 | `bind.js` | 防止过期会话与本地回调端口泄漏 |
| 绑定轮询间隔 | 2 s（QQ/Gmail）/ 服务端给（Graph） | `bind.js` | 避免触发平台限流 |
| 连通性自检超时 | 20 s | `index.js` | 「测试连接」不能把 HTTP 请求拖死 |

## 8. 内部安全上限的边界

上述常量都带注释说明"为什么不能配"；要放宽请先读 [lessons.md](lessons.md) 的 §4 / §5 / §10——
它们和"不丢信 / 不重复烧 token / 不重放历史"直接相关。
