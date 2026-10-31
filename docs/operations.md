# 运维手册

> 装在哪、怎么重启、出问题看哪、怎么验证。架构见 [architecture.md](architecture.md)。

## 1. 部署形态（两种都支持）

| 形态 | 特征 | 改完源码怎么生效 |
|---|---|---|
| **链接安装**（`link:`，Windows 上是 junction；插件页"从本地目录安装"给的就是这种） | `profiles/<name>/node_modules/dsh-mail-automation` 是指向源码目录的链接 | 直接重启 DSH（源码即安装副本）；`node sync.mjs` 会提示"无需同步" |
| **拷贝安装**（`dsh plugin add file:<dir>`，或装 `pnpm pack` 出的 tarball） | profile 里是**副本** | `node sync.mjs` → 重启 DSH |

- 实测 dsh `0.2.1-rc.3`：链接安装下裸 `import '@deepseek-ai/dsh-llm'`（及 `dsh-session/dsh-tools/dsh-brand`）照样解析，
  插件日志会打 `schema=bare-import`。
- **desktop profile 只能在应用内插件页重装**：`dsh` CLI 会拒绝
  （`error: profile "desktop" is managed exclusively by the Electron application`）。
- 插件**不往 profile 里写任何文件**。

## 2. 运行期文件在哪

| 内容 | 默认位置 |
|---|---|
| 活配置（YAML 覆盖层） | `~/.dsh/mail-automation/mail-automation.yaml` |
| 提示词 | 同目录 `prompt/prompt.md` / `prompt/prompt-html.md` / `prompt/digest-prompt.md` / `prompt/<taskId>-prompt.md`（路径由配置决定） |
| 存档 / 快照 | `~/.dsh/mail-automation/archive`、`startup.md`（没有 `digest/` 输出目录） |
| 插件自落日志 | `~/.dsh/mail-automation/mail-automation.log`（>2 MB 轮转 `.1`） |
| 状态（正常路径） | `~/.dsh/storages/mail_automation_state.json`（域 `mail_automation_state`，4 张表；`meta.scheduleRuns` 存每任务上次运行/槽） |
| 状态（兜底） | `<storage.root>/state.json`（仅当宿主没有 storage-domain；CLI/补档脚本也用它） |
| Graph 令牌 | `~/.dsh/mail-automation/tokens/graph-<id>.json`（不含文件夹后缀；可在来源里用 `token_file` 改） |
| Gmail 令牌 | `~/.dsh/mail-automation/tokens/<id>.json`（默认；0600，原子写） |
| 凭据 | `~/.dsh/.credentials.yaml` 的 `refs:`（或凭据页写入）；QQ appSecret 扫码绑定写 `QQ_BOT_SECRET` |

## 3. 改完代码的标准流程

```powershell
cd <path-to-this-repo>
node test\entry.test.mjs        # 92 项：契约/注册/卸载/凭据/设置页参数/定时任务
node test\issues.test.mjs       # 22 项：当前配置/存档工具/快照/前端不变量/收信与保存回归
node sync.mjs                   # 仅拷贝安装需要；链接安装会提示"无需同步"
# 重启 DSH（插件加载在启动阶段）
```

**不要在 DSH 运行期间改 profile 的 `cordis.patch.yml`**：HMR 会重载整个插件层，
实测会丢 preset 工具、杀掉在途 turn，最坏把 `sessionController` 永久废掉（`unfixed-issues` T1）。

## 4. 验证清单

1. **日志**：`~/.dsh/mail-automation/mail-automation.log` 出现新的一行
   `插件加载：configFile=… profileDir=… schema=bare-import` + `已注册工具：qq_notify / …`，
   以及 `下次定时任务：「…」(id) 每天 … → …`（没有启用的任务时会写 `没有启用的定时任务`）。
   第一行**没有**就说明模块求值期就失败了（`dsh web` 下宿主日志可能没有 sink）。
