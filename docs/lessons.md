# 运行语义（历史记录）

> **历史记录**：部分条目指向 0.8 已删除的功能（手动总览、`digest.*`、旧迁移）。当前契约以
> [development.md](development.md) 为准；本文只用于理解为什么某些护栏仍然存在。

## 1. `storageDomain` 的记录解析是**白名单**，字段会被静默丢弃 ✅

**现象**：在 `retries` 记录里加字段（例如"放弃标记"），写入成功、当次有效，重启后字段消失，行为回到原点，且**没有任何日志**。
**机制**：`storageDomain` 只保留 `domainTable(schema)` 里 `parse()` 返回的字段；未知键在 hydrate 时丢掉。
**现码**：`src/state-domain.js` 的四张表白名单（`STATE_RECORD_SCHEMAS`），注释已写明"漏列就会在装载时丢掉"。
**做法**：想加跨启动状态，先决定属于哪张表——能进白名单就改 schema（并考虑版本迁移），否则放 `meta.json` 这类自由格式文件；
**绝不**把标记塞进"本来就会被删掉的那条记录"（例如放弃重试时正要 `delete retries[key]`）。加字段必须带"重启后仍在"的回归。

## 2. 状态/元数据文件：完成标记必须**原子写**，否则截断即永久隐形 ✅

**现象**：进程被杀/断电后 `meta.json` 变半截 → `readMeta()` null → `listArchived()` 跳过、`adoptOrphans` 也看不见 → 邮件永久消失且无报错。
**机制**：`writeFileSync` 是原地截断写，绝不保证原子。
**现码**：`src/fsutil.js` 的 `atomicWriteFile`（同目录唯一 tmp → rename → 有界重试 → **绝不 copy 兜底**），
用在 7 处：4 处 meta、conclusion、`state.json`、Graph 令牌、digest。
**做法**：把文件分两类——**内容**（body/raw，可重写）与**提交标记**（meta/conclusion/token/state.json），后者一律原子写；
tmp 名带 pid+序号（并发写互相踩过）；rename 在 Windows 上会被杀软/预览占用（EPERM/EBUSY/EACCES），有界重试后上抛；
读路径要能识别并清理残留 tmp（`#clearStaleArtifacts` 清 `.*.tmp.<pid>.<n>`）。

## 3. `ctx.effect()` 同步抛错会拆掉**整个 fiber** 的全部 effect ✅

**现象**：设置页路由重复注册抛 `duplicate route`，结果不是"设置页坏了"，而是 `apply()` 中止、心跳/定时器/工具全部被撤销——**邮件监控直接停**。
**机制**：effect 回调里的同步异常会 finalize 后 rethrow，`_reload` 把整个 fiber 判 FAILED 并撤销全部 effect。指南只讲了可逆性，没讲"一个 effect 抛错会连坐"。
**现码**：`uiapi.js` 的路由注册就地 try/catch，重复路由只 WARN、其它注册错误记 ERROR、**绝不 rethrow**，
且失败时 `unregister` 保持 `undefined`（不去删别人的路由）。
**做法**：注册**外部资源**（HTTP 路由、全局监听、第三方句柄）时一律就地兜住；区分"必须让插件失败"（工具、skill 等核心契约）与"次要面失败"（设置页）。

## 4. 定时器与重试：**单句柄 + 分类预算**，不要"每个事件一个定时器" ✅

**现码（0.5 起）**：`state.scheduleTimer` 单槽，任何时刻只挂**最早**的一条任务；`armSchedules()` 从
`cfg.schedules` + `meta.scheduleRuns` 全量重算 `{at, slot}`。失败只分两类：`busy`（轮询占锁 5 s × 24；处理占锁 60 s × 3，
`planBusyRetry()`）与 `agent`（回合失败，不重试、只落盘状态）；保存配置/volatile 更新/心跳签名变化都走同一个
`armSchedules()`，不会留下互相顶掉的第二个句柄。定时任务持 `schedule` 锁且永不被看门狗抢占（只 WARN）。
**教训**：多个 `setTimeout` 各存一个句柄时，shutdown 只清得掉一个、保存配置又会把另一个清掉。

## 5. 回合超时/取消：`withTimeout` 只 reject，**不会停回合** ✅

