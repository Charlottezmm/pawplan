# PawPlan v0.2 Clean Slate 技术方案

日期：2026-08-16
状态：P0 已在功能分支实现并通过本地数据库验收；生产 feature flags 仍关闭，线上数据尚未修改

## 1. 决策摘要

本方案可以实现，但不应把全部需求一次性作为一个不可审查的大开关上线。

推荐顺序：

1. 先统一 Active Plan 真源和归档过滤语义；
2. 再实现任务归档、恢复和永久删除；
3. 再实现循环时间块的单次例外与系列拆分；
4. 最后开放原子 Replace Plan Window；
5. P0 完成并经过真实 readback 后，再实现 P1 的逾期分流。

本轮沿用已经确认的产品语义：

- Project 是多个并行的具体项目；不增加 main/supporting role，也不要求每月只能有一个 Main Project；
- Category 只表示课程/考试、科研、工作等领域；
- 长期计划继续维持现状，不增加 Active Plan Window 或每日突出数量规则；
- backlog 只在用户明确选择“移出排期”时使用；
- Preview、Review 草稿和 proposal 都不代表 live 已修改；
- 所有实际写入必须经过确认、持久化、审计和最终 readback。

## 2. 当前线上事实与范围风险

2026-08-16 的只读审计结果：

| Workspace | todo | backlog | done | skipped | overdue todo | Review draft |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `charlotte` | 0 | 0 | 31 | 140 | 0 | 9 |
| `DAY` | 71 | 0 | 2 | 0 | 71 | 0 |
| `wendywork` | 10 | 7 | 2 | 19 | 10 | 1 |

因此，“81 条逾期待办”和“10 份 Review 草稿”是三个工作区的聚合数，不是 Charlotte 工作区自身的数据：

- 81 条逾期 = `DAY` 71 条 + `wendywork` 10 条；
- 10 份草稿 = `charlotte` 9 份 + `wendywork` 1 份；
- Charlotte 当前的 140 条旧任务已经是 `skipped`，不是 61 条 todo + 79 条 backlog。

未经用户再次确认工作区范围，不允许按聚合数跨工作区清理。

其他线上事实：

- 每个工作区当前均只有一个 active plan，但数据库尚无唯一约束；
- Charlotte 有 5 条循环 `time_blocks(kind=routine)`，分别是 AI 基础、AI Agent、硬件、自媒体和家务；
- Charlotte 另有 2 条循环 recovery；
- 独立 `routines` 表当前为空，因此本次循环系列能力可以覆盖现有旧 routine，但代码仍需统一两套容量语义。

## 3. 目标

### 3.1 P0

- 安全预览、批量归档和恢复任务；
- 严格二次确认后，按最多 50 条一批永久删除；
- 按“仅本次 / 本次及以后 / 整个系列”修改或停止循环时间块；
- 以一份新计划原子替换指定日期窗口；
- Today、Week、Month、Backlog、Project 汇总、MCP 和容量模型默认排除 archived；
- 所有写操作具备幂等、审计、结构化状态和真实 readback；
- 所有能力默认由 feature flag 关闭，逐项 smoke 后开放。

### 3.2 P1

- 重复逾期进入 `needs_triage`，不再无限自动顺延；
- 允许用户明确选择完成、顺延一次、移出排期、归档或跳过。

## 4. 非目标

- 未经确认自动修改 live schedule；
- 自动每天重排整个计划；
- 自动把长期 Roadmap 全部拆成每日任务；
- 默认永久删除历史；
- 复杂外部日历同步；
- 本轮引入完整 RFC 5545 RRULE 引擎或多时区；
- 按标题猜测并合并旧 Project、任务或循环系列；
- 清理其他 workspace 的数据，除非用户明确确认精确 workspace 和预览。

## 5. 架构

```text
用户筛选 / 新计划 payload
          ↓
严格 schema 解析 + Active Plan resolver
          ↓
精确 Preview
  - resolved IDs
  - row fingerprint
  - count / minutes / titles
  - conflicts / side effects
          ↓
HMAC preview token（短时有效）
          ↓
operation_approvals pending Review
          ↓
登录用户在 Review 批准精确 Preview
          ↓
apply 校验并一次性消费 approval_id
          ↓
plan_operations 幂等 claim
          ↓
单一数据库事务
  - 行锁与 fingerprint 重验
  - archive / restore / delete / split series / replace
  - audit / plan version / result
  - transaction readback
          ↓
提交后 Today / Week / Month / tasks / capacity readback
```

