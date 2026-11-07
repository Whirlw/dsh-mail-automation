/**
 * 插件自身的配置 schema（Schemastery）。
 *
 * 设计（对齐 dsh-plugin-guide §3.6）：
 * - **所有可调参数都在这里声明**，所以「只改 cordis.yml、不改代码」就能改轮询间隔、
 *   邮箱来源、总览时间、QQ 推送、存档位置 —— 这是 §3.6 那条红线的判断标准。
 * - 真正需要**不重载就生效**的字段标成 `.volatile()`（Schemastery 3.18+ 支持：
 *   `z.number().volatile()`），运行时读到的是 `{ get() }`，改完由 `loader/volatile-update`
 *   通知，插件下一次操作重新 `get()` 即可（见 index.js 的 unwrap/refresh）。
 * - 默认值里**不出现机器绝对路径**：配置文件默认放在 `$DSH_HOME/mail-automation/` 下，
 *   按机器/用户不同用 `expandPath()` 展开（换机、换用户都不用改代码）。
 * - `configFile` 仍然保留：对外提供一个「YAML 覆盖层」，便于像改提示词一样随手改、
 *   改完即生效（覆盖层只覆盖它写到的字段，其余取本 schema 的值）。
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { DEFAULT_AGENT_WORKSPACE, DEFAULT_CONFIG_FILE, resolveProfileDir } from './config.js';
import { DEFAULT_OPENER_PROMPT } from './defaults.js';

/**
 * 载入 Schemastery，两份来源按顺序尝试：
 *
 *   1. **裸 `import`** —— 插件被装进 profile 目录树（正常安装形态）时，Node 从
 *      `profiles/<name>/node_modules` 就能解析到；宿主对 `@deepseek-ai/*` 的解析重写也在这层。
 *   2. **profile 的 require** —— pnpm 把 `file:` 目录依赖装成 junction、realpath 落到工作区
 *      （解析不到 profile 依赖）时的那条老路。
 *
 * 为什么不再只留第 2 条：`createRequire(<profile>/package.json)` 一旦解析不到，异常发生在
 * **模块求值期**，插件连 `apply()` 都进不去；`dsh web` 下这种失败没有日志 sink
 * （guide/unfixed-issues.md T3），现场表现为「插件装了，但什么都没挂上」。
 * 裸 import 是主路径，两条都失败才抛——加载期响亮失败，好过静默不激活。
 *
 * 这里用顶层 await（ESM 合法，host.js 的桥接模块同样用法）：模块变成 async，
 * 但 `export const Config` 仍然在求值完成时就绪。
 */
function loadFromProfile() {
  // schemastery 是 profile 里的普通依赖，同步 require 即可（不在宿主注入名单里）
  const require = createRequire(path.join(resolveProfileDir(), 'package.json'));
  const loaded = require('@deepseek-ai/schemastery');
  return loaded?.default ?? loaded;
}

export let schemaSource = '';

const Schema = await (async () => {
  let bareError;
  try {
    const mod = await import('@deepseek-ai/schemastery');
    const loaded = mod?.default ?? mod;
    if (typeof loaded?.object === 'function') {
      schemaSource = 'bare-import';
      return loaded;
    }
    bareError = new Error('裸 import 拿到的模块没有 object()');
  } catch (err) {
    bareError = err;
  }
  try {
    const loaded = loadFromProfile();
    if (typeof loaded?.object !== 'function') throw new Error('profile require 拿到的模块没有 object()');
    schemaSource = 'profile-require';
    return loaded;
  } catch (profileError) {
    throw new Error(
      'dsh-mail-automation 无法加载 @deepseek-ai/schemastery（' +
        `裸 import：${bareError?.message ?? bareError}；` +
        `profile require：${profileError?.message ?? profileError}）`,
    );
  }
})();

