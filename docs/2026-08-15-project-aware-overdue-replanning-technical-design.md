# PawPlan 多 Project 与项目感知逾期重规划技术方案

日期：2026-08-15
状态：技术方案已确认，进入实施

## 1. 背景与问题

PawPlan 当前已经具备长期日期任务、Project/Track、固定时间块、容量模型、MCP、Review 草稿和写后读回，但还不能稳定完成“多个长期 Project 并行推进 + 未完成任务智能延后”。

主要原因：

1. `projects` 目前只有名称和颜色，没有项目类别、目标、成功标准、优先级、期限和状态。
2. `tasks` 虽然有 `project_id` 和 `parent_task_id`，但缺少正式的 Milestone 层级和可靠的父子任务约束。
3. 当前 `propose_daily_rebalance` 需要外部 Agent 直接给出每条任务的目标日期和时段。PawPlan 只校验并生成 Review 草稿，不负责稳定地寻找下一个可用时段。
4. 当前没有可靠记录“某任务已经因逾期顺延过几次”，因此无法区分首次逾期和重复逾期。
5. Today 中“延后”与 `backlog` 状态混用，容易让任务退出日常视图并失去可见性。

## 2. 目标

- 支持多个并行 Project，不再使用“每月唯一 Main Project”的假设，也不再为 Project 增加 main/supporting 等角色层。
- 每个 Project 直接表示一个具体项目，并明确所属类别、目标、成功标准、期限、优先级、最低投入和任务层级。
- 支持长期排期，不设置 14 天或单月的产品级排期上限。
- 不设置每天最多几个任务的数量限制，但所有排期必须通过容量和受保护时间块校验。
- 首次逾期任务可以由系统寻找下一个安全时段，并生成一份合并的 Review 草稿。
- 重复逾期任务不再机械顺延，改为输出 `needs_decision`，等待用户决定拆分、合并、取消、重新定期或明确移出排期。
- 自动化永远不能在未经确认时把任务放入 backlog。
- Review 草稿只有经用户批准、持久化并读回最终状态后，才算真正生效。

## 3. 非目标

本方案明确不包含：

- 批量物理删除、批量归档或对应 MCP 工具。
- 自动清理现有 `skipped` 历史任务。
- 自动隐藏 Week/Month 中所有 `skipped` 任务。
- 自动应用 Review 草稿。
- 自动移动、缩短或覆盖课程、考试、返校、routine、recovery、meeting 或 unavailable 时间块。
- 在迁移期间修改现有任务的日期、时段、`todo/done/skipped/backlog` 状态。
- 构建全局黑盒优化器，或每次运行都重新排列整个长期计划。

## 4. 方案比较

### 方案 A：只改自动化 Prompt

外部 Agent 继续读取任务，自行决定新日期，再调用现有 rebalance 工具。

优点：改动小。
缺点：项目上下文仍不完整；不同运行可能给出不同结果；无法可靠识别重复逾期；继续依赖 Prompt 细节。

结论：不采用。

### 方案 B：项目结构化 + 窄的逾期重规划工具

外部 Agent 负责识别意图、解释原因和触发重规划；PawPlan 后端负责读取最新项目/任务/容量/约束，按稳定规则寻找目标时段，并创建 Review 草稿。

优点：结果可预测、可测试、可审计；保留 AI 的项目理解能力；不会把全部权限交给黑盒调度器。
缺点：需要数据库迁移、新 MCP 契约、Project UI 和 Review 扩展。

结论：推荐。

### 方案 C：全局自动优化器

每次运行重新优化所有项目和未来任务。

优点：理论上能做全局最优。
缺点：行为不透明、diff 大、容易每天来回移动任务，正是当前“很乱”的放大版。

结论：本阶段不采用。

## 5. 目标架构

```text
Roadmap / 用户确认的项目定义
        ↓
Project Portfolio
  ├─ 多个具体 Project
  ├─ 类别 / 目标 / 成功标准 / 优先级 / 期限
  └─ Milestone → Task → Subtask
        ↓
外部定时 Agent：识别逾期和解释原因
        ↓
propose_overdue_replan
        ↓
PawPlan 后端：读取最新状态 + 确定候选时段 + 校验约束
        ↓
一份 Review 草稿
        ↓
用户批准 / 拒绝
        ↓
事务写入 + rollover 计数 + 最终 readback
```

职责边界：