外部 Agent 只负责意图、解释和发起 Preview。后端负责 workspace 隔离、Active Plan、筛选解析、冲突检测、事务、审计和读回。

## 6. P0 前置：唯一 Active Plan 真源

当前页面和 MCP 对 Active Plan 的过滤不一致；部分容量查询会读取 workspace 内所有 plan 的任务。Replace Window 上线前必须先修正。

新增统一 resolver：

```ts
resolveActivePlanContext(workspaceId): {
  id: string;
  startDate: Date;
  endDate: Date;
  currentVersionId: string | null;
}
```

规则：

- 0 个 active plan：`active_plan_missing`；
- 多于 1 个：`active_plan_conflict`，不允许任取一条；
- Today、Week、Month、Backlog、Project 汇总、MCP tasks/capacity、rebalance 和 overdue replan 使用同一个 `planId`；
- Project 定义仍属于 workspace，但 Project 任务统计只计算 active plan；
- 增加每个 workspace 最多一个 active plan 的 partial unique index；
- 增加 `(plan_id, version_number)` 唯一约束，写新版本前锁 active plan 行。

迁移前先查找多 active plan。当前线上为 0 个冲突，因此不需要猜测性数据修复。

## 7. 数据模型

### 7.1 任务归档

使用正交字段，不扩展 `task_status`：

```sql
ALTER TABLE tasks
  ADD COLUMN archived_at timestamptz;

CREATE INDEX tasks_workspace_active_date_idx
  ON tasks(workspace_id, plan_id, date)
  WHERE archived_at IS NULL;

CREATE INDEX tasks_overdue_candidate_idx_v2
  ON tasks(workspace_id, plan_id, status, date)
  WHERE status = 'todo' AND archived_at IS NULL;
```

语义：

- `skipped`：用户决定不做；
- `archived_at != null`：退出当前计划但保留历史；
- 归档不改变原 status；
- 恢复只清空 `archived_at`，原 status 自然恢复；
- 历史查询使用 `archive_state=archived|all`，默认 `active`。

### 7.2 通用批量操作记录

```sql
CREATE TABLE plan_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_id uuid REFERENCES plans(id) ON DELETE SET NULL,
  operation_kind varchar(48) NOT NULL,
  idempotency_key varchar(200) NOT NULL,
  request_hash varchar(64) NOT NULL,
  group_id uuid,
  status varchar(24) NOT NULL,
  result_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_json jsonb,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, idempotency_key)
);
```

`operation_kind` 包括：

- `archive_tasks_batch`
- `restore_tasks_batch`
- `delete_tasks_batch`
- `update_time_block_series`
- `delete_time_block_series`
- `replace_plan_window`

表内保存幂等和结构化结果，`change_logs` 保存业务审计。操作记录先 claim；业务变更、成功结果和审计在同一事务提交。业务事务失败后，单独将 claim 标成 failed，使失败也可观察。

### 7.3 用户批准凭证

```sql
CREATE TABLE operation_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operation_kind varchar(48) NOT NULL,
  request_hash varchar(64) NOT NULL,
  preview_hash varchar(64) NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'pending',
  summary_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz NOT NULL,
  approved_at timestamptz,
  rejected_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

Preview 会创建 pending approval，但不改 live。只有登录用户能在 Review 页面批准或拒绝。Apply 必须携带 `approval_id`；服务端在占用 idempotency key 前先校验一次，并在业务事务内加锁复验和一次性消费。Agent 无法自行把 Preview token 转换成用户批准。

### 7.4 循环时间块例外

```sql
ALTER TABLE time_blocks
  ADD COLUMN protected boolean NOT NULL DEFAULT true,
  ADD COLUMN revision integer NOT NULL DEFAULT 0,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE TYPE time_block_exception_action AS ENUM ('cancel', 'override');