**现象**：回合超时后代码继续走，但回合还在跑（烧 token、可能调 `qq_notify`），下一封的 `whenIdle()` 继续等它；串行链一旦被卡住，**之后每一封都排在死链上**。
**现码**：`agent.cancel(cause, options?)` → `{kind:'hook', reason}`（**不要用 `disposed`**，会让后续输入永久 park）→
`whenIdle()` **有界等待 15 s** → 停不稳就把会话记脏、本进程不再复用；`run.dispose()` 内部也是 cancel+whenIdle 的**无界 await**，
所以外面必须再包一层超时（20 s）；priming 遇 `timedOut` 要立即 break，不要重试 3 次（会把看门狗拖爆）。

## 6. 子智能体：父会话必须先在本进程里"有过回合" ✅

**现象**：父会话是重启后恢复的/刚建的，子智能体第一步就被 `agent/pre-step` 拒（`turn/end blocked`，一个 step 都没开）。
"父会话是否就绪"如果用 `events.some(assistant/message)` 扫全会话，恢复出来的历史消息会让它永远判"就绪"。
**现码**：`openerRoundProduced(before, events, text)` 只看**本次新增**事件或返回文本非空；失败记 `parentPrimeFailed`
但**保留 handle**（清了会触发换代风暴）；子会话真被拒时 `retryWithFreshParentIfBlocked()` 换一代、每进程一次。
**另两条**：**不要归档父会话**（会让它名下所有子会话不可用）；静默模式用 `origin:'subagent'` 创建，而不是"建完再归档"。

## 7. `exec.signal` 的真实语义：abort **不会**撤销副作用 ✅

**机制**：`exec.signal` 是 caller-owned、单次调用级；abort 后 body 仍会跑完，宿主在 body 返回后若已 abort 会把结果整体替换成
`Error: tool call aborted`。
**现码**：取消点只放不可逆边界**之前**（写盘/发送/提交游标之前）；越过边界后被取消，`cancelReplyLate()` 如实回报
"副作用可能已发生、结果未回报、不要重跑"，并记日志——不伪造"已取消"。
**禁止**为了"能中途停"把 signal 一路传进核心写路径：半完成态比跑完更危险。

## 8. 配置：YAML 覆盖层**不经** schemastery；schema 约束是 fail-loud，不是夹紧 ✅

**现象**：`initial_headers: 999` 在 YAML 覆盖层"合法"通过，界面显示 999，实际取数被内部夹到 50。
**机制**：`cordis.yml` 的 config 走 schema 校验；覆盖层走 `canonicalize → merge → normalize`，schema 完全不参与。
**现码**：夹紧在 `normalizeConfig`（唯一承重层）；schema 里**故意不写** `.max()`（写了只会让 cordis 里填 999 变成加载失败）。
**做法**：对"由展开值回写"的参数同时保留 **raw**（用户原文）与 **effective**（展开值）——`agent.workspaceRaw` vs `agent.workspace`；
路径类字段在 Store 里改成 getter，并在路径变化时拒绝把旧内存写进新文件（`storage.state_file` 已这么做）。

## 9. 设置页"正则改 YAML"的边界 ⚠️

**现象**：只改几个标量却可能造出重复键/坏 YAML；`monitor :`（冒号前空格）、`"monitor":`、BOM、行内 `{…}`、锚点 `&m`
都会让段定位失败，随后"追加到末尾"产生重复段。
**现码**：段定位容 BOM/引号/冒号前空格；**定位不到就报错、不 append**；非块状段落直接拒绝并告诉用户改成多行；
写前做**整表校验** `normalizeConfig(mergeConfig(base, overlay))`（只校验 overlay 会恒报"没有 sources"）；原子写并保留原 mode。
**未吸收**：`render: null` 这种"段存在、值为空"仍会被判成非块状而拒绝保存——将来把 `render.*` 接进设置页前要先处理。

## 10. 增量同步：`seen` 集合深度与"扫描窗口"不匹配会**批量重放历史** ✅

**事故**：Graph 的 `seenIds` 只有 49 个，而扫描窗口从 50 扩到 300 后，窗口里 250 封历史邮件被判成"新邮件"，每拍归档 50 封并逐封跑 agent——一晚把 3–4 月的旧信重跑一遍。
**现码**（`src/sources/graph.js`）：**位置判据**——列表按时间倒序，遇到第一个已见 id 之前的才是新邮件；
之后的"没见过但更旧"只标记已见、**绝不归档**；整窗没有任何已见 id（换机/状态重建/积压超窗）→ 重建基线 + WARN；
只有**真正交付**的批次才写 `seen`，未交付的保持"未见"下一轮继续（否则 >窗口 的新信会被静默吞掉）。
IMAP 同理用 `UIDVALIDITY + uidNext`：旧游标只在 validity 一致时沿用，否则重建基线。