- 外部 Agent：意图、候选解释、项目影响说明。
- PawPlan 后端：权限、最新数据读取、容量计算、受保护时间块、候选时段选择、冲突检查、幂等、写入、审计和 readback。
- 用户：批准实际日程变化和重复逾期任务的处置。

## 6. 数据模型

### 6.1 Project

复用现有 `projects` 表，新增以下字段：

```sql
CREATE TYPE project_status AS ENUM (
  'active',
  'paused',
  'completed',
  'archived'
);

ALTER TABLE projects
  ADD COLUMN category varchar(80),
  ADD COLUMN objective text,
  ADD COLUMN success_criteria text,
  ADD COLUMN status project_status NOT NULL DEFAULT 'active',
  ADD COLUMN priority priority NOT NULL DEFAULT 'normal',
  ADD COLUMN start_date timestamptz,
  ADD COLUMN target_date timestamptz,
  ADD COLUMN weekly_target_minutes integer,
  ADD COLUMN needs_definition boolean NOT NULL DEFAULT true;
```

约束：

- 允许任意数量的 active Project 并行存在，不设置 main/supporting/obligation/maintenance 等 role。
- `projects.name` 表示具体项目，例如“CS 课程期末考试准备”“Physics-Grounded Manipulation 研究”“试剂分销工作流改造”。
- `category` 表示项目所属领域，例如“课程/考试”“科研”“工作”；它不表示项目的重要性，也不代替具体项目名称。
- 项目重要性和冲突顺序由 `priority`、`target_date` 等字段表达，不混入 category。
- `category` 使用可编辑文本并在 UI 提供常用建议值，不使用封闭枚举，避免未来类别变化导致迁移。
- Project 保存“为什么做、做到什么算完成”；Task 只保存具体行动。
- active Project 在 UI 提交时必须有 `category`、`objective` 和 `success_criteria`；迁移阶段不强制数据库 `NOT NULL`，避免猜测旧数据。
- `weekly_target_minutes` 是可选的最低投入，不是硬配额；未设置时仍可依赖项目优先级和目标日期。

### 6.2 Milestone

新增 `project_milestones`：

```sql
CREATE TYPE milestone_status AS ENUM (
  'planned',
  'in_progress',
  'completed',
  'skipped'
);

CREATE TABLE project_milestones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title varchar(180) NOT NULL,
  objective text,
  success_criteria text,
  target_date timestamptz,
  status milestone_status NOT NULL DEFAULT 'planned',
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

索引：

- `(workspace_id, project_id, position)`
- `(workspace_id, status, target_date)`

### 6.3 Task 层级与逾期记录

```sql
ALTER TABLE tasks
  ADD COLUMN milestone_id uuid REFERENCES project_milestones(id) ON DELETE SET NULL,
  ADD COLUMN original_date timestamptz,
  ADD COLUMN rollover_count integer NOT NULL DEFAULT 0,
  ADD COLUMN last_rollover_at timestamptz;

CREATE INDEX tasks_workspace_project_idx
  ON tasks(workspace_id, project_id);

CREATE INDEX tasks_workspace_milestone_idx
  ON tasks(workspace_id, milestone_id);

CREATE INDEX tasks_overdue_candidate_idx
  ON tasks(workspace_id, status, date)
  WHERE status = 'todo';