CREATE TABLE time_block_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  series_id uuid NOT NULL REFERENCES time_blocks(id) ON DELETE CASCADE,
  occurrence_date date NOT NULL,
  action time_block_exception_action NOT NULL,
  override_title varchar(180),
  override_kind time_block_kind,
  override_starts_at timestamptz,
  override_ends_at timestamptz,
  override_protected boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, series_id, occurrence_date)
);
```

`protected` 与 `movable` 不合并：时间块无论是否 protected 都占容量；protected 控制 Agent 能否提出修改，用户明确确认的系列操作仍可修改 protected。

### 7.5 Replace Window 修订记录

```sql
CREATE TABLE plan_window_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL REFERENCES plan_operations(id) ON DELETE RESTRICT,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  source_key varchar(160) NOT NULL,
  base_version_id uuid,
  request_hash varchar(64) NOT NULL,
  diff_json jsonb NOT NULL,
  result_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plan_window_task_refs (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  source_key varchar(160) NOT NULL,
  external_task_key varchar(200) NOT NULL,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  revision_id uuid NOT NULL REFERENCES plan_window_revisions(id) ON DELETE CASCADE,
  UNIQUE(plan_id, source_key, external_task_key)
);
```

稳定 external key 用来区分“同一任务的新版本”和“标题相同的不同任务”，不能继续只按标题或 Project 名称猜测身份。

### 7.6 P1 triage

P1 再加：

```sql
ALTER TABLE tasks
  ADD COLUMN needs_triage_at timestamptz;
```

首次逾期成功顺延后增加 `rollover_count`；再次逾期时设置 `needs_triage_at`，不自动改日期。用户完成明确处置后清空它。

## 8. MCP 契约

所有 schema 均为 strict：`additionalProperties=false`。所有日期为 Asia/Shanghai 本地自然日；底层窗口统一采用右开区间 `[date_from, date_to)`。例如“8 月 15–30 日”应传 `date_from=2026-08-15`、`date_to=2026-08-31`。

### 8.1 `preview_task_batch`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["action", "filters"],
  "properties": {
    "action": { "enum": ["archive", "restore", "delete"] },
    "filters": {
      "type": "object",
      "additionalProperties": false,
      "minProperties": 1,
      "properties": {
        "statuses": { "type": "array", "items": { "enum": ["todo", "done", "skipped", "backlog"] }, "uniqueItems": true },
        "date_from": { "type": "string", "format": "date" },
        "date_to": { "type": "string", "format": "date" },
        "project_ids": { "type": "array", "items": { "type": "string", "format": "uuid" }, "uniqueItems": true },
        "task_ids": { "type": "array", "items": { "type": "string", "format": "uuid" }, "uniqueItems": true }
      }
    },
    "include_done": { "type": "boolean", "default": false },
    "allow_delete_unarchived": { "type": "boolean", "default": false }
  }
}
```

要求：

- 至少一个可解析筛选条件；未知 Project/Task ID 直接失败；
- 日期必须成对出现；
- 默认排除 done；
- delete 默认只选 archived；
- delete 最多 50 条；archive/restore 保护上限 500 条；
- 返回精确数量、总分钟、全部标题、状态、日期、Project、关联副作用、受影响草稿、短时 preview token 和 pending `approval_id`。

token 包含排序后的 task IDs，以及每条任务的 `id/planId/status/date/projectId/estimatedMinutes/archivedAt/updatedAt` fingerprint。Apply 只接受 token，不再接受 filters。

### 8.2 `archive_tasks_batch` / `restore_tasks_batch`

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["preview_token", "approval_id", "confirm_task_count", "idempotency_key"],
  "properties": {
    "preview_token": { "type": "string", "minLength": 32 },
    "confirm_task_count": { "type": "integer", "minimum": 1, "maximum": 500 },
    "approval_id": { "type": "string", "format": "uuid" },
    "idempotency_key": { "type": "string", "minLength": 8, "maxLength": 200 }
  }
}
```

归档只设置 `archived_at`，恢复只清空它；二者都不改 status。

### 8.3 `delete_tasks_batch`

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["preview_token", "approval_id", "confirm_task_count", "confirmation", "idempotency_key", "operation_id"],
  "properties": {
    "preview_token": { "type": "string", "minLength": 32 },
    "approval_id": { "type": "string", "format": "uuid" },
    "confirm_task_count": { "type": "integer", "minimum": 1, "maximum": 50 },
    "confirmation": { "const": "PERMANENT_DELETE" },
    "idempotency_key": { "type": "string", "minLength": 8, "maxLength": 200 },
    "operation_id": { "type": "string", "format": "uuid" }
  }
}
```

