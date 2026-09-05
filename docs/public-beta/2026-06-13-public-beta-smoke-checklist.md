# PawPlan v1 Formal Invite Smoke Checklist

Date: 2026-06-13

Use Local Gate for repository work. The later invite/deployment checklist is
only for separately authorized release work; it is not permission to migrate,
create invites, or modify production data.

## Local Gate

```bash
git status --short --branch
node --version
npm --version
npm ci
RUN_DATABASE_INTEGRATION=0 DATABASE_URL= npm run test
```

Use the committed lockfile. Next 14 requires Node >=18.17; record the actual
runtime used. Existing installed dependencies can be reused for a docs-only
check; report that a clean install was not tested.

### Isolated PostgreSQL acceptance

Prerequisites: PostgreSQL `initdb`, `pg_ctl`, `createdb`, `psql` on PATH and a free
port 55439. This creates a new temporary cluster, not a database in the user's
existing server. Run the following in one shell; stop if any setup step fails.
The test-only trust authentication is restricted to loopback and a private
temporary socket directory. Do not reuse this setup for a shared environment.

```bash
set -e
TASK_PG_DIR=$(mktemp -d /tmp/pawplan-agent-check.XXXXXX)
initdb -D "$TASK_PG_DIR/data" -A trust -U pawplan_test > "$TASK_PG_DIR/init.log"
pg_ctl -D "$TASK_PG_DIR/data" -l "$TASK_PG_DIR/server.log" \
  -o "-h 127.0.0.1 -p 55439 -k $TASK_PG_DIR" -w start
trap 'pg_ctl -D "$TASK_PG_DIR/data" -m fast -w stop' EXIT
createdb -h 127.0.0.1 -p 55439 -U pawplan_test pawplan_agent_check
export DATABASE_URL='postgresql://pawplan_test@127.0.0.1:55439/pawplan_agent_check'
export APP_SECRET='test-secret'
npm run db:migrate
RUN_DATABASE_INTEGRATION=1 npm run test -- src/tests/integration
npm run build
# Before browser checks: confirm 3000 is free; do not kill an unrelated server.
# If occupied, stop here and identify it rather than letting Playwright reuse it.
if lsof -nP -iTCP:3000 -sTCP:LISTEN; then
  echo 'Port 3000 is occupied; identify the server before running E2E.'
  exit 1
fi
npm run test:e2e -- src/tests/e2e/review-trust.spec.ts --workers=1
psql "$DATABASE_URL" -c 'SELECT count(*) AS remaining_test_workspaces FROM workspaces;'
# Expected: 0. On shell exit the trap stops this temporary cluster.
```

If PostgreSQL is unavailable, report integration as blocked/skipped, not passed.
Do not substitute `.env.production.local` or the personal `daily_progress` DB.
Next build can load local env files; explicit `DATABASE_URL` and `APP_SECRET`
above override those values without changing the files.

### What each gate proves

| Gate | Evidence and limitations |
| --- | --- |
| `npm run test` | Vitest includes unit and integration directories. Without `RUN_DATABASE_INTEGRATION=1`, all DB tests skip. `db-transaction.test.ts` accepts any nonempty URL; validate the isolated target before enabling it. |
| `RUN_DATABASE_INTEGRATION=1 npm run test -- src/tests/integration` | Actual PostgreSQL transactions, Review/Apply/readback, stale-preview rollback, archive/restore and replacement failure checks. Require zero unexpected skips. |
| `npm run build` | Next compilation and TypeScript checks; does not prove browser behavior or database mutation correctness. |
| `npm run test:e2e -- src/tests/e2e/review-trust.spec.ts --workers=1` | Desktop Chromium and mobile WebKit Review copy/empty state, plus mocked onboarding success/failure. Does not exercise browser Apply. |
| `npm run test:e2e` | Broader suite, with a mix of mocked routes, fake DBs and real local DB fixtures. Inspect skips; some DB cases skip if unavailable. `readme-preview.spec.ts` rewrites tracked `public/screenshots/pawplan-preview.png`; run it only when that artifact is in scope. |

Playwright starts `npm run dev` at `127.0.0.1:3000`, sets `APP_SECRET=test-secret`
and a test admin ID, and has `reuseExistingServer: true`. An existing server may
have a different database or secret. Keep the port free and run build/E2E
sequentially because they share `.next`. If browser binaries are missing, use
`npx playwright install chromium webkit` when installation is in scope.

There is currently no tracked GitHub Actions workflow. `npm run lint` invokes
`next lint`, but ESLint dependencies/configuration are not set up: it prompts
for initialization and is not a working unattended gate. Do not report lint or
remote CI as passed, or initialize a new lint/CI framework during unrelated work.

### Core flow: batch task notes

Reuse `src/tests/integration/task-notes-batch-db.test.ts`:

1. Seed 43 tasks in a new test workspace; propose one notes approval. Assert
   `draft_created`, 43 diffs and unchanged persisted notes before approval.
2. Retry the proposal with the same key: one approval, same token, `duplicate`.
3. Explicitly approve, then Apply. Assert `succeeded`, `processedCount=43`,
   `mutationApplied=true` and successful post-commit readback.
4. Independently SELECT the tasks and compare notes by exact ID; assert 43 audit
   rows and approval `consumed`. Retry Apply: no additional audit rows.
