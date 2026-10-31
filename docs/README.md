# 文档索引

| 文档 | 读者 | 内容 |
|---|---|---|
| [../README.md](../README.md) | 使用者 | 安装、最小配置、常用命令、常见坑 |
| [architecture.md](architecture.md) | 维护者 | 装配与生命周期、模块地图、一封邮件的一生、并发、agent 模型、持久化、安全边界 |
| [configuration.md](configuration.md) | 使用者 / 维护者 | 三层配置、全部字段表、路径展开、volatile、已知边界 |
| [api.md](api.md) | agent / 前端 / 排障 | 7 个工具的参数与返回、四个技能、设置页 HTTP 接口、离线 CLI、补档脚本 |
| [operations.md](operations.md) | 运维 / 维护者 | 两种装法、运行期文件位置、验证清单、故障定位、紧急操作、回滚与备份 |
| [lessons.md](lessons.md) | 维护者 | 运行语义（历史条目保留供查，不代表当前兼容承诺） |
| [development.md](development.md) | 维护者 | 环境事实、代码边界、当前契约、验证命令、发布检查 |
| `onboarding-prompt.md`（工作区根，不随包分发） | 新维护者 / AI agent | 可直接复制的入职提示词：阅读顺序、设计答复、硬性约束、交付格式 |
| [multi-source.md](multi-source.md) | 维护者（做多邮箱扩展时） | 四种协议的 provider 契约与现状、各协议坑、OAuth/扫码绑定实现与纪律、测试与实施顺序 |

约定：

- 本目录是**维护者文档**，中文；`README*.md` 是面向使用者的入口，五语并存且**标题（英文）必须一致**。
- 改了行为就同步改对应文档；`dsh-plugin-dev check` 的 `readme-five-langs` / `readme-consistency` 会拦住标题漂移。