要求：

- token 与确认数量完全一致；
- 行锁后重算 fingerprint，变化则 `preview_stale`；
- 有 draft Review 引用时先返回 `active_review_dependency`；
- 使用 `DELETE ... RETURNING id` 返回数据库实际删除 ID；
- duplicate 直接从持久化 result 返回，不能再次读取已经不存在的任务；
- 多批使用同一 operation ID 分组，每批各有独立 idempotency key。

### 8.4 `update_time_block_series` / `delete_time_block_series`

以下为 update 变体；delete 变体不包含 `changes`，其他字段相同：

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["series_id", "scope", "occurrence_date", "changes", "mode", "idempotency_key"],
  "properties": {
    "series_id": { "type": "string", "format": "uuid" },
    "scope": { "enum": ["occurrence", "following", "series"] },
    "occurrence_date": { "type": "string", "format": "date" },
    "changes": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "title": { "type": "string", "minLength": 1, "maxLength": 180 },
        "kind": { "enum": ["course", "meeting", "unavailable", "routine", "recovery"] },
        "start_time": { "type": "string", "pattern": "^([01]\\d|2[0-3]):[0-5]\\d$" },
        "end_time": { "type": "string", "pattern": "^([01]\\d|2[0-3]):[0-5]\\d$" },
        "weekday_mask": { "type": "integer", "minimum": 0, "maximum": 127 },
        "recurrence_label": { "type": "string", "maxLength": 160 },
        "protected": { "type": "boolean" },
        "starts_on": { "type": "string", "format": "date" },
        "ends_on": { "type": "string", "format": "date" }
      }
    },
    "mode": { "enum": ["preview", "apply"] },
    "preview_token": { "type": "string" },
    "approval_id": { "type": "string", "format": "uuid" },
    "idempotency_key": { "type": "string", "minLength": 8, "maxLength": 200 }
  }
}
```

规则：

- `occurrence` 更新写 override，删除写 cancel；不允许改单次 occurrence 的 recurrence 或系列起止日期；
- `following` 截断原系列，并从选中日期创建继承后的新系列；删除则只截断；
- `series` 修改或删除整个当前系列段；
- 所有写入都先 Preview，返回受影响日期、冲突和 capacity before/after；
- Apply 后返回 series IDs、exception IDs、affected dates、constraints 与 capacity readback；
- synthetic occurrence ID 只用于展示，写操作必须传真实 `series_id + occurrence_date`；
- 本轮继续拒绝跨午夜时间块。

### 8.5 `replace_plan_window`

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["date_from", "date_to", "source_key", "expected_plan_id", "expected_current_version_id", "tasks", "weekly_summaries", "monthly_summaries", "focus_project_ids", "retire_scope", "idempotency_key", "mode"],
  "properties": {
    "date_from": { "type": "string", "format": "date" },
    "date_to": { "type": "string", "format": "date" },
    "source_key": { "type": "string", "minLength": 1, "maxLength": 160 },
    "expected_plan_id": { "type": "string", "format": "uuid" },
    "expected_current_version_id": { "type": ["string", "null"], "format": "uuid" },
    "retire_scope": { "enum": ["source_managed", "all_non_completed"] },
    "tasks": { "type": "array", "items": { "type": "object" }, "maxItems": 500 },
    "weekly_summaries": { "type": "array", "items": { "type": "object" } },
    "monthly_summaries": { "type": "array", "items": { "type": "object" } },
    "focus_project_ids": { "type": "array", "items": { "type": "string", "format": "uuid" }, "uniqueItems": true },
    "idempotency_key": { "type": "string", "minLength": 8, "maxLength": 200 },
    "mode": { "enum": ["preview", "replace"] },
    "preview_token": { "type": "string" },
    "approval_id": { "type": "string", "format": "uuid" }
  }
}
```

实际 MCP 契约已把 Task 与摘要子对象展开成严格 schema；Task 必须引用已存在、已定义且属于当前 workspace 的 Project UUID。Project 和 Milestone 的创建/定义继续通过 Project Portfolio 完成，Replace Window 不按名称猜测或隐式创建 Project。`approval_id` 只在 `mode=replace/apply` 时必填，Preview 返回它供 Review 使用。

