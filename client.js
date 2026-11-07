/**
 * dsh-mail-automation 的桌面端设置页（浏览器半侧）。
 *
 * 形态：`settings.section` 的一条设置页（`id: mail-automation`），在设置面板左侧导航里
 * 与 General / Models / Plugins / QQ 机器人并列。
 *
 * 三条与官方 UI 约定对齐的地方（对照 dsh-plugin-guide §4.8 与 UI 技能 references/ui-plugin.md）：
 *   - 只渲染 slot 里的 React 组件，不碰 document.body、不 iframe 托管页面；
 *   - 样式全部用 `--dsw-alias-*` 主题 token（下面 TOKENS 里的就是 cordis_inspect Theme 列出的那批）；
 *   - `require('react')` 由宿主模块表提供，不重复装 React、不 require 任何 Harness Client 包。
 *
 * 数据通道：GET/POST `/plugins/dsh-mail-automation/api`（host 侧 src/uiapi.js 注册）。
 * 同一套操作也暴露给 agent（`mail_automation_config` 工具），见技能 references/user-actions.md。
 */
window.__ModuleLoader__.load({
  id: 'dsh-mail-automation',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useLayoutEffect } = React;

    const API = '/plugins/dsh-mail-automation/api';

    const GUIDE_ZH = `可用变量

普通邮件 / HTML 邮件提示词：
  {{source}}          来源名
  {{subject}}         邮件主题
  {{from}}            发件人
  {{date}}            邮件时间
  {{now}}             本机当前时间
  {{mail_dir}}        这封邮件的存档目录
  {{mail_file}}       正文文件（body.txt）
  {{conclusion_file}} 结论文件（conclusion.md）
  {{preview_file}}    预览图（preview.png）

定时任务提示词：
  {{now}} / {{date}}        本机当前时间 / 日期
  {{task_id}} / {{task_name}} 任务 id / 显示名
  {{pending_count}}         本次选中的存档封数
  {{pending_list}}          逐封清单（最多 80 封）
  {{pending_omitted}}       清单被省略的封数
  {{archive_dir}}           存档根目录
  {{snapshot_file}}         启动快照文件
  {{startup_snapshot}}      启动快照文本（最多 8000 字）

写法：{{变量名}}，只替换已知变量，未知变量原样保留，区分大小写。

注释方法

1. 文件开头连续的「# + 空格」行视为注释，整块丢弃；注释块中间可以夹空行。
2. 正文任意位置的 <!-- 注释 --> 会被删除。
3. 正文标题请用 ## 起；单个 # 只用于文件头注释。
4. 注释不会进入模型；保存后下一封邮件 / 下一轮任务生效。

内部 skills

qq-notify
  通过 QQ 官方机器人发主动消息。何时发、怎么排版、什么不该发。
  工具：qq_notify

mail-automation-archive
  读单封本地存档：text / html / image / raw / conclusion / meta。
  工具：mail_automation_archive_read（可传 id 或 file）

mail-automation-archive-batch
  批量列存档 id；可附加标题/时间/发件人/收件人/conclusion.md；
  可用 ids 只返回指定邮件。适合总览、批量分类。
  工具：mail_automation_archive_list

mail-automation-archive-clear
  清理全部存档，或按 id 列表清理；破坏性，发送成功后或用户明确要求时才用。
  工具：mail_automation_archive_clear

怎么让模型使用内部 skill

0. 默认提示词直接点名工具（archive_list / archive_clear / qq_notify）；
   skill 只是可选的详细说明书，不是调用工具的前提。
1. 在提示词里直接点名，例如：
   「使用 mail-automation-archive-batch 技能读取所有存档，再用 qq_notify 发送总览。」
2. 模型会通过 skill 工具加载该技能的正文，再调用对应工具。
   如果 agent.tools 里没有 skill，到「参数」页把它加进工具集。
3. 也可以直接点名工具（例如 mail_automation_archive_list），只要它在
   agent.tools 里，模型就能直接调用。
4. 不要在提示词里复制 skill 全文；点名技能 + 写清目标即可。`;

    const GUIDE_EN = `Available variables

Mail / HTML mail prompts:
  {{source}}          source name
  {{subject}}         subject
  {{from}}            sender
  {{date}}            mail date
  {{now}}             local current time
  {{mail_dir}}        this mail's archive folder
  {{mail_file}}       body file (body.txt)
  {{conclusion_file}} conclusion file (conclusion.md)
  {{preview_file}}    preview image (preview.png)

Scheduled task prompts:
  {{now}} / {{date}}          local current time / date
  {{task_id}} / {{task_name}} task id / display name
  {{pending_count}}           archives selected for this run
  {{pending_list}}            per-mail inventory (up to 80)
  {{pending_omitted}}         omitted inventory count
  {{archive_dir}}             archive root
  {{snapshot_file}}           startup snapshot file
  {{startup_snapshot}}        startup snapshot text (up to 8000 chars)

Syntax: {{name}}; known names are replaced, unknown names are left as-is (case-sensitive).

Comments

1. A contiguous block of "# " lines at the top of the file is a comment and is removed.
2. Any <!-- comment --> in the body is removed.
3. Use ## for body headings; a single # is reserved for the top comment block.
4. Comments never reach the model; saving takes effect on the next mail / next run.

Internal skills

qq-notify
  Send a proactive QQ message: when to send, formatting, what never to send.
  Tool: qq_notify

mail-automation-archive
  Read one local archive: text / html / image / raw / conclusion / meta.
  Tool: mail_automation_archive_read (accepts id or file)

mail-automation-archive-batch
  List archive ids; optionally attach subject/date/from/to/conclusion.md;
  restrict with ids. For digests and batch triage.
  Tool: mail_automation_archive_list

mail-automation-archive-clear
  Clear all archives or a list of ids; destructive, only after a successful send
  or an explicit user request.
  Tool: mail_automation_archive_clear

How to make the model use a skill

0. The default prompt names tools directly (archive_list / archive_clear / qq_notify);
   skills are optional detailed instructions, not a prerequisite for calling tools.
1. Name it in the prompt, e.g.:
   "Use the mail-automation-archive-batch skill to read the archive, then send the digest with qq_notify."
2. The model loads the skill body with the skill tool, then calls the tools.
   If skill is missing from agent.tools, add it on the Settings tab.
3. You can also name the tool directly (e.g. mail_automation_archive_list);
   as long as it is in agent.tools the model can call it.
4. Do not paste the whole skill into the prompt; name the skill and state the goal.`;

    /** 文案：中英两份。走 ctx.locale，跟随界面语言。 */
    const ZH = {
      'section.title': '邮件自动化',
      'tab.status': '概览',
      'tab.mail': '已存档',
      'tab.prompts': '提示词',
      'tab.guide': '指南',
      'tab.schedules': '定时任务',
      'tab.params': '参数',
      'status.title': '工作状态',
      'status.running': '正在轮询',
      'status.processing': '正在处理',
      'status.task': '正在执行定时任务',
      'status.idle': '空闲（等待下一拍）',
      'status.booting': '正在启动',
      'status.waitingSetup': '等待绑定邮箱',
      'status.stopped': '未就绪',
      'status.lastTick': '上次拉取',
      'status.never': '尚未执行',
      'status.nextSchedule': '下次定时任务',
      'status.backend': '状态存储',
      'status.config': '配置文件',
      'status.archive': '存档目录',
      'status.error': '最近错误',
      'status.retryPoll': '立即重试拉取',
      'status.retrying': '重试中…',
      'status.retryDone': '已重新拉取',
      'status.sources': '邮箱来源',
      'status.noSources': '无邮箱来源',
      'setup.title': '还没有绑定邮箱',
      'setup.hint': '添加一个 IMAP / POP3 邮箱，或绑定 Gmail / Microsoft Graph。配置完成前插件保持空闲。',
      'setup.action': '去添加 / 绑定',
      'status.manageSources': '管理',
      'status.progress': '进度：',
      'mail.title': '已存档的邮件',
      'mail.empty': '还没有存档邮件。',
      'mail.hint': '可用定时任务清理存档邮件',
      'mail.count': '共 {n} 封',
      'col.done': '已处理',
      'col.time': '时间',
      'col.source': '来源',
      'col.from': '发件人',
      'col.subject': '主题',
      'col.processing': '处理中',
      'col.pending': '待处理',
      'col.failed': '失败',
      'mail.retrying': '排队中…',
      'mail.retryFailed': '重试失败邮件（{n}）',
      'mail.retryQueued': '已排队 {n} 封，下一拍开始处理',
      'mail.retryNone': '没有处理失败的邮件',
      'mail.delete': '删除',
      'mail.confirmDelete': '确认删除',
      'mail.deleteHint': '删除这封本地存档（不碰邮箱）',
      'mail.deleted': '已删除 {n} 封存档',
      'prompts.title': '编辑提示词',
      'prompts.hint': '保存后下一封邮件立即生效，不需要重启。定时任务各自的提示词在「定时任务」页签里编辑。',
      'guide.title': '提示词指南',
      'guide.content': GUIDE_ZH,
      'prompts.mail': '普通邮件',
      'prompts.html': 'HTML 邮件',
      'prompts.missing': '（文件不存在，当前用的是内置兜底文案）',
      'params.title': '运行参数',
      'params.hint': '写入 mail-automation.yaml（注释与其它字段保持原样）。保存后立刻重读配置。',
      'param.poll': '轮询间隔（秒）',
      'param.heartbeat': '心跳间隔（秒）',
      'param.busyRetry': '定时任务撞上轮询：重试间隔（秒）',
      'param.busyRetryMax': '定时任务撞上轮询：最多重试次数',
      'param.busyRetryHint': '只影响“到点撞上轮询”的退避；有独立定时器，不会被心跳间隔拖慢。撞上 agent 处理邮件会60秒后重试，最多3次。',
      'param.heartbeatHint': '心跳只控制“多久检查一次轮询/配置”，改完需重载。',
      'param.headers': '启动快照条数',
      'param.silent': '静默处理（不在侧边栏显示会话；重启生效）',
      'param.sessionBudget': '单个会话体积上限（MB）',
      'param.sessionBudgetHint': '父会话/每日会话累计超过它就归档换代；0 = 不限制。会话太长会让每条请求都注定失败。',
      'param.promptMaxKb': '单条提示词上限（KB）',
      'param.promptMaxKbHint': '超过就拒绝发送并把这封记为失败（附字节数）；0 = 不限制。',
      'param.workspace': '邮件 agent 工作区',
      'param.workspaceHint': '未选择工作区时的会话落点；留空则使用 $DSH_HOME/workspace/default。（重启生效；改动会归档旧父会话并新建）',
      'param.modelTitle': '邮件 agent 的模型与工具',
      'param.provider': '模型 provider',
      'param.model': '模型',
      'param.followDeploy': '跟随部署默认',
      'param.modelsUnavailable': '拿不到宿主的模型目录：可以直接手填 provider / 模型 id',
      'param.effort': '思考强度',
      'param.tools': '可用工具',
      'param.toolsHint': '只影响邮件子 agent；改完下一封邮件/定时任务生效。每多一个工具，每封邮件的固定前缀就更长。',
      'param.toolsBuiltin': '默认工具全部删掉后，子 agent 不会拿到任何工具。',
      'param.toolsRemove': '删除这一行',
      'param.toolsAdd': '＋ 添加一行',
      'param.toolsPlaceholder': '工具名或模块名，例如 read_image / read / grep / web_fetch / @scope/plugin',
      'param.toolsOk': '✓ 可挂载',
      'param.toolsModule': '✓ 模块',
      'param.toolsBad': '✗ 未识别',
      'preset.title': '邮件预设',
      'preset.ok': '已注册',
      'preset.missing': '未注册（邮件 agent 用部署默认预设）',
      'param.toolsDefault': '（默认：archive_read / qq_notify / read_image）',
      'param.renderTitle': 'HTML 邮件预览图',
      'param.renderWidth': '视口宽度（px）',
      'param.renderSliceHeight': '每片最大高度（px）',
      'param.renderSliceOverlap': '切片重叠（px）',
      'param.renderMaxHeight': '整页最大高度（px）',
      'param.renderRemoteImages': '允许远程图片/样式（关掉可避免\"打开即已读\"的追踪像素）',
      'param.renderBrowser': '浏览器路径',
      'param.renderBrowserHint': '留空 = 自动探测 Edge/Chrome；非 Windows 请显式填写',
      // ── 定时任务 ──
      'schedules.title': '定时任务',
      'schedules.hint': '到点后由 agent 按各自的提示词执行。',
      'schedules.empty': '还没有定时任务。',
      'schedules.add': '添加任务',
      'schedules.addClose': '收起',
      'schedules.edit': '编辑',
      'schedules.editClose': '收起',
      'schedules.delete': '删除',
      'schedules.confirmDelete': '确认删除',
      'schedules.run': '立即运行',
      'schedules.running': '执行中…',
      'schedules.busyHint': '正在轮询/处理邮件，运行会稍后重试',
      'schedules.saved': '定时任务已保存',
      'schedules.deleted': '定时任务已删除',
      'schedules.name': '名称',
      'schedules.id': '内部 ID（留空自动派生）',
      'schedules.enabled': '启用',
      'schedules.type': '排期',
      'schedule.daily': '每天',
      'schedule.weekly': '每周',
      'schedule.monthly': '每月',
      'schedule.interval': '固定间隔',
      'schedule.startup': '每次启动',
      'schedules.times': '时刻（HH:MM，多个用逗号分隔）',
      'schedules.weekdays': '星期（1=周一 … 7=周日）',
      'schedules.days': '每月哪几天（1–31）',
      'schedules.everyMinutes': '间隔（分钟）',
      'schedules.prompt': '提示词',
      'schedules.promptMissing': '还没有填入提示词',
      'schedules.promptFile': '提示词文件（可选）',
      'schedules.promptFileHint': '留空 = 自动创建 prompt/<内部ID>-prompt.md（所有提示词统一放 prompt 文件夹）；填了则写到该路径。',
      'schedules.next': '下次',
      'schedules.last': '上次',
      'schedules.never': '尚未运行',
      'schedules.statusSucceeded': '{ago}运行成功',
      'schedules.statusRetry': '{n} 秒后重试',
      'schedules.statusRunning': '运行中',
      'schedules.statusFailed': '运行失败',
      'schedules.statusNever': '未运行',
      'schedules.statusDeferred': '下次启动',
      'schedules.statusDisabled': '已停用',
      'schedules.agoSeconds': '{n} 秒前',
      'schedules.agoMinutes': '{n} 分钟前',
      'schedules.agoHours': '{n} 小时前',
      'schedules.agoDays': '{n} 天前',
      'schedules.runDone': '已运行：{name}（{n} 封）',
      'schedules.runFailed': '运行失败：',
      'schedules.startupHint': '启动任务在每次插件启动、基线完成后运行一次（每个进程一次）。',
      'action.save': '保存',
      'action.saving': '保存中…',

      'action.reset': '取消',
      'msg.saved': '已保存',
      'msg.loadFailed': '读取状态失败：',
      'msg.saveFailed': '保存失败：',
      'msg.dirty': '有未保存的修改',
      'ago.second': '秒前',
      'ago.minute': '分钟前',
      'ago.hour': '小时前',
      'ago.day': '天前',
      'justNow': '刚刚',
      // ── 邮箱与绑定（多邮箱 + OAuth + QQ 扫码） ──
      'tab.sources': '邮箱',
      'sources.title': '邮箱来源',
      'sources.hint': '这里的增删改都会保存到配置文件。新添加的邮箱第一次只记下当前位置，不会把以前的旧邮件当成新邮件。',
      'sources.add': '添加邮箱',
      'sources.addClose': '收起',
      'sources.edit': '编辑',
      'sources.editClose': '收起',
      'sources.delete': '删除',
      'sources.test': '测试连接',
      'sources.testing': '测试中…',
      'sources.bound': '已绑定',
      'sources.unbound': '未绑定',
      'sources.editable': '可编辑',
      'sources.readonly': '来自 cordis 配置（只读）',
      'sources.empty': '还没有邮箱来源。点「添加邮箱」用表单新建，或直接改 YAML。',
      'sources.deleteConfirm': '确认删除',
      'sources.deleteArchives': '同时删除该邮箱尚未总览的存档（不可恢复）',
      'sources.saved': '邮箱已保存（下一拍生效）',
      'sources.deleted': '邮箱已删除',
      'sources.required': '请至少填写名称；账号密码类邮箱还需要 host + user',
      'source.addTitle': '添加邮箱',
      'source.editTitle': '编辑邮箱',
      'source.name': '显示名',
      'source.id': '内部 ID（留空自动派生）',
      'source.type': '协议',
      'source.provider': '服务商预设',
      'source.providerCustom': '自定义',
      'source.host': '服务器',
      'source.port': '端口',
      'source.secure': 'TLS',
      'source.user': '账号（邮箱地址）',
      'source.password': '密码 / 授权码',
      'source.passwordKeep': '留空 = 不改',
      'source.credential': '授权码 / 密码',
      'source.credentialPlain': '明文',
      'source.credentialRef': '引用',
      'source.credentialPlainHint': '明文会写入 mail-automation.yaml；更推荐改用左侧「引用」（引用名在 DSH 凭据页创建）',
      'source.passwordRef': '密码引用名（凭据页的 ref，推荐）',
      'source.passwordRefHint': '例如 QQ_MAIL_PASSWORD（在 DSH 凭据页创建）；填了引用名就不用在这里写密码',
      'source.mailbox': '文件夹',
      'source.folder': '文件夹 / 标签',
      'source.clientId': 'OAuth 客户端 id',
      'source.clientSecret': 'OAuth 客户端 secret',
      'source.clientSecretRef': 'secret 的凭据引用名',
      'source.clientSecretRefHint': '例如 GMAIL_CLIENT_SECRET（在 DSH 凭据页创建）；填了引用名就不用在这里写 secret',
      'source.tenant': 'Microsoft 租户（common / 租户 id）',
      'source.tokenFile': '令牌文件（留空用默认位置）',
      'source.oauth2Hint': '保存后点下方「登录」完成设备码授权。OAuth2 只申请只读权限：offline_access + IMAP.AccessAsUser.All（不会发信）。',
      'source.oauth2ClientHint': 'Azure 应用注册的公共客户端 ID（需允许公共客户端流）',
      'bind.start': '绑定',
      'bind.qqTitle': 'QQ 官方机器人',
      'bind.qqHint': '扫码把机器人绑定到本机：自动写入 AppID、接收人 openid 与 appSecret（凭据页）。',
      'bind.qqStart': '扫码绑定 QQ 机器人',
      'bind.qqRebind': '重新扫码绑定',
      'action.close': '关闭',
      'bind.qqBound': '已绑定',
      'bind.qqManual': '手动填写',
      'bind.qqManualClose': '收起手动填写',
      'bind.qrAlt': 'QQ 机器人绑定二维码',
      'bind.qrHint': '用手机 QQ 扫码，按页面提示确认绑定',
      'bind.qqPageHint': '手机页面可能一直显示「连接中」：插件已拿到 AppID/openid，可关闭该页面，不影响 QQ 推送。',
      'bind.openLink': '或点此打开链接',
      'bind.userCode': '在浏览器打开链接并输入代码：',
      'bind.waiting': '等待授权…（关闭对话框可取消）',
      'bind.done': '绑定完成',
      'bind.failed': '绑定失败：',
      'bind.expired': '已过期，请重新发起',
      'bind.cancel': '取消绑定',
      'bind.manualTitle': '无法自动接收回调，请手动粘贴授权码',
      'bind.codePlaceholder': '粘贴完整回调 URL（含 code=…）或授权码',
      'bind.complete': '完成绑定',
      'bind.appId': 'AppID',
      'bind.openid': 'openid',
      'bind.manualTitle2': '手动填写（扫码不可用时）',
      'bind.secret': 'appSecret（写入凭据 QQ_BOT_SECRET）',
      'bind.secretSave': '写入凭据',
      'bind.secretSaved': 'appSecret 已写入凭据',
      'bind.saveIds': '保存 AppID / openid',
      'bind.idsSaved': 'AppID / openid 已保存',
      'bind.hintGmail': 'Gmail 需要在 Google Cloud 创建「桌面应用」OAuth 客户端并填 clientId / secret。',
      'bind.hintGraph': 'Graph 需要 Azure 应用注册（公共客户端）并填 clientId / tenant。',
    };
    const EN = {
      'section.title': 'Mail Automation',
      'tab.status': 'Overview',
      'tab.mail': 'Archived',
      'tab.prompts': 'Prompts',
      'tab.guide': 'Guide',
      'tab.schedules': 'Schedules',
      'tab.params': 'Settings',
      'status.title': 'Status',
      'status.running': 'Polling',
      'status.processing': 'Processing',
      'status.task': 'Running a scheduled task',
      'status.idle': 'Idle (waiting for next tick)',
      'status.booting': 'Starting',
      'status.waitingSetup': 'Waiting for a mailbox',
      'status.stopped': 'Not ready',
      'status.lastTick': 'Last fetch',
      'status.never': 'Never',
      'status.nextSchedule': 'Next scheduled task',
      'status.backend': 'State store',
      'status.config': 'Config file',
      'status.archive': 'Archive',
      'status.error': 'Last error',
      'status.retryPoll': 'Retry now',
      'status.retrying': 'Retrying…',
      'status.retryDone': 'Polled again',
      'status.sources': 'Mailboxes',
      'status.noSources': 'No mailboxes',
      'setup.title': 'No mailbox configured',
      'setup.hint': 'Add an IMAP / POP3 mailbox or bind Gmail / Microsoft Graph. The plugin stays idle until then.',
      'setup.action': 'Add or bind',
      'status.manageSources': 'Manage',
      'status.progress': 'Progress:',
      'mail.title': 'Archived mails',
      'mail.empty': 'No archived mail.',
      'mail.hint': 'Scheduled tasks can clean up archived mail.',
      'mail.count': '{n} item(s)',
      'col.done': 'Done',
      'col.time': 'Time',
      'col.source': 'Source',
      'col.from': 'From',
      'col.subject': 'Subject',
      'col.processing': 'Processing',
      'col.pending': 'Pending',
      'col.failed': 'Failed',
      'mail.retrying': 'Queueing…',
      'mail.retryFailed': 'Retry failed ({n})',
      'mail.retryQueued': 'Queued {n}; starts on the next tick',
      'mail.retryNone': 'No failed mail',
      'mail.delete': 'Delete',
      'mail.confirmDelete': 'Confirm delete',
      'mail.deleteHint': 'Delete this local archive (mailbox untouched)',
      'mail.deleted': 'Deleted {n} archive(s)',
      'prompts.title': 'Edit prompts',
      'prompts.hint': 'Saving takes effect on the next mail; no restart needed. Each scheduled task has its own prompt on the Schedules tab.',
      'guide.title': 'Prompt guide',
      'guide.content': GUIDE_EN,
      'prompts.mail': 'Plain mail',
      'prompts.html': 'HTML mail',
      'prompts.missing': ' (file missing — the built-in fallback text is in use)',
      'params.title': 'Runtime settings',
      'params.hint': 'Written into mail-automation.yaml, keeping comments and other fields. Config is re-read on save.',
      'param.poll': 'Poll interval (s)',
      'param.heartbeat': 'Heartbeat (s)',
      'param.busyRetry': 'Scheduled task vs poll: retry interval (s)',
      'param.busyRetryMax': 'Scheduled task vs poll: max retries',
      'param.busyRetryHint': 'Only affects backing off when a scheduled run hits a poll; the scheduler has its own timer and is not slowed down by the heartbeat. Agent-processing collisions retry after 60s, at most 3 times.',
      'param.heartbeatHint': 'Heartbeat only controls how often polling/config changes are checked; it needs a reload.',
      'param.headers': 'Startup headers',
      'param.silent': 'Silent (hide sessions from the sidebar; takes effect after a restart)',
      'param.sessionBudget': 'Per-session size limit (MB)',
      'param.sessionBudgetHint': 'A parent or daily session that grows past this is archived and replaced; 0 = no limit. An oversized session makes every request fail.',
      'param.promptMaxKb': 'Per-prompt size limit (KB)',
      'param.promptMaxKbHint': 'A prompt past this is not sent and the mail is marked failed (with the byte count); 0 = no limit.',
      'param.workspace': 'Mail agent workspace',
      'param.workspaceHint': 'Where sessions land when no workspace is selected; empty uses $DSH_HOME/workspace/default. (Takes effect after a restart; a changed value archives the old session and creates a new one.)',
      'param.modelTitle': 'Model and tools for the mail agent',
      'param.provider': 'Model provider',
      'param.model': 'Model',
      'param.followDeploy': 'Follow the deployment default',
      'param.modelsUnavailable': 'The host model catalog is unavailable: type the provider / model id directly',
      'param.effort': 'Reasoning effort',
      'param.tools': 'Allowed tools',
      'param.toolsHint': 'Only affects the per-mail sub-agent; takes effect on the next mail/scheduled task. Every extra tool enlarges the fixed prefix per mail.',
      'param.toolsBuiltin': 'If you remove all default tools, the sub-agent gets no tools at all.',
      'param.toolsRemove': 'Remove row',
      'param.toolsAdd': '+ Add row',
      'param.toolsPlaceholder': 'tool or module, e.g. read_image / read / grep / web_fetch / @scope/plugin',
      'param.toolsOk': '✓ resolvable',
      'param.toolsModule': '✓ module',
      'param.toolsBad': '✗ unknown',
      'preset.title': 'Mail preset',
      'preset.ok': 'registered',
      'preset.missing': 'not registered (mail agent uses the deployment preset)',
      'param.toolsDefault': '(default: archive_read / qq_notify / read_image)',
      'param.renderTitle': 'HTML preview image',
      'param.renderWidth': 'Viewport width (px)',
      'param.renderSliceHeight': 'Max slice height (px)',
      'param.renderSliceOverlap': 'Slice overlap (px)',
      'param.renderMaxHeight': 'Max page height (px)',
      'param.renderRemoteImages': 'Allow remote images/styles (off blocks tracking pixels)',
      'param.renderBrowser': 'Browser path',
      'param.renderBrowserHint': 'Empty = auto-detect Edge/Chrome; set it explicitly off Windows',
      // ── scheduled tasks ──
      'schedules.title': 'Scheduled tasks',
      'schedules.hint': 'At the scheduled time the agent runs with its own prompt.',
      'schedules.empty': 'No scheduled task yet.',
      'schedules.add': 'Add task',
      'schedules.addClose': 'Close',
      'schedules.edit': 'Edit',
      'schedules.editClose': 'Close',
      'schedules.delete': 'Delete',
      'schedules.confirmDelete': 'Confirm delete',
      'schedules.run': 'Run now',
      'schedules.running': 'Running…',
      'schedules.busyHint': 'Polling/processing mail; the run will retry shortly',
      'schedules.saved': 'Scheduled tasks saved',
      'schedules.deleted': 'Scheduled task deleted',
      'schedules.name': 'Name',
      'schedules.id': 'Internal id (auto when empty)',
      'schedules.enabled': 'Enabled',
      'schedules.type': 'Schedule',
      'schedule.daily': 'Daily',
      'schedule.weekly': 'Weekly',
      'schedule.monthly': 'Monthly',
      'schedule.interval': 'Fixed interval',
      'schedule.startup': 'On startup',
      'schedules.times': 'Times (HH:MM, comma separated)',
      'schedules.weekdays': 'Weekdays (1=Mon … 7=Sun)',
      'schedules.days': 'Days of month (1–31)',
      'schedules.everyMinutes': 'Interval (minutes)',
      'schedules.prompt': 'Prompt',
      'schedules.promptMissing': 'Prompt is required',
      'schedules.promptFile': 'Prompt file (optional)',
      'schedules.promptFileHint': 'Empty = create prompt/<id>-prompt.md automatically (all prompts live in the prompt folder); otherwise write to that path.',
      'schedules.next': 'Next',
      'schedules.last': 'Last',
      'schedules.never': 'never',
      'schedules.statusSucceeded': 'Succeeded {ago}',
      'schedules.statusRetry': 'Retry in {n}s',
      'schedules.statusRunning': 'Running',
      'schedules.statusFailed': 'Run failed',
      'schedules.statusNever': 'Not run',
      'schedules.statusDeferred': 'Next startup',
      'schedules.statusDisabled': 'Disabled',
      'schedules.agoSeconds': '{n}s ago',
      'schedules.agoMinutes': '{n}m ago',
      'schedules.agoHours': '{n}h ago',
      'schedules.agoDays': '{n}d ago',
      'schedules.runDone': 'Ran: {name} ({n} mail)',
      'schedules.runFailed': 'Run failed: ',
      'schedules.startupHint': 'A startup task runs once per plugin start, after the baseline.',
      'action.save': 'Save',
      'action.saving': 'Saving…',

      'action.reset': 'Cancel',
      'msg.saved': 'Saved',
      'msg.loadFailed': 'Failed to load state: ',
      'msg.saveFailed': 'Save failed: ',
      'msg.dirty': 'Unsaved changes',
      'ago.second': 's ago',
      'ago.minute': 'min ago',
      'ago.hour': 'h ago',
      'ago.day': 'd ago',
      'justNow': 'just now',
      // ── mailboxes & binding ──
      'tab.sources': 'Mailboxes',
      'sources.title': 'Mailbox sources',
      'sources.hint': 'Changes here are saved to the config file. A new mailbox only records its current position on the first run — older mail is not treated as new.',
      'sources.add': 'Add mailbox',
      'sources.addClose': 'Close',
      'sources.edit': 'Edit',
      'sources.editClose': 'Close',
      'sources.delete': 'Delete',
      'sources.test': 'Test',
      'sources.testing': 'Testing…',
      'sources.bound': 'Bound',
      'sources.unbound': 'Not bound',
      'sources.editable': 'editable',
      'sources.readonly': 'from cordis config (read-only)',
      'sources.empty': 'No mailbox sources yet. Use "Add mailbox" or edit the YAML directly.',
      'sources.deleteConfirm': 'Confirm delete',
      'sources.deleteArchives': 'Also delete this mailbox\'s not-yet-summarised archives (irreversible)',
      'sources.saved': 'Mailbox saved (takes effect next tick)',
      'sources.deleted': 'Mailbox deleted',
      'sources.required': 'Name is required; account/password mailboxes also need host + user',
      'source.addTitle': 'Add mailbox',
      'source.editTitle': 'Edit mailbox',
      'source.name': 'Display name',
      'source.id': 'Internal ID (blank = derived)',
      'source.type': 'Protocol',
      'source.provider': 'Provider preset',
      'source.providerCustom': 'Custom',
      'source.host': 'Server',
      'source.port': 'Port',
      'source.secure': 'TLS',
      'source.user': 'Account (email address)',
      'source.password': 'Password / app password',
      'source.passwordKeep': 'blank = keep existing',
      'source.credential': 'App password / password',
      'source.credentialPlain': 'Plain',
      'source.credentialRef': 'Ref',
      'source.credentialPlainHint': 'Stored in mail-automation.yaml — a credential ref is safer (create it on the DSH credentials page)',
      'source.passwordRef': 'Password credential ref (recommended)',
      'source.passwordRefHint': 'e.g. QQ_MAIL_PASSWORD (create it on the DSH credentials page); with a ref you do not store the password here',
      'source.mailbox': 'Folder',
      'source.folder': 'Folder / label',
      'source.clientId': 'OAuth client id',
      'source.clientSecret': 'OAuth client secret',
      'source.clientSecretRef': 'Secret credential ref',
      'source.clientSecretRefHint': 'e.g. GMAIL_CLIENT_SECRET (create it on the DSH credentials page); with a ref you do not store the secret here',
      'source.tenant': 'Microsoft tenant (common / tenant id)',
      'source.tokenFile': 'Token file (blank = default)',
      'source.oauth2Hint': 'Save, then click “Log in” below to finish the device-code flow. Read-only scopes: offline_access + IMAP.AccessAsUser.All (no mail sending).',
      'source.oauth2ClientHint': 'Public-client ID from the Azure app registration (public client flow enabled)',
      'bind.start': 'Bind',
      'bind.qqTitle': 'QQ official bot',
      'bind.qqHint': 'Scan to bind the bot to this machine: AppID, recipient openid and appSecret (credentials) are written automatically.',
      'bind.qqStart': 'Scan to bind QQ bot',
      'bind.qqRebind': 'Re-bind with QR',
      'action.close': 'Close',
      'bind.qqBound': 'Bound',
      'bind.qqManual': 'Manual entry',
      'bind.qqManualClose': 'Hide manual entry',
      'bind.qrAlt': 'QQ bot binding QR code',
      'bind.qrHint': 'Scan with mobile QQ and confirm on the page',
      'bind.qqPageHint': 'The phone page may keep showing “Connecting”: the plugin already received AppID/openid. You can close it; QQ notifications still work.',
      'bind.openLink': 'or open this link',
      'bind.userCode': 'Open the link in a browser and enter the code:',
      'bind.waiting': 'Waiting for authorisation… (close to cancel)',
      'bind.done': 'Binding complete',
      'bind.failed': 'Binding failed: ',
      'bind.expired': 'Expired — start again',
      'bind.cancel': 'Cancel binding',
      'bind.manualTitle': 'Cannot receive the callback automatically — paste the code',
      'bind.codePlaceholder': 'Paste the full callback URL (with code=…) or the code',
      'bind.complete': 'Complete binding',
      'bind.appId': 'AppID',
      'bind.openid': 'openid',
      'bind.manualTitle2': 'Manual entry (if QR binding is unavailable)',
      'bind.secret': 'appSecret (stored as QQ_BOT_SECRET)',
      'bind.secretSave': 'Save secret',
      'bind.secretSaved': 'appSecret stored',
      'bind.saveIds': 'Save AppID / openid',
      'bind.idsSaved': 'AppID / openid saved',
      'bind.hintGmail': 'Gmail needs a "Desktop app" OAuth client from Google Cloud (clientId / secret).',
      'bind.hintGraph': 'Graph needs an Azure app registration (public client) with clientId / tenant.',
    };

    /* ── 样式：只用主题 token ───────────────────────────────────────── */
    const T = {
      bg: 'var(--dsw-alias-bg-base)',
      layer: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      text: 'var(--dsw-alias-label-primary)',
      dim: 'var(--dsw-alias-label-secondary)',
      brand: 'var(--dsw-alias-brand-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    };
    /**
     * 叠色（elevation tint）：用**文字色**按百分比混到透明，压在父容器上。
     *
     * 为什么不用 `--dsw-alias-bg-layer-1/2`：实测这套主题里，设置面板的内容区本身就等于
     * `layer-2`（卡片用 layer-2 直接"消失"），而浅色模式下 base/layer-1/layer-2 全是纯白
     * （三层分不开）。文字色则永远与背景反相——浅色下压出浅灰、深色下压出稍亮的灰，
     * 两种模式都单调地往外抬一层，不依赖任何具体 token 取值。
     */
    const tint = (percent) => `color-mix(in srgb, var(--dsw-alias-label-primary) ${percent}%, transparent)`;
    /** 官方 DSH 设置页按钮：浅边框/透明底，主操作反色填充，8px 圆角 */
    const buttonBase = {
      appearance: 'none', font: 'inherit',
      border: `1px solid ${T.borderStrong}`, background: 'transparent', color: T.dim,
      borderRadius: 8, padding: '5px 14px', fontSize: 13, lineHeight: 1.5,
      minHeight: 32, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      whiteSpace: 'nowrap', flexShrink: 0, cursor: 'pointer',
    };
    /** 右上角/行内操作：和标题匹配的紧凑按钮；保存类仍用 buttonBase */
    const buttonCompact = {
      ...buttonBase, minHeight: 28, padding: '3px 10px', fontSize: 12, borderRadius: 7,
    };
    const S = {
      /*
       * 设置页的滚动容器是宿主壳（不是这个 div），所以 `scrollbar-gutter` 加在这里管不到它：
       * 展开表单让页面变长 → 外层滚动条出现 → 内容宽度少约 10px → 标题/提示重新折行。
       * 这里不常驻滚动条：宽度由组件按“带滚动条时的可用宽度”显式锁定（adjustContentWidth），
       * 滚动条出现/消失都不改变内容宽度。
       */
      page: {
        display: 'flex', flexDirection: 'column', gap: 12, color: T.text, minWidth: 0,
      },
      head: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      title: { fontSize: 16, fontWeight: 600, margin: 0 },
      dot: { width: 8, height: 8, borderRadius: 4, flex: '0 0 auto' },
      tabs: { display: 'flex', gap: 4, borderBottom: `1px solid ${T.borderStrong}`, padding: '8px 0 0', flexWrap: 'wrap' },
      tab: {
        border: 'none', background: 'transparent', color: T.dim, cursor: 'pointer',
        padding: '6px 12px 8px', borderRadius: '6px 6px 0 0', fontSize: 13,
        fontWeight: 500, lineHeight: 1.5, borderBottom: '2px solid transparent', marginBottom: -1,
        transition: 'color 160ms ease, border-color 160ms ease',
      },
      tabActive: { background: 'transparent', color: T.text, fontWeight: 600, borderBottom: `2px solid ${T.brand}` },
      // 卡片：叠一层 6% 文字色 + 更强的边框。层次靠叠色单调抬升（浅色/深色都不会
      // "三层纯白"或"第二层消失"），不画投影：主题里没有 alias 级的 shadow token，
      // 写死 rgba 在深色下是黑雾、换成 tint(12) 又是亮边——都不如交给边框（U1）。
      card: {
        border: `1px solid ${T.borderStrong}`, borderRadius: 10, background: tint(6), padding: 12,
        display: 'flex', flexDirection: 'column', gap: 8,
      },
      cardTitle: { fontSize: 13, fontWeight: 600, margin: 0, color: T.text, lineHeight: 1.5 },
      // 文字分级：页面标题 16 / 卡片标题 13 / 条目名 13 加粗 / 表单标签 12 加粗 /
      // 正文 13 / 小字 12 / 说明 11。组件里不再各写 fontSize。
      itemTitle: { fontSize: 13, fontWeight: 600, color: T.text, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      formLabel: { fontSize: 12, fontWeight: 600, color: T.text },
      textBody: { fontSize: 13, lineHeight: 1.45 },
      textSmall: { fontSize: 12, lineHeight: 1.45 },
      textSmallDim: { fontSize: 12, color: T.dim, lineHeight: 1.45 },
      textCaption: { fontSize: 11, color: T.dim, lineHeight: 1.45 },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 10 },
      row: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
      label: { fontSize: 11, color: T.dim },
      value: { fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, color: T.dim, overflowWrap: 'anywhere' },
      badge: {
        // nowrap 是必需的：允许换行时"处理中…"会被挤成两行（实测）
        fontSize: 11, lineHeight: 1.3, padding: '1px 6px', borderRadius: 999, whiteSpace: 'nowrap',
        border: `1px solid ${T.border}`, color: T.dim,
      },
      /** 待总览列表：两行式（主题一行、时间·来源·发件人一行），长内容单行省略 */
      mailList: { display: 'flex', flexDirection: 'column', minWidth: 0 },
      mailRow: {
        display: 'flex', alignItems: 'flex-start', gap: 10, minWidth: 0,
        padding: '7px 2px', borderBottom: `1px solid ${T.border}`,
      },
      // 状态列：固定宽度才能让各行的主题左边缘对齐；宽度按当前语言的最长徽标算，
      // 免得中文界面里留一大片空白（英文 "Processing" 比"处理中"宽，也不能切掉）。
      mailState: { display: 'flex', alignItems: 'center', paddingTop: 1, flex: '0 0 auto' },
      mailMain: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 },
      mailSubject: { fontSize: 13, lineHeight: 1.45, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      mailMeta: { fontSize: 11, lineHeight: 1.45, color: T.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      /** 禁用态：内联样式不会自动吃到 UA 的 :disabled 灰化，手动给一份 */
      btnDisabled: { opacity: 0.45, cursor: 'not-allowed' },
      btn: buttonBase,
      // 标题右侧/行内操作：紧凑尺寸；保存类用 btn/btnPrimary 的普通尺寸
      btnSm: buttonCompact,
      // 主按钮：官方设置页的"保存"——主文字色填充、底色文字，透明边框
      btnPrimary: {
        border: '1px solid transparent', background: T.text, color: T.bg, fontWeight: 500,
      },
      // 标签会变的按钮（保存 ↔ 保存中…）：宽度由当前语言的文案算出、文字居中，避免点一下按钮就抖一下
      btnFixed: { textAlign: 'center', justifyContent: 'center' },
      // 次级按钮：同尺寸浅边框，弱化文字；危险操作用调用点自己的 error 色覆盖
      btnGhost: { border: `1px solid ${T.borderStrong}`, background: 'transparent', color: T.dim },
      // 角落的小操作（例如删除一行工具）：官方 field reset 那种纯文字按钮
      btnLink: {
        appearance: 'none', font: 'inherit', border: 'none', background: 'transparent',
        color: T.dim, padding: '0 2px', minHeight: 0, borderRadius: 0,
        fontSize: 12, lineHeight: 1.5, cursor: 'pointer',
      },
      actions: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      actionsEnd: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' },
      field: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
      // 输入控件：在卡片那层 6% 之上再叠 6%（合成约 12%），所以比卡片更实一档；
      // 即便浏览器不支持 color-mix，border-l2 也仍然勾出边界。
      input: {
        background: tint(6), color: T.text, border: `1px solid ${T.borderStrong}`,
        borderRadius: 6, padding: '5px 8px', fontSize: 13, lineHeight: 1.3, minHeight: 30,
        width: '100%', boxSizing: 'border-box',
      },
      textarea: {
        background: tint(6), color: T.text, border: `1px solid ${T.borderStrong}`, borderRadius: 8,
        padding: 8, fontSize: 12, lineHeight: 1.5, minHeight: 132, resize: 'vertical',
        width: '100%', boxSizing: 'border-box', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      },
      /*
       * `<select>` 不能直接用 S.input：原生控件会**先铺自己的白底**，再叠我们的半透明 tint，
       * 深色主题下弹层就成了"白底 + 浅色字"（实测：思考强度/模型两个下拉看不见选项）。
       * 所以 select 与 option 都用**不透明** token；`colorScheme` 跟随主题（深浅各一套原生控件配色）。
       */
      select: {
        background: T.layer2, color: T.text, border: `1px solid ${T.borderStrong}`,
        borderRadius: 6, padding: '5px 8px', fontSize: 13, lineHeight: 1.3, minHeight: 30,
        width: '100%', boxSizing: 'border-box',
        colorScheme: 'light dark',
      },
      option: { background: T.layer2, color: T.text },
      notice: { fontSize: 12 },
      empty: { fontSize: 12, color: T.dim },
      check: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 },
    };

    const clock = (value) => {
      if (!value) return '';
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return String(value);
      return d.toLocaleString();
    };
    /**
     * 邮件时间 → 本地时区的 `YYYY-MM-DD HH:mm`。
     * 后端存的是 ISO(UTC)，直接切字符串会把 UTC 当本地时间显示（比英国夏令时少 1 小时），
     * 容易被当成另一封邮件，所以这里显式按本地时区格式化。
     */
    const ipTime = (value) => {
      if (!value) return '';
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return String(value).replace('T', ' ').slice(0, 16);
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    };
    const relTime = (ms, tr) => {
      if (!ms) return '';
      const diff = Date.now() - ms;
      if (diff < 5 * 1000) return tr('justNow');
      if (diff < 3600e3) return `${Math.round(diff / 1000)} ${tr('ago.second')}`;
      if (diff < 86400e3) return `${Math.round(diff / 60000)} ${tr('ago.minute')}`;
      if (diff < 7 * 86400e3) return `${Math.round(diff / 3600e3)} ${tr('ago.hour')}`;
      return `${Math.round(diff / 86400e3)} ${tr('ago.day')}`;
    };
    const fmt = (template, vars) => String(template).replace(/\{(\w+)\}/g, (all, key) => (vars && key in vars ? String(vars[key]) : all));

    /**
     * 原生滚动条宽度（量一次）。overlay 滚动条返回 0——那种情况下本来就不占宽度。
     * 只在需要"预留滚动条宽度"时用；探针挂到 body 上量完立刻移除，不参与渲染。
     */
    const scrollbarWidth = (() => {
      let cached;
      return () => {
        if (cached !== undefined) return cached;
        try {
          const probe = document.createElement('div');
          probe.style.cssText = 'position:absolute;top:-9999px;left:-9999px;width:100px;height:100px;overflow-y:scroll';
          document.body.appendChild(probe);
          cached = probe.offsetWidth - probe.clientWidth;
          probe.remove();
        } catch {
          cached = 0;
        }
        return cached;
      };
    })();

    /** 向上找真正滚动的容器：设置页的滚动条属于宿主壳，不是插件里的 page div */
    function scrollContainerOf(el) {
      let node = el && el.parentElement;
      while (node && node !== document.body && node !== document.documentElement) {
        try {
          if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node;
        } catch {
          // ignore
        }
        node = node.parentElement;
      }
      return document.scrollingElement || document.documentElement;
    }

    async function callApi(action, payload) {
      const init = action
        ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...(payload || {}) }) }
        : { method: 'GET' };
      const res = await fetch(API, { ...init, cache: 'no-store' });
      let data = null;
      try {
        data = await res.json();
      } catch {
        throw new Error(`HTTP ${res.status}（响应不是 JSON）`);
      }
      if (!res.ok || !data || data.ok === false) {
        // 失败响应也可能带快照（部分成功的绑定）：挂到 error 上，调用方可以回灌 UI
        const error = new Error((data && data.error) || `HTTP ${res.status}`);
        error.data = data;
        throw error;
      }
      return data;
    }

    /* ── 组件 ──────────────────────────────────────────────────────── */
    /**
     * 自动高度的提示词编辑器：按内容撑开，`minHeight` 保证可点，`maxHeight` 之后内部滚动。
     *
     * 用 JS 而不是只写死 minHeight：三段提示词长短差很多（普通/HTML 只有一行，总览很长），
     * 固定 132px 会让前两个留下大片空白、整页又被撑出滚动条。宽度变化时重算（页面宽度锁会改 width）。
     */
    function PromptEditor({ id, value, onChange }) {
      const ref = useRef(null);
      const resize = () => {
        const el = ref.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${Math.min(180, Math.max(56, el.scrollHeight + 2))}px`;
      };
      useLayoutEffect(resize, [value]);
      useEffect(() => {
        const el = ref.current;
        if (!el) return undefined;
        resize();
        let lastWidth = 0;
        let observer;
        try {
          observer = new ResizeObserver((entries) => {
            const width = entries[0]?.contentRect?.width ?? 0;
            // 只对宽度变化重算：高度是我们自己设的，观察高度会自激
            if (Math.abs(width - lastWidth) > 1) {
              lastWidth = width;
              resize();
            }
          });
          observer.observe(el);
        } catch {
          observer = undefined;
        }
        window.addEventListener('resize', resize);
        return () => {
          try {
            observer?.disconnect();
          } catch {
            // ignore
          }
          window.removeEventListener('resize', resize);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return h('textarea', {
        id,
        ref,
        rows: 1,
        style: { ...S.textarea, minHeight: 56, maxHeight: 180, overflowY: 'auto' },
        value,
        spellCheck: false,
        onChange: (event) => onChange(event.target.value),
      });
    }

    function StatusDot(state, tr) {
      if (state.disposed) return { color: T.idle, text: tr('status.stopped') };
      // 还没配置邮箱：这是"等待绑定"而不是"正在启动"（baselined 会一直是 false）
      if (state.setupRequired) return { color: T.warn, text: tr('status.waitingSetup') };
      if (state.lastError) return { color: T.error, text: tr('status.stopped') };
      // activity 比 running 更细：轮询结束后还要把邮件逐封交给 agent（processing），
      // 那段时间不能继续显示"正在轮询"。
      if (state.activity === 'processing') return { color: T.ok, text: tr('status.processing') };
      if (state.activity === 'task') return { color: T.ok, text: tr('status.task') };
      if (state.running) return { color: T.ok, text: tr('status.running') };
      if (state.booting || !state.baselined) return { color: T.warn, text: tr('status.booting') };
      return { color: T.ok, text: tr('status.idle') };
    }

    function Value(p) {
      return h('div', { style: S.row }, h('div', { style: S.label }, p.label), h('div', { style: S.value, title: p.title || '' }, p.value || '—'));
    }

    /* ── 邮箱来源 / 绑定面板─────────────────────────────────────
     *
     * 数据通道与其它页签相同（GET 快照 + POST 动作），但有三件事必须在客户端做对：
     *   1. 绑定是**轮询**：start → 每 2.5s poll 一次，完成/失败/过期就停；
     *   2. 二维码是图片（data:image/svg+xml）：白底黑码是扫码的硬要求，不能套主题色；
     *   3. 删除来源默认**不删**存档：勾选框显式给出，且要再点一次"确认删除"。
     */
    function SourcesPanel(props) {
      const { snap, tr, api, onSnapshot } = props;
      const [form, setForm] = useState(null); // { mode:'add'|'edit', ...fields }
      const [note, setNote] = useState(null); // { ok, text }
      const [busy, setBusy] = useState('');
      const [binding, setBinding] = useState(null); // { kind:'mail'|'qq', bind, qr, saved, warnings, note }
      const [confirmId, setConfirmId] = useState('');
      const [dropArchives, setDropArchives] = useState(false);
      const [manualCode, setManualCode] = useState('');
      const [qqDraft, setQqDraft] = useState(null); // { appId, openid, secret }
      /** 绑定后默认收起手填表单；需要改 AppID/openid/secret 时再展开 */
      const [qqManual, setQqManual] = useState(false);
      const mounted = useRef(true);
      useEffect(() => {
        mounted.current = true;
        return () => {
          mounted.current = false;
        };
      }, []);

      const sources = (snap && snap.sources) || [];
      const qq = (snap && snap.qq) || {};

      const post = async (action, payload) => {
        const data = await api(action, payload);
        if (data && data.sources && typeof onSnapshot === 'function') onSnapshot(data);
        return data;
      };

      const blankForm = (type) => ({
        mode: 'add',
        /** 编辑前的 id：改 id 时用它删旧条目（不能拿新 id 当 previousId） */
        originalId: '',
        type,
        name: '',
        id: '',
        provider: '',
        host: '',
        port: '',
        secure: true,
        user: '',
        password: '',
        passwordRef: '',
        /** 授权码的输入方式：明文直填 / 凭据引用（左侧下拉切换） */
        secretMode: 'plain',
        mailbox: '',
        folder: '',
        clientId: '',
        clientSecret: '',
        clientSecretRef: '',
        clientSecretMode: 'plain',
        tenant: 'common',
        tokenFile: '',
      });

      const editForm = (row) => ({
        ...blankForm(row.type),
        mode: 'edit',
        originalId: row.id,
        name: row.name || '',
        id: row.id || '',
        provider: row.provider || '',
        host: row.host || '',
        port: row.port ? String(row.port) : '',
        secure: row.secure !== false,
        user: row.user || '',
        password: '',
        passwordRef: row.passwordRef || '',
        secretMode: row.passwordRef ? 'ref' : 'plain',
        mailbox: row.mailbox || '',
        folder: row.folder || '',
        clientId: row.clientId || '',
        clientSecret: '',
        clientSecretRef: row.clientSecretRef || '',
        clientSecretMode: row.clientSecretRef ? 'ref' : 'plain',
        tenant: row.tenant || 'common',
        tokenFile: row.tokenFile || '',
      });

      const setField = (key, value) => setForm((prev) => ({ ...(prev || blankForm('imap')), [key]: value }));

      const saveSource = async () => {
        if (!form) return;
        if (!String(form.name || '').trim()) {
          setNote({ ok: false, text: tr('sources.required') });
          return;
        }
        const source = { type: form.type, name: String(form.name).trim() };
        if (String(form.id || '').trim()) source.id = String(form.id).trim();
        if (form.type === 'imap' || form.type === 'pop3') {
          if (String(form.provider || '').trim()) source.provider = String(form.provider).trim();
          if (String(form.host || '').trim()) source.host = String(form.host).trim();
          if (String(form.port || '').trim()) source.port = Number(form.port);
          source.secure = form.secure !== false;
          if (String(form.user || '').trim()) source.user = String(form.user).trim();
          // 明文与引用二选一：由左侧下拉决定写 password 还是 password_ref
          if (form.secretMode === 'ref') {
            source.password_ref = String(form.passwordRef || '').trim();
            source.credential_mode = 'ref';
          }
          if (form.type === 'imap' && String(form.mailbox || '').trim()) source.mailbox = String(form.mailbox).trim();
        } else if (form.type === 'oauth2') {
          if (String(form.user || '').trim()) source.user = String(form.user).trim();
          if (String(form.host || '').trim()) source.host = String(form.host).trim();
          if (String(form.port || '').trim()) source.port = Number(form.port);
          source.secure = form.secure !== false;
          if (String(form.clientId || '').trim()) source.client_id = String(form.clientId).trim();
          if (String(form.tenant || '').trim()) source.tenant = String(form.tenant).trim();
          if (String(form.tokenFile || '').trim()) source.token_file = String(form.tokenFile).trim();
          if (String(form.mailbox || '').trim()) source.mailbox = String(form.mailbox).trim();
        } else if (form.type === 'gmail') {
          if (String(form.user || '').trim()) source.user = String(form.user).trim();
          if (String(form.clientId || '').trim()) source.client_id = String(form.clientId).trim();
          if (form.clientSecretMode === 'ref' && String(form.clientSecretRef || '').trim()) {
            source.client_secret_ref = String(form.clientSecretRef).trim();
          }
          if (String(form.folder || '').trim()) source.folder = String(form.folder).trim();
          if (String(form.tokenFile || '').trim()) source.token_file = String(form.tokenFile).trim();
        } else if (form.type === 'graph') {
          if (String(form.clientId || '').trim()) source.client_id = String(form.clientId).trim();
          if (String(form.tenant || '').trim()) source.tenant = String(form.tenant).trim();
          if (String(form.folder || '').trim()) source.folder = String(form.folder).trim();
          if (String(form.tokenFile || '').trim()) source.token_file = String(form.tokenFile).trim();
        }
        setBusy('source');
        setNote(null);
        try {
          const data = await post('save-source', {
            source,
            previousId: form.mode === 'edit' ? String(form.originalId || '') : '',
            secret: form.type === 'imap' || form.type === 'pop3'
              ? (form.secretMode === 'plain' ? String(form.password || '') : '')
              : '',
            clientSecret: form.type === 'gmail' && form.clientSecretMode === 'plain'
              ? String(form.clientSecret || '')
              : '',
          });
          if (!mounted.current) return;
          setForm(null);
          setNote({ ok: true, text: tr('sources.saved') + ((data.warnings || []).length ? `\n⚠ ${data.warnings.join('；')}` : '') });
        } catch (err) {
          if (mounted.current) setNote({ ok: false, text: String(err && err.message ? err.message : err) });
        } finally {
          if (mounted.current) setBusy('');
        }
      };

      const deleteSource = async (id) => {
        setBusy('delete');
        setNote(null);
        try {
          const data = await post('delete-source', { id, deleteArchives: dropArchives === true });
          if (!mounted.current) return;
          setConfirmId('');
          setDropArchives(false);
          setNote({
            ok: true,
            text: `${tr('sources.deleted')}${data.removedArchives ? `（${data.removedArchives} 份存档）` : ''}`,
          });
        } catch (err) {
          if (mounted.current) setNote({ ok: false, text: String(err && err.message ? err.message : err) });
        } finally {
          if (mounted.current) setBusy('');
        }
      };

      const testSource = async (id) => {
        setBusy(`test:${id}`);
        setNote(null);
        try {
          const data = await post('verify-source', { id });
          if (mounted.current) setNote({ ok: true, text: String(data.detail || 'OK') });
        } catch (err) {
          if (mounted.current) setNote({ ok: false, text: String(err && err.message ? err.message : err) });
        } finally {
          if (mounted.current) setBusy('');
        }
      };

      const startMailBind = async (row) => {
        setBusy(`bind:${row.id}`);
        setNote(null);
        try {
          const data = await post('mail-bind-start', { sourceId: row.id });
          if (mounted.current) setBinding({ kind: 'mail', sourceId: row.id, bind: data.bind, note: null });
        } catch (err) {
          if (mounted.current) setNote({ ok: false, text: String(err && err.message ? err.message : err) });
        } finally {
          if (mounted.current) setBusy('');
        }
      };

      const startQqBind = async () => {
        setBusy('qq-bind');
        setNote(null);
        try {
          const data = await post('qq-bind-start');
          if (!mounted.current) return;
          setBinding({
            kind: 'qq',
            bind: data.bind,
            qr: data.qr || '',
            note: data.qrError ? { ok: false, text: data.qrError } : null,
          });
        } catch (err) {
          if (mounted.current) setNote({ ok: false, text: String(err && err.message ? err.message : err) });
        } finally {
          if (mounted.current) setBusy('');
        }
      };

      const cancelBinding = async () => {
        const current = binding;
        setBinding(null);
        setManualCode('');
        if (!current || !current.bind) return;
        try {
          await post(current.kind === 'qq' ? 'qq-bind-cancel' : 'mail-bind-cancel', { id: current.bind.id });
        } catch {
          // 取消失败不影响本地关闭（会话有 TTL）
        }
      };

      const completeGmail = async () => {
        if (!binding || !binding.bind) return;
        setBusy('complete');
        try {
          const data = await post('mail-bind-complete', { id: binding.bind.id, code: manualCode });
          if (!mounted.current) return;
          setBinding((prev) => (prev ? { ...prev, bind: data.bind } : prev));
        } catch (err) {
          setBinding((prev) => (prev ? { ...prev, note: { ok: false, text: String(err && err.message ? err.message : err) } } : prev));
        } finally {
          if (mounted.current) setBusy('');
        }
      };

      const saveQqIds = async () => {
        const draft = qqDraft || { appId: qq.appId || '', openid: qq.openid || '' };
        setBusy('qq-ids');
        setNote(null);
        try {
          await post('save-params', { params: { 'qq.app_id': draft.appId || '', 'qq.openid': draft.openid || '' } });
          if (mounted.current) setNote({ ok: true, text: tr('bind.idsSaved') });
        } catch (err) {
          if (mounted.current) setNote({ ok: false, text: String(err && err.message ? err.message : err) });
        } finally {
          if (mounted.current) setBusy('');
        }
      };

      const saveQqSecret = async () => {
        const draft = qqDraft || {};
        if (!draft.secret) return;
        setBusy('qq-secret');
        setNote(null);
        try {
          await post('save-secret', { ref: 'QQ_BOT_SECRET', value: draft.secret });
          if (mounted.current) {
            setQqDraft((prev) => ({ ...(prev || {}), secret: '' }));
            setNote({ ok: true, text: tr('bind.secretSaved') });
          }
        } catch (err) {
          if (mounted.current) setNote({ ok: false, text: String(err && err.message ? err.message : err) });
        } finally {
          if (mounted.current) setBusy('');
        }
      };

      // 绑定轮询：只在 pending 时跑；完成/失败/过期立刻停（依赖是原始值，不随对象身份重置）
      const bindId = binding && binding.bind ? binding.bind.id : '';
      const bindStatus = binding && binding.bind ? binding.bind.status : '';
      useEffect(() => {
        if (!bindId || bindStatus !== 'pending') return undefined;
        const kind = binding && binding.kind;
        const action = kind === 'qq' ? 'qq-bind-poll' : 'mail-bind-poll';
        const timer = setInterval(async () => {
          try {
            const data = await api(action, { id: bindId });
            if (!mounted.current) return;
            if (data && data.sources && typeof onSnapshot === 'function') onSnapshot(data);
            setBinding((prev) => (prev && prev.bind && prev.bind.id === bindId ? { ...prev, bind: data.bind, saved: data.saved, warnings: data.warnings || [] } : prev));
          } catch (err) {
            if (!mounted.current) return;
            const text = String(err && err.message ? err.message : err);
            setBinding((prev) =>
              prev && prev.bind && prev.bind.id === bindId
                ? { ...prev, note: { ok: false, text }, bind: { ...prev.bind, status: 'failed', error: text } }
                : prev,
            );
          }
        }, 2500);
        return () => clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [bindId, bindStatus]);

      const field = (label, key, opts = {}) =>
        h(
          'label',
          { style: S.field, key },
          h('span', { style: S.label }, label),
          h('input', {
            style: opts.area ? S.textarea : S.input,
            type: opts.type || 'text',
            value: form && form[key] !== undefined && form[key] !== null ? form[key] : '',
            placeholder: opts.placeholder || '',
            onChange: (event) => setField(key, event.target.value),
            autoComplete: 'off',
          }),
          opts.hint ? h('span', { style: S.textCaption }, opts.hint) : null,
        );

      const typeOptions = ((snap && snap.catalog && snap.catalog.sourceTypes) || [
        { type: 'imap', label: 'IMAP' },
        { type: 'pop3', label: 'POP3' },
        { type: 'oauth2', label: 'OAuth2（IMAP）' },
        { type: 'gmail', label: 'Gmail API' },
        { type: 'graph', label: 'Microsoft Graph' },
      ]);
      const providerPresets = ['', 'qq', '163', '126', 'gmail', 'outlook', 'icloud', 'foxmail'];
      // value 保持小写（host 预设查表用），显示名按品牌大小写
      const providerLabels = {
        qq: 'QQ', '163': '163', '126': '126', gmail: 'Gmail', outlook: 'Outlook', icloud: 'iCloud', foxmail: 'Foxmail',
      };

      const formCard = form
        ? h(
            'div',
            // 嵌在「邮箱来源」卡片里的编辑区：透明底 + 虚线边框，避免卡片套卡片
            { style: { ...S.card, background: 'transparent', border: `1px dashed ${T.border}`, padding: 10 } },
            h('h3', { style: S.cardTitle }, form.mode === 'edit' ? tr('source.editTitle') : tr('source.addTitle')),
            h(
              'div',
              { style: S.grid },
              h(
                'label',
                { style: S.field },
                h('span', { style: S.label }, tr('source.type')),
                h(
                  'select',
                  {
                    style: S.select,
                    value: form.type,
                    onChange: (event) => setForm((prev) => ({ ...blankForm(event.target.value), mode: prev.mode, originalId: prev.originalId, name: prev.name, id: prev.id })),
                  },
                  typeOptions.map((item) => h('option', { key: item.type, value: item.type, style: S.option }, item.label)),
                ),
              ),
              field(tr('source.name'), 'name'),
              field(tr('source.id'), 'id', { hint: '改 ID 视为新邮箱（旧游标不再复用）' }),
              form.type === 'imap' || form.type === 'pop3'
                ? h(
                    'label',
                    { style: S.field, key: 'provider' },
                    h('span', { style: S.label }, tr('source.provider')),
                    h(
                      'select',
                      {
                        style: S.select,
                        value: form.provider || '',
                        onChange: (event) => setField('provider', event.target.value),
                      },
                      providerPresets.map((preset) =>
                        h('option', { key: preset || 'custom', value: preset, style: S.option }, preset ? (providerLabels[preset] || preset) : tr('source.providerCustom')),
                      ),
                    ),
                  )
                : null,
            ),
            form.type === 'imap' || form.type === 'pop3'
              ? h(
                  'div',
                  { style: S.grid },
                  field(tr('source.host'), 'host', { placeholder: 'imap.qq.com / pop.qq.com' }),
                  field(tr('source.port'), 'port', { placeholder: form.type === 'pop3' ? '995' : '993' }),
                  field(tr('source.user'), 'user', { placeholder: 'me@example.com' }),
                  // 文件夹紧跟账号：两列布局下邮箱地址在左、文件夹在同一行右侧（POP3 无文件夹概念）
                  form.type === 'imap' ? field(tr('source.mailbox'), 'mailbox') : null,
                  /*
                   * 授权码一个控件：左侧选"明文/引用"，右侧填对应内容。
                   * 之前是两个并排输入框，用户要同时猜"该填哪个"，还容易两个都填。
                   */
                  h(
                    'label',
                    { style: { ...S.field, gridColumn: '1 / -1' }, key: 'credential' },
                    h('span', { style: S.label }, tr('source.credential')),
                    h(
                      'div',
                      { style: { display: 'flex', gap: 8, minWidth: 0 } },
                      h(
                        'select',
                        {
                          style: { ...S.select, flex: '0 0 96px', width: 96 },
                          value: form.secretMode || 'plain',
                          onChange: (event) =>
                            setForm((prev) => ({
                              ...(prev || blankForm('imap')),
                              secretMode: event.target.value,
                              password: '',
                              passwordRef: '',
                            })),
                        },
                        h('option', { value: 'plain', style: S.option }, tr('source.credentialPlain')),
                        h('option', { value: 'ref', style: S.option }, tr('source.credentialRef')),
                      ),
                      h('input', {
                        style: { ...S.input, flex: '1 1 auto', minWidth: 0 },
                        type: (form.secretMode || 'plain') === 'ref' ? 'text' : 'password',
                        value: (form.secretMode || 'plain') === 'ref' ? form.passwordRef : form.password,
                        placeholder:
                          (form.secretMode || 'plain') === 'ref' ? 'QQ_MAIL_PASSWORD' : tr('source.passwordKeep'),
                        autoComplete: 'off',
                        onChange: (event) =>
                          setField((form.secretMode || 'plain') === 'ref' ? 'passwordRef' : 'password', event.target.value),
                      }),
                    ),
                    h(
                      'span',
                      { style: S.textCaption },
                      (form.secretMode || 'plain') === 'ref' ? tr('source.passwordRefHint') : tr('source.credentialPlainHint'),
                    ),
                  ),
                  h(
                    'label',
                    { style: { ...S.check, gridColumn: '1 / -1' } },
                    h('input', { type: 'checkbox', checked: form.secure !== false, onChange: (event) => setField('secure', event.target.checked) }),
                    tr('source.secure'),
                  ),
                )
              : null,
            form.type === 'oauth2'
              ? h(
                  'div',
                  { style: S.grid },
                  field(tr('source.user'), 'user', { placeholder: 'me@company.com' }),
                  field(tr('source.host'), 'host', { placeholder: 'outlook.office365.com' }),
                  field(tr('source.port'), 'port', { placeholder: '993' }),
                  field(tr('source.clientId'), 'clientId', { hint: tr('source.oauth2ClientHint') }),
                  field(tr('source.tenant'), 'tenant', { placeholder: 'common' }),
                  field(tr('source.mailbox'), 'mailbox'),
                  field(tr('source.tokenFile'), 'tokenFile'),
                  h('div', { style: { ...S.empty, gridColumn: '1 / -1' } }, tr('source.oauth2Hint')),
                )
              : null,
            form.type === 'gmail'
              ? h(
                  'div',
                  { style: S.grid },
                  field(tr('source.user'), 'user', { placeholder: 'me@gmail.com' }),
                  field(tr('source.clientId'), 'clientId'),
                  // 与授权码一致：左侧选明文/引用，右侧填 secret 或凭据引用名
                  h(
                    'label',
                    { style: { ...S.field, gridColumn: '1 / -1' }, key: 'clientSecret' },
                    h('span', { style: S.label }, tr('source.clientSecret')),
                    h(
                      'div',
                      { style: { display: 'flex', gap: 8, minWidth: 0 } },
                      h(
                        'select',
                        {
                          style: { ...S.select, flex: '0 0 96px', width: 96 },
                          value: form.clientSecretMode || 'plain',
                          onChange: (event) =>
                            setForm((prev) => ({
                              ...(prev || blankForm('gmail')),
                              clientSecretMode: event.target.value,
                              clientSecret: '',
                              clientSecretRef: '',
                            })),
                        },
                        h('option', { value: 'plain', style: S.option }, tr('source.credentialPlain')),
                        h('option', { value: 'ref', style: S.option }, tr('source.credentialRef')),
                      ),
                      h('input', {
                        style: { ...S.input, flex: '1 1 auto', minWidth: 0 },
                        type: (form.clientSecretMode || 'plain') === 'ref' ? 'text' : 'password',
                        value:
                          (form.clientSecretMode || 'plain') === 'ref' ? form.clientSecretRef : form.clientSecret,
                        placeholder:
                          (form.clientSecretMode || 'plain') === 'ref' ? 'GMAIL_CLIENT_SECRET' : tr('source.passwordKeep'),
                        autoComplete: 'off',
                        onChange: (event) =>
                          setField(
                            (form.clientSecretMode || 'plain') === 'ref' ? 'clientSecretRef' : 'clientSecret',
                            event.target.value,
                          ),
                      }),
                    ),
                    h(
                      'span',
                      { style: S.textCaption },
                      (form.clientSecretMode || 'plain') === 'ref'
                        ? tr('source.clientSecretRefHint')
                        : tr('source.credentialPlainHint'),
                    ),
                  ),
                  field(tr('source.folder'), 'folder', { placeholder: 'INBOX（Gmail 标签 id，不是名称）' }),
                  field(tr('source.tokenFile'), 'tokenFile'),
                  h('div', { style: { ...S.empty, gridColumn: '1 / -1' } }, tr('bind.hintGmail')),
                )
              : null,
            form.type === 'graph'
              ? h(
                  'div',
                  { style: S.grid },
                  field(tr('source.clientId'), 'clientId'),
                  field(tr('source.tenant'), 'tenant'),
                  field(tr('source.folder'), 'folder', { placeholder: 'inbox' }),
                  field(tr('source.tokenFile'), 'tokenFile'),
                  h('div', { style: { ...S.empty, gridColumn: '1 / -1' } }, tr('bind.hintGraph')),
                )
              : null,
            h(
              'div',
              { style: S.actionsEnd },
              h(
                'button',
                { type: 'button', style: { ...S.btn, ...S.btnPrimary, ...(busy === 'source' ? S.btnDisabled : null) }, disabled: busy === 'source', onClick: saveSource },
                busy === 'source' ? tr('action.saving') : tr('action.save'),
              ),
              h('button', { type: 'button', style: { ...S.btn, ...S.btnGhost }, onClick: () => setForm(null) }, tr('action.reset')),
            ),
          )
        : null;

      const bindCard = binding && binding.bind
        ? (() => {
            const bind = binding.bind;
            const done = bind.status === 'completed';
            const failed = ['failed', 'expired', 'cancelled', 'denied'].includes(bind.status);
            return h(
              'div',
              { style: S.card },
              h('h3', { style: S.cardTitle }, binding.kind === 'qq'
                ? tr('bind.qqTitle')
                : bind.provider === 'gmail'
                  ? 'Gmail API'
                  : bind.provider === 'oauth2'
                    ? 'OAuth2（IMAP）'
                    : 'Microsoft Graph'),
              bind.status === 'pending' && binding.kind === 'qq'
                ? h(
                    'div',
                    { style: { display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' } },
                    // 二维码必须白底黑码：主题 token 在深色下会把码反色，扫不出来（功能要求，非配色偏好）
                    // 二维码生成失败时**仍然显示链接**：那是唯一的降级路径
                    binding.qr
                      ? h('img', {
                          src: binding.qr,
                          alt: tr('bind.qrAlt'),
                          width: 180,
                          height: 180,
                          style: { width: 180, height: 180, background: '#fff', padding: 8, borderRadius: 8, flex: '0 0 auto' },
                        })
                      : null,
                    h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 } },
                      h('div', { style: S.label }, binding.qr ? tr('bind.qrHint') : tr('bind.manualTitle2')),
                      h('div', { style: S.mono }, bind.url || ''),
                      bind.url ? h('a', { href: bind.url, target: '_blank', rel: 'noreferrer', style: { ...S.textSmall, color: T.brand } }, tr('bind.openLink')) : null,
                      h('div', { style: S.textCaption }, tr('bind.qqPageHint')),
                    ),
                  )
                : null,
              bind.status === 'pending' && binding.kind === 'mail' && (bind.provider === 'graph' || bind.provider === 'oauth2')
                ? h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                    h('div', { style: S.label }, tr('bind.userCode')),
                    h('div', { style: { fontSize: 22, fontWeight: 700, letterSpacing: 2 } }, bind.userCode || '—'),
                    bind.verificationUri
                      ? h('a', { href: bind.verificationUri, target: '_blank', rel: 'noreferrer', style: { ...S.textSmall, color: T.brand } }, bind.verificationUri)
                      : null,
                    bind.message ? h('div', { style: S.mono }, bind.message) : null,
                  )
                : null,
              bind.status === 'pending' && binding.kind === 'mail' && bind.provider === 'gmail'
                ? h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                    h('div', { style: S.label }, tr('bind.hintGmail')),
                    bind.url ? h('a', { href: bind.url, target: '_blank', rel: 'noreferrer', style: { ...S.textSmall, color: T.brand, overflowWrap: 'anywhere' } }, bind.url) : null,
                    /*
                     * 手动粘贴框**始终**给出：回环端口能起来不代表 Google 会回跳
                     * （OAuth 客户端类型错 / redirect_uri 未登记时不会回跳，只能等 TTL）。
                     */
                    h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                      h('div', { style: S.label }, tr('bind.manualTitle')),
                      h('input', {
                        style: S.input,
                        value: manualCode,
                        placeholder: tr('bind.codePlaceholder'),
                        onChange: (event) => setManualCode(event.target.value),
                      }),
                      h(
                        'button',
                        { type: 'button', style: { ...S.btn, ...S.btnPrimary, alignSelf: 'flex-start' }, disabled: busy === 'complete' || !manualCode, onClick: completeGmail },
                        tr('bind.complete'),
                      ),
                    ),
                  )
                : null,
              bind.status === 'pending'
                ? h('div', { style: { ...S.empty, color: T.dim } }, tr('bind.waiting'))
                : null,
              done
                ? h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                    h('div', { style: { ...S.itemTitle, color: T.ok } }, `✓ ${tr('bind.done')}`),
                    (bind.result && (bind.result.account || bind.result.email))
                      ? h('div', { style: S.mono }, bind.result.account || bind.result.email)
                      : null,
                    bind.result && bind.result.appId
                      ? h('div', { style: S.mono }, `${tr('bind.appId')}: ${bind.result.appId}　${tr('bind.openid')}: ${bind.result.openid || '—'}`)
                      : null,
                    (binding.warnings || []).length
                      ? h('div', { style: { ...S.notice, color: T.warn, whiteSpace: 'pre-wrap' } }, `⚠ ${binding.warnings.join('；')}`)
                      : null,
                    binding.kind === 'qq'
                      ? h('div', { style: S.textCaption }, tr('bind.qqPageHint'))
                      : null,
                  )
                : null,
              failed
                ? h('div', { style: { ...S.notice, color: T.error, whiteSpace: 'pre-wrap' } }, `⚠ ${bind.error || tr('bind.expired')}`)
                : null,
              binding.note
                ? h('div', { style: { ...S.notice, color: binding.note.ok ? T.ok : T.error, whiteSpace: 'pre-wrap' } }, binding.note.text)
                : null,
              h(
                'div',
                { style: S.actions },
                h('button', { type: 'button', style: { ...S.btnSm, ...S.btnGhost }, onClick: cancelBinding }, done ? tr('action.close') : tr('bind.cancel')),
              ),
            );
          })()
        : null;

      const qqDraftState = qqDraft || { appId: qq.appId || '', openid: qq.openid || '', secret: '' };

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'flex-start', gap: 8 } },
            h('h3', { style: { ...S.cardTitle, marginRight: 'auto' } }, tr('sources.title')),
            h(
              'button',
              {
                type: 'button',
                style: { ...S.btnSm, ...S.btnPrimary, flex: '0 0 auto' },
                // 再点一次收起：当前已经在「新增」模式时置空，否则打开新增表单（编辑别的来源时点它会切到新增）
                onClick: () => {
                  setNote(null);
                  setForm((prev) => (prev && prev.mode === 'add' ? null : blankForm('imap')));
                },
              },
              form && form.mode === 'add' ? tr('sources.addClose') : tr('sources.add'),
            ),
          ),
          // 提示单独一行、固定小号：和标题同一行时，表单展开/滚动条出现会让它重新折行
          h('div', { style: S.textCaption }, tr('sources.hint')),
          // 新增表单紧跟在标题下面：点「添加邮箱」后不用滚到列表末尾才看见
          // （编辑表单不在这里，它展开在对应来源那一行下面）
          form && form.mode === 'add' ? formCard : null,
          sources.length === 0
            ? h('div', { style: S.empty }, tr('sources.empty'))
            : sources.map((row) =>
                h(
                  'div',
                  { key: row.id, style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 0', borderTop: `1px solid ${T.border}` } },
                  h(
                    'div',
                    { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                    h('span', { style: S.itemTitle }, row.name),
                    h('span', { style: S.badge }, row.typeLabel || row.type),
                    row.canBind
                      ? h('span', { style: { ...S.badge, color: row.bound ? T.ok : T.warn } }, row.bound ? tr('sources.bound') : tr('sources.unbound'))
                      : null,
                    !row.editable ? h('span', { style: S.badge }, tr('sources.readonly')) : null,
                    h('span', { style: { ...S.mono, marginLeft: 'auto' } }, row.cursor || ''),
                  ),
                  h(
                    'div',
                    { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                    h('span', { style: { ...S.mono, flex: '1 1 220px' } }, row.detail || ''),
                    row.canBind
                      ? h(
                          'button',
                          { type: 'button', style: { ...S.btnSm }, disabled: busy === `bind:${row.id}`, onClick: () => startMailBind(row) },
                          tr('bind.start'),
                        )
                      : null,
                    h(
                      'button',
                      { type: 'button', style: { ...S.btnSm }, disabled: busy === `test:${row.id}`, onClick: () => testSource(row.id) },
                      busy === `test:${row.id}` ? tr('sources.testing') : tr('sources.test'),
                    ),
                    row.editable
                      ? h(
                          'button',
                          {
                            type: 'button',
                            style: { ...S.btnSm, ...S.btnGhost },
                            // 再点一次收起；编辑另一行时直接切过去
                            onClick: () => {
                              setNote(null);
                              setForm((prev) =>
                                prev && prev.mode === 'edit' && prev.originalId === row.id ? null : editForm(row),
                              );
                            },
                          },
                          // 打开时文案变「收起」，与「添加邮箱」的开关一致
                          form && form.mode === 'edit' && form.originalId === row.id
                            ? tr('sources.editClose')
                            : tr('sources.edit'),
                        )
                      : null,
                    row.editable
                      ? h(
                          'button',
                          { type: 'button', style: { ...S.btnSm, ...S.btnGhost }, onClick: () => { setConfirmId(confirmId === row.id ? '' : row.id); setDropArchives(false); } },
                          tr('sources.delete'),
                        )
                      : null,
                  ),
                  confirmId === row.id
                    ? h(
                        'div',
                        { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', background: tint(6), borderRadius: 8, padding: 8 } },
                        h(
                          'label',
                          { style: S.check },
                          h('input', { type: 'checkbox', checked: dropArchives, onChange: (event) => setDropArchives(event.target.checked) }),
                          tr('sources.deleteArchives'),
                        ),
                        h(
                          'button',
                          { type: 'button', style: { ...S.btnSm, ...S.btnGhost, marginLeft: 'auto' }, disabled: busy === 'delete', onClick: () => deleteSource(row.id) },
                          tr('sources.deleteConfirm'),
                        ),
                      )
                    : null,
                  // 编辑表单展开在**该来源下面**（新增表单仍在标题下面）
                  form && form.mode === 'edit' && form.originalId === row.id ? formCard : null,
                ),
              ),
        ),
        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'flex-start', gap: 8 } },
            h('h3', { style: { ...S.cardTitle, marginRight: 'auto' } }, tr('bind.qqTitle')),
            h(
              'button',
              {
                type: 'button',
                style: { ...S.btnSm, ...S.btnPrimary, flex: '0 0 auto', ...(busy === 'qq-bind' ? S.btnDisabled : null) },
                disabled: busy === 'qq-bind',
                onClick: startQqBind,
              },
              qq.bound ? tr('bind.qqRebind') : tr('bind.qqStart'),
            ),
          ),
          h('div', { style: S.empty }, tr('bind.qqHint')),
          h(
            'div',
            { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
            h('span', { style: { ...S.badge, color: qq.bound ? T.ok : T.dim } }, qq.bound ? tr('bind.qqBound') : tr('sources.unbound')),
            qq.bound
              ? h('button', { type: 'button', style: { ...S.btnSm, ...S.btnGhost }, onClick: () => setQqManual((prev) => !prev) },
                  qqManual ? tr('bind.qqManualClose') : tr('bind.qqManual'))
              : null,
          ),
          qq.bound && !qqManual
            ? null
            : h(
                'div',
                { style: S.grid },
                h(
                  'label',
                  { style: S.field },
                  h('span', { style: S.label }, tr('bind.appId')),
                  h('input', {
                    style: S.input,
                    value: qqDraftState.appId,
                    onChange: (event) => setQqDraft({ ...qqDraftState, appId: event.target.value }),
                    autoComplete: 'off',
                  }),
                ),
                h(
                  'label',
                  { style: S.field },
                  h('span', { style: S.label }, tr('bind.openid')),
                  h('input', {
                    style: S.input,
                    value: qqDraftState.openid,
                    onChange: (event) => setQqDraft({ ...qqDraftState, openid: event.target.value }),
                    autoComplete: 'off',
                  }),
                ),
                h(
                  'label',
                  { style: S.field },
                  h('span', { style: S.label }, tr('bind.secret')),
                  h('input', {
                    style: S.input,
                    type: 'password',
                    value: qqDraftState.secret || '',
                    onChange: (event) => setQqDraft({ ...qqDraftState, secret: event.target.value }),
                    autoComplete: 'new-password',
                  }),
                ),
              ),
          qq.bound && !qqManual
            ? null
            : h(
                'div',
                { style: S.actionsEnd },
                h('button', { type: 'button', style: { ...S.btn }, disabled: busy === 'qq-ids', onClick: saveQqIds }, tr('bind.saveIds')),
                h(
                  'button',
                  { type: 'button', style: { ...S.btn, ...(busy === 'qq-secret' || !qqDraftState.secret ? S.btnDisabled : null) }, disabled: busy === 'qq-secret' || !qqDraftState.secret, onClick: saveQqSecret },
                  tr('bind.secretSave'),
                ),
              ),
        ),
        bindCard,
        note
          ? h('div', { style: { ...S.notice, color: note.ok ? T.ok : T.error, whiteSpace: 'pre-wrap' } }, `${note.ok ? '✓' : '⚠'} ${note.text}`)
          : null,
      );
    }

    /* ── 定时任务面板────────────────────────────────────────── */
    /**
     * 任意数量的定时任务：每日/每周/每月/固定间隔/启动时，每条有自己的提示词。
     *
     * 与邮箱面板同一套纪律：整份任务数组提交给 `save-schedules`，后端做整表校验后原子写；
     * 提示词带 `prompt_file` 时写到那个文件，否则内联进 YAML。QQ 不再由插件发——
     * 提示词里让 agent 自己调 qq_notify（默认总览提示词已经这么写）。
     */
    function SchedulesPanel({ snap, tr, api, onSnapshot }) {
      const rows = (snap && snap.schedules) || [];
      const [draft, setDraft] = useState(null);
      const [busy, setBusy] = useState('');
      const [note, setNote] = useState(null);
      const [deleting, setDeleting] = useState('');

      const blankDraft = () => ({
        mode: 'add',
        originalId: '',
        id: '',
        name: '',
        enabled: true,
        type: 'daily',
        times: '21:30',
        weekdays: [3],
        days: [1],
        everyMinutes: 60,
        prompt: '',
        promptFile: '',
      });

      const editDraft = (row) => ({
        mode: 'edit',
        // 编辑时改 id：仍用旧 id 去删掉旧条目，不能拿新 id 当 previousId
        originalId: row.id,
        id: row.id,
        name: row.name,
        enabled: row.enabled !== false,
        type: row.schedule && row.schedule.type ? row.schedule.type : 'daily',
        times: Array.isArray(row.schedule && row.schedule.times) ? row.schedule.times.join(', ') : '21:30',
        weekdays: Array.isArray(row.schedule && row.schedule.weekdays) && row.schedule.weekdays.length ? row.schedule.weekdays : [1],
        days: Array.isArray(row.schedule && row.schedule.days) && row.schedule.days.length ? row.schedule.days : [1],
        everyMinutes: (row.schedule && row.schedule.everyMinutes) || 60,
        prompt: row.prompt || '',
        promptFile: row.prompt_file || '',
      });

      const setField = (key, value) => setDraft((prev) => ({ ...(prev || blankDraft()), [key]: value }));
      const parseTimes = (text) =>
        String(text || '')
          .split(/[,，\s]+/)
          .map((s) => s.trim())
          .filter(Boolean);
      const parseNums = (text, fallback) => {
        const list = String(text || '')
          .split(/[,，\s]+/)
          .map((s) => Number(s))
          .filter((n) => Number.isFinite(n));
        return list.length > 0 ? list : fallback;
      };

      /** UI 草稿 → 后端 payload（排期字段用运行时 camelCase；后端再落成 YAML snake_case） */
      const toPayload = (d) => {
        const schedule = { type: d.type };
        if (d.type === 'daily' || d.type === 'weekly' || d.type === 'monthly') {
          schedule.times = parseTimes(d.times);
        }
        if (d.type === 'weekly') schedule.weekdays = d.weekdays;
        if (d.type === 'monthly') schedule.days = parseNums(d.days, [1]);
        if (d.type === 'interval') schedule.everyMinutes = Math.trunc(Number(d.everyMinutes)) || 60;
        return {
          id: String(d.id || '').trim(),
          name: String(d.name || '').trim(),
          enabled: d.enabled !== false,
          schedule,
          prompt: d.prompt,
          prompt_file: String(d.promptFile || '').trim(),
        };
      };

      const save = async (nextRows, editedId = '') => {
        setBusy('save');
        try {
          const data = await api('save-schedules', { schedules: nextRows, editedId });
          onSnapshot(data);
          setDraft(null);
          setDeleting('');
          setNote({ ok: true, text: tr('schedules.saved') });
        } catch (err) {
          setNote({ ok: false, text: tr('msg.saveFailed') + String(err && err.message ? err.message : err) });
        } finally {
          setBusy('');
        }
      };

      const submitDraft = () => {
        if (!draft) return;
        if (!draft.prompt.trim()) {
          setNote({ ok: false, text: tr('schedules.promptMissing') });
          return;
        }
        if ((draft.type === 'daily' || draft.type === 'weekly' || draft.type === 'monthly') && parseTimes(draft.times).length === 0) {
          setNote({ ok: false, text: tr('schedules.times') });
          return;
        }
        const payload = toPayload(draft);
        // 编辑时先去掉旧的那条（改了 id 的话旧 id 也必须消失，不能留下两条）
        const originalId = draft.mode === 'edit' ? draft.originalId : '';
        const nextRows = rows
          .filter((row) => !originalId || row.id !== originalId)
          .map(toPayload);
        nextRows.push(payload);
        save(nextRows, originalId);
      };

      const removeRow = (row) => {
        if (deleting !== row.id) {
          setDeleting(row.id);
          return;
        }
        const nextRows = rows.filter((entry) => entry.id !== row.id).map(toPayload);
        if (draft && draft.mode === 'edit' && draft.originalId === row.id) setDraft(null);
        save(nextRows);
      };

      const runNow = async (row) => {
        setBusy(`run:${row.id}`);
        setNote(snap && snap.status && snap.status.running ? { ok: false, text: tr('schedules.busyHint') } : null);
        try {
          const data = await api('run-task', { id: row.id });
          onSnapshot(data);
          setNote({ ok: true, text: fmt(tr('schedules.runDone'), { name: row.name, n: data.count ?? 0 }) });
        } catch (err) {
          const payload = err && err.data;
          if (payload && Array.isArray(payload.schedules)) onSnapshot(payload);
          setNote({ ok: false, text: tr('schedules.runFailed') + String(err && err.message ? err.message : err) });
        } finally {
          setBusy('');
        }
      };

      const field = (label, key, opts = {}) =>
        h('label', { style: S.field, key },
          h('span', { style: S.label }, label),
          opts.multiline
            ? h('textarea', {
                style: { ...S.textarea, minHeight: 64 },
                value: draft[key] || '',
                onChange: (e) => setField(key, e.target.value),
                spellCheck: false,
              })
            : h('input', {
                style: S.input,
                type: opts.type || 'text',
                min: opts.min,
                value: draft[key] ?? '',
                onChange: (e) => setField(key, e.target.value),
                spellCheck: false,
              }));

      const checkbox = (label, checked, onChange) =>
        h('label', { style: S.check },
          h('input', { type: 'checkbox', checked: Boolean(checked), onChange: (e) => onChange(e.target.checked) }),
          h('span', null, label));

      const weekdayChecks = draft
        ? h('div', { style: { ...S.field } },
            h('span', { style: S.label }, tr('schedules.weekdays')),
            h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
              [1, 2, 3, 4, 5, 6, 7].map((day) =>
                h('label', { key: day, style: { ...S.check, gap: 3 } },
                  h('input', {
                    type: 'checkbox',
                    checked: (draft.weekdays || []).includes(day),
                    onChange: (e) => {
                      const current = new Set(draft.weekdays || []);
                      if (e.target.checked) current.add(day);
                      else current.delete(day);
                      setField('weekdays', [...current].sort((a, b) => a - b));
                    },
                  }),
                  h('span', null, String(day))),
              )))
        : null;

      /** 名称后的状态：x 秒前成功（绿）/ n 秒后重试（黄）/ 失败（红）/ 未运行（灰） */
      const agoText = (ms) => {
        const diff = Math.max(0, Date.now() - ms);
        if (diff < 60_000) return fmt(tr('schedules.agoSeconds'), { n: Math.max(1, Math.floor(diff / 1000)) });
        if (diff < 3_600_000) return fmt(tr('schedules.agoMinutes'), { n: Math.floor(diff / 60_000) });
        if (diff < 86_400_000) return fmt(tr('schedules.agoHours'), { n: Math.floor(diff / 3_600_000) });
        return fmt(tr('schedules.agoDays'), { n: Math.floor(diff / 86_400_000) });
      };
      const statusBadge = (row) => {
        const badge = (color, text, title) =>
          h('span', { style: { ...S.badge, color, borderColor: color }, title: title || '' }, text);
        if (!row.enabled) return badge(T.dim, tr('schedules.statusDisabled'));
        if (busy === `run:${row.id}`) return badge(T.warn, tr('schedules.statusRunning'));
        if (row.deferred) return badge(T.dim, tr('schedules.statusDeferred'));
        const now = Date.now();
        if (row.retryAt > now) {
          return badge(T.warn, fmt(tr('schedules.statusRetry'), { n: Math.max(1, Math.ceil((row.retryAt - now) / 1000)) }), row.lastError || '');
        }
        if (row.lastStatus === 'running') return badge(T.warn, tr('schedules.statusRunning'));
        if (row.lastStatus === 'failed') return badge(T.error, tr('schedules.statusFailed'), row.lastError || '');
        if (row.lastStatus === 'ok' || (!row.lastStatus && row.lastRunAt)) {
          const at = Number(row.lastRunAtMs) || new Date(row.lastRunAt || 0).getTime();
          if (at) return badge(T.ok, fmt(tr('schedules.statusSucceeded'), { ago: agoText(at) }));
        }
        return badge(T.dim, tr('schedules.statusNever'));
      };

      const formCard = draft
        ? h('div',
            // 嵌在「定时任务」卡片里的编辑区：透明底 + 虚线边框，避免卡片套卡片（与邮箱表单一致）
            { style: { ...S.card, background: 'transparent', border: `1px dashed ${T.border}`, padding: 10 } },
            h('h3', { style: S.cardTitle }, draft.mode === 'edit' ? tr('schedules.edit') : tr('schedules.add')),
            h('div', { style: S.grid },
              field(tr('schedules.name'), 'name'),
              field(tr('schedules.id'), 'id')),
            h('div', { style: S.grid },
              h('label', { style: S.field },
                h('span', { style: S.label }, tr('schedules.type')),
                h('select', {
                  style: S.select,
                  value: draft.type,
                  onChange: (e) => setField('type', e.target.value),
                },
                  h('option', { style: S.option, value: 'daily' }, tr('schedule.daily')),
                  h('option', { style: S.option, value: 'weekly' }, tr('schedule.weekly')),
                  h('option', { style: S.option, value: 'monthly' }, tr('schedule.monthly')),
                  h('option', { style: S.option, value: 'interval' }, tr('schedule.interval')),
                  h('option', { style: S.option, value: 'startup' }, tr('schedule.startup'))))),
            draft.type === 'interval'
              ? field(tr('schedules.everyMinutes'), 'everyMinutes', { type: 'number', min: 1 })
              : draft.type === 'startup'
                ? h('div', { style: S.empty }, tr('schedules.startupHint'))
                : field(tr('schedules.times'), 'times'),
            draft.type === 'weekly' ? weekdayChecks : null,
            draft.type === 'monthly' ? field(tr('schedules.days'), 'days') : null,
            h('div', { style: { display: 'flex', gap: 18, flexWrap: 'wrap' } },
              checkbox(tr('schedules.enabled'), draft.enabled, (value) => setField('enabled', value))),
            h('div', { style: S.field },
              h('span', { style: S.label }, tr('schedules.prompt')),
              h(PromptEditor, { value: draft.prompt, onChange: (value) => setField('prompt', value) })),
            field(tr('schedules.promptFile'), 'promptFile'),
            h('div', { style: S.textCaption }, tr('schedules.promptFileHint')),
            h('div', { style: S.actionsEnd },
              h('button', {
                type: 'button',
                style: { ...S.btn, ...S.btnPrimary, ...(busy === 'save' ? S.btnDisabled : null) },
                disabled: busy === 'save',
                onClick: submitDraft,
              }, busy === 'save' ? tr('action.saving') : tr('action.save')),
              h('button', {
                type: 'button',
                style: { ...S.btn, ...S.btnGhost },
                onClick: () => { setDraft(null); setNote(null); },
              }, tr('action.reset'))))
        : null;

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h('div', { style: S.card },
          h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 8 } },
            h('h3', { style: { ...S.cardTitle, marginRight: 'auto' } }, `${tr('schedules.title')}（${rows.length}）`),
            h('button', {
              type: 'button',
              style: { ...S.btnSm, ...S.btnPrimary },
              disabled: Boolean(busy),
              onClick: () => {
                setNote(null);
                setDeleting('');
                // 编辑中点「添加」= 切到新增表单（与邮箱页签一致），按钮文案随之变成「收起」
                setDraft((prev) => (prev && prev.mode === 'add' ? null : blankDraft()));
              },
            }, draft && draft.mode === 'add' ? tr('schedules.addClose') : tr('schedules.add'))),
          h('div', { style: S.empty }, tr('schedules.hint')),
          note
            ? h('div', { role: note.ok ? 'status' : 'alert', style: { ...S.notice, color: note.ok ? T.ok : T.error, whiteSpace: 'pre-wrap' } }, `${note.ok ? '✓' : '⚠'} ${note.text}`)
            : null,
          // 新增表单在标题下面；编辑表单展开在**对应任务那一行下面**
          draft && draft.mode === 'add' ? formCard : null,
          rows.length === 0
            ? h('div', { style: S.empty }, tr('schedules.empty'))
            : rows.map((row, index) =>
                h('div', {
                  key: row.id,
                  style: {
                    display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0,
                    padding: '8px 2px', borderTop: index === 0 ? 'none' : `1px solid ${T.border}`,
                  },
                },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                    h('span', { style: S.itemTitle }, row.name),
                    statusBadge(row)),
                  h('div', { style: { ...S.mono, whiteSpace: 'normal' } },
                    `${row.description}　·　${tr('schedules.next')}: ${row.nextAt ? clock(row.nextAt) : '—'}` +
                      `　·　${tr('schedules.last')}: ${row.lastRunAt ? clock(row.lastRunAt) : tr('schedules.never')}`),
                  row.lastError
                    ? h('div', { style: { ...S.notice, color: T.error, whiteSpace: 'pre-wrap' } }, `⚠ ${row.lastError}`)
                    : null,
                  h('div', { style: S.actions },
                    h('button', {
                      type: 'button',
                      style: { ...S.btnSm, ...S.btnGhost },
                      disabled: Boolean(busy),
                      title: snap && snap.status && snap.status.running ? tr('schedules.busyHint') : '',
                      onClick: () => runNow(row),
                    }, busy === `run:${row.id}` ? tr('schedules.running') : tr('schedules.run')),
                    h('button', {
                      type: 'button',
                      style: { ...S.btnSm, ...S.btnGhost },
                      disabled: Boolean(busy),
                      onClick: () => {
                        setNote(null);
                        setDeleting('');
                        setDraft((prev) =>
                          prev && prev.mode === 'edit' && prev.originalId === row.id ? null : editDraft(row),
                        );
                      },
                    }, draft && draft.mode === 'edit' && draft.originalId === row.id
                      ? tr('schedules.editClose')
                      : tr('schedules.edit')),
                    h('button', {
                      type: 'button',
                      style: { ...S.btnSm, ...S.btnGhost, ...(deleting === row.id ? { color: T.error, borderColor: T.error } : null) },
                      disabled: Boolean(busy),
                      onClick: () => removeRow(row),
                    }, deleting === row.id ? tr('schedules.confirmDelete') : tr('schedules.delete'))),
                  // 编辑表单嵌在这条任务下面、同一张卡片里
                  draft && draft.mode === 'edit' && draft.originalId === row.id ? formCard : null,
                )),
          ),
      );
    }

    function MailAssistantSection() {
      const [tab, setTab] = useState('status');
      const [snap, setSnap] = useState(null);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState('');
      const [notice, setNotice] = useState(null);
      const [promptDraft, setPromptDraft] = useState(null);
      const [paramDraft, setParamDraft] = useState(null);
      // U2：提示带"成功/失败"判别位（与 pollNote 同形），否则失败文案会显示成成功色
      const [mailNote, setMailNote] = useState(null);
      // 每封存档的两步删除：第一次点变成"确认删除"，第二次才真正调后端
      const [deletingMail, setDeletingMail] = useState('');
      // 工具集自由输入的草稿（null = 未编辑，直接显示当前值）
      const [toolDraft, setToolsDraft] = useState(null); // { ok, text } | null
      const [pollNote, setPollNote] = useState('');
      // 刷新完成回执：只显示两秒，避免常驻
      // 成功后哪个按钮短暂变成“已保存/已刷新”（1 秒后复原）；值：'params' | 'prompts' | 'reload'
      const [justDone, setJustDone] = useState('');
      const [, setTick] = useState(0);
      const mounted = useRef(true);
      const dirtyPrompts = useRef(false);
      const dirtyParams = useRef(false);
      const pageRef = useRef(null);
      /** 锁定的内容宽度（px）：始终等于“外层有滚动条时”的可用宽度 */
      const [pageWidth, setPageWidth] = useState(0);

      /**
       * 把内容宽度锁在“外层滚动条存在时”的可用宽度。
       *
       * 为什么不能只用 CSS：滚动条属于**宿主壳**的滚动容器，`scrollbar-gutter` 加在插件
       * 的 page div 上不生效。这里先按 `width:100%` 量出自然宽度，再按住外层是否已有
       * 滚动条决定要不要再减一个滚动条宽度；两种状态下最终宽度相同，所以展开/收起表单
       * 时滚动条出现不会引起任何折行。
       */
      const adjustContentWidth = () => {
        const el = pageRef.current;
        if (!el) return;
        const previous = el.style.width;
        let natural = 0;
        let target = 0;
        try {
          el.style.width = '100%';
          natural = el.getBoundingClientRect().width;
          const scroller = scrollContainerOf(el);
          const style = getComputedStyle(scroller);
          const borders =
            (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.borderRightWidth) || 0);
          // offsetWidth 含边框/滚动条，clientWidth 不含：差值就是当前可见的滚动条宽度
          const visibleScrollbar = Math.max(0, scroller.offsetWidth - scroller.clientWidth - borders);
          target = Math.round(visibleScrollbar > 0 ? natural : natural - scrollbarWidth());
        } catch {
          target = Math.round(natural);
        } finally {
          el.style.width = previous;
        }
        if (target > 0) setPageWidth((prev) => (Math.abs(prev - target) < 1 ? prev : target));
      };
      // tab 切换后先按新内容校准一次；表单展开/列表变化由 ResizeObserver 触发
      useLayoutEffect(() => {
        adjustContentWidth();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [tab]);
      useEffect(() => {
        const el = pageRef.current;
        if (!el) return undefined;
        let observer;
        try {
          observer = new ResizeObserver(() => adjustContentWidth());
          observer.observe(el);
        } catch {
          observer = undefined;
        }
        const onResize = () => adjustContentWidth();
        window.addEventListener('resize', onResize);
        return () => {
          try {
            observer?.disconnect();
          } catch {
            // ignore
          }
          window.removeEventListener('resize', onResize);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      const tr = MailAssistantSection.pick || ((key) => EN[key] || key);
      /**
       * 保存按钮的固定宽度：按**当前语言**的 "保存中…" 文案算。
       * 中文一个字约 13px、英文一个字符约 7.5px，加 26px 内边距，下限 84、上限 150。
       * 这样中英各自贴合约 1–2 px，也不会因为某个语言文案特别长把按钮撑成一条。
       */
      const buttonWidth = (() => {
        const text = String(tr('action.saving') || '');
        const width = Array.from(text).reduce((sum, ch) => sum + (/[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 13 : 7.5), 0);
        return Math.min(150, Math.max(84, Math.round(width) + 26));
      })();

      const load = async () => {
        try {
          const data = await callApi();
          if (!mounted.current) return;
          setSnap((prev) => ({ ...data, models: data.models ?? ((prev && prev.models) || null) }));
          setError('');
          if (!dirtyPrompts.current) setPromptDraft(null);
          if (!dirtyParams.current) setParamDraft(null);
        } catch (err) {
          if (mounted.current) setError(String(err && err.message ? err.message : err));
        }
      };
      /**
       * 立即重试拉取：网络断开/休眠唤醒后那次失败不用重启，点一下就好。
       * host 侧还会顺手解开"卡住"的那一轮（running 超过 15 秒没结束就强制接管）。
       */
      const runRetryPoll = async () => {
        setBusy('poll');
        setPollNote(null);
        try {
          const data = await callApi('retry-poll');
          if (!mounted.current) return;
          setSnap((prev) => ({ ...data, models: data.models ?? ((prev && prev.models) || null) }));
          setPollNote({ ok: true, text: String(data.text || tr('status.retryDone')) });
        } catch (err) {
          if (mounted.current) setPollNote({ ok: false, text: String(err && err.message ? err.message : err) });
        } finally {
          if (mounted.current) setBusy('');
        }
      };

      /** 重试失败邮件：只排队，真正的处理由下一拍 tick 的 retryPending 做（不阻塞请求） */
      const runRetry = async () => {
        setBusy('retry');
        setMailNote(null);
        try {
          const data = await callApi('retry-failed');
          if (!mounted.current) return;
          setSnap((prev) => ({ ...data, models: data.models ?? ((prev && prev.models) || null) }));
          setMailNote({ ok: true, text: fmt(tr('mail.retryQueued'), { n: data.queued ?? 0 }) });
        } catch (err) {
          if (mounted.current) setMailNote({ ok: false, text: String(err && err.message ? err.message : err) });
        } finally {
          if (mounted.current) setBusy('');
        }
      };

      /** 删除单封存档：第一次点只进入确认态，避免误删（不碰邮箱） */
      const deleteMail = async (item) => {
        const id = item.name || item.dir || '';
        if (!id) return;
        if (deletingMail !== id) {
          setDeletingMail(id);
          setMailNote(null);
          return;
        }
        setBusy('mail-delete');
        setMailNote(null);
        try {
          const data = await callApi('delete-mail', { id });
          if (!mounted.current) return;
          setSnap((prev) => ({ ...data, models: data.models ?? ((prev && prev.models) || null) }));
          setMailNote({ ok: true, text: fmt(tr('mail.deleted'), { n: data.removed ?? 1 }) });
          setDeletingMail('');
        } catch (err) {
          if (mounted.current) setMailNote({ ok: false, text: String(err && err.message ? err.message : err) });
          setDeletingMail('');
        } finally {
          if (mounted.current) setBusy('');
        }
      };

      useEffect(() => {
        mounted.current = true;
        load();
        const timer = setInterval(() => {
          if (busy) return; // 保存中不刷新，避免把正在编辑的内容冲掉
          load();
        }, 5000);
        return () => {
          mounted.current = false;
          clearInterval(timer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [busy]);

      useEffect(() => {
        const timer = setInterval(() => setTick((n) => n + 1), 1000);
        return () => clearInterval(timer);
      }, []);
      // 保存/失败提示只活 4 秒：它是“刚才那次操作”的回执，不是常驻状态
      useEffect(() => {
        if (!justDone) return undefined;
        const timer = setTimeout(() => setJustDone(''), 3000);
        return () => clearTimeout(timer);
      }, [justDone]);
      useEffect(() => {
        if (!notice) return undefined;
        const timer = setTimeout(() => setNotice(null), 4000);
        return () => clearTimeout(timer);
      }, [notice]);

      // 界面语言切换时重渲染（词典已注册进 locale 服务，pick 在调用时才读当前语言）
      useEffect(() => {
        const subscribe = MailAssistantSection.subscribeLocale;
        if (typeof subscribe !== 'function') return undefined;
        const off = subscribe(() => setTick((n) => n + 1));
        return () => {
          try {
            off?.();
          } catch {
            // ignore
          }
        };
      }, []);

      const status = (snap && snap.status) || {};
      const pending = (snap && snap.pending) || { count: 0, items: [] };
      const params = (snap && snap.params) || {};
      const prompts = (snap && snap.prompts) || {};
      const dot = StatusDot(status, tr);

      const promptsState = promptDraft || {
        mail: (prompts.mail && prompts.mail.text) || '',
        html: (prompts.html && prompts.html.text) || '',
      };
      const paramsState = paramDraft || {
        poll_seconds: params.poll_seconds,
        heartbeat_seconds: params.heartbeat_seconds,
        busy_retry_seconds: params.busy_retry_seconds,
        busy_retry_max: params.busy_retry_max,
        initial_headers: params.initial_headers,
        'agent.silent': params['agent.silent'] === true,
        'agent.session_budget_mb': params['agent.session_budget_mb'],
        'agent.prompt_max_kb': params['agent.prompt_max_kb'],
        'agent.workspace': params['agent.workspace'] || '',
        'agent.provider': params['agent.provider'] || '',
        'agent.model': params['agent.model'] || '',
        'agent.reasoning_effort': params['agent.reasoning_effort'] || 'inherit',
        'agent.tools': Array.isArray(params['agent.tools']) ? params['agent.tools'] : [],
        'render.width': params['render.width'],
        'render.slice_height': params['render.slice_height'],
        'render.slice_overlap': params['render.slice_overlap'],
        'render.max_height': params['render.max_height'],
        'render.remote_images': params['render.remote_images'] !== false,
        'render.browser': params['render.browser'] || '',
      };

      const setPrompt = (key, value) => {
        dirtyPrompts.current = true;
        setPromptDraft({ ...promptsState, [key]: value });
        setNotice(null);
      };
      const setParam = (key, value) => {
        dirtyParams.current = true;
        setParamDraft({ ...paramsState, [key]: value });
        setNotice(null);
      };
      /** 一次改多个参数：provider 变了要同时清 model（两次 setParam 会互相覆盖草稿） */
      const setParamsPatch = (patch) => {
        dirtyParams.current = true;
        setParamDraft({ ...paramsState, ...patch });
        setNotice(null);
      };

      const cancelPrompts = () => {
        dirtyPrompts.current = false;
        setPromptDraft(null);
        setNotice(null);
      };
      const savePrompts = async () => {
        setBusy('prompts');
        try {
          const data = await callApi('save-prompts', { prompts: promptsState });
          setSnap((prev) => ({ ...data, models: data.models ?? ((prev && prev.models) || null) }));
          dirtyPrompts.current = false;
          setPromptDraft(null);
          setNotice(null);
          setJustDone('prompts');
        } catch (err) {
          setNotice({ kind: 'error', text: tr('msg.saveFailed') + String(err && err.message ? err.message : err) });
        } finally {
          setBusy('');
        }
      };
      const saveParams = async () => {
        setBusy('params');
        try {
          const data = await callApi('save-params', { params: paramsState });
          setSnap((prev) => ({ ...data, models: data.models ?? ((prev && prev.models) || null) }));
          dirtyParams.current = false;
          setParamDraft(null);
          setToolsDraft(null);
          setNotice(null);
          setJustDone('params');
        } catch (err) {
          setNotice({ kind: 'error', text: tr('msg.saveFailed') + String(err && err.message ? err.message : err) });
        } finally {
          setBusy('');
        }
      };

      const tabButton = (id, text) =>
        h(
          'button',
          {
            type: 'button',
            onClick: () => {
              setTab(id);
              // 提示属于“刚才那次操作”，切页就该消失，否则会跨页显示“已保存”
              setNotice(null);
              setMailNote(null);
              setPollNote(null);
              setDeletingMail('');
            },
            style: { ...S.tab, ...(tab === id ? S.tabActive : null) },
          },
          text,
        );

      /*
       * "还没绑定邮箱"是**配置引导**，不是错误：后端 refreshConfig 对"没有 sources"会清空 lastError
       * 并置 setupRequired，这里显示一张引导卡片，而不是红色报错 + "立即重试拉取"。
       */
      const setupRequired = Boolean(status.setupRequired)
        || (Array.isArray(snap && snap.sources) && snap.sources.length === 0 && !status.lastError);
      const statusTab = h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        setupRequired
          ? h(
              'div',
              { style: S.card },
              h('h3', { style: S.cardTitle }, tr('setup.title')),
              h('div', { style: S.empty }, tr('setup.hint')),
              h(
                'div',
                { style: S.actions },
                h(
                  'button',
                  { type: 'button', style: { ...S.btn, ...S.btnPrimary }, onClick: () => setTab('sources') },
                  tr('setup.action'),
                ),
              ),
            )
          : null,
        h(
          'div',
          { style: S.card },
          h('h3', { style: S.cardTitle }, tr('status.title')),
          h(
            'div',
            { style: S.grid },
            h(Value, {
              label: tr('status.lastTick'),
              value: status.lastTickAt ? `${clock(status.lastTickAt)}　${relTime(status.lastTickAt, tr)}` : tr('status.never'),
            }),
            h(Value, {
              label: tr('status.nextSchedule'),
              value: status.nextScheduleAt
                ? `${clock(status.nextScheduleAt)}${status.nextScheduleTask ? `　${status.nextScheduleTask}` : ''}`
                : '—',
            }),
            h(Value, {
              label: tr('preset.title'),
              value: !(snap && snap.preset)
                ? '—'
                : snap.preset.error
                  ? '⚠ ' + snap.preset.error
                  : snap.preset.registered
                    ? tr('preset.ok')
                    : tr('preset.missing'),
              title: (snap && snap.preset && (snap.preset.tools || []).join(' / ')) || '',
            }),
          ),
          h('div', { style: S.row }, h('div', { style: S.label }, tr('status.config')), h('div', { style: S.mono }, status.configFile || '—')),
          h('div', { style: S.row }, h('div', { style: S.label }, tr('status.archive')), h('div', { style: S.mono }, status.archiveDir || '—')),
          status.lastError
            ? h(
                'div',
                { style: { ...S.row, marginTop: 2, gap: 4 } },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                  h('div', { style: S.label }, tr('status.error')),
                  h('button', {
                    type: 'button',
                    style: { ...S.btnSm, marginLeft: 'auto', ...(busy === 'poll' ? S.btnDisabled : null) },
                    disabled: busy === 'poll',
                    onClick: () => runRetryPoll(),
                  }, busy === 'poll' ? tr('status.retrying') : tr('status.retryPoll')),
                ),
                // 错误正文单独一行、左对齐（以前 label 和正文挤在同一个 column flex 里，label 被居中）
                h(
                  'div',
                  { style: { ...S.value, color: T.error, whiteSpace: 'normal' } },
                  `${status.lastErrorAt ? `${clock(status.lastErrorAt)}　` : ''}${status.lastError}`,
                ),
              )
            : null,
          pollNote
            ? h('div', { style: { ...S.notice, color: pollNote.ok ? T.ok : T.error, whiteSpace: 'pre-wrap' } }, pollNote.text)
            : null,
        ),
        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'flex-start', gap: 8 } },
            h(
              'h3',
              { style: { ...S.cardTitle, marginRight: 'auto' } },
              `${tr('status.sources')}${snap && snap.sources ? `（${snap.sources.length}）` : ''}`,
            ),
            h(
              'button',
              {
                type: 'button',
                style: { ...S.btnSm, ...S.btnGhost },
                onClick: () => setTab('sources'),
              },
              tr(
                snap && snap.sources && snap.sources.length
                  ? 'status.manageSources'
                  : 'sources.add',
              ),
            ),
          ),
          snap && snap.sources && snap.sources.length
            ? snap.sources.map((s, index) =>
            /*
             * 一行一个来源、三行式：名称+协议徽标 / 身份信息 / 进度。
             * 以前是单行 flex + `marginLeft:auto`：长游标换行后右对齐，和上面的名称完全脱节，
             * 而且协议显示的是小写 type（imap/graph/gmail），现在用 typeLabel。
             */
            h(
              'div',
              {
                key: s.id,
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 3,
                  minWidth: 0,
                  padding: '8px 2px',
                  borderTop: index === 0 ? 'none' : `1px solid ${T.border}`,
                },
              },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap' } },
                h('span', { style: S.itemTitle }, s.name),
                h('span', { style: S.badge }, s.typeLabel || s.type || '?'),
              ),
              s.detail
                ? h(
                    'div',
                    { style: { ...S.textCaption, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                    s.detail,
                  )
                : null,
              s.cursor
                ? h(
                    'div',
                    { style: { ...S.mono, whiteSpace: 'normal', overflowWrap: 'anywhere' } },
                    h('span', { style: { color: T.dim } }, `${tr('status.progress')} `),
                    s.cursor,
                  )
                : null,
            ),
          )
          : h('div', { style: S.empty }, tr('status.noSources')),
        ),
      );

      // 重试失败邮件的可用条件：确实有 failed 的、且当前没在跑
      const failedCount = pending.items.filter((item) => item.outcome === 'failed').length;
      const retryDisabled = Boolean(busy) || Boolean(status.running) || failedCount === 0;

      // 状态列宽度：按当前语言最长徽标估算（CJK 约 1 字宽、ASCII 约 0.58 字宽），
      // 再加 padding 12 + border 2 + 取整余量，避免固定 72px 那样的大片空白。
      const estimateTextWidth = (text, size) =>
        Array.from(String(text)).reduce((w, ch) => w + (/[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? size : size * 0.58), 0);
      const stateColWidth = Math.max(
        24,
        Math.ceil(Math.max(estimateTextWidth(tr('col.processing'), 10), estimateTextWidth(tr('col.pending'), 10)) + 18),
      );

      const mailTab = h(
        'div',
        { style: S.card },
        // 标题与「重试失败邮件」同一行：按钮固定在块的右上角
        h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' } },
          h('h3', { style: { ...S.cardTitle, marginRight: 'auto' } }, `${tr('mail.title')}　${fmt(tr('mail.count'), { n: pending.count })}`),
          // 重试失败邮件：与 mail_automation_config 的 retry_failed 同一个 host 操作；
          // 清掉失败占位结论、attempts 归零后排队，下一拍（≤30s）处理。
          h('button', {
            type: 'button',
            style: { ...S.btnSm, ...(retryDisabled ? S.btnDisabled : null) },
            disabled: retryDisabled,
            title: failedCount === 0 ? tr('mail.retryNone') : '',
            onClick: () => runRetry(),
          }, busy === 'retry' ? tr('mail.retrying') : fmt(tr('mail.retryFailed'), { n: failedCount }))),
        pending.count === 0
          ? h('div', { style: S.empty }, tr('mail.empty'))
          : // 两行式列表而不是表格：设置面板只有 ~540px 宽，5 列表格会把
            // 「来源」压成竖排、（长）发件人再把主题挤到溢出。列表让主题独占第一行、
            // 次要信息收进第二行，长内容统一单行省略（悬停看全文）。
            h('div', { style: S.mailList },
              pending.items.map((item) => {
                const processing = status.processingDir && item.dir === status.processingDir;
                // 按**本地时区**显示：早先直接切 ISO 字符串，等于显示 UTC，
                // 和邮件客户端里的时间差一个时区（英国夏令时 +1），会被误认成另一封邮件。
                const time = ipTime(item.date);
                const meta = [time, item.source, item.from].filter(Boolean).join(' · ');
                return h('div', { key: item.dir || item.name, style: S.mailRow },
                  h('div', { style: { ...S.mailState, width: stateColWidth, flex: `0 0 ${stateColWidth}px` } },
                    // 三态区分清楚：处理失败（红）、已处理（绿）、处理中（黄）、待处理（灰）
                    item.outcome === 'failed'
                      ? h('span', { style: { ...S.badge, color: T.error, borderColor: T.error }, title: item.error || tr('col.failed') }, tr('col.failed'))
                      : item.hasConclusion
                        ? h('span', { style: { ...S.badge, color: T.ok, borderColor: T.ok }, title: tr('col.done') }, '✓')
                        : processing
                          ? h('span', { style: { ...S.badge, color: T.warn, borderColor: T.warn } }, tr('col.processing'))
                          : h('span', { style: { ...S.badge, opacity: 0.5 } }, tr('col.pending'))),
                  h('div', { style: S.mailMain },
                    h('div', { style: S.mailSubject, title: item.subject || '' }, item.subject || '(无主题)'),
                    h('div', { style: S.mailMeta, title: meta }, meta || '—'),
                  ),
                  h('button', {
                    type: 'button',
                    style: {
                      ...S.btnSm,
                      ...S.btnGhost,
                      color: T.error,
                      borderColor: T.error,
                      alignSelf: 'center',
                      flex: '0 0 auto',
                      ...(busy === 'mail-delete' ? S.btnDisabled : null),
                      ...(processing ? S.btnDisabled : null),
                    },
                    disabled: busy === 'mail-delete' || processing,
                    title: processing ? tr('col.processing') : tr('mail.deleteHint'),
                    onClick: () => deleteMail(item),
                  }, deletingMail === (item.name || item.dir) ? tr('mail.confirmDelete') : tr('mail.delete')),
                );
              })),
        h('div', { style: S.empty }, tr('mail.hint')),
        mailNote
          ? h(
              'div',
              {
                role: mailNote.ok ? 'status' : 'alert',
                style: { ...S.notice, color: mailNote.ok ? T.ok : T.error, whiteSpace: 'pre-wrap' },
              },
              `${mailNote.ok ? '✓' : '⚠'} ${mailNote.text}`,
            )
          : null,
      );

      const promptBox = (key, label) => {
        const meta = prompts[key] || {};
        return h(
          'div',
          { style: S.field, key },
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', minWidth: 0 } },
            h('label', { style: S.formLabel, htmlFor: `mm-prompt-${key}` }, label),
            h('span', { style: S.mono }, meta.path || '(未配置路径)'),
            // 原来单独占一行，三段就多 3 行；并到标题行里，整页矮 ~50px
            meta.exists === false ? h('span', { style: { ...S.label, color: T.warn } }, tr('prompts.missing')) : null,
          ),
          h(PromptEditor, {
            id: `mm-prompt-${key}`,
            value: promptsState[key] || '',
            onChange: (next) => setPrompt(key, next),
          }),
        );
      };

      const promptsTab = h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h('div', { style: S.card },
          h('h3', { style: S.cardTitle }, tr('prompts.title')),
          h('div', { style: S.empty }, tr('prompts.hint')),
          promptBox('mail', tr('prompts.mail')),
          promptBox('html', tr('prompts.html')),
          h('div', { style: S.actionsEnd },
            dirtyPrompts.current ? h('span', { style: { ...S.notice, color: T.warn } }, tr('msg.dirty')) : null,
            notice ? h('span', { style: { ...S.notice, color: notice.kind === 'error' ? T.error : T.ok } }, notice.text) : null,
            h('button', {
              type: 'button', style: { ...S.btn, ...S.btnGhost }, disabled: Boolean(busy), onClick: cancelPrompts,
            }, tr('action.reset')),
            h('button', { type: 'button', style: { ...S.btn, ...S.btnPrimary, ...(busy === 'prompts' || justDone === 'prompts' ? S.btnDisabled : null) }, disabled: Boolean(busy) || justDone === 'prompts', onClick: savePrompts },
              justDone === 'prompts' ? tr('msg.saved') : tr('action.save')),
          ),
        ),
      );

      const guideTab = h(
        'div',
        { style: S.card },
        h('h3', { style: S.cardTitle }, tr('guide.title')),
        h(
          'div',
          {
            style: {
              ...S.textBody,
              whiteSpace: 'pre-wrap',
              lineHeight: 1.75,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              overflowX: 'auto',
            },
          },
          tr('guide.content'),
        ),
      );

      const numberField = (key, label, min, hint) =>
        h('div', { style: S.field, key },
          h('label', { style: S.formLabel, htmlFor: `mm-p-${key}` }, label),
          h('input', {
            id: `mm-p-${key}`, type: 'number', min: min || 1, style: S.input,
            value: paramsState[key] === null || paramsState[key] === undefined ? '' : paramsState[key],
            onChange: (e) => setParam(key, e.target.value === '' ? '' : Number(e.target.value)),
          }),
          hint ? h('div', { style: S.textCaption }, hint) : null);

      const checkField = (key, label) =>
        h('label', { style: S.check, key },
          h('input', { type: 'checkbox', checked: Boolean(paramsState[key]), onChange: (e) => setParam(key, e.target.checked) }),
          h('span', null, label));

      const textField = (key, label, hint) =>
        h('div', { style: S.field, key },
          h('label', { style: S.formLabel, htmlFor: `mm-p-${key}` }, label),
          h('input', {
            id: `mm-p-${key}`, type: 'text', style: S.input, spellCheck: false,
            value: paramsState[key] === null || paramsState[key] === undefined ? '' : paramsState[key],
            onChange: (e) => setParam(key, e.target.value),
          }),
          hint ? h('div', { style: S.textCaption }, hint) : null);

      /*
       * 「模型与工具」这一组的派生值：模型目录由 GET 快照带回来（可能为 null），
       * 工具目录来自 snapshot.catalog。拿不到目录时退化成手填/只显示默认项，保存不受影响。
       */
      const models = (snap && snap.models) || null;
      const providers = models && Array.isArray(models.providers) ? models.providers : [];
      const efforts = (snap && snap.catalog && Array.isArray(snap.catalog.efforts))
        ? snap.catalog.efforts
        : ['inherit', 'minimal', 'low', 'medium', 'high'];
      const toolCatalog = (snap && snap.catalog && Array.isArray(snap.catalog.tools)) ? snap.catalog.tools : [];
      const toolIds = Array.isArray(paramsState['agent.tools']) ? paramsState['agent.tools'] : [];
      const toolRows = toolDraft === null ? toolIds : toolDraft;
      const aliases = (snap && snap.catalog && snap.catalog.aliases) || {};
      const catalogPkgs = {};
      for (const entry of toolCatalog) catalogPkgs[entry.id] = entry.id;
      /** 与后端 resolveToolSpec 同规则：目录 id / 工具名 / 模块名 三选一 */
      const resolveRow = (value) => {
        const text = String(value || '').trim();
        if (!text) return { kind: 'empty', label: '' };
        if (catalogPkgs[text]) return { kind: 'ok', label: tr('param.toolsOk') };
        if (aliases[text]) return { kind: 'ok', label: tr('param.toolsOk') + ' → ' + aliases[text] };
        if (/^@[^/\s]+\/[^/\s]+/.test(text) || /^[a-z0-9][\w.-]*\/[\w./-]+$/i.test(text)) return { kind: 'module', label: tr('param.toolsModule') };
        return { kind: 'bad', label: tr('param.toolsBad') };
      };
      const commitToolRows = (rows) => {
        setToolsDraft(rows);
        setParam('agent.tools', rows.map((row) => String(row || '').trim()).filter(Boolean));
      };
      const providerId = paramsState['agent.provider'] || '';
      const declaredModels = (providers.find((provider) => provider.id === providerId) || {}).models || [];
      const declaredIds = declaredModels.map((model) => model.id);
      // 当前值可能不在目录里（目录拿不到 / 手填 / 换了 provider）：补一个"当前"选项，
      // 否则 <select value> 找不到匹配项时浏览器会显示第一项，界面说"跟随部署默认"、保存却写旧值。
      const currentModel = paramsState['agent.model'] || '';
      const modelOptions = currentModel && !declaredIds.includes(currentModel)
        ? [{ id: currentModel, name: currentModel + ' (当前)' }, ...declaredModels]
        : declaredModels;
      // 思考强度来自**所选模型**的能力表（宿主 ModelCatalog 的 reasoning.efforts），拿不到才回落固定集合
      const selectedModel = declaredModels.find((model) => model.id === currentModel);
      const effortOptions = (selectedModel && selectedModel.efforts && selectedModel.efforts.length
        ? selectedModel.efforts
        : efforts).concat((selectedModel && selectedModel.efforts && selectedModel.efforts.includes('inherit')) || !selectedModel ? [] : ['inherit']);

      const selectField = (id, label, value, options, onPick) =>
        h('div', { style: S.field },
          h('label', { style: S.formLabel, htmlFor: id }, label),
          h('select', { id, style: S.select, value, onChange: (e) => onPick(e.target.value) },
            options.map((option) => h('option', { key: option.value, value: option.value, style: S.option }, option.label))));

      const modelFields = h('div', { style: S.grid },
        providers.length > 0
          ? selectField(
              'mm-p-provider',
              tr('param.provider'),
              providerId,
              [{ value: '', label: tr('param.followDeploy') }, ...providers.map((provider) => ({ value: provider.id, label: provider.id }))],
              (value) => setParamsPatch({ 'agent.provider': value, 'agent.model': '' }),
            )
          : textField('agent.provider', tr('param.provider'), tr('param.modelsUnavailable')),
        modelOptions.length > 0
          ? selectField(
              'mm-p-model',
              tr('param.model'),
              paramsState['agent.model'] || '',
              [{ value: '', label: tr('param.followDeploy') }, ...modelOptions.map((model) => ({ value: model.id, label: model.name || model.id }))],
              (value) => setParam('agent.model', value),
            )
          : textField('agent.model', tr('param.model'), providers.length > 0 ? '' : tr('param.modelsUnavailable')),
        selectField(
          'mm-p-effort',
          tr('param.effort'),
          paramsState['agent.reasoning_effort'] || 'inherit',
          effortOptions.map((id) => ({ value: id, label: id === 'inherit' ? tr('param.followDeploy') : id })),
          (value) => setParam('agent.reasoning_effort', value),
        ),
      );

      const paramsActions = h('div', { style: { ...S.actionsEnd, paddingTop: 2 } },
        h('button', { type: 'button', style: { ...S.btn, ...S.btnPrimary, ...(busy === 'params' || justDone === 'params' ? S.btnDisabled : null) }, disabled: Boolean(busy) || justDone === 'params', onClick: saveParams },
          justDone === 'params' ? tr('msg.saved') : tr('action.save')),
        h('button', {
          type: 'button', style: { ...S.btn, ...S.btnGhost },
          onClick: () => { dirtyParams.current = false; setParamDraft(null); setToolsDraft(null); setNotice(null); },
        }, tr('action.reset')),
        dirtyParams.current ? h('span', { style: { ...S.notice, color: T.warn } }, tr('msg.dirty')) : null,
        notice ? h('span', { style: { ...S.notice, color: notice.kind === 'error' ? T.error : T.ok } }, notice.text) : null,
      );

      const paramsTab = h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h('div', { style: S.card },
          h('h3', { style: S.cardTitle }, tr('params.title')),
          h('div', { style: S.empty }, tr('params.hint')),
          h('div', { style: S.grid },
            numberField('poll_seconds', tr('param.poll'), 5),
            numberField('heartbeat_seconds', tr('param.heartbeat'), 1, tr('param.heartbeatHint')),
            numberField('busy_retry_seconds', tr('param.busyRetry'), 1, tr('param.busyRetryHint')),
            numberField('busy_retry_max', tr('param.busyRetryMax'), 1),
            numberField('initial_headers', tr('param.headers'), 1),
            numberField('agent.session_budget_mb', tr('param.sessionBudget'), 0, tr('param.sessionBudgetHint')),
            numberField('agent.prompt_max_kb', tr('param.promptMaxKb'), 0, tr('param.promptMaxKbHint')),
          ),
          h('div', { style: { display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 4 } },
            checkField('agent.silent', tr('param.silent')),
          ),
          // 邮件 agent 的工作区：会话落地目录（同 dsh-qqbot-bridge 的"默认工作区"）
          textField('agent.workspace', tr('param.workspace'), tr('param.workspaceHint')),
        ),
        /*
         * 模型与工具：邮件子 agent 的成本/质量旋钮。
         * 模型目录来自宿主（GET 的 `models`），拿不到就退化成手填——保存不依赖目录。
         */
        h('div', { style: S.card },
          h('h3', { style: S.cardTitle }, tr('param.modelTitle')),
          modelFields,
          h('div', { style: S.field },
            h('label', { style: S.formLabel, htmlFor: 'mm-p-tools' }, tr('param.tools')),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 } },
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                toolRows.map((row, rowIndex) => {
                  const verdict = resolveRow(row);
                  return h('div', { key: rowIndex, style: { display: 'flex', gap: 8, alignItems: 'center' } },
                    h('input', {
                      type: 'text', style: { ...S.input, flex: 1, minWidth: 0 }, spellCheck: false,
                      value: row, placeholder: tr('param.toolsPlaceholder'),
                      onChange: (e) => {
                        const next = [...toolRows];
                        next[rowIndex] = e.target.value;
                        commitToolRows(next);
                      },
                    }),
                    h('span', { style: { ...S.textSmall, whiteSpace: 'nowrap', color: verdict.kind === 'bad' ? T.error : verdict.kind === 'empty' ? T.dim : T.ok } }, verdict.label || '—'),
                    h('button', {
                      type: 'button', style: { ...S.btnLink },
                      title: tr('param.toolsRemove'),
                      onClick: () => commitToolRows(toolRows.filter((_, i) => i !== rowIndex)),
                    }, '×'));
                }),
                h('button', {
                  type: 'button', style: { ...S.btnSm, ...S.btnGhost, alignSelf: 'flex-start' },
                  onClick: () => commitToolRows([...toolRows, '']),
                }, tr('param.toolsAdd'))),
              toolCatalog.length === 0 ? h('span', { style: S.textCaption }, tr('param.toolsDefault')) : null,
            ),
            h('div', { style: S.textCaption }, tr('param.toolsHint')),
            h('div', { style: S.textCaption }, tr('param.toolsBuiltin')),
          ),
        ),
        /* HTML 邮件预览图：把 render.* 接进设置页（直连宿主无头 Edge/Chrome） */
        h('div', { style: S.card },
          h('h3', { style: S.cardTitle }, tr('param.renderTitle')),
          h('div', { style: S.grid },
            numberField('render.width', tr('param.renderWidth'), 320),
            numberField('render.slice_height', tr('param.renderSliceHeight'), 600),
            numberField('render.slice_overlap', tr('param.renderSliceOverlap'), 0),
            numberField('render.max_height', tr('param.renderMaxHeight'), 600),
          ),
          checkField('render.remote_images', tr('param.renderRemoteImages')),
          textField('render.browser', tr('param.renderBrowser'), tr('param.renderBrowserHint')),
        ),
        paramsActions,
      );

      // 邮箱/绑定页签：面板自己管表单与绑定轮询，快照更新回灌到主组件（其它页签也受益）
      const sourcesTab = h(SourcesPanel, {
        snap,
        tr,
        api: callApi,
        onSnapshot: (data) =>
          setSnap((prev) => ({ ...data, models: data.models ?? ((prev && prev.models) || null) })),
      });

      // 定时任务页签：任意数量、各自提示词；保存/运行都走后端同一套操作
      const schedulesTab = h(SchedulesPanel, {
        snap,
        tr,
        api: callApi,
        onSnapshot: (data) =>
          setSnap((prev) => ({ ...data, models: data.models ?? ((prev && prev.models) || null) })),
      });

      return h(
        'div',
        {
          ref: pageRef,
          className: 'dsh-mail-page',
          style: { ...S.page, ...(pageWidth > 0 ? { width: `${pageWidth}px`, maxWidth: '100%' } : null) },
        },
        h('style', null,
          '.dsh-mail-page button:hover:not(:disabled){filter:brightness(1.08)}' +
          '.dsh-mail-page button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}'),
        h('div', { style: S.head },
          h('span', { style: { ...S.dot, background: dot.color } }),
          h('h2', { style: S.title }, tr('section.title')),
          h('span', { style: S.textSmallDim }, dot.text),
        ),
        h('div', { style: S.tabs },
          tabButton('status', tr('tab.status')),
          tabButton('mail', tr('tab.mail')),
          tabButton('sources', tr('tab.sources')),
          tabButton('schedules', tr('tab.schedules')),
          tabButton('prompts', tr('tab.prompts')),
          tabButton('params', tr('tab.params')),
          tabButton('guide', tr('tab.guide')),
        ),
        error ? h('div', { style: { ...S.notice, color: T.error } }, tr('msg.loadFailed') + error) : null,
        tab === 'status' ? statusTab : tab === 'mail' ? mailTab : tab === 'sources' ? sourcesTab : tab === 'schedules' ? schedulesTab : tab === 'prompts' ? promptsTab : tab === 'guide' ? guideTab : paramsTab,
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // 文案：注册进 Client locale 服务，再优先用它的 bind()（调用时读当前语言，
        // 自动走 fallback 链）；bind 拿不到时才按 `getLocale().active` 自己选词典。
        //
        // 注意 `LocaleSnapshot` 的字段是 **active**（不是 id）：早先读 `.id` 恒为
        // undefined，于是无论界面语言是什么都会退回英文。
        const locale = ctx.locale;
        let translate = null;
        // 词典注册返回 disposer：交给 effect 管，重载时先撤旧的再注册，
        // 否则重复注册同一个 (namespace, locale) 会抛（单占用），整段 try 静默降级。
        const registerDicts = () => {
          const disposers = [
            locale.register('mail-automation', 'en', EN),
            locale.register('mail-automation', 'zh-CN', ZH),
            locale.register('mail-automation', 'zh', ZH),
          ];
          return () => {
            for (const dispose of disposers) {
              try {
                dispose?.();
              } catch {
                // ignore
              }
            }
          };
        };
        try {
          if (typeof ctx.effect === 'function') ctx.effect(registerDicts);
          else registerDicts();
        } catch {
          // 词典注册失败不影响面板：pick() 会按 getLocale().active 选内置词典
        }
        try {
          translate = locale.bind('mail-automation');
        } catch {
          translate = null;
        }
        const pick = (key) => {
          if (translate) {
            try {
              const text = translate(key);
              if (text && text !== key) return text;
            } catch {
              // 落到下面的自有词典
            }
          }
          let active = '';
          try {
            const snap = locale && locale.getLocale ? locale.getLocale() : null;
            active = String((snap && snap.active) || '');
          } catch {
            active = '';
          }
          const dict = active.toLowerCase().startsWith('zh') ? ZH : EN;
          return dict[key] || EN[key] || key;
        };
        MailAssistantSection.pick = pick;
        // 语言切换时让面板重渲染（nav 的 label 是 thunk，壳每次投影都会重读）
        MailAssistantSection.subscribeLocale = (fn) => {
          try {
            return locale.subscribe(fn);
          } catch {
            return () => {};
          }
        };

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'mail-automation',
              order: 56,
              label: () => pick('section.title'),
            },
            MailAssistantSection,
          ),
        );
      },
    };
  },
});
