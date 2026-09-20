# Task time slots in the existing Today view

Tasks can now have a persisted start/end time, a protected slot, a formal deadline, a preferred completion date and a continuation checkpoint. Today keeps its existing layout; the right-hand timeline includes task slots alongside fixed arrangements. On mobile, a jump link leads to the same timeline in a bounded, scrollable region. Task slots are included in the server-rendered first page; the timeline refreshes after changes rather than every browser focus. Backlog offers this-week/next-week searches with an explicit date range.

## User flow

- Open a task's **安排／收尾** action, or click its timeline block. Set a date, start time and this session's duration. The task's original whole-task estimate remains unchanged.
- **安排任务时段** proposes slots for the selected day's tasks, trying morning/afternoon/evening preferences first, then falling back within the explicitly selected clock window with a preview warning. A manual start time overrides the coarse preference explicitly.
- **继续一段** extends the selected slot and previews any affected later movable slots, preserving order. Fixed/protected blocks and formal deadlines are hard constraints. If a later task cannot fit, the proposal fails without changing anything; first choose a later date for that task.
- **先收尾** records progress/remaining work and clears the slot while retaining `todo`. **后续再做** records the checkpoint and proposes a new slot. Only **完成任务** sets `done`.
- Backlog's **找一个时间段** searches the explicit range. This week begins today; next week is Monday–Sunday in Asia/Shanghai. It reserves existing planned work, recurring fixed blocks and configured segment capacity first. No fit leaves the task in Backlog with an explanation.
- Each proposal shows exact before/after slots, protection, deadline/preferred-date changes, checkpoints and capacity warnings. Confirmation approves and applies that exact proposal. Closing an unconfirmed preview or returning to edit rejects that pending preview. If rejection fails, the dialog stays open for retry. An approved operation whose Apply failed stays available in Review for retry.

Protected slots must be explicitly unlocked before they can move. Preferred completion dates produce warnings, whereas formal deadlines block invalid placement. Capacity warnings for manually chosen slots remain visible for user judgment; automatic suggestions do not add new overload. Reaching a slot's end never automatically completes a task.

## Persistence and compatibility

Migration `0022_lowly_carnage.sql` adds five nullable task columns: `scheduled_start`, `scheduled_end`, `deadline_at`, `target_date`, `checkpoint`. Existing `movable=false` provides slot protection. No existing task is backfilled or rescheduled. One task has one upcoming/current slot; approved replacements and checkpoints remain in `change_logs`. Multiple simultaneous sessions for one task are outside this increment.

The database trigger validates paired, same-local-day windows and formal deadlines. Older date/segment-only writers clear an unlocked obsolete slot rather than leaving a contradictory time. A protected slot rejects legacy moves until explicitly unlocked. Archiving/Backlog clears obsolete slots. Coarse unscheduled tasks retain existing behavior. Week/capacity projections use exact windows when present; task estimates remain whole-task estimates.

The new flow reuses `operation_approvals` with `operationKind=task_timing`. A preview stores the exact operations and a hash of active-plan tasks, fixed occurrences, routines and capacities. Apply locks the workspace, approval and task rows, rechecks the snapshot and clock, applies all changes in one transaction, verifies exact IDs, consumes the approval and writes one audit entry. A post-commit read checks persistence. Changed or expired previews do not apply. Retrying the same approval is idempotent; if subsequent work has changed its result, the response requires a fresh read rather than claiming the old result is current.

The same proposal key and payload return the same preview. Reusing a key with a different payload is rejected. Browser confirmation is separate from Apply; MCP cannot approve its own preview. Approved timing operations remain visible in Review until applied, so a failed Apply can be retried.

API contract: [OpenAPI](2026-09-20-task-time-slots.openapi.yaml). MCP: `get_task_timing` (read), `propose_task_timing` (review), `apply_task_timing` (write). Existing `get_tasks` also returns the added task fields. There is no separate Claude handoff feature.

## Verification and release

Use an explicitly isolated database, never the personal or production database. The timing E2E fixture requires a loopback database named `pawplan_timing_check`; run with `DATABASE_URL` and `APP_SECRET=test-secret`. `playwright.timing.config.ts` owns port 3157 and refuses to reuse another server.

```sh
RUN_DATABASE_INTEGRATION=1 npm test -- src/tests/integration
npm test -- src/tests/unit/task-timing.test.ts
npm run build
npx playwright test --config=playwright.timing.config.ts
```

Tests cover read-only preview, approval enforcement, atomic Apply, exact persisted readback, repeat/concurrent Apply, stale snapshots, tenant isolation, expiration, deadlines, protection, capacity, backlog placement, partial progress, legacy date writers and desktop/mobile reloads. Test fixture data is deleted after each run.

Production migration and deployment require explicit authorization. Before release: verify the intended release base (production has previously used a branch other than main), back up the target database, apply the additive migration, deploy the reviewed commit and verify authenticated UI/MCP reads without rescheduling personal tasks. A feature rollback can restore the prior application deployment while retaining the new columns and history. If old clients need to edit protected tasks during rollback, an explicitly authorized database rollback can disable `tasks_timing_guard`; retain the columns/data for recovery. Do not drop task data or apply a destructive reverse migration.

### Local acceptance receipt · 2026-09-20

- Clean migration from an empty, newly created `pawplan_timing_check` database passed.
- Full Vitest run with database integration enabled: 92 files, 550 tests passed, zero skipped.
- Dedicated Playwright acceptance: 6 tests passed across desktop Chromium and mobile WebKit, including persisted reloads and Review confirmation.
- Production build passed. `git diff --check` passed.
- The isolated database contained zero remaining workspaces after verification. The owned development server and PostgreSQL cluster were stopped.
- Personal/production data was not changed. At this local acceptance checkpoint, implementation was in the `codex/task-timeblocks` worktree and had not yet been committed, pushed or deployed.

### UI review fixes · 2026-09-20

Today uses the same pending-first ordering at load and refresh. In-flight status edits survive older server snapshots while fresh timing details remain visible. Batch date changes clear selection and submission rechecks that IDs belong to the visible date. Duration inputs reject blank, fractional and out-of-range values before sending a preview. LAN HTTP can generate idempotency keys without `randomUUID`. Dialogs mount only when opened; completed task slots have task-specific read-only details.

Validation: 94 Vitest files / 564 tests passed with isolated database integration enabled; 24 Playwright cases passed across desktop Chromium and mobile WebKit, including rejected-preview and approved-Apply retry failures. Production build and diff checks passed. No production migration is required for these UI fixes.

The Today axis expands short occupied intervals to readable blocks, with all ticks and the current-time marker mapped consistently. The scrollable axis opens near the current time on both desktop and mobile. MCP clients with an older cached tool catalog must refresh/reconnect to discover the task-timing tools; `get_agent_guidance.taskTiming` describes their workflow and permission requirements.