语义：

- `source_managed` 只替换同一 source key 过去创建的任务，是默认安全模式；
- `all_non_completed` 是显式 Clean Slate，归档窗口内所有非 done、非 archived 任务；
- 不使用唯一 Main Project；`focus_project_ids` 只是周/月摘要里的关注项目，可多选，不改变 Project 身份；
- Preview 显示 create/update/unchanged/would_archive、保留的 done、未修改的固定时间块、Project/Milestone 引用和容量冲突；
- `mode=replace` 必须携带 Preview token 和登录用户在 Review 批准后得到的 `approval_id`；
- done、窗口外任务、固定时间块永远不改；
- archive 旧任务与创建/更新新任务在同一事务中执行；
- 任何冲突全部回滚，不允许部分成功；
- Apply 返回 `succeeded/no_change/failed/duplicate`、created/archived/unchanged/failed IDs 和最终 readback。

### 8.6 Review 批准 HTTP API（OpenAPI 3.1）

```yaml
openapi: 3.1.0
info:
  title: PawPlan Operation Approval API
  version: 0.2.0
paths:
  /api/operation-approvals:
    post:
      summary: Approve or reject one exact pending Clean Slate operation
      security:
        - workspaceSession: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              additionalProperties: false
              required: [approvalId, decision]
              properties:
                approvalId:
                  type: string
                  format: uuid
                decision:
                  type: string
                  enum: [approved, rejected]
      responses:
        '200':
          description: Decision persisted for the current workspace
          content:
            application/json:
              schema:
                type: object
                additionalProperties: false
                required: [status, approvalId, approvedAt, rejectedAt]
                properties:
                  status:
                    type: string
                    enum: [approved, rejected]
                  approvalId:
                    type: string
                    format: uuid
                  approvedAt:
                    type: [string, 'null']
                    format: date-time
                  rejectedAt:
                    type: [string, 'null']
                    format: date-time
        '400':
          description: Invalid strict request body
        '401':
          description: Missing or invalid workspace session
        '409':
          description: Approval is missing, expired, or was already decided
        '500':
          description: Unexpected approval persistence failure
components:
  securitySchemes:
    workspaceSession:
      type: apiKey
      in: cookie
      name: daily_progress_workspace
```

该 API 只改变 approval 状态，不直接执行计划写入。真正的 archive/delete/series/replace 仍由对应服务在事务内复验并消费批准凭证。

## 9. 关键流程

### 9.1 Archive / Restore

1. 解析明确筛选器；
2. 解析 Active Plan 和 workspace；
3. 默认排除 done；
4. 返回精确任务清单、preview token 和 pending approval；
5. 登录用户在 Review 核对 count、总时长和全部标题后批准；
6. Apply 校验 `approval_id`，行锁并重验 fingerprint；
7. 单事务消费 approval、更新 `archived_at`、写 operation/change log、读回；
8. 提交后读取 todo、backlog、Today、Week、Month、总计和 archive history。

### 9.2 Permanent Delete

1. 默认只允许选择 archived；
2. Preview 最多 50 条，列出级联影响和 draft dependency；
3. 要求 Review 用户批准、精确 count、固定确认文本和 idempotency key；
4. `DELETE ... RETURNING`；
5. 审计保留删除前 snapshot 和实际返回 IDs；
6. 提交后读取 todo、backlog、Week、Month；
7. 同 key 重试从操作结果返回 duplicate，不重复删除。

### 9.3 Recurring Series

统一新增 `loadEffectiveTimeBlocks`：查询系列、查询例外、展开 recurrence、应用 cancel/override，再供页面、MCP、容量和冲突检测使用。

“本次及以后”不能简单把 `ends_at` 改成生效日 00:00，因为当前展开器也从 `ends_at` 提取每天结束时间。必须保留原日结束时刻，截断到生效日前一天，并在同一事务创建新系列段。

### 9.4 Replace Window

1. 校验 Preview 和登录用户批准凭证；
2. claim idempotency key + request hash；
3. `SELECT active plan FOR UPDATE`，核对 expected plan/version；
4. 锁定窗口内被管理的任务并重算 diff；
5. 任一手工修改、done 变化、Project 引用或 fingerprint 冲突时整批停止；
6. 校验 Project/Milestone/parent 同 workspace、同 Project、无环；
7. 在同一事务消费 approval、归档旧任务、创建新任务；
8. 写 plan version、revision、task refs、change log 和 operation result；
9. 事务内 readback；
10. 提交后再读 Today、Week、Month、task counts 和 capacity。

