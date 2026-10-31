---
name: mail-automation-archive-clear
description: 清理邮件助理的本地存档（只在本地，不碰邮箱）。用 mail_automation_archive_clear 一次清空全部存档，或按 id 列表只清指定邮件。
---

# 清理存档邮件

**破坏性操作**：删掉的是本地 `archive/` 目录（含正文、预览图、conclusion.md）。清理后原文只能重新收信/补档，**不可撤销**。

## 工具

`mail_automation_archive_clear`

| 参数 | 说明 |
| --- | --- |
| `ids` | 可选。要删除的存档 id（目录名或 `meta.id`）；**不传 = 清理全部**；显式 `[]` 会被拒绝（避免"空列表删光"） |

返回 `{ ok, removed, ids, missing, remaining, retries_removed, total_before, text }`：
- `removed` 是真正删掉的目录数；`remaining` 是没删掉的（权限/占用）；
- `missing` 是 id 列表里找不到的；
- 相关重试记录会一并清掉（`retries_removed`）。

## 什么时候可以调

- 总览任务：**`qq_notify` 发送成功之后**才能清理；发送失败/返回失败不要清理（提示词里已写）。
- 用户明确说"清空存档 / 删掉这些邮件"时，按用户给的 id 清理；用户没说清空就不要清空。
- 只清用户点名的那几封时，传 `ids`，不要用"不传 ids"。

## 规矩

- id 用 `mail_automation_archive_list` 返回的 `id`（存档目录名）；不要自己拼绝对路径（工具只认存档根内的目录）。
- 清理前如果还没汇总 / 还没发 QQ，先确认用户真的不需要这些存档。
- 清理后不要重试同一批 id；`missing` 说明它们本来就不存在。
