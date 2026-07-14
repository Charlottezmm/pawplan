# Hosted MCP atomic task batch reliability

## Goal

Prevent Hosted MCP task maintenance from stopping at an unexplained partial state when the workspace reaches its daily write limit. Keep the existing limit of 50 successful write-tool calls per workspace per Shanghai calendar day.

The implementation adds:

- structured quota state and `429` recovery metadata;
- a concurrency-safe quota reservation before a write starts;
- one narrow, atomic, idempotent task batch tool for trusted status/schedule edits;
- persisted batch results and final task readback;
- an explicit rejection of JSON-RPC batch request bodies.

## Non-goals

- Removing or raising the daily limit.
- Applying routine planning suggestions without Review.
- Replacing `propose_daily_rebalance` or `propose_week_rebalance`.
- Destructive plan replacement, task deletion, constraint editing, billing, or plan tiers.
- Manually editing production data.

## MCP contract

The quota unit remains one successful Hosted MCP write-tool call. `update_tasks_batch` is one call and is capped at 50 distinct tasks. Routine planning still uses a Review-first rebalance tool; this batch is only for trusted direct edits explicitly requested by the user.

```yaml
tools:
  get_mcp_usage:
    permission: read
    input: { type: object, additionalProperties: false }
    output:
      type: object
      required: [limit, used, remaining, reset_at]
      properties:
        limit: { type: integer, const: 50 }
        used: { type: integer, minimum: 0 }
        remaining: { type: integer, minimum: 0 }
        reset_at: { type: string, format: date-time }

  update_tasks_batch:
    permission: write
    input:
      type: object
      additionalProperties: false
      required: [idempotency_key, operations]
      properties:
        idempotency_key: { type: string, minLength: 8, maxLength: 200 }
        operations:
          type: array
          minItems: 1
          maxItems: 50
          items:
            type: object
            additionalProperties: false
            required: [task_id]
            properties:
              task_id: { type: string, minLength: 1 }
              status: { enum: [todo, done, skipped, backlog] }
              date: { type: string, pattern: '^\\d{4}-\\d{2}-\\d{2}$' }
              day_segment: { enum: [morning, afternoon, evening] }
              blocked: { type: boolean }
              expected_status: { enum: [todo, done, skipped, backlog] }
              expected_date: { type: string, pattern: '^\\d{4}-\\d{2}-\\d{2}$' }
              expected_day_segment: { enum: [morning, afternoon, evening] }
              expected_blocked: { type: boolean }
    output:
      type: object
      required: [status, batchId, idempotencyKey, completedTaskIds, pendingTaskIds, readback]
      properties:
        status: { enum: [succeeded, no_change, duplicate] }
        batchId: { type: string }
        idempotencyKey: { type: string }
        completedTaskIds: { type: array, items: { type: string } }
        pendingTaskIds: { type: array, maxItems: 0 }
        readback: { type: array, items: { type: object } }
```

Every operation must set at least one of `status`, `date`, `day_segment`, or `blocked`. Task IDs must be unique. Optional `expected_*` fields provide optimistic concurrency checks. PawPlan validates the entire request and all current task states before the first update.

### Structured `429`

```yaml
status: 429
headers:
  Retry-After: integer seconds until reset_at
body:
  error: hosted_mcp_daily_write_limit_reached
  message: Hosted MCP daily write limit reached
  retry_after: integer
  reset_at: ISO-8601 timestamp
  limit: 50
  remaining: 0
```

## Data model and migration

```sql
CREATE TABLE mcp_task_write_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idempotency_key varchar(200) NOT NULL,
  request_hash varchar(64) NOT NULL,
  status varchar(20) NOT NULL,
  result_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mcp_task_write_batches_workspace_key_unique
    UNIQUE (workspace_id, idempotency_key)
);
```

No existing table or quota value is rewritten. Rollback drops only this new table and reverts the code paths.

## Flows

### Quota reservation

1. Authenticate and reject JSON-RPC array bodies.
2. For a write tool, open a short transaction and take a workspace-scoped PostgreSQL transaction advisory lock.
3. Count successful/reserved writes in the current Shanghai day.
4. If full, return structured `429` without invoking the MCP tool.
5. Otherwise insert a successful usage row as the reservation and commit.
6. Execute the tool. If its HTTP/JSON-RPC result fails, mark the reservation unsuccessful. An `update_tasks_batch` retry that returns `duplicate` also releases the new reservation, so one logical idempotent batch consumes quota only once. A process crash conservatively consumes one slot until midnight rather than permitting an overrun.

### Atomic task batch

1. Parse and normalize the full payload; hash the canonical operation list.
2. In one database transaction, claim `(workspace_id, idempotency_key)`.
3. If a completed claim exists with the same hash, return `duplicate` with a fresh task readback. A different hash returns `409 idempotency_payload_mismatch`.
4. Read every task, verify workspace ownership, uniqueness, dates, and optional expected state.
5. Apply all updates and audit rows.
6. Read every task again, persist the result, and commit.
7. Any validation or write failure aborts the transaction, leaving all task rows and the batch claim unchanged.

## Errors

- `400 invalid_batch`: schema, duplicate task ID, missing update, or invalid date.
- `404 task_not_found`: one or more task IDs are outside the workspace or missing; no writes occur.
- `409 task_state_conflict`: an `expected_*` value is stale; no writes occur.
- `409 idempotency_payload_mismatch`: the key was already used for a different payload.
- `429 hosted_mcp_daily_write_limit_reached`: no tool execution occurs; response includes reset metadata.
- Unexpected failures remain MCP tool errors; the quota reservation is released when the route receives the failure.

## Test plan

- Quota: 49/50 boundary, Shanghai midnight reset metadata, concurrent final-slot reservation, failed-call release, and duplicate batch retry without a second charge.
- HTTP: structured `429`, `Retry-After`, handler not invoked at the cap, JSON-RPC arrays rejected.
- Batch: successful multi-task update, real readback, all-no-op result, injected rollback, missing task, stale expected state, duplicate retry, payload mismatch, and concurrent idempotency claim.
- Contract: read-only clients see `get_mcp_usage` but not `update_tasks_batch`; routine planning guidance still points to Review-first rebalance tools.
- Regression: existing import idempotency and Review draft/apply tests remain green.

## Risks and rollback

- Advisory locks are PostgreSQL-specific; PawPlan already uses PostgreSQL/Neon. Keep the lock transaction short and never hold it during tool execution.
- A process crash after reservation can consume one quota slot without a successful business write. This is a conservative safety tradeoff and self-heals at Shanghai midnight.
- A batch can update more rows per quota unit than a single-task tool. The existing quota is explicitly call-based (`import_plan_bundle` already writes up to 200 tasks in one call); the new tool is capped at 50 tasks and cannot delete tasks or edit constraints.
- Rollback is code-first: remove the two MCP tools and restore post-call usage recording. The additive batch table may remain safely unused or be dropped in a later migration.