2. **状态**：`~/.dsh/storages/mail_automation_state.json` 里 `sources` 有游标（IMAP：`uidValidity/uidNext`；Graph：`seenIds`），
   `agent.main.parentSessionId` 存在，`meta.main.scheduleRuns` 里每个跑过的任务有 `lastRunAt/lastSlot/lastStatus`。
3. **数据**：`archive/` 里是否出现新目录（`meta.json` + `body.txt`），`startup.md` 是否刚更新。
4. **离线**：`node test/entry.test.mjs`、`node test/issues.test.mjs`、`node test/harness.mjs`（假 ctx 跑整链）。
5. **静态**：
   ```powershell
   node "$DSH_HOME/profiles/<profile>/node_modules/dsh-plugin-guide/bin/dsh-plugin-dev.js" check --cwd .
   npx @perrylink/dsh-plugin-doctor --repo . --workspace <your-workspace>
   ```
   跑 doctor 前必须：把 `<your-workspace>\.bin` 前置到 PATH（`dsh plugin` 依赖**系统 pnpm**，
   本机 pnpm 只有 `.mjs` 入口），并设 `npm_config_cache` 到工作区（沙箱内 npx 写不了用户缓存）。
6. **真实行为**：设置页「概览」看状态 / `mail_automation_status` 工具 / 给自己发一封测试信，等 ≤ `poll_seconds`。
7. **邮箱管理**：设置页「邮箱」→ 每行点「测试连接」，应看到 `IMAP 登录成功…` / `POP3 登录成功…` /
   `Gmail 登录成功：…` / `Graph 登录成功：…`；新增一个来源后，「概览」的来源列表应立即多一行（游标显示"尚未建立基线"），
   下一拍变成 UID/UIDL/historyId。
8. **绑定**：Gmail/Graph 行点「绑定」→ 浏览器完成授权 → 对话框显示 `✓ 绑定完成`，行内徽标变「已绑定」；
   令牌文件出现在上表的位置。QQ 卡片点「扫码绑定 QQ 机器人」→ 出现二维码 → 手机 QQ 扫码确认 → 卡片显示「已绑定」。
   失败时对话框给的是**分类原因**（缺 clientId / 授权被拒 / 过期 / 网络），不是一句"失败"。
9. **定时任务**：设置页「定时任务」→ 添加一条 `startup` 任务（提示词随便写）→ 保存后**不会立刻执行**，
   状态显示「下次启动」；重启 DSH 后才出现 `[schedule:<id>] 开始执行`。再加一条间隔 1 分钟的
   `interval` 任务，到点应出现第二次日志，且 `state.json` / 域里的 `meta.scheduleRuns.<id>` 跟着更新。
   删除全部任务后概览显示「没有启用的定时任务」。

### 4b. 不能重启桌面 GUI 时的等价启动验证

用**临时 DSH_HOME + 临时 profile** 起一个真实的 `dsh web`：同样的宿主、同样的加载路径，不碰用户数据。

```powershell
# 1) 临时 DSH_HOME（内含 profiles\ 与 .credentials.yaml：必须 version: 1 + refs:）
$env:DSH_HOME = "$env:TEMP\dsh-smoke-home"
$env:PATH = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin;<your-workspace>\.bin;" + $env:PATH
# 2) 从发行模板克隆一个临时 web profile，并装入本插件
dsh --profile smokeweb --from-default-profile web --dump-config
dsh plugin --profile smokeweb add file:<path-to-this-repo>
# 3) 用插件的 bundle patch 启动（端口 0 = 随机；不打开浏览器）
dsh --profile smokeweb --patch .\cordis.patch.yml --port 0 --no-open
```

验证点：

- 插件日志出现 `插件加载` / `已注册工具` / `邮件预设已注册：mail-automation-agent` / `可用 agent 预设…mail-automation-agent`；
- `GET <url>/plugins/dsh-mail-automation/api` **不带**会话 cookie → `401`（路由存在且鉴权生效）；
- 用打印出的 `?token=` 换到 `dsh-auth-*` cookie 后再 GET → `200`，`sources[].typeLabel` 四协议齐全；
- `verify-source`（连不上的来源）→ `400` 且 `ok:false`；`save-source` 非法来源 → `400` 且文件不被改坏。

