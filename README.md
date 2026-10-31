# dsh-mail-automation

简体中文 · [English](README-en.md)

DeepSeek Harness（DSH）插件：把收件箱变成自动化流程——轮询邮箱（IMAP / POP3 / OAuth2 / Gmail API / Graph），
每封新邮件落成本地存档，交给一个**受限子智能体**读并写结论；另外可以配置**任意数量的定时任务**
（每日 / 每周 / 每月 / 固定间隔 / 启动时），每条任务有自己的提示词。

## 它是什么：默认控制流，不是固定产品

开箱即用的链路只有两步：

1. **轮询 + 落档**：把配置的邮箱新邮件存到本地 `archive/`；
2. **每封邮件一个回合**：把存档交给带提示词的受限子智能体，结论写成 `conclusion.md`。

**定时任务必须显式配置**：在 `schedules:` 里给每条任务写 `prompt_file`。一条总览任务可以读存档、写总览，然后
**自己调 `qq_notify`** 发到 QQ，再调 `archive_clear` 清理。

**QQ 提醒和总览只是常见控制流**，没有一处是写死的：

- **定时任务可加可删**（设置页「定时任务」或 YAML 的 `schedules:`）：每日多个时刻、每周多天、每月多天、
  每 N 分钟、每次启动；每条任务有自己的 `prompt_file`；
- **提示词可换**（设置页「提示词」/「定时任务」或 `prompt.file` / `prompt.html_file`）：可以让它分类、抽取、起草回复、调用别的工具，而不只是“总结”；
- **工具可换**（`agent.tools`）：安装其他 DSH 插件/工具（`fs`、`search`、`web`、`skill`、`todo` 等），子智能体就能写文件、查网页、调用你自己的插件；
- **投递可换/可关**：插件不再内置推送；每次发送都是提示词里的一次 `qq_notify` 工具调用。`archive/` 和
  `conclusion.md` 就是普通文件，可以自己消费。

一句话：**「QQ 提醒 + 总览」本质上只是「处理一封邮件」+「一个提示词里会发 QQ 的定时任务」**。可复用的是轮询、本地存档、受限 agent 回合和调度器；提示词、工具、投递和下游自动化都可以换成你自己的。

- 来源：IMAP（`imapflow`）、POP3（内置客户端）、OAuth2（IMAP）、Gmail API 与 Microsoft Graph（OAuth，设置页里授权/扫码绑定）
- 一封邮件一个存档目录：原始报文、HTML、纯文本、预览图、`conclusion.md`
- 每封邮件跑在极简预设的子智能体里（没有 shell、不能写文件）——见 `agent.preset`
- 任意数量的定时任务（每日多时刻 / 每周多天 / 每月多天 / 固定间隔 / 启动时），每条一个提示词；QQ 由 agent 自己发
- 设置页可调邮件子 agent 的**模型 / 思考强度 / 工具集**，以及 **HTML 预览图渲染**参数
- 五种协议已全部实现（IMAP / POP3 / **OAuth2（IMAP）** / Gmail API / Microsoft Graph）；支持在设置页**添加/编辑/删除多个邮箱**，以及 QQ 官方机器人的**二维码绑定**
- DSH 内的设置页（概览 / 已存档 / 邮箱 / 定时任务 / 提示词 / 参数 / 指南），保存时就地改写 YAML 覆盖层

## 环境要求

- Node `^22.19.0 || >=24.0.0`
- DSH `0.1.2-rc.1` … `0.2.x`——`@deepseek-ai/dsh-llm|session|tools|storage-domain|brand` 的精确 peer 范围见
  `package.json`。宿主不在范围内会**直接拒绝安装**（`dsh plugin add` 会校验 peer）。
- HTML 邮件预览图需要 Chromium 内核浏览器（Edge/Chrome）；非 Windows 请显式配 `render.browser`。
- QQ 推送需要 QQ 官方机器人的 `appId` / `appSecret` 与接收人 `openid`。

## 安装

几种装法都能用，选一种：

**npm 安装**（发布后）：

```powershell
dsh plugin add dsh-mail-automation
```

**链接安装**（Windows 上就是 junction，插件页「从本地目录安装」给的是这种）。本仓库**就是**安装副本，
改完源码重启 DSH 即可：

```powershell
# 在 DSH 桌面端：设置 → 插件 → 从本地目录安装 → 选中本目录
# 然后重启 DSH
```