## 11. 凭据：`ctx.credentials` 在 `apply` 早期可能不可用；文件兜底是**第二份实现** ✅

**做法**：运行时优先 `ctx.credentials.resolve(ref)`；拿不到值**不要**立刻回读 `.credentials.yaml` 并当成"已配置"
（会复活托管存储里已删除的旧值）；兜底限定为"provider 完全缺席"，且用**同一个 YAML 解析器**（正则扫 `refs:` 会漏 CRLF/小写键/转义引号）。
**现码**：`src/credentials.js` 只有一处文件兜底（层名 `credentials-file`），缝就绪后自动升级成 `credentials:<layer>`；
空值绝不算已配置；CLI/补档脚本没有 ctx，只能走文件（`resolveSecretsFromRefs`），但 id 规则与运行时**同一条**。

## 12. 文件系统/平台细节（Windows 为主）✅

- **`fs.realpathSync`（JS 版）不解析 Windows junction**，必须 `realpathSync.native`，并剥掉 `\\?\` 前缀（`\\?\UNC\…` 还原成 `\\server\share`）。
- `path.relative` 跨盘符/UNC 会返回**绝对路径**：判"是否在目录内"必须同时拒绝 `..` 前缀与 `path.isAbsolute(rel)`；`startsWith(root)` 不加分隔符会误判 `root2`。
- **目录内 ≠ 文件在目录内**：`body.txt` 可以是指向存档外的符号链接，读文件前要**逐文件**再校验一次。
- 原子 rename 的 EPERM/EBUSY/EACCES 要有界重试；tmp 名要唯一；清 tmp 不要碰正式文件。

## 13. Web/UI：主题里**没有 shadow token**；失败提示要有判别位 ✅

- `--dsw-alias-*` 只有颜色类 token；`--dsw-shadow-*`/`--dsw-elevation-*` 是固定黑 alpha，规范还禁止与 `--dsw-alias-border-*` 配对。
  硬编码 `rgba(0,0,0,.08)` 在深色下是黑雾，换 `tint(12)` 又变"亮边" → **能删阴影就删**，层次交给 border + 背景叠色。
- 任何"结果提示"都要带 `{ok,text}` 判别位：失败用 error 色 + `⚠` + `role="alert"`，成功 `✓` + `role="status"`（只靠颜色对色盲不友好）。
- 失败文案也要走 i18n（`tr()`），否则英文界面会冒后台返回的中文串。
- 路由注册失败要可观测：README/状态页/工具文本至少一处能回答"设置页通道是否 ok"。

## 14. 日志与可观测性：`console.warn` 在 `dsh web` 下可能**没有 sink** ⚠️

**现象**：纯模块习惯用 `console.warn`，但桌面/`dsh web` 下它不进插件日志，用户永远看不到"预览分片失败""跳过 N 封积压"。
**现码**：`render.js` 已经走 `onFallback` 注入；**唯一残留**是 `src/sources/graph.js` 里"写入 Graph 令牌失败"那一行 `console.warn`。
**做法**（未做）：给 graph.js 加 `setWarnSink(fn)`，`apply()` 注入 `log.warn`；CLI/补档脚本不注入就退回 console。
**纪律**：插件内统一用注入的 `logger`；"跳过/放弃/截断/降级"都是**状态变化**，必须留痕；一次操作只打一条汇总，不逐条刷屏。

## 15. 测试：`node --check` 不够；`unref` 定时器会让离线用例"静默退出" ✅

- **`withTimeout` 的 timer 通常是 `unref()` 的**（插件不能吊住进程）。测试里只 `await` 一个永不 resolve 的 promise，
  Node 会以 "unsettled top-level await" 直接退出而不是报超时——用例要自己持一个 ref 句柄。
- **`node --check` 只查语法**：作用域错误（`pollSource` 里引用 tick 的局部 `c`）和依赖缺失都要运行时才炸；
  部署前至少跑一次**真实入口 smoke**（`import('./src/index.js')` + 一次 `apply` 级测试）。
- 无 React 测试环境时，前端用**源码静态断言**守住：无硬编码颜色、`setDigestNote` 每个写点都带 `{ok:…}`、关键文案存在
  （`issues.test.mjs` 读了 `client.js` 源文本）；函数级作用域约束也可以静态断言（截函数体，断言不出现裸 `c.`）。
- 回归测试按"阶段"分节，每条断言对应一个具体事故/缺陷；改行为时同步改旧断言（C4 那两条旧语义正是事故根因）。

## 16. 部署与运维：`sync.mjs` 是白名单；一次性脚本不要"触发器 + 立即启动"双路径 ✅/📌

- `sync.mjs` 的 `ITEMS` 是**手写白名单**：新增根目录（如 `docs/`、`LICENSE`）要显式加进去，否则安装副本缺文件；
  同步后做**逐文件 SHA256 比对**（只允许 `test/`、`sync.mjs`、`package-lock.json` 不同）。
- 宿主插件加载在启动阶段：改完必须重启；`dsh web` 的 URL 每次重启会变。
- 工作区 `node_modules` 与安装副本是两套：安装副本从 profile 根解析依赖，工作区测试要自己的依赖。
- **一次性运维脚本的安全模式**（事故：任务跑两次）：不要同时"注册一次性触发器"和"立即 `Start-ScheduledTask`"；
  任务内 `schtasks /Delete` 删自己有竞态。正确姿势：要么只 `Start-ScheduledTask`（不设触发器），要么设触发器后**立刻确认任务已不存在**；
  脚本开头备份、结尾写人类可读报告；不在运行中的宿主里直接改状态文件；需要停宿主时延迟执行并用 try/finally 保证拉起。
- 链接安装下**不需要** `sync.mjs`（源码即副本），此时脚本只打印提示并 `exit 0`。

## 17. 协作/审查：三方独立提案 + 对抗性分析确实能抓到真问题 📌

流程：每个阶段 3 个互不共享上下文的子代理各写方案 → 主代理裁决 → 实现 → 双测试全绿 → 记录分歧。
收益可量化：**多次是复核而不是主代理发现真问题**——C9（JS `realpathSync` 不解析 junction；越界被 `query` 兜底成"读另一封"）、
G7（整表校验必须先 `mergeConfig(base, overlay)`）、C5/P-N1（域后端未 hydrate 时 `save()` 是假成功）、
U3（effect 抛错拆整个 fiber）、A3（放弃标记必须落 `meta.json`，域记录白名单会吃掉新字段）。
**每条修复必须回答三问**：① 会不会制造新的半完成态？② 失败路径是否可见？③ 有没有一条回归断言能在旧代码上失败？

## 18. 指南已经讲清楚、不要重复踩的部分 ✅

插件契约（`name` + `apply` + `inject`）、注册即 effect、waterfall 必须 `next()`、扩展点强弱选择；
工具 `defineTool` 的"`execute` 只返回 schema 值 / `render` 面向人 / presenter 纯函数"；
Schemastery 配置、`Volatile` + `loader/volatile-update`、settings 表单命名空间；
bundle/patch 清单、多 patch 数组、`!!js`、peer 依赖范围、`engines.dsh`、`files` 白名单；
UI 插件 slot 渲染、`--dsw-alias-*` token、静态 `dsh.client.inject`、`locale`/`icon` 元数据；
`cordis_inspect_*` 验证、`dsh --dump-config`、`dsh-plugin-dev check/verify`、`pack` 后试装；
`dsh web` 下 `apply` 抛错可能没有日志 sink（`unfixed-issues` T3）。

## 19. 本仓不做的上游提案 📌

建议加进 `dsh-plugin-guide` 的条目（记录在此，不要在本仓实现）：状态记录 schema 白名单与升级、文件写入原子性与"完成标记"、
effect 抛错的 fiber 级联、超时 ≠ 取消、子智能体父会话 priming、`exec.signal` 的边界语义、YAML 覆盖层绕过 schema、
增量同步的迁移语义（新章节）、Windows 文件系统细节、一次性运维脚本的安全模式。

## 20. 与指南快照的偏差（本仓实测更正）

这一轮里踩到几条"指南快照落后于宿主"的事实，已固化成 [architecture.md](architecture.md) 与
[development.md](development.md) 的结论：doctor 现在有 X 组（checkset 含 `+X1-X5`）；链接安装可用（旧说法是"必须真实目录"）；
`dsh --profile desktop --dump-config` 被宿主拒绝（desktop profile 由 Electron 独占）。

## 21. 0.3.x 这一轮新增的经验

1. **原生表单控件不能用半透明背景**：`<select>`/`<input>` 会先铺自己的白底，再叠我们的 `tint(6)`，
   深色主题下弹层变"白底白字"。给 select/option 用**不透明** token（`--dsw-alias-bg-layer-2`）并设 `colorScheme`。
2. **进度态不该靠"闪一下的标签"**：本地操作常在 10–50 ms 内完成，`保存中…/刷新中…` 只是噪音。
   改成"按钮文案恒定 + 成功后按钮短暂变 `已保存/已刷新` 并禁用 3 秒"，反馈可见且不抖宽度。
3. **`render: null` 是合法空段**：`setYamlScalar` 不能把它判成"非块状写法"而拒绝整次保存；
   `null/~` 归一成 `section:` 再插键（本机覆盖层里真的这么写过）。
4. **预设必须运行时注册，且失败要可见**：`agentPresets.register()` 成功 ≠ 装配成功（broken 挂在 roster 上）；
   注册后必须 `resolve()` 复查并写 `presetError`，供快照/设置页显示。
5. **模型必须成对**：`provider + model` 只填一半时 host 会按部署默认跑、只留一条 WARN；在 `saveParams` 写盘前直接拒绝。
6. **priming 失败要分类**：`turn/end` 的 `reason.kind=error`（如 401 AUTH）或"零事件"都不是抖动，
   立即 break 并记录原文，不要重试 3 次；凭据/模型类错误也**不要**换父会话（换了也一样）。
7. **换模型要重建父会话**：启动时模型不可用会让父会话处于"未热身"，换模型后沿用旧父会话可能先被 `pre-step` 拒一次；
   模型签名变化时 `resetParentForModelChange()`。
8. **工具集要允许自由写法**：目录 id / 工具名 / 任意 `@scope/包` 三种都认，按**包**去重合并，
   人设随工具集生成（不要写死"你没有网络"）。
9. **模型目录读宿主真实形状**：`ModelCatalog = { default, routableProviders, groups, failures }`；
   provider 列表来自 `groups`，模型能力（`reasoning.efforts`）来自 `group.models` —— 读错字段会让下拉永远为空。
10. **提示只属于"那次操作"**：切页要清（`notice`/`digestNote`/`pollNote`），并设置自动消失时间，否则会跨页残留。

## 22. 0.4 这一轮（多协议来源 + OAuth/扫码绑定）新增的经验

1. **"跳过失败的一封、继续推进游标"是丢信的标准写法**。Gmail 元数据批量取时只要有一封失败就必须**整批抛**、
   不提交 `historyId`；POP3 `RETR` 找不到 UIDL 要抛 `EGONE` 而不是空正文。两条都有回归（阶段31）。
2. **协议不同，游标语义就不同，但调用方的三条不变式不能变**：`mode/state` 由 provider 给，`shouldAdvanceCursor()`
   仍是唯一提交点。POP3 的"序号"只是会话内位置，**绝不能**进 `header.id` 或 `seenIds`（号码会因删除而平移）。
3. **OAuth 令牌是"读-改-写"**：refresh_token 会被平台轮换，文件锁 + 原子写缺一不可（`proper-lockfile` +
   `atomicWriteFile` 0600）。两个进程同时刷新会把对方的新值写旧，下一次就是 `invalid_grant`。
4. **绑定会话是外部资源**：Gmail 回环端口、QQ 一次性 task、Graph device code 都有 TTL；必须
   `disposeAll()` 挂到 shutdown，且 HTTP 轮询要能在"会话已过期"时给出可读原因（不是 500）。
5. **secret 永远不进快照/日志/HTTP 公开字段**：`readParams` 故意不含 `qq.app_secret`；`qq-bind-poll` 只回
   `{appId, openid}`；`save-secret` 只写不读且只允许 `QQ_BOT_SECRET / QQ_BOT_APP_ID`。QQ 的 `client_secret` 由
   宿主侧 `peekQqCredentials()` 读取、**全部落盘成功后**才 `consumeQqCredentials()` 擦除（写失败可重试）；
   不要从 `bind.result` 里读——`finish()` 的 `resultView` 只保留非敏感字段，早期实现就是在这里静默丢的。
6. **二维码是功能，不是主题**：主题 token 在深色模式下会把码反色，扫不出来。`client.js` 里唯一的字面色
   `background:'#fff'` 是有注释的例外，静态断言也把它钉住了。
7. **YAML 里改数组用 Document API**，不要正则拼 `sources:`。`YAML.parseDocument(...).set('sources', …)` 能保留其它段
   与注释；代价是该段自身的注释会被重排（文档已写明）。写前必须用**合并后的整表**做 `normalizeConfig` 校验。
8. **编辑表单"密码留空"必须等于"不改"**：快照不下发密码，如果按空值覆盖，用户点一次保存就静默丢了凭据。
   `upsertSource` 在没有新值、也没有改成引用名时保留旧 `password`/`client_secret`（有回归）。
9. **删除来源默认不删存档**：存档是用户数据，`archive/` 又是待总览队列。勾选框 + 二次确认才允许
   `deleteMails()`；游标则必须随来源删除，否则以后加回同 id 会接上一条指向别的账号的旧游标。
10. **`dsh-plugin-dev verify` 会在"compat profile 装 dsh-headless rc.2 / 运行 rc.3"处失败**（2026-10-31 实测），
    与插件代码无关。发布门禁以 `check` + 两套离线测试 + `test/harness.mjs` 为准，别把 verify 的 exit 1 当回归。
11. **两层 sources 必须按 id 合并，不能沿用 `mergeConfig` 的"数组整体替换"**：否则覆盖层新增一个邮箱，
    base（cordis.patch.yml）里的邮箱会在运行时静默消失。`composeConfig()` 是唯一合并入口，loadConfig 与整表校验共用。
12. **凭据写入必须排在整表校验之后**：漏填 host 的保存失败不该已经把别的来源正在用的 `password_ref` 改掉。
    写文件失败还要能回滚凭据；做不到就要在错误里说清楚。
13. **绑定会话的终态不可被晚到的 poll 覆盖**：用户取消/二维码过期后，在途请求回来仍会拿 completed 结果；
    `finish()` 拒绝从终态改写成别的状态，否则"取消"会变成"绑定成功"。
14. **单点游标（Gmail historyId）只能越过完整交付的记录**：分页未读完或单轮超 50 封时，
    推进到最后一条完整交付的 history 记录，不能使用响应里的信箱当前游标；元数据取不到则整轮不提交。
    单条记录未完成且游标不变时，去重集合不能按 `SEEN_CAP` 截断，否则会循环重放。
    POP3 用"最后一个已见 UIDL"的位置判据，不要用截断的集合直接 filter；本批任一取头失败必须阻止推进，避免后面的成功项越过失败项。

## 23. 0.5 这一轮（自定义定时任务 + 投递交给 agent）新增的经验

1. **单定时器槽在"任意数量任务"下依然是唯一正确形状**：`state.scheduleTimer` 永远只挂最早的那个 `setTimeout`；
   `armSchedules()` 每次都从配置 + `meta.scheduleRuns` 全量重算 `{at, slot}`，不为每条任务各存一个句柄。
   否则 save/volatile/重试三条路径会互相 clear 别人的定时器（§4 的同类事故）。
2. **定时发送要 at-most-once，邮件处理才要"宁可重复"**：发 QQ 重复一次是打扰，漏一封邮件只是下一轮再处理。
   所以任务在**开始执行前**就把 `lastSlot` 落盘（`lastStatus='running'`），崩溃重启后同槽不重跑；
   代价是"执行到一半崩了"这一槽不会再跑，`lastStatus=running` 会留在设置页提示。
3. **`startup` 任务的槽必须带"进程身份"**：`boot:<PROCESS_BOOT_ID>`。用固定字符串会让它一辈子只跑一次；
   用 `lastRunAt` 判断"是否本进程跑过"又分不清 hot reload。注意**同一进程里的插件重载不重跑**（模块缓存，
   `PROCESS_BOOT_ID` 不变）——这是有意的，别把它当 bug。
4. **删掉内置投递后，"是否送达"只有 agent 知道**：插件不再有 `delivery.ok` 可判断。约定"发送失败时在正文
   最后写「（QQ 发送失败：…）」"是唯一可靠的止损信号；`buildDigest` 看到它就不删存档。任何"turn ok 就等于
   已送达"的推断都是错的（agent 可能只是忘发）。
5. **旧提示词文件是迁移的一部分**：0.4 的 `digest-prompt.md` 只写"输出正文"，投递由代码做。直接删掉内置投递
   会让老用户**静默收不到 QQ**。`withDigestDeliveryInstruction()` 在运行时给不含 `qq_notify` 的总览提示词补一段
   硬要求；新装用户的默认提示词本身就写了发送步骤。
6. **月末、多时刻、间隔锚点都要用纯函数测**：`monthly` 的 31 号在没有该日的月份按**最后一天**跑（否则 2 月
   直接消失）；`interval` 从 `lastRunAt` 锚定、停机错过只补一次（补 N 次会连发 N 条）；`daily` 的 `nextScheduleAt`
   必须**严格大于** `now`（正好踩点启动不能立刻重跑）。
7. **`schedules` 数组也要按 id 合并，不能沿用 `mergeConfig` 的整体替换**：与 sources 同一条（§22.11）。
   否则 base（cordis.patch.yml）里的任务会在设置页保存一次后静默消失。
8. **配置节流与"已删除键"的可见性**：`schedules` 不标 volatile，但心跳每拍比较签名并重排——既避免了
   `loader/volatile-update` 只对 cordis 生效的问题，也不会每次心跳都重建定时器。0.5 删掉的
   `notify_on_start` / `digest.deliver` / `digest.include_agent_summary` 由 `normalizeConfig` 收集进 `cfg.deprecated`，
   启动时打一条 WARN："配置没生效但没报错"是老配置迁移里最容易被吞掉的一类故障。
9. **0.7 起不再写 `digest/` 输出**：总览/定时任务都靠 agent 直接发 QQ，落盘只保留 `archive/`；任务输出文件
   已删除，避免"目录存在但没人读"的僵尸状态。

## 24. 0.6 这一轮（目录迁移 / 提示词文件 / 前端分级）新增的经验

1. **默认路径迁移必须"复制 + 读路径回退旧文件"**：Graph 令牌从 `$DSH_HOME/graph-mail-token.json` 搬到
   `tokens/graph.json`、提示词搬进 `prompt/`。只改默认路径会让老用户"绑定还在、插件读不到"；迁移用原子写复制、
   **旧文件保留**，读路径在新文件缺失时回退旧位置（`graph.js` 的 `tokenFileOf` / `normalizeSource`）。
2. **"留空自动建文件"的默认路径必须可移植**：YAML 里写绝对路径会把本机路径固化（G3）。规则：在配置目录内写
   `prompt/<id>-prompt.md`，在 `$DSH_HOME` 内写 `$DSH_HOME/...`，否则才写绝对路径（`portablePromptRaw`）。
3. **删功能时把旧键收进 `deprecated` 并打 WARN**：0.6 删掉了 `digest.prompt_file` / `digest.inline_prompt`；
   静默忽略等于"改了没生效还查不出原因"（与 0.5 的 `notify_on_start` / `digest.deliver` 同一条）。
4. **前端组件顶层不要读可能为 null 的草稿**：`SchedulesPanel` 曾在 `draft=null`（刚打开页签）时构造
   `weekdayChecks`，读 `draft.weekdays` 直接抛错，React 把整个设置页卸载。表单只在 `draft` 非空的分支里构造；
   回归用 fake React 真渲染（阶段33），不要只做源码静态断言。
5. **按钮/文字分级集中到 `S` token**：`S.itemTitle / formLabel / textBody / textSmall / textSmallDim / textCaption /
   btnSm`。组件里再写 `fontSize: 12` 会让同一层级在不同页签漂移；例外只有二维码/验证码这种功能性大字。

## 25. 0.7 这一轮（去总览类型 / 批量存档工具）新增的经验

1. **删掉 `kind` 不能只删 UI**：默认 `id=digest` 任务的旧提示词还写着"清单附在末尾"，而调度器不再附加
   `pending_list`。`withArchiveToolInstructions()` 在运行时给不含 `mail_automation_archive_list` 的 digest 提示词
   补工具用法；否则升级后总览会"有提示词、没数据"。
2. **批量工具也必须 fail-closed**：`archive_list` / `archive_clear` 只通过 `store.listArchived()` 解析 id，
   不接受路径；`clear` 的 `ids: []` 明确拒绝（否则"空列表"会被误读成清理全部）。
3. **id 只能有一个权威定义**：用**存档目录名**做选择/清理的 id，`meta.id`（协议 id）只作为 `mail_id` 展示/兼容，
   避免不同 UIDVALIDITY 下同名协议 id 指向不同目录。
4. **清理是破坏性默认工具**：0.7 把 `archive_clear` 放进默认工具集（用户要求）；skill 与默认总览提示词必须写清
   "发送成功后才清、按用户给的 id 清、空数组拒绝"，否则一次提示注入就能清空存档。
5. **批次返回要有上限与缺失可见性**：`archive_list` 默认 1000 封上限、`max_conclusion_chars` 默认 4000，
   并在 `text`/`missing` 里明确"被截断/找不到"，避免模型把没返回的邮件当成不存在。
6. **默认提示词的历史注释只能一次性清**：`ensureDefaultPromptFiles()` 只对带旧标题
   （`# 邮件监控提示词` / `# 每日总览提示词`）的文件做 strip；不能每次启动都 strip，否则用户按指南新加的
   `# 注释` 会在下次启动被吞掉。指南页要把 `#` 头注释与 `<!-- -->` 两种语法写清楚。

