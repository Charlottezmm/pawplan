# PawPlan timetable 导入去重与 UI 收尾技术说明

## 目标

- 重复导入同一条固定日程时不再创建重复 `time_blocks`。
- 预览明确区分“将新增 / 已存在 / 与现有日程重叠”。
- 真正的时间重叠必须由用户显式确认，不能把一次普通“保存”当作授权。
- 保存结果返回结构化状态并回读实际持久化记录。
- 用统一、可访问的确认弹层替换最有价值的原生 `window.confirm`。

## 非目标

- 不把计划页改造成伪精确时间轴。
- 不改变 Review 常驻入口或 Review → Apply → Readback 边界。
- 不更换全站字体，不机械重写全部 CSS/Tailwind。
- 不根据标题单独判断重复；标题相同但日期、时间、地点或重复规则不同仍是不同日程。

## 数据模型

给 `time_blocks` 增加可空字段：

```sql
import_fingerprint varchar(64) NULL
```

并增加仅作用于非空值的唯一索引：

```sql
UNIQUE (workspace_id, import_fingerprint)
WHERE import_fingerprint IS NOT NULL
```

历史记录保持 `NULL`，不会在 migration 中猜测来源或合并既有数据。只有 timetable 导入创建的时间块写入指纹。

指纹是规范化后以下字段的 SHA-256：标题、类型、起止时间、重复规则、星期掩码、地点。课程关联不参与指纹：课程名可能来自显式 `course` 字段，也可能由课程类日程标题回退生成，不能让同一个时间块仅因关联方式不同而重复写入。备注当前并不持久化到 `time_blocks`，因此也不参与指纹。

## API 契约

### `POST /api/imports/timetable`

预览继续返回 `rows / warnings / conflicts`，并新增：

- `rowStatuses[]`: 每行的 `new | existing | duplicate | conflict` 状态和理由；
- `newCount / existingCount / conflictCount`；
- `conflicts` 只表示非完全相同的真实重叠；完全相同的既有日程进入 `existing`。

### `POST /api/imports/timetable/save`

请求新增可选 `allowConflicts: boolean`。当最新读回仍存在真实重叠且该值不是 `true` 时返回 `409 timetable_conflict_confirmation_required`。

成功响应：

```json
{
  "result": {
    "status": "succeeded | no_change",
    "blocksCreated": 0,
    "blocksExisting": 1,
    "coursesCreated": 0,
    "coursesReused": 1,
    "readback": [{ "fingerprint": "...", "id": "...", "title": "..." }]
  }
}
```

服务端在保存前重新检查重叠；数据库唯一索引和 `ON CONFLICT DO NOTHING` 负责并发重试的最终防线。响应前按指纹回读，数量或字段不匹配则失败，不假装成功。

## UI 流程

- 增加 CSV 文件选择；读取后仍进入同一个 textarea 和预览流程。
- `existing` 行显示“已存在，将跳过”；`conflict` 行显示“时间重叠”。
- 有真实冲突时保存按钮默认禁用；用户勾选“仍然保存这些重叠日程”后才可继续。
- 保存成功显示“新增 N、跳过 N”，`no_change` 明确显示“没有新增”。
- 今天页移出排期、Review 清空、Inbox 删除和高风险操作批准使用共享确认弹层。
- 固定日程删除在现有编辑 sheet 内采用两步确认，避免嵌套 sheet。

## 错误处理

- 文件不是文本或读取失败：仅清空该次文件选择，不覆盖已输入内容。
- 预览后的 CSV 被修改：现有 preview token 失效，必须重新预览。
- 冲突检查不可用：禁止保存，而不是把未知状态当作无冲突。
- 保存期间禁止关闭确认层或重复提交。
- 指纹回读不完整：事务失败并返回明确错误。

## 测试

- 单元：指纹稳定性、字段变化、同批重复、既有重复、并发冲突、`no_change`、回读失败。
- 路由：冲突 gate、结构化响应、preview token、冲突检查不可用。
- 组件/E2E：文件选择、状态 pill、冲突勾选、保存反馈、确认层焦点/Escape/取消/确认。
- 回归：全量 Vitest、Next build、相关 Playwright，375/390/430px 和桌面真实浏览器检查。

## 风险与回滚

- 风险：规范化过强会把本应不同的日程判成相同。为避免此问题，地点、重复规则和完整起止范围均参与指纹；课程关联仅作为附属元数据，不改变时间块身份。
- 风险：历史上已存在的重复项不会自动合并；本次只阻止新的重复写入。
- 回滚：应用代码先停止写入/读取 `import_fingerprint`，再删除唯一索引和字段。migration 不修改或删除历史行。
