# PawPlan v1.0 Daily Agent Loop Prompts（已废弃）

Date: 2026-06-13
Superseded: 2026-08-27

> 本页原有 Morning Review、Evening Check-In 和 Weekly Review 定时模板已废弃。不要复制这些模板建立固定频率自动 Review。

当前规则：

- 只有用户主动请求计划调整，或用户提供了需要处理的具体事件时，才运行 planning review。
- 不因为任务逾期就自动选择新日期或时段；`propose_overdue_replan` 已删除。
- 已知精确目标时，可使用 `propose_daily_rebalance` 或 `propose_week_rebalance` 创建 Review 草稿。
- Review 只能由用户审核和 Apply；Apply 后必须 read back，才能确认真实状态。
- 固定课表导入仍使用 `propose_timetable_import` 并进入 Review。
- Check-in、conversation、decision、Inbox 或 task status 仍只在用户明确要求记录时写入。

手动调用示例：

```text
请根据我刚才确认的变化检查 PawPlan。先读取任务、固定安排和容量；如果需要调整，
给出最小改动，并使用 propose_daily_rebalance 或 propose_week_rebalance 创建 Review。
不要自动 Apply，也不要把逾期任务自动移到 backlog。
```

保留此文件仅用于说明旧链接为何失效；它不再是 public beta 的现行操作指南。