```

父子任务：

- 为 `parent_task_id` 增加自引用外键，`ON DELETE SET NULL`。
- 加约束前先扫描无效 parent ID；无效值写入迁移报告并置空。
- 应用层校验父任务、子任务属于同一 workspace 和同一 Project。
- MVP 只支持一层或多层树，不支持循环依赖；写入时拒绝环。

逾期计数定义：

- `rollover_count` 只在“逾期重规划 Review 被批准并成功应用”时增加。
- 普通手动改日期不自动增加该值。
- `rollover_count=0` 且日期已过：首次逾期候选。
- `rollover_count>=1` 且新日期再次过期：重复逾期，进入 `needs_decision`。
- `original_date` 用于保留首次进入系统时的计划日期；旧任务迁移时只能以迁移当时的当前日期字段回填，不能伪造历史原始日期。

## 7. Backlog 语义

本方案不更改 `task_status` 枚举，也不迁移现有 backlog 数据，但收紧行为：

- backlog 表示用户明确决定“暂不参与日程排期”。
- backlog 不等于逾期，也不等于普通延后。
- 自动化和 `propose_overdue_replan` 禁止产生 `move_to_backlog`。
- 逾期但未经确认的任务继续保持 `todo` 和原日期，继续显示在逾期区。
- Today 的“延后”不能再直接写入 backlog：
  - 普通延后必须选择新日期；
  - “移出排期”作为独立操作，并明确提示任务将离开日常排期视图。
- 新增 Backlog 可见入口，按 Project 分组，显示总数和最近更新时间；本方案不自动恢复或清理任何旧 backlog。

## 8. 长期排期与容量

- `plans.start_date/end_date` 和任务日期继续支持长期范围。
- `get_month` 保留任意 `date_from/date_to` 查询，不把 31 天默认值解释为产品上限。
- 项目页可展示跨月 Milestone 和任务。
- 不设置每天任务数量上限。
- 所有自动目标时段必须满足：
  - 剩余分钟数不小于 `estimated_minutes`；
  - 不覆盖 protected block；
  - 不移动 routine/recovery/course/meeting/unavailable；
  - 不移动已经安排的未来任务腾位置；
  - 优先保留原 `day_segment`；原时段无容量时才考虑能量匹配的其他时段。
- 长期搜索按 Project `target_date` 或 Plan `end_date` 分块执行，不使用固定 14 天硬上限。

## 9. MCP 契约

### 9.1 `get_project_portfolio`

用途：让 Agent 读取多个项目及其目标，而不是只看到 task ID。

输入 JSON Schema：

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "status": {
      "type": "array",
      "items": { "enum": ["active", "paused", "completed", "archived"] },
      "maxItems": 4
    },
    "category": {
      "type": "array",
      "items": { "type": "string", "minLength": 1, "maxLength": 80 },
      "maxItems": 20
    },
    "include_milestones": { "type": "boolean", "default": true },
    "include_task_summary": { "type": "boolean", "default": true }
  }
}
```

返回：

- Project 结构字段；
- Milestone；
- `todo/done/skipped/backlog` 数量；
- 逾期数量；
- 未关联 Project/Milestone 的任务数量；
- `needs_definition` 项目列表。

### 9.2 扩展 `get_tasks`

新增可选过滤：

```json
{
  "project_ids": ["uuid"],
  "milestone_ids": ["uuid"],
  "parent_task_id": "uuid",
  "overdue_as_of": "YYYY-MM-DD"
}
```

每条任务 readback 新增：

- Project 名称、category、priority、target date；
- Milestone 名称和 target date；
- parent task；
- `original_date`、`rollover_count`、`last_rollover_at`。

### 9.3 `propose_overdue_replan`

该工具只创建 Review 草稿，不能 apply。