5. Change a task after Preview: Apply must reject with `preview_stale`, preserve
   old notes and leave approval unconsumed. Test cleanup deletes its workspaces.

This exercises real services and PostgreSQL; approval is simulated by a service
call, not a browser click or a hosted MCP request. For changes to Review UI/API
or MCP permissions, additionally check that actual boundary: no task mutation
before user confirmation; only accepted operations applied; rejected/skipped
operations unchanged; refresh and read back exact IDs after Apply.
`review_only` must not Apply or directly mutate tasks.

### Closeout

- Report commands, environment, pass/fail/skip counts, and which assertions used mocks.
- Confirm test workspace cleanup and stop only services started for this run.
- Run `git diff --check`, `git diff --stat`, and `git status --short`; preserve unrelated changes.
- List blocked or omitted checks with reasons. A local gate does not authorize commit, push or deployment.


## Database And Migration

- Apply migrations through the deployment path.
- Confirm these tables exist in the target database:
  - `beta_invite_codes`
  - `workspace_onboarding_events`
  - `oauth_clients`
  - `oauth_authorization_codes`
  - `claude_connector_authorizations`
- Confirm existing workspaces can still log in.
- Confirm new workspace creation creates active starter plan state.

## Invite Access

1. Confirm production has `PAWPLAN_ADMIN_WORKSPACE_IDS` set to the owner workspace id.
2. Open `More -> 邀请管理` as the owner workspace.
3. Create a one-person invite link.
4. Open `/login`.
5. Confirm existing workspace login is separate from invite-link creation.
6. Open `/join/<invite-token>`.
7. Confirm the user can create a workspace without manually entering the invite token.
8. Confirm an invalid, expired, or reused invite token fails before password hashing.
9. Confirm successful creation redirects to `/today`.
10. Confirm a non-owner workspace cannot open `/admin/invites` or call `/api/admin/invites`.

## First-Run Onboarding

1. Open `/today` in a new workspace.
2. Confirm onboarding checklist is visible.
3. Import or skip fixed schedule.
4. Connect or skip connector setup.
5. Open `/review`.
6. Confirm checklist state changes only from real data or explicit skip events.

## Import

Plan:

1. Open `/import`.
2. Preview `plan.md`.
3. Confirm warnings/conflicts render.
4. Save only after preview.
5. Confirm direct save with only static confirmation is rejected.

Timetable:

1. Preview `timetable.csv`.
2. Confirm `Asia/Shanghai`, row count, block count, warnings, and conflicts render.
3. Confirm conflict lookup failure does not block preview.
4. Confirm oversized date ranges, too many rows, and too many generated blocks are rejected.
5. Save only after matching preview token.

## Calendar And Constraints

1. Open `/constraints`.
2. Confirm course count, fixed block count, conflict count, and next fixed block render.
3. Confirm `导入 timetable.csv` links to `/import`.
4. Create a course block.
5. Edit the block.
6. Delete a block.
7. Confirm no drag-and-drop calendar behavior exists.

## Connector Setup

Codex:

1. Open `/settings`.
2. Create a read-write MCP token.
3. Copy raw token once.
4. Configure Codex with `PAWPLAN_MCP_TOKEN`.
5. Confirm read-write tools include `propose_daily_rebalance` and `propose_week_rebalance`.
6. Revoke the token.
7. Confirm revoked token cannot call MCP.

Claude:

1. Open `/settings`.
2. Confirm protected resource metadata verifies.
3. Confirm authorization server metadata verifies and includes `mcp` scope.
4. Add PawPlan MCP URL in Claude Custom Connector.
5. Complete browser authorization.
6. Confirm authorization appears in Settings.
7. Confirm Claude can see high-level rebalance tools but cannot auto-apply Review drafts.
8. Revoke authorization.
9. Confirm Claude access stops.

## Review

1. Create a task-change draft through `propose_patch`.
2. Create a timetable draft through `propose_timetable_import`.
3. Open `/review`.
4. Confirm queue shows task changes, timetable imports, and conflict/blocked counts.
5. Accept one operation and reject another.
6. Confirm apply writes only accepted operations.
7. Confirm timetable apply rechecks conflicts before writing `time_blocks`.
8. Confirm skipped/conflicted operations remain visible and audited.

## Agent Runs

1. Create a daily rebalance draft through `propose_daily_rebalance`.
2. Confirm the returned status is `draft_created` before claiming a new Review draft exists.
3. Repeat the same call with the same idempotency key.
4. Confirm the returned status is `duplicate` and points to the existing draft.
5. Try a no-op or skipped move.
6. Confirm the returned status is `no_change` and no Review draft is claimed.
7. Force or observe a failed run in a non-production test workspace.
8. Confirm the returned status is `failed`, includes an error, and does not claim success.

## Safety Checks

- MCP read-only tokens do not expose write tools.
- MCP cannot directly edit constraints.
- `propose_patch` and `propose_timetable_import` create Review drafts only.
- `propose_daily_rebalance` and `propose_week_rebalance` create Review drafts only.
- No automatic apply path exists.
- Review remains required for every draft, including duplicate or retried agent runs.
- Template export does not include passwords, invite codes, raw tokens, token hashes, or connector access token hashes.
- Workspace delete requires exact typed confirmation.