## 10. 错误处理

标准业务错误：

- `invalid_filter`
- `unresolved_filter`
- `preview_required`
- `preview_expired`
- `preview_stale`
- `approval_required`
- `approval_not_approved`
- `approval_expired`
- `approval_mismatch`
- `confirmation_count_mismatch`
- `active_plan_missing`
- `active_plan_conflict`
- `stale_plan_version`
- `idempotency_payload_mismatch`
- `operation_in_progress`
- `task_not_found`
- `active_review_dependency`
- `managed_task_changed`
- `manual_task_collision`
- `retirement_confirmation_required`
- `project_ref_unknown`
- `project_definition_incomplete`
- `milestone_project_mismatch`
- `parent_cycle`
- `invalid_occurrence`
- `protected_time_conflict`
- `capacity_exceeded`
- `readback_failed`

所有预期错误返回结构化 code/details；未知错误记录 error ID，不吞异常、不返回假成功。`failed` 操作必须保留可观察记录。

## 11. 默认查询与权限

所有 live task 查询默认增加：

```sql
archived_at IS NULL
AND plan_id = resolved_active_plan_id
```

覆盖：

- Today 当日任务和 overdue；
- Week、Month、Backlog；
- Project 汇总；
- MCP `get_tasks/get_today/get_week/get_month/get_capacity`；
- rebalance、overdue replan、patch apply；
- 普通单任务和 batch 写入；
- 模板导出/导入语义。

`get_tasks` 新增：

```text
archive_state = active | archived | all
```

默认 `active`。普通更新工具拒绝修改 archived task；必须先 restore。

Clean Slate Preview 会持久化 pending approval，因此也属于 write 权限；archive/restore/delete/series apply/replace 同样为 write 权限，并继续受 Hosted MCP 写额度限制。写工具不对 read-only token 暴露。

## 12. 测试计划

### 12.1 数据模型和迁移

- additive migration 与旧数据兼容；
- active plan 唯一约束；
- archived partial indexes；
- exception 唯一约束；
- operation idempotency 唯一约束；
- 模板 v0.5 以可选字段保持向后兼容，并验证 archived 排除及 protected/exception round-trip。

### 12.2 Archive / Restore / Delete

- status/date/project/task ID 筛选；
- 默认排除 done；
- 未知 ID 和模糊范围失败；
- token 篡改、过期、跨 workspace/action、stale；
- archive/restore 不改变 status；
- delete 确认文本、count、50 条边界；
- draft dependency；
- `DELETE RETURNING` 实际 ID；
- 同 key duplicate、不同 payload 409；
- 注入任一步失败时零业务写入；
- Today/Week/Month/Backlog/Project/capacity 默认隐藏 archived；
- archive history 可见且可恢复。

### 12.3 Recurrence

- occurrence cancel/override；
- following 更新/停止；
- series 更新/删除；
- 第一个、中间、最后 occurrence；
- recurrence mask、kind、protected、起止日期；
- 无效 occurrence、跨 workspace、跨午夜；
- Preview 后变更导致 stale；
- capacity 和 constraints before/after 一致；
- 同 key 不重复创建 series/exception。

### 12.4 Replace Window

- 多 Project、跨 14 天、跨月；
- source-managed 与显式 clean-slate；
- 窗口外、done、固定时间块不变；
- 相同 key duplicate，不同 payload 409；
- stale plan version/fingerprint 零写入；
- Project/Milestone/parent 校验；
- archive + create 任一失败整笔回滚；
- 任务数量与输入一致；
- Today/Week/Month/tasks/capacity 最终 readback 一致。

### 12.5 P1

- 首次 rollover 后再次逾期进入 triage；
- 未经确认不进 backlog、不归档、不跳过。

### 12.6 当前验证结果