## 26. 2026-11-07：system prompt 一变，折叠代理就把会话换了一条车道

**现象**：用户的主会话（31,559 条消息）突然不能继续对话。每条请求都被上游代理拒绝：

```
413 core-text profile: 24357 message(s), 19499215B core … duplicateRatio=0.042
{"error":{"type":"request_too_large","code":"egress_window_fuse","stage":"forward"}}
```

**机制**：billion-context（bili）的车道身份是「会话 id + **system prompt 的 sha256 前 16 位**」：

```js
function resolveSessionOrder(rawId, history, personaTag, declaredModel, …){
  const tag = personaTag ?? '';                 // = 整段 system prompt
  const tagHash = sha256(tag);
  const recorded = skeletons.get(rawId);
  if (tagChanged) { /* 四条 reanchor 启发式，全落空就往下走 */ }
  return { key: `${rawId}|sub:${fp16(tag)}` };  // 新车道，不继承折叠块
}
```

`provider` / `model` **不参与**这段哈希（`declaredModel` 只当 reanchor 的旁证）——所以"给后台 agent
换个 provider/key"并不能隔离身份，只能分隔配额。这一点我第一版写错了，后来对着 bili 的实际
metadata 才纠正过来。

事故当天该会话的 system prompt 从 16,480 token 变成 16,636（`sessions.metadata_json.systemPromptTokens`
可以直接对照两条车道），四条 `reanchor` 启发式全部落空——日志里最直白的一条是
`[resume-inheritance] miss: no byte-exact resume among 23 eligible chain(s)`——于是 31,347 条消息进了
`…|sub:c37b54e4…`：一条全新的车道，**不继承 base 的折叠块**，整段历史（19.5 MB）直接撞 bili 的
egress 闸门（`max(兜底字节, 窗口 × 7.5 B/token)`），413 且没有自愈路径（`bili` 没有离线 fold 命令，
`splitSessionWarnings` 又恰好跳过这种 `personaNamespace` 会话）。