输入 JSON Schema：

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["idempotency_key", "as_of_date", "task_ids", "reason"],
  "properties": {
    "idempotency_key": { "type": "string", "minLength": 8, "maxLength": 200 },
    "as_of_date": { "type": "string", "format": "date" },
    "task_ids": {
      "type": "array",
      "items": { "type": "string", "format": "uuid" },
      "minItems": 1,
      "maxItems": 50,
      "uniqueItems": true
    },
    "reason": { "type": "string", "minLength": 1, "maxLength": 4000 },
    "created_by": { "enum": ["codex", "claude", "user"] }
  }
}
```

后端不信任 Agent 提供的候选身份。每次调用必须重新验证：

- workspace 一致；
- 当前仍为 `todo`；
- 真实日期早于 `as_of_date`；
- `movable=true`；
- 不处于 backlog；
- 数据源日期无冲突；
- 任务没有在其他未处理 Review 草稿中被移动。

返回状态：

- `draft_created`：至少一个合法首次逾期任务进入 Review 草稿。
- `needs_decision`：没有可自动起草的任务，但存在重复逾期、blocked、缺项目上下文或无容量任务。
- `no_change`：没有合法逾期候选。
- `duplicate`：相同幂等键已有结果。
- `failed`：输入、查询或持久化失败。

允许混合结果：有可移动任务时返回 `draft_created`，同时附带 `needs_decision[]` 和 `skipped[]`。

每个 `needs_decision` 项必须包含：

- task ID 和标题；
- Project / Milestone；
- 当前日期、原始日期和 rollover 次数；
- 不能自动处理的结构化原因；
- 可选建议，但不得修改状态或日期。

## 10. 候选时段算法

对首次逾期任务：

1. 按 Project priority、Project target date、Task priority、原日期和稳定返回顺序排序。
2. 从 `as_of_date` 开始，按天分块扫描到 Project target date；无 Project target date 时扫描到 Plan end date。
3. 先检查原 day segment。
4. 原时段容量不足时，再按 energy 匹配检查其他时段。
5. 只使用当前剩余容量，不移动未来任务腾位置。
6. 父任务或依赖 Milestone 未满足时，返回 `needs_decision` 或在满足依赖后的日期继续搜索。
7. 找到目标后暂扣该时段容量，再为下一任务搜索，避免同一草稿内部超配。
8. 找不到安全位置时返回 `no_capacity`，不生成该任务的 move operation。

确定性要求：

- 相同数据库快照、相同 `as_of_date` 和相同 task IDs 必须生成相同候选结果。
- 候选顺序和幂等键 canonicalization 分离；计算哈希不能改变 Review 中的计划顺序。

## 11. 自动化运行

PawPlan 继续不内置 LLM scheduler。外部 Codex/Cowork 自动化只负责定时触发。

旧的泛化“每日全局重排”不直接升级。新流程上线前保持暂停。

建议运行流程：

1. 完成既有只读链路：`get_agent_guidance → get_today → get_week → get_month → get_tasks → get_capacity → get_constraints → get_checkins`。
2. 调用 `get_project_portfolio` 补齐项目目标和层级。
3. 只选择真实日期已过且仍为 `todo` 的候选。
4. 调用一次 `propose_overdue_replan`。
5. 输出 `draft_created / needs_decision / no_change / duplicate / failed`。
6. 明确说明 Review 前 live schedule 未改变。

运行频率可以继续每日一次，但它不是每日全局重排：没有逾期事件时必须返回 `no_change`，不能为了“做点什么”移动任务。

## 12. Review 与应用流程

Review 每条 move 显示：

- Project / Milestone / Task；
- 原日期和目标日期；
- 原时段和目标时段；
- 预计分钟数；
- 目标时段应用前后的剩余容量；
- protected block 校验结果；
- rollover 次数；
- 移动原因和对项目目标的影响。

应用时：

1. 重新锁定并读取任务。
2. 重新校验 status、date、segment、movable、容量和 protected blocks。
3. 只应用用户接受且仍合法的 operation。
4. 成功 move 后原子增加 `rollover_count`，写 `last_rollover_at`。
5. 写 Review audit 和 change log。
6. 返回任务最终日期、状态、rollover 次数和容量 readback。

Review 草稿未经批准前，不更新 `rollover_count`，也不改变 live schedule。

## 13. 错误处理

结构化错误码至少包括：

- `task_not_found`
- `task_not_overdue`
- `task_not_todo`
- `task_not_movable`
- `task_blocked`
- `repeated_overdue`
- `project_context_missing`
- `milestone_dependency_unmet`
- `date_source_conflict`
- `capacity_incomplete`
- `no_capacity_before_target`
- `draft_conflict`
- `protected_block_conflict`
- `stale_task_state`

安全原则：

- 任一查询结果冲突时不猜真源。
- 单项错误不应让其他独立合法项丢失，但必须在返回中列出 skipped/needs_decision。
- 数据库事务失败时整次 apply 回滚。
- Tool 调用成功不等于业务成功；调用方必须检查结构化 status 和 readback。

## 14. 迁移策略

### 阶段 0：迁移前审计

- 备份生产数据库或创建可恢复快照。
- 记录当前 project/task/status/date 数量基线。
- 扫描：
  - 无效 `project_id`；
  - 无效 `parent_task_id`；
  - Project 缺失任务；
  - 当前 overdue、backlog、skipped 数量；
  - 未处理 Review 草稿引用的 task IDs。
- 只生成报告，不修任务日期和状态。

### 阶段 1：加法式数据库迁移

- 新增 Project 字段、Milestone 表、Task 逾期字段和索引。
- 所有新 Project 结构字段先允许兼容旧数据。
- 不删除或重命名旧列。
- 不修改 task status enum。

### 阶段 2：保守回填

- 现有 Project：
  - `status='active'`；
  - `priority='normal'`；
  - `needs_definition=true`；
  - category/objective/success criteria/target date 保持空，不根据名字猜测。
- 现有 Task：
  - `original_date = date`；
  - `rollover_count = 0`；
  - `last_rollover_at = NULL`；
  - 保持原 project、date、segment、status。
- 无效 parent ID：先写迁移报告，再置空，随后添加自引用外键。
- 未关联 Project 的任务保持未关联，并在 Project Portfolio 中显示为 `unassigned`；不自动创建 Project 或猜测分类。

迁移限制：历史上已经顺延过几次无法从当前 task row 可靠恢复。回填为 0 只是新机制起点，必须在报告中声明，不伪装成真实历史。

### 阶段 3：读路径上线

- 先上线 Project Portfolio UI、`get_project_portfolio` 和扩展后的 `get_tasks`。
- 验证 Today/Week/Month/Capacity 与迁移前数量一致。
- 用户补齐各 Project 的类别、目标、成功标准、优先级和期限。
- 此阶段不启用新的重规划写工具。

### 阶段 4：Review 与重规划上线

- 在 feature flag 后上线 `propose_overdue_replan`。
- 扩展 Review 卡片和 apply readback。
- 现有 `propose_daily_rebalance` 继续可用，但旧自动化保持暂停，不与新自动化同时运行。

### 阶段 5：Shadow 验证

至少完成 3 次不同日期的只读/shadow 运行：

- 记录候选任务、排序、目标时段和 needs_decision；
- 不创建 Review 草稿；
- 与人工判断对比；
- 验证长周期 Project、重复逾期、容量不足、protected blocks 和日期漂移。

只有 shadow 结果稳定后，才允许生成 Review 草稿。

### 阶段 6：Draft-only 启用

- 启用每日一次逾期巡检。
- 只允许 `propose_overdue_replan` 创建 Review 草稿。
- 不允许 auto-apply。
- 每次运行和 Review apply 后都做 readback。

## 15. 兼容性

- 旧 task/project 数据无需一次性重写。
- 旧 MCP 客户端继续使用现有工具；新增字段只作为响应扩展。
- 旧 Review 草稿继续按原 patch schema 工作。
- import/export schema 增加可选 Project/Milestone 字段；旧模板仍可导入，进入 `needs_definition/unassigned`。
- backlog、skipped、done 的既有含义和存储不在本迁移中改变。

## 16. 回滚策略

应用回滚：

- 使用 feature flag 立即关闭 `propose_overdue_replan`。
- 暂停外部自动化。
- 旧 `propose_daily_rebalance` 和既有读视图继续工作。

数据库回滚：

- 新结构上线后优先使用前向修复，不立即 drop 新列或表。
- 只要新 Milestone/rollover 数据已经写入，就不执行破坏性 down migration。
- 若迁移在任何新数据写入前失败，可回滚新增 enum/table/column/index。
- 原 task 日期、时段和状态未在迁移中修改，因此关闭新功能即可恢复旧行为。

自动化回滚：

- 保留新自动化配置但设置为 paused。
- 读回 automation status，确认没有继续生成草稿。
- 已存在的 Review 草稿保持 draft，交由用户拒绝或逐条处理，不自动 apply。

## 17. 测试计划

### 单元测试

- Project/Milestone schema 和序列化。
- active Project 必填字段校验。
- Project 父子任务同 workspace、无循环。
- 首次逾期与重复逾期分类。
- 多 Project priority/target date 稳定排序。
- 原 day segment 优先。
- 容量不足和 protected block 排除。
- 不移动未来任务腾位置。
- backlog 不进入逾期重规划。
- 相同快照生成相同目标和幂等结果。

### MCP 契约测试

- strict JSON Schema；拒绝额外字段。
- read-only token 不得调用 propose 工具。
- 最多 50 条候选。
- duplicate/no_change/needs_decision/failed/draft_created 返回完整。
- task IDs 跨 workspace 时拒绝且不泄露数据。

### 集成测试

- `propose_overdue_replan` 只创建一个 Review 草稿。
- 草稿前 live task/date/status/rollover_count 不变。
- Review 部分接受、部分拒绝。
- apply 前任务被手工修改时返回 stale conflict。
- apply 后 date/segment/rollover_count/change log/readback 一致。
- 迁移前后 Today/Week/Month/Capacity 基线一致。

### E2E

- 创建两个并行 Project，例如课程/考试与科研项目，并设置不同类别和目标。
- 建立 Milestone、Task、Subtask。
- 制造首次逾期，生成 Review，批准并读回。
- 再次逾期，验证只返回 needs_decision，不机械顺延。
- 验证 backlog 任务不被自动恢复或移动。
- 验证课程/routine/recovery 不被覆盖。

## 18. 验收标准

- 用户能看到所有 active Project 的类别、目标、成功标准、优先级、期限、Milestone 和 Task。
- 多个 Project 可以并行存在，没有单月唯一约束，也没有额外 role 层。
- 长期任务不因超过 14 天或一个月而被系统拒绝。
- 每天任务数量无硬上限，但 Review 不允许应用容量冲突。
- 首次逾期任务生成稳定、可解释的一份 Review 草稿。
- 重复逾期任务保持可见并进入 needs_decision，不自动进入 backlog。
- protected blocks 不被移动或覆盖。
- Review 前 live unchanged；Review 后有持久化记录和最终 readback。
- 迁移不改变现有任务日期、时段和状态。

## 19. 已确认的实施决策

已确认：

1. 不增加 Project role。Project 直接表示具体项目，category 只表达“课程/考试、科研、工作”等所属领域。
2. 重复逾期严格定义为：已经有一次 Review-approved rollover，新的目标日期再次过去且仍为 `todo`。
3. Backlog UI 把“延后”拆成“选择新日期”和“移出排期”两个明确动作。
4. Project category 使用自由文本并在 UI 提供“课程/考试、科研、工作”等常用建议值。
5. 多 Project 冲突时采用“Project priority → Project target date → Task priority → 原日期”的默认顺序。

实施仍遵守迁移边界：先加法式迁移和只读路径，再进行 shadow 验证；在验证通过前不修改生产任务日期、状态或自动化。

## 20. 当前实现与上线交接

截至 2026-08-15，代码实现和生产加法迁移已完成；未修改 live 任务日期/时段/状态，逾期自动化仍未启用。

已实现：

- 加法式 Drizzle 迁移 `0014_swift_slyde.sql`，包括旧任务 `original_date=date` 回填；不改现有任务日期、时段或状态。
- Project Portfolio 的创建、编辑、Milestone 展示、Task/Subtask 层级展示；category 为自由文本建议值，不含 role。
- `get_project_portfolio`、扩展后的 `get_tasks` 和 feature-flag 保护的 `propose_overdue_replan`。
- 首次逾期生成一份 Review 草稿；重复逾期返回 `needs_decision`；任何路径都不会自动进入 backlog。
- Review apply 时重新读取任务和目标时段容量；成功后读回日期、时段、状态、rollover 次数和最后 rollover 时间。读回不完整时，前端不把草稿显示为已生效。
- Backlog 独立入口；Today 的“选择新日期”和“移出排期”已拆开。

迁移验证结果：

- 迁移前已生成 PostgreSQL custom-format 备份并通过 `pg_restore --list` 校验。
- 迁移前后均为 25 个 Project、282 个 Task、81 todo、35 done、159 skipped、7 backlog、10 份 Review draft。
- 迁移前备份与迁移后数据库的全部 Task `id/date/day_segment/status` 规范化 SHA-256 完全一致。
- 282 个旧 Task 均以当时 `date` 回填 `original_date`；`rollover_count=0`、`last_rollover_at=NULL`。
- 25 个旧 Project 均保持 `needs_definition=true` 且 category 为空，没有猜测分类或目标。
- 真实数据库事务 rollback smoke、Project Portfolio MCP 读路径 smoke、完整测试和生产构建均通过。

上线顺序：

1. 已完成：备份数据库，并记录 Project、Task、overdue、backlog、skipped 和 Review draft 数量。
2. 已完成：执行加法迁移，并核对任务数量和逐行日程/状态摘要。
3. 待完成：部署应用，并保持 `PAWPLAN_OVERDUE_REPLAN_ENABLED=false`。
4. 在 Project Portfolio 补齐旧 Project 的 category、objective、success criteria、priority 和 target date。
5. 用只读 MCP 结果完成至少 3 个不同日期/场景的 shadow 对照；不得创建或应用 Review 草稿。
6. 对照稳定后设置 `PAWPLAN_OVERDUE_REPLAN_ENABLED=true`，只允许创建 Review 草稿；继续禁止 auto-apply。
7. 每次批准后核对 Review 返回的最终 readback 与 Today/Week/get_tasks 状态。

回滚时先把 `PAWPLAN_OVERDUE_REPLAN_ENABLED` 设回 `false` 并读回部署配置；新列已有数据后不执行破坏性 down migration，优先前向修复。

仍未实现：批量物理删除、批量归档、隐藏 skipped，以及对应 MCP 工具。这部分继续等待单独确认。