- 67 个单元测试文件通过，共 407 项测试通过；默认运行时 5 项数据库集成测试按环境门控跳过；
- 在本地 PostgreSQL 显式运行 5 项集成测试全部通过；
- 已验证 61 条 todo + 79 条 backlog 的 140 条 Clean Slate 场景：归档后 todo=0、backlog=0、archived=140，并可完整恢复；
- 已验证相同 idempotency key 返回 duplicate 且不重复写入；
- 已验证跨 workspace 精确 ID 被拒绝；
- 已通过数据库触发的中途失败验证 Replace archive/create/version 整体回滚；
- 已验证循环时间块的 occurrence cancel/override 会进入 effective timeline 与 capacity readback；
- Next.js production build、Drizzle 无漂移检查和 `git diff --check` 均通过。

## 13. 迁移与发布策略

### 阶段 0：备份与基线

- 新建生产数据库备份；
- 保存 task/plan/time block/draft 的 count、ID 和关键字段 hash；
- 记录当前 Today、Week、Month、Backlog、capacity 输出。

### 阶段 1：只读兼容层

- 应用 additive schema：`0015` 为归档/系列/Replace，`0016` 为用户批准凭证；
- 部署 Active Plan resolver、archive-aware 查询和 exception-aware time-block loader；
- 所有新写 feature flag 保持关闭；
- 证明旧数据下页面/MCP/capacity 输出不变。

### 阶段 2：Archive / Restore

- 开启 Preview；
- smoke 精确 count/token/stale；
- 开启 archive/restore；
- 先在测试 workspace 执行并恢复；
- 再对用户确认的生产 workspace 执行。

### 阶段 3：Series 管理

- 先 Preview Charlotte 现有 5 条 routine；
- 测试“本次及以后”停止一条并读回过去/未来实例；
- 确认 capacity 只在未来受影响；
- 再开放全部 scope。

### 阶段 4：Replace Window

- 先只开放 preview；
- 校验 8 月 15–30 日输入使用 `[2026-08-15, 2026-08-31)`；
- 用户确认 exact diff 和 `retire_scope`；
- 开启 replace 并执行一次真实 readback；
- 相同 idempotency key 重试，验证 duplicate 且无新增任务。

### 阶段 5：Permanent Delete

- 归档和恢复稳定后才开放；
- 默认只删除已归档数据；
- 每次最多 50 条并保留数据库备份；
- 本阶段不作为清理旧计划的默认手段。

### 阶段 6：P1

- 在 P0 稳定后独立实施 overdue triage；
- 不与 P0 数据迁移同时开启。

## 14. 回滚

- 所有迁移为 additive，不自动改旧任务状态；
- 出现异常先关闭对应 feature flag，保留兼容读路径；
- 一旦出现 archived/exception 数据，不能回滚到不认识这些字段的旧代码，否则旧任务或被取消 occurrence 会重新出现；
- Replace 的恢复使用 revision 生成逆向 Preview，经用户确认后恢复，不做盲目 down migration；
- 永久删除只能从数据库备份恢复，因此必须最后开放；
- 现有 Project-aware migration 不回滚，P0 在其上继续加法迁移；
- PR 在全部 P0 测试、生产 migration smoke 和 readback 通过前保持 Draft，不合并 main。

## 15. 当前数据清理建议

本次不要用永久删除清理旧计划。

推荐动作：

1. 对 Charlotte 的 9 份 draft 使用现有批量 reject，保留审计；
2. 对 Charlotte 的 140 条 skipped 任务使用新 archive，退出 Today/Week/Month，同时仍可恢复；
3. 不处理 `DAY` 的 71 条 overdue、`wendywork` 的 10 条 overdue 和 1 份 draft，除非用户明确确认这些 workspace 也属于本次清理范围；
4. Charlotte 当前没有 todo/backlog，因此其清理后预期仍为 todo=0、backlog=0、archived=140、remaining drafts=0；
5. 清理完成后读回 Today、Week、Month、Backlog、archive history 和 draft count。

如果用户确认要清理全部三个 workspace，必须为每个 workspace 分别生成 Preview 和确认，不能用一个聚合 operation 跨 workspace 执行。

## 16. 剩余生产确认

产品实现已经确认：Replace 默认使用安全的 `source_managed`；只有用户在 Preview 中显式选择 `all_non_completed` 才执行 Clean Slate。

生产数据清理只剩范围确认：本次是仅处理 `charlotte`，还是也包括 `DAY` 与 `wendywork`。三个 workspace 必须分别 Preview、分别批准，不能按 81/10 的聚合数字直接操作。