**第二环**才是让事故"卡死"的原因：bili 的 `growthFoldingArmed()` 要求
`externalSummary.enabled === true && autoFold === true` 且有 target；没开就走 fail-fast 分支，
`probeForEvidence` 直接把注定超窗的请求判掉，连折叠都不试。

**现码**：

- `src/budget.js`：`sessionFootprint` / `evaluateSessionBudget` / `evaluatePromptBudget` /
  `detectBillionContext` / `readBillionContextConfig` / `billionContextFoldVerdict`（纯函数，`fs`/`home` 可注入）。
- `src/agent.js`：`sessionBudgetBytes()` + `ensureParent` 的换代分支（父会话超预算 → 归档 + 新建）、
  `runInner` 的 daily 分支（当天会话超预算 → 弃用换新）、`runInSession` 的提示词闸门。
- `src/index.js`：`warnIfBillionContextUnarmed()`（启动时一次，仅 bili 在场且没开自动折叠时）。
- 配置：`agent.session_budget_mb`（默认 8）、`agent.prompt_max_kb`（默认 512）。

**做法（再遇到"后台 agent + 折叠代理"这类组合）**：

1. **先确认代理按什么认身份**：这类代理多半按 system prompt（或首条消息）认，换 provider 不解决问题。
   读它的实现/元数据，别按直觉写结论——我第一版就写成了「provider 身份 + system prompt」并据此给了错误建议。
2. **把折叠武装起来**：`compress.externalSummary.enabled + autoFold + targets`。开了它，超窗时先折叠
   再送；不开就只能 fail-fast 413，而且这个失败发生在插件看不见的地方。
3. **给会话设体积上限**，别指望外部折叠永远成功：会话一旦超过模型窗口，每条新请求都必然失败，
   而失败发生在插件看不见的地方，表现为"agent 处理失败 → 重试 → 再失败"的死循环。
   换代（归档 + 新建）是唯一在插件控制范围内的自愈手段。
4. **单条提示词也要设闸**：巨长邮件正文/上万封的存档清单能在**一条请求内**超窗，这跟历史长度无关。
5. **改 system prompt 是有代价的**：装/卸插件、改工具集、甚至代理自己往 system prompt 里注入说明
   （bili 就会注入压缩工具说明、marker 完整性说明、generation-boundary 说明），都可能让会话中途换车道。
   大改动尽量放在会话开始前，或者接受"折叠需要重建"这件事。
6. **不要用"删会话文件"修 413**：会话日志是 DSH 的内存 + 磁盘双写，进程退出时会把旧尾巴追加回去；
   而且裁剪过的 seq 一旦对不上，会话会直接从侧边栏消失（本次的第二个事故）。

