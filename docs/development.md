# 开发与验证

> 基线：插件 `1.0.0`、Node `^22.19.0 || >=24.0.0`。本文只记录**当前**开发约束，不保留旧版本变更史。

## 1. 环境事实

| 项 | 值 |
|---|---|
| 插件 | `1.0.0`（显式定时任务 + 直接工具调用） |
| 离线测试 | `node test/entry.test.mjs` = 92 项；`node test/issues.test.mjs` = 22 项 |
| 静态检查 | `dsh-plugin-dev check` = 12 passed / 0 failed / 1 warned / 3 skipped |
| 安装形态 | profile `desktop` 里是指向本仓库的 junction（插件页安装）；日志 `schema=bare-import` |

`1 warned` 是 `manifest-package-manager`（未固定 packageManager），与功能无关。

## 2. 代码边界

| 文件 | 职责 |
|---|---|
| `src/index.js` | 装配：配置、轮询、调度、agent、HTTP 路由、卸载 |
| `src/config.js` | schema/YAML 归一化、路径展开、提示词读取、schema 导出 |
| `src/schema.js` | Cordis 配置 schema（当前字段的唯一说明） |
| `src/schedule.js` | 纯排期数学与 busy 退避 |
| `src/store.js` | 状态双后端、存档布局、结论状态 |
| `src/digest.js` | 任务提示词模板变量（清单/快照），不再有手动总览 |
| `src/tools.js` | 7 个 agent 工具 |
| `src/uiapi.js` | 设置页 HTTP 操作与状态快照 |
| `client.js` | 设置页 UI（单文件 bundle） |

**不复存在**（0.8.0 清理）：`digest.*` 配置、默认任务、`schedules[].prompt` 内联、`prompt.inline`、
`mail_automation_digest` 工具、`kind` / `consume_archive`、旧 Graph 令牌迁移、旧来源 id 游标沿用、
旧提示词路径复制/注释剥离/skill 名改写、旧工具集自动升级、`deprecated` 警告机制。
新增代码不要再为这些旧形态加回兼容分支。

## 3. 必须保持的契约

1. `apply()` 同步返回，异步工作放 `ctx.effect` / `registerAsync`。
2. 定时任务**必须**有 `prompt_file`；没有默认任务。`schedules: []` 合法。
3. 提示词文件是唯一来源；`saveSchedules` 可把正文写进 `prompt/<id>-prompt.md`，但 YAML 只存路径。
4. 默认工具集 5 件：archive_read / archive_list / archive_clear / qq_notify / read_image。
   未配置时用默认；用户列表原样保留，不自动迁移。
5. Graph 令牌按来源生成：`tokens/graph-<id>.json`（不含文件夹后缀），不再读旧固定路径。
6. 状态 `meta` 白名单必须保留 `scheduleRuns`，否则重启后同槽重跑。
7. 设置页页签顺序：概览 → 已存档 → 邮箱 → 定时任务 → 提示词 → 参数 → 指南。
8. 合法运行时兜底**保留**：subprocess→local spawn、credentials 服务→文件、storage-domain→`state.json`、
   workspace/model/preset 兜底、网络/渲染超时。这些不是"旧版本适配"。

## 4. 本地验证

```powershell
node test\entry.test.mjs
node test\issues.test.mjs
node "C:\Users\31089\.dsh\profiles\desktop\node_modules\dsh-plugin-guide\bin\dsh-plugin-dev.js" check --cwd .
node test\harness.mjs        # 需要真实邮箱配置；不进 CI
```

客户端改动后需在设置页 **Ctrl+F5**；后端/工具改动需重启 DSH。不要把测试写成依赖真实 `~/.dsh`：
用 `DSH_HOME` 指向临时目录。

## 5. 测试编写约定

- 每个断言只测当前契约，不写"旧配置仍可用"。
- 临时目录用 `fs.mkdtempSync(path.join(os.tmpdir(), ...))`，结束时删除。
- 配置测试显式传 `dshHome` / `configFile`，避免污染真实 profile。
- 设置页静态断言只查行为标记（页签顺序、按钮、状态文案），不锁死整段 JSX。

## 6. 发布检查

1. `package.json` 版本与 `docs/architecture.md` 基线一致。
2. 两个测试文件全绿；`dsh-plugin-dev check` 无 failed。
3. README / docs 不再出现已删除的配置键、工具名或测试计数。
4. `client.js` 与后端快照字段一一对应（尤其 `status` / `schedules`）。
5. 卸载后工具、skill、HTTP 路由、定时器全部撤销。