**拷贝安装**（`file:` 或 `npm pack` 出的 tarball）。profile 里是副本，改完必须同步：

```powershell
node sync.mjs      # 把 src/ client.js skills/ scripts/ locale/ docs/ 同步进 profile 安装副本
# 然后重启 DSH
```

实测 dsh `0.2.1-rc.3`：链接安装下 `@deepseek-ai/*` 照样解析（插件日志里是 `schema=bare-import`）。
插件**不往 profile 里写任何文件**。注意 **desktop profile 只能在应用内插件页重装**——`dsh` CLI 会拒绝它
（`profile "desktop" is managed exclusively by the Electron application`）。

## 配置

三层配置，后层覆盖前层：

1. `cordis.patch.yml` → `mail-automation` 那一行的 `config`（Schemastery 校验；profile 层可按 id 覆盖）
2. `configFile` 指向的 YAML 覆盖层——默认 `$DSH_HOME/mail-automation/mail-automation.yaml`，每轮轮询重读
3. `src/defaults.js` 里的内置默认值

日常只改覆盖层：保存后下一拍生效（提示词下一次处理/任务触发时生效）。`poll_seconds` 是 volatile；
`schedules` 变化会在下一次心跳自动重排，都不用重载插件。完整字段表见 [docs/configuration.md](docs/configuration.md)。

凭据尽量别写进 YAML，用引用：

```yaml
sources:
  - id: private
    name: 私人邮箱
    type: imap
    host: imap.qq.com
    user: me@qq.com
    password_ref: MAIL_PRIVATE_PASSWORD   # 经 ctx.credentials 解析
schedules:
  - id: digest
    name: 邮件总览
    schedule:
      type: daily                    # daily / weekly / monthly / interval / startup
      times: ["12:00", "21:00"]
    prompt_file: prompt/digest-prompt.md
  - id: boot
    name: 启动快照
    schedule:
      type: startup                  # 每次启动、基线完成后运行一次
    prompt_file: prompt/boot-prompt.md
qq:
  enabled: true
  openid: <接收人 openid>                 # appId/appSecret 默认解析 QQ_BOT_APP_ID / QQ_BOT_SECRET
```

## 快速开始

1. 按上面的方式安装并重启 DSH。
2. 写一份最小覆盖层（一个来源 + 你的 `openid`）到 `$DSH_HOME/mail-automation/mail-automation.yaml`。
3. 把 `MAIL_PRIVATE_PASSWORD`（以及可选的 `QQ_BOT_APP_ID` / `QQ_BOT_SECRET`）写进凭据页，或
   `$DSH_HOME/.credentials.yaml` 的 `refs:` 块。
4. 重启 DSH，看 `$DSH_HOME/mail-automation/mail-automation.log` 里有没有
   `插件加载 … schema=bare-import` 与 `已注册工具：qq_notify / …`。
5. 打开**设置 → 邮件助理**：应能看到来源、游标，以及 `startup.md` 里最新的 10 条邮件头。

## 工具

| 工具 | 作用 |
|---|---|
| `qq_notify` | 通过 QQ 官方机器人发一条消息 |
| `mail_automation_archive_read` | 只读**单封本地存档**（`text` / `html` / `image` / `raw` / `conclusion` / `meta`） |
| `mail_automation_archive_list` | 批量列存档（或指定 id），按需附加标题/时间/发件人/收件人/conclusion.md |
| `mail_automation_archive_clear` | 清理全部存档，或只清理给定的 id 列表（破坏性） |
| `mail_automation_status` | 轮询间隔、各定时任务、各来源游标、已存档数量 |
| `mail_automation_poll` | 立刻跑一轮（顺带解开卡住的那一轮） |
| `mail_automation_config` | 与设置页同一套操作：read / save_params / save_prompts / retry_failed / retry_poll |

两个存档 skill（`mail-automation-archive-batch` / `mail-automation-archive-clear`）会注册给 agent，两个批量工具默认在
`agent.tools` 里。

参数、返回值与 HTTP 接口见 [docs/api.md](docs/api.md)。

## 设置页