/** 一个邮箱来源。四种协议共用一张表，按 type 取用各自字段。 */
const Source = Schema.object({
  id: Schema.string().default('').description('来源标识（存档目录名、状态游标都用它；留空按邮箱身份派生）'),
  name: Schema.string().default('').description('显示名（提示词、总览、日志里用）'),
  type: Schema.union([Schema.const('imap'), Schema.const('pop3'), Schema.const('oauth2'), Schema.const('gmail'), Schema.const('graph')])
    .default('imap')
    .description('imap / pop3 = 账号密码；oauth2 = IMAP + XOAUTH2（Microsoft 365 设备码登录）；gmail = Gmail API（OAuth）；graph = Microsoft Graph（OAuth）'),
  // ── imap / pop3 ──
  host: Schema.string().default('').description('服务器地址（可留空：按 provider 或邮箱域名推断）'),
  port: Schema.number().default(0).description('端口（0 = 按预设：IMAP 993 / POP3 995）'),
  secure: Schema.boolean().default(true).description('是否 TLS'),
  user: Schema.string().default('').description('用户名/邮箱地址'),
  password: Schema.string()
    .role('secret')
    .default('')
    .description('密码/授权码（不建议写在这里，优先用 passwordRef）'),
  passwordRef: Schema.string()
    .default('')
    .description('凭据引用名（走 ctx.credentials，例如 MAIL_PRIVATE_PASSWORD）'),
  mailbox: Schema.string().default('').description('IMAP 邮箱文件夹（留空 = INBOX）'),
  provider: Schema.string().default('').description('邮箱服务商预设名（qq / 163 / gmail / outlook …）'),
  // ── gmail / graph（OAuth） ──
  tokenFile: Schema.string()
    .default('')
    .description('OAuth 令牌文件（graph 留空 = $DSH_HOME/mail-automation/tokens/graph-<id>.json；gmail 留空 = $DSH_HOME/mail-automation/tokens/<id>.json）'),
  folder: Schema.string().default('').description('Graph 文件夹 / Gmail 标签 **id**（留空 = inbox / INBOX；Gmail 填标签名会 400）'),
  top: Schema.number().default(20).description('每轮比对最近多少封（graph / gmail）'),
  clientId: Schema.string().default('').description('OAuth 客户端 id（gmail / graph 绑定用）'),
  clientSecret: Schema.string()
    .role('secret')
    .default('')
    .description('OAuth 客户端 secret（Gmail「已安装应用」需要；优先用 clientSecretRef）'),
  clientSecretRef: Schema.string().default('').description('OAuth 客户端 secret 的凭据引用名'),
  tenant: Schema.string().default('common').description('Microsoft Graph 租户（common / 租户 id / 域名）'),
});

/** 一个定时任务的排期：类型 + 时刻/周几/每月哪几天/间隔分钟 */
const ScheduleSpec = Schema.object({
  type: Schema.union([
    Schema.const('daily'),
    Schema.const('weekly'),
    Schema.const('monthly'),
    Schema.const('interval'),
    Schema.const('startup'),
  ])
    .default('daily')
    .description('daily 每天 / weekly 每周 / monthly 每月 / interval 每 N 分钟 / startup 每次启动一次'),
  times: Schema.array(Schema.string()).default(['21:30']).description('本地时刻 HH:MM；daily/weekly/monthly 用，可写多个'),
  weekdays: Schema.array(Schema.number()).default([1]).description('weekly 用：ISO 周几 1=周一 … 7=周日'),
  days: Schema.array(Schema.number()).default([1]).description('monthly 用：每月第几天 1–31（月份没有该日时按最后一天）'),
  everyMinutes: Schema.number().default(60).description('interval 用：每多少分钟一次（≥1）'),
});

/** 一条定时任务：排期 + 自己的提示词（agent 在触发时按它执行） */
const MailSchedule = Schema.object({
  id: Schema.string().default('').description('任务标识（运行记录/日志用；留空自动 task-N；必须唯一）'),
  name: Schema.string().default('').description('显示名'),
  enabled: Schema.boolean().default(true).description('是否启用'),
  schedule: ScheduleSpec.description('排期'),
  promptFile: Schema.string().default('').description('提示词文件（相对配置文件目录；每次触发现读）'),
});

