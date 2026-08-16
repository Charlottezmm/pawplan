# AI-first Project Portfolio 写入契约

日期：2026-08-16
状态：已实现，仍遵循 Review-first

## 目标与边界

AI 可以提出一份精确的 Project/Milestone 定义更新，但不能直接修改 live Portfolio。用户必须在 PawPlan Review 批准该 Preview，之后 AI 才能用一次性 `approval_id` 应用。

本能力只支持：

- 创建或更新 Project 定义；
- 创建或更新 Milestone；
- 用新 Project 的 `client_key` 在同一 payload 内引用它。

明确不做：

- 不按名称猜测 Project；
- 不关联、移动、归档或修改任何 Task；
- 不创建 Main/Supporting role；
- 不修改 skipped Task；
- 不新增数据库表。

## 可靠性流程

```text
AI exact update payload
  -> propose_project_portfolio_update
  -> HMAC Preview token + pending operation_approval
  -> 登录用户在 Review 批准
  -> apply_project_portfolio_update
  -> approval preflight
  -> plan_operations idempotency claim
  -> transaction:
       lock Active Plan
       lock/recheck Project + Milestone snapshot
       consume approval once
       atomic Project/Milestone writes
       change_log + transaction readback
  -> post-commit readback
```

已有 Project 更新必须携带 `expected_updated_at`；已有 Milestone 更新同样使用该并发保护。Apply 使用 `workspace_id + idempotency_key` 幂等，重复请求返回 `duplicate`，不同 payload 复用 key 返回 `idempotency_payload_mismatch`。

Active Project 的最终状态必须同时具备非空 `name/category/objective/success_criteria`。暂停、完成或归档的 Project 可以暂时保留不完整定义，并由 `needs_definition` 反映状态。

## MCP 契约

两个工具都使用 strict object，未知字段失败。

### `propose_project_portfolio_update`

```json
{
  "update": {
    "projects": [
      {
        "action": "create",
        "client_key": "research",
        "name": "Embodied AI Research",
        "color": "#2563eb",
        "category": "科研",
        "objective": "Build a physics-grounded manipulation model",
        "success_criteria": "Validated experiment and paper draft",
        "status": "active",
        "priority": "high",
        "start_date": "2026-08-16",
        "target_date": "2026-12-20",
        "weekly_target_minutes": 600
      }
    ],
    "milestones": [
      {
        "action": "create",
        "client_key": "baseline",
        "project_client_key": "research",
        "title": "Reproduce baseline",
        "objective": "Run the reference pipeline",
        "success_criteria": "Metrics reproduced",
        "target_date": "2026-09-15",
        "status": "planned",
        "position": 0
      }
    ]
  },
  "reason": "Define the Project before creating its execution plan"
}
```

返回 `pending_review`、`previewToken`、`approvalId`、过期时间与精确操作摘要；`liveUnchanged=true`。

更新已有 Project：

```json
{
  "action": "update",
  "project_id": "uuid",
  "expected_updated_at": "2026-08-16T01:00:00.000Z",
  "changes": {
    "objective": "New exact objective"
  }
}
```

更新已有 Milestone 使用 `milestone_id + expected_updated_at + changes`。新 Milestone 必须且只能提供一个 `project_id` 或 `project_client_key`。

### `apply_project_portfolio_update`

```json
{
  "update": {
    "projects": [
      {
        "action": "update",
        "project_id": "11111111-1111-4111-8111-111111111111",
        "expected_updated_at": "2026-08-16T01:00:00.000Z",
        "changes": { "objective": "New exact objective" }
      }
    ],
    "milestones": []
  },
  "preview_token": "signed-token",
  "approval_id": "uuid",
  "idempotency_key": "stable-request-key"
}
```

`update` 必须与 Preview 中的业务 payload 完全一致。返回：

- `status: succeeded | no_change | duplicate | failed`；
- 实际 `createdProjectIds/updatedProjectIds/unchangedProjectIds` 与 `createdMilestoneIds/updatedMilestoneIds/unchangedMilestoneIds`；
- `projectClientIds/milestoneClientIds`；
- transaction readback 与 post-commit `readback.verification`。

## 验收重点

- Propose 只写 pending approval，Project/Milestone/Task 均不变；
- 缺失、未批准、过期、已消费或不匹配 approval 时零业务写入；
- Preview 后 Project/Milestone 发生变化时返回 stale；
- 创建 Project 与引用它的 Milestone 原子提交；
- 任一步失败时 Project/Milestone 和 approval consumption 全部回滚；
- 相同 idempotency key 不重复创建；
- readback 只返回当前 workspace 的实际 ID 和最终字段；
- 全链路不读取或写入 Task 作为隐式关联依据。