**设置 → 邮件助理** 有七个页签：**概览**（状态、上次/下次定时任务、状态后端、配置路径、各来源游标、「立即重试」）、
**已存档**（已保存在本地的邮件，带 ✓ / 失败 / 处理中 徽标；每封有「删除」按钮，第一次点变「确认删除」；「重试失败邮件」在块右上角）、
**邮箱**、**定时任务**（任意数量任务，各自排期与提示词，可立即运行）、**提示词**（普通/HTML 提示词，均在 `prompt/` 目录）、
**参数**（轮询/心跳/快照条数、静默模式、agent 工作区，以及邮件模型 / 思考强度 / 工具集）、
**指南**（可用变量、注释语法、内部 skill 的功能与调用方法）。
保存只就地改写 YAML 里改动的标量（保留注释），写前做整表校验；定时任务按整份数组写入并校验。

## 常见问题

- **完全不轮询** → 配置里没有 `sources`，或 `configFile` 指向不存在的文件（日志会点名路径）。
- **没有存档** → `password_ref` 没解析到（空凭据永远不算已配置），或 IMAP `STATUS` 返回不可用（本轮跳过、游标不动）。
- **每封都失败** → 看 `conclusion.md` 里的 `（agent 处理失败：…）`；父会话 priming 失败或子会话被 `agent/pre-step` 拒时日志会说。
  `mail-automation-agent` 预设有问题只损失省 token，会自动退回部署默认。
- **没有预览图** → 找不到 Edge/Chrome，配 `render.browser`；`render.remote_images: false` 还会挡掉远程图片/样式（防追踪像素）。
- **总览没跑** → `schedules` 里有非法条目（概览页会显示配置错误），或任务被禁用；日志里的
  `下次定时任务：…` 会点名下一条，`mail_automation_status` 会列出全部任务。
- **总览跑了但 QQ 没收到** → 看任务提示词有没有调 `qq_notify`，以及对应子会话的报错。插件不再代发、也不在运行时改提示词。
- **总览跑了但没清存档** → agent 回合失败，或 agent 报告了 `（QQ 发送失败：…）`。任务提示词需要 agent 在发送成功后自己调
  `archive_clear`。日志里都会带 `[schedule:<id>]`。
- **启动任务每次重启都跑、热重载不跑** → 这是设计：启动任务的槽每个进程只认领一次，同进程里的插件重载不算新启动。运行中新增/编辑的 `startup` 任务保存后显示「下次启动」，不会立刻执行。
- **设置页 404 / 空白** → `webServer` 缺失或路由被别的实例占用；插件只 WARN，不影响邮件处理。
- **从 0.7 升到 0.8（破坏性清理）**：`digest.*`、`schedules[].prompt` 内联、`prompt.inline`、`kind` /
  `consume_archive`、旧 Graph 令牌迁移、旧来源 id 游标沿用、旧提示词复制/注释剥离/skill 名改写、
  `mail_automation_digest` 工具全部删除。每条任务必须在 `schedules` 里显式写 `prompt_file`；提示词放 `prompt/`；
  Graph 使用按来源生成的令牌文件（`tokens/graph-<id>.json`，不再带文件夹后缀）。
  Graph 自动来源 id 为 `graph-<clientId>`（没有 clientId 时 `graph-mailbox`）；需要稳定键请显式写 `id`。

## 测试

```powershell
node test\entry.test.mjs     # 92 项：契约、注册顺序、卸载、凭据、设置页参数、定时任务
node test\issues.test.mjs    # 22 项：当前配置、存档工具、快照、前端不变量、收信与保存回归
node test\harness.mjs        # 假 ctx 跑整链（需要真实邮箱配置）
node src\cli.js config       # 打印解析后的配置（密码脱敏）
```

## 文档

- [docs/architecture.md](docs/architecture.md) —— 生命周期、模块、一封邮件的一生、并发、agent 模型、持久化
- [docs/configuration.md](docs/configuration.md) —— 全部字段、路径展开、volatile、已知边界
- [docs/api.md](docs/api.md) —— 工具、技能、设置页 HTTP 接口、CLI
- [docs/operations.md](docs/operations.md) —— 装法、文件位置、验证、故障定位、回滚
- [docs/lessons.md](docs/lessons.md) —— 指南没覆盖的运行语义（上一任经验）
- [docs/development.md](docs/development.md) —— 变更纪律、缺陷台账、check/doctor 结果
- [docs/multi-source.md](docs/multi-source.md) —— 新增 POP3 / Gmail API / Graph delta：provider 契约、坑与实施顺序

## 边界

- 对邮箱只读：不标已读、不移动、不删除服务器上的邮件。
- 只监控配置的文件夹，不做群发。
- agent 处理串行：一封邮件或一个定时任务跑完再跑下一个。
- 邮箱侧异常只写日志，不抛给宿主。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