export const Config = Schema.object({
  configFile: Schema.string()
    .default(DEFAULT_CONFIG_FILE)
    .description('YAML 覆盖层的路径（留空 = 只用本 schema 的配置）；相对路径按 $DSH_HOME 展开'),

  // ── 轮询 ──
  pollSeconds: Schema.number()
    .min(5)
    .step(1)
    .default(30)
    .volatile()
    .description('轮询间隔（秒）；标了 volatile，改完不用重载插件'),
  heartbeatSeconds: Schema.number()
    .min(1)
    .step(1)
    .default(5)
    .description('心跳检查间隔（秒）：每隔这么久看一次「到点该轮询了吗」；改完需重载插件'),
  busyRetrySeconds: Schema.number()
    .min(1)
    .max(300)
    .step(1)
    .default(5)
    .description('定时任务到点撞上轮询占锁时，隔多少秒重试一次（默认 5）'),
  busyRetryMax: Schema.number()
    .min(1)
    .max(1000)
    .step(1)
    .default(24)
    .description('定时任务撞上轮询占锁时最多重试多少次（默认 24，约 2 分钟）'),
  initialHeaders: Schema.number()
    .min(1)
    .step(1)
    .default(10)
    .description('启动快照抓取多少条邮件头（1–50，超出按 50 处理）'),
  archiveRetryAttempts: Schema.number()
    .min(1)
    .max(10)
    .step(1)
    .default(3)
    .description('单封邮件取正文/落盘失败后最多重试几轮；超过就跳过该封并记 ERROR（避免一封坏信卡住整个来源）'),

  sources: Schema.array(Source).description('邮箱来源列表（可以为空：插件保持空闲，设置页引导绑定）'),

  prompt: Schema.object({
    file: Schema.string().default('').description('普通邮件的提示词文件（Markdown，# 开头的头部注释会被剥掉）'),
    htmlFile: Schema.string().default('').description('带 HTML 正文的邮件用这份提示词（留空 = 复用 file）'),
  }).description('交给 agent 的提示词'),

  schedules: Schema.array(MailSchedule).description('定时任务列表；空数组 = 不跑任何定时任务'),

  storage: Schema.object({
    root: Schema.string().default('').description('存档根目录（留空 = $DSH_HOME/mail-automation）'),
    archiveSubdir: Schema.string().default('archive').description('存档子目录（一封邮件一个目录，平铺）'),
    snapshotFile: Schema.string().default('startup.md').description('启动快照文件名（每次覆盖）'),
    stateFile: Schema.string()
      .default('state.json')
      .description('状态文件（游标/重试/父会话）；只在宿主没有 storage-domain 时使用，否则状态在 $DSH_HOME/storages 的状态域里'),
    logMaxBytes: Schema.number()
      .min(65536)
      .step(65536)
      .default(2 * 1024 * 1024)
      .description('插件自落日志的轮转阈值（字节）；改完需重载插件'),
  }).description('本地存储'),

  agent: Schema.object({
    workspace: Schema.string()
      .default(DEFAULT_AGENT_WORKSPACE)
      .description('未选择工作区时的会话落点；留空则使用 $DSH_HOME/workspace/default。'),
    sessionMode: Schema.union([Schema.const('per_mail'), Schema.const('daily')])
      .default('per_mail')
      .description('per_mail = 每封一个受管子智能体（用完归档）；daily = 每天复用同一会话'),
    preset: Schema.string()
      .default('mail-automation-agent')
      .description('处理邮件用的预设 id（默认由插件按 agent.tools 运行时注册；留空 = 跟随部署默认；取不到会自动退回默认）'),
    provider: Schema.string()
      .default('')
      .description('处理邮件用的模型 provider（留空 = 跟随部署默认；设置页从宿主模型目录里选）'),
    model: Schema.string()
      .default('')
      .description('处理邮件用的模型 id（留空 = 跟随部署默认；与 provider 成对生效）'),
    tools: Schema.array(Schema.string())
      .default([
        'mail_automation_archive_read',
        'mail_automation_archive_list',
        'mail_automation_archive_clear',
        'qq_notify',
        'read_image',
      ])
      .description(
        '邮件/定时任务子 agent 可用的工具集（默认：读存档 / 批量列存档 / 清理存档 / 发 QQ / 看预览图；清空 = 不给任何工具）',
      ),
    reasoningEffort: Schema.string()
      .default('low')
      .description('处理邮件时的思考强度 minimal/low/medium/high（留空或 inherit = 跟随部署默认）'),
    turnTimeoutSeconds: Schema.number()
      .min(30)
      .step(10)
      .default(300)
      .description('单封邮件交给 agent 处理的超时（秒）；超时按失败处理并进入重试队列'),
    retryAttempts: Schema.number()
      .min(1)
      .step(1)
      .default(3)
      .description('agent 处理失败后最多重试几次（达到上限就放弃这封）'),
    openerPrompt: Schema.string()
      .default(DEFAULT_OPENER_PROMPT)
      .description('父会话的开场白（空白会话在 WebUI 里不显示，所以要有一轮真实对话）；留空 = 不写开场白'),
    silent: Schema.boolean()
      .default(false)
      .description(
        '静默处理：父会话以 origin=subagent 创建，不挂工作区、不进侧边栏、不归档；下次启动时工作区/silent 没变就沿用上次的父会话，变了才归档旧会话并新建。默认关，重启生效',
      ),
    sessionBudgetMb: Schema.number()
      .min(0)
      .step(1)
      .default(8)
      .description(
        '单个会话（父会话 / 每日会话）累计事件的字节上限（MB）：超过就在启动或换日时归档旧会话并新建，避免会话无界增长把请求撑爆（bili 之类的折叠代理会因此 413）。0 = 不限制',
      ),
    promptMaxKb: Schema.number()
      .min(0)
      .step(16)
      .default(512)
      .description(
        '单条提示词的字节上限（KB）：超过就拒绝发送并把这封记为失败（不送注定 413 的请求）。0 = 不限制',
      ),
  }).description('agent 运行方式'),
  credentials: Schema.object({
    secretRetrySeconds: Schema.number()
      .min(30)
      .step(10)
      .default(300)
      .description('passwordRef 解析不到时的重试退避（秒），避免每轮轮询都刷同一条 WARN'),
  }).description('凭据解析'),

  render: Schema.object({
    width: Schema.number().min(320).step(10).default(1000).description('预览图视口宽度（px）'),
    sliceHeight: Schema.number()
      .min(600)
      .step(50)
      .default(1400)
      .description('超长页面每片最大高度（px）；太高小字会被压糊'),
    sliceOverlap: Schema.number().min(0).step(10).default(120).description('相邻切片的重叠高度（px），避免切到半行字'),
    maxHeight: Schema.number()
      .min(600)
      .default(12000)
      .description('整页图/切片的最大高度（px）；超过这个高度以下的内容**不会**进图片，需要更全就调大'),
    remoteImages: Schema.boolean()
      .default(true)
      .description('是否允许邮件里引用远程图片/样式（关掉可避免"打开即已读"的追踪像素，但版式会变素）'),
    browser: Schema.string()
      .default('')
      .description('Chromium 内核浏览器可执行文件（Edge/Chrome）；留空 = 按常见安装路径自动探测'),
  }).description('HTML 邮件预览图渲染（headless Edge/Chrome）'),

  qq: Schema.object({
    enabled: Schema.boolean().default(true).description('是否允许 QQ 推送'),
    appId: Schema.string()
      .default('')
      .description('QQ 机器人 AppID（留空则经 ctx.credentials 解析 QQ_BOT_APP_ID）'),
    appSecret: Schema.string()
      .role('secret')
      .default('')
      .description('QQ 机器人 AppSecret（留空则经 ctx.credentials 解析 QQ_BOT_SECRET）'),
    openid: Schema.string().default('').description('接收人的 openid（必填，否则发送会明确报错）'),
    markdown: Schema.boolean().default(true).description('用 msg_type=2 发 Markdown（不支持时自动退回纯文本）'),
  }).description('QQ 机器人推送'),
}).description('dsh-mail-automation：轮询邮箱 → 逐封 agent 处理 → 可选 QQ 提醒/总览');