临时目录用完即删（不含用户数据）。

## 5. 故障定位

| 现象 | 先看 | 常见根因 |
|---|---|---|
| 完全不轮询 | 日志有没有"插件加载" | 配置无 `sources`；`configFile` 指向不存在的文件（换机器最常见，日志会点名路径） |
| 有基线、无新邮件 | `sources` 游标是否在动 | IMAP `STATUS` 异常（被 `imapStatusSane` 挡住，日志 WARN）；`password_ref` 没解析到 |
| 每封都失败 | `conclusion.md` 的 `（agent 处理失败：…）` | 父会话 priming 失败 / 子会话被 `pre-step` 拒 / preset 装配失败（看 `可用 agent 预设` 那行有没有 `(装配失败)`） |
| 同一封跑两遍 | `retries` 与 `conclusionState` | 陈旧 retry 记录；或轮次锁被接管过（日志"作废该轮"） |
| 定时任务不跑 | 日志 `下次定时任务` / 设置页「定时任务」 | `schedules` 里有非法条目（概览会显示粘性配置错误）、任务被禁用、或时区/时刻写错 |
| 到点但被跳过 | 日志 `[schedule:<id>] 到点但正在轮询` | 轮次锁被占：轮询时 5s 后重试（最多 24 次），处理时 60s×3；连续被占则本次跳过（存档未动） |
| 启动任务没执行 | 日志 `[schedule:<id>] 开始执行` | 配置错误导致 boot 没走到 `armSchedules`；或 hot reload 同进程（启动槽已认领，不重复） |
| 总览跑了但 QQ 没收到 | 子会话 | 提示词必须调 `qq_notify`；发送失败时正文末尾应有「（QQ 发送失败：…）」 |
| 总览发了但没清理存档 | 日志 `[schedule:<id>]` / agent 回合 | 任务提示词要求发送成功后调 `archive_clear`；agent 没调/回合失败/报告发送失败都会保留 |
| 同一任务跑了两遍 | `meta.scheduleRuns` 的 `lastSlot` | 同一槽只认领一次；若真重复，多半是手工把 `lastSlot` 改坏或两个 DSH 实例共用一个状态后端 |
| 没有预览图 | 日志"预览图渲染失败" | 找不到 Edge/Chrome（配 `render.browser`）；分片失败会 WARN 缺几片 |
| 设置页 404 / 空白 | 日志"设置页路由" | `webServer` 缺失或路由被别的实例占用（只 WARN，不影响邮件） |
| 轮次卡住不结束 | 日志"无进展" | 网络 I/O 不返回（看门狗会作废该轮）；总览轮只 WARN 不抢占 |
| 重启后多了"未分组"会话 | `agent.silent` / `agent.workspace` | 这两个变了会归档旧父会话并新建（签名变化）；属预期 |
| POP3 有基线、之后漏信 | 日志里有没有 `POP3 邮件已不在服务器上` | 别的客户端下载后删除了邮件（协议限制）；`UIDL` 不可用的服务器会在首轮就报错 |
| Gmail 每次启动都重建基线 | 日志 `historyId=… 已失效` | historyId 过期（几天到几周）；属预期，历史不会重放。频繁发生说明账号长期没轮询 |
| Gmail 绑定完成但取信 403 | 令牌文件里的 scope | OAuth 同意屏没勾 `gmail.readonly`；重新绑定并确认勾选 |
| Graph 绑定报 `invalid_client` / `AADSTS…` | 应用注册 | clientId/tenant 写错，或应用没允许"公共客户端流" |
| QQ 扫码一直 pending | 对话框与日志 | 没在手机上确认；10 分钟后会话过期，重新生成二维码 |
| QQ 扫码报反爬 HTML | 日志里的 HTTP 状态 | `q.qq.com` 接口/风控变化（第三方实现参考，未官方承诺）；用同一卡片的手填 AppID/openid/appSecret |
| 删了邮箱但存档还在 | `archive/` | 预期：删除来源默认保留存档；要删需在确认框里勾选"同时删除存档" |

