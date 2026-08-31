# PawPlan Scheduled Automation（已废弃）

> **Superseded — 2026-08-27**
>
> PawPlan 不再推荐或支持固定频率的每日自动 Review。本页只保留为历史路径兼容，不能作为当前操作指南。

当前产品边界：

- 不配置每日、早晨、晚间或每周定时 agent 去主动检查并创建 Review。
- `propose_overdue_replan` 已从 MCP surface 删除；PawPlan 不再替逾期任务自动选择新日期或时段。
- 用户主动要求调整计划，或提供了需要调整的具体事件时，agent 才能读取当前计划并调用 `propose_daily_rebalance` 或 `propose_week_rebalance`。
- Rebalance 仍然只创建 Review 草稿；用户必须在 PawPlan 审核后 Apply。
- Review、draft、suggestion 或工具调用成功都不等于计划已修改；Apply 后必须 read back 持久化结果。
- `review_only` 权限继续保留，适合只允许读取和创建 Review 草稿的连接；它不是 scheduled automation 的推荐入口。

如需手动调整，请直接告诉已连接 PawPlan MCP 的 agent：

```text
请读取 PawPlan 当前任务和固定安排，并根据我刚才确认的情况提出最小调整。
只有目标任务、日期和上午/下午/晚上时段明确时，才调用 propose_daily_rebalance
或 propose_week_rebalance。不要自动 Apply；创建 Review 后告诉我去 PawPlan 审核。
```

此变更只移除固定频率主动审核，不改变 `Review -> Apply -> Readback` 安全契约，也不删除历史 agent run 或 Review 记录。