## 6. 紧急操作

| 目的 | 做法 |
|---|---|
| 立刻再拉一轮（并解开卡住的那轮） | 设置页「立即重试拉取」，或 `mail_automation_poll`，或 `mail_automation_config{action:'retry_poll'}` |
| 重新排队所有"处理失败"的邮件 | 设置页「重试失败邮件（N）」或 `mail_automation_config{action:'retry_failed'}`（只排队，下一拍处理） |
| 补某一天的总览 | 缺存档就先 `node scripts/backfill-day.mjs <day>`，再让任务/agent 读取存档处理 |
| 立刻跑某条定时任务 | 设置页「定时任务」→ 该行「立即运行」（或 HTTP `run-task`）；不会认领排期槽、不影响下次时间 |
| 临时关掉一条定时任务 | 设置页「定时任务」里取消「启用」并保存（`enabled: false`）；不再排期，手动仍可运行 |
| 把启动快照推到 QQ | 加一条 `type: startup` 的任务，提示词写「用 qq_notify 把 `{{startup_snapshot}}` 发给我」 |
| 手工清空已存档队列 | 直接删 `archive/` 下的目录（会丢结论，谨慎）；或让任务/agent 处理后再清理 |
| 删除单封存档 | 设置页「已存档」每行「删除」→ 再点「确认删除」（只删本地目录，不碰邮箱）；或 agent 调 `archive_clear{ids:[id]}` |
| 换邮箱/改账号 | 改 YAML 的 `sources`（`id` 必须唯一）；**改 id、文件夹或协议等于新邮箱**：旧游标会删除并重新建基线。也可以直接在「邮箱」页签编辑 |
| 删除一个邮箱 | 「邮箱」页签 → 删除 → 再点「确认删除」（可勾选同时删未总览存档）。定义在 cordis.patch.yml 里的来源删不掉，会提示去 profile 改 |
| 重新授权 Gmail/Graph | 「邮箱」页签对应行点「绑定」；旧令牌文件会被原子覆盖（Graph 也可删掉对应的 `tokens/graph-*.json`） |
| QQ 机器人换绑/重绑 | 「邮箱」页签顶部卡片 →「重新扫码绑定」；也可手填 AppID/openid 并单独写 appSecret |

## 7. 回滚

- 代码：工作区是链接安装时直接 `git`/文件回滚后重启；拷贝安装要 `node sync.mjs` 再重启。
- 配置：`mail-automation.yaml` 是纯文本，改前先备份；设置页保存是**就地改标量 / 整份任务数组 + 整表校验**，失败不会写半份。
- 状态：`mail_automation_state.json` 是"域"格式（`unit/tables`），**不要手改**；要重建就让插件重新建基线
  （删文件后首次轮询会走 baseline，停机期间的邮件不会被补处理）。`meta.main.scheduleRuns` 删掉等于让每条任务
  "从未运行过"：日常任务会重新排下一次，`startup` 任务会在下一个进程启动时再跑一次。
- 存档：`archive/` 里没被清理的目录可以直接拷走留档；任务成功后由 agent 调 `archive_clear` 删除。

## 8. 备份建议

邮件助理的数据全在 `~/.dsh/mail-automation/` 与一个 domain JSON 里，体积小：

```powershell
Copy-Item -Recurse "$HOME\.dsh\mail-automation" "$HOME\Backups\mail-automation-$(Get-Date -Format yyyyMMdd)" -Force
Copy-Item "$HOME\.dsh\storages\mail_automation_state.json" "$HOME\Backups\mail-automation-state-$(Get-Date -Format yyyyMMdd).json" -Force
```

注意：YAML 里可能存着 `qq.app_secret`——备份目录别进公开仓库。
