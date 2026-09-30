# Cloud assistant implementation and rollout evidence

This includes a staged backend extension of the existing hosted `/api/mcp`, a
same-origin session API at `/api/assistant`, and three integrated Today sheets.
It does not establish a connection
to Charlotte's dot assistant on iOS, add embedded chat, or activate reminders.

## Seven-feature coverage

| Requested capability | Backend implemented/reused | Actual usability and remaining gap |
| --- | --- | --- |
| 1. Chat create/update/complete tasks | `preview_assistant_change` / `confirm_assistant_change`; immutable draft, expiry, stale checks, workspace isolation, idempotency and exact-ID readback. New tasks start in backlog. | Verified in local PostgreSQL and tool dispatch. Remote chat needs migration, deployment, supported dot connector and connected read/write acceptance. No new chat UI. |
| 2. Continue from progress/blockers/next step | Confirmed append-only `save_continuation`; `get_continuation` filters by task/project and retains evidence, remaining duration and energy. | Today mobile-web progress sheet supports task association, recent records, preview, explicit confirmation, exact saved-record verification, cancellation and same-draft retry. Verified locally against PostgreSQL on desktop Chromium/mobile WebKit. Shipping requires migration and deployment; mobile web does not require a chat connector. Missing reports remain unknown. |
| 3. Time/energy recommendations | `recommend_next_tasks` ranks eligible tasks in an explicit time window, excludes blockers/energy mismatch, checks contiguous free intervals, fixed arrangements, locked slots and deadlines, uses recorded remaining work where present. | Today time/energy sheet presents read-only suggestions and opens progress for a chosen task; verified on desktop/mobile. Does not book work. Capacity and latest state must be validated by `propose_task_timing` before booking; estimates and limited continuation history are caveated. |
| 4. Propose safe rescheduling | Existing `get_task_timing` → `propose_task_timing` → user approval in Review → `apply_task_timing`. Reuses fixed/routine slots, protected task rules, deadline/capacity checks and stale snapshots. | Existing product flow remains available. Its PostgreSQL integration suite was rerun locally. No automatic scheduling or new scheduler. |
| 5. Gao/Liu meeting preparation and actions | `prepare_meeting_summary` returns source records and current task state for explicit projects/period; `save_meeting_feedback` preserves user-supplied feedback/decisions/questions/next actions after preview-confirm. | Bundle supports an external assistant's summary. It does not infer advisor assignments, completion dates or feedback, send messages, or turn proposed actions into tasks silently. Create agreed tasks through separate previews. No meeting UI added. |
| 6. Configurable proactive reminders | Confirmed `configure_reminders` persists timezone, quiet hours, minimum interval, daily cap and topics; `get_reminder_configuration` reports delivery adapter unconfigured. Activation is rejected by schema (`enabled: false`). | Configuration only. No delivery adapter, scheduled runs, push channel, actual activation or reminders. Preferences remain undecided and no timers are created. |
| 7. Plan vs actual comparisons | `compare_plan_actual` reports current estimate, captured plan estimate, observed duration and observed delta, unknown logs, approximate times, clipped records, overlaps, changing/missing snapshots and truncation. | Today actual-records header opens a date-range comparison sheet; verified on desktop/mobile. Completion clicks never fabricate duration; no aggregate productivity ratio or claim of complete logging. Shipping requires migration and deployment. |

## Write contract

1. Call `preview_assistant_change` with one exact change and a fresh retry key.
2. Display the returned change/before/after/warnings to the user.
3. Wait for explicit confirmation of that exact preview. Never manufacture it.
4. Call `confirm_assistant_change` with the immutable `draft_id`,
   `confirmation: USER_CONFIRMED`, and the user's instruction.
5. Inspect `readback.verification` **and** `matchesMutation` before claiming the
   intended result. `applied_with_readback_error` means the write committed but
   verification failed; retry the same draft. `duplicate` reads the same receipt
   and never performs a second mutation. Later changes can make `matchesMutation`
   false even when the read itself succeeds.

Drafts expire after 30 minutes. Changed task/project/preferences/active-plan
context invalidates confirmation. Preview persists only a draft; it changes no
live task, continuation or reminder configuration. `read_only` cannot preview;
`review_only` can preview but cannot confirm. Hosted previews consume no write
quota; confirmation uses the existing quota and duplicate-release behavior.
Existing direct tools remain for previously confirmed exact user instructions.

`create_task` records an explicitly supplied date/segment as a backlog anchor;
it does not create an exact appointment. `update_task` deliberately has no
calendar movement fields, and cannot place backlog work directly into todo.
Calendar placement/rescheduling uses the existing constraint-aware timing flow.
Returning movable work to backlog previews and clears its exact slot; protected
work uses the existing Review path. Completion changes status, never actual logs.

`/api/assistant` accepts `{tool, arguments}` for these seven assistant tools only.
It derives workspace ownership from the session, rejects cross-origin requests,
and accepts no client workspace override. It is an API companion, not a chat UI.
Remote clients use authenticated hosted MCP instead of cookie-session access.

## Connection feasibility (checked 2026-09-30)

Existing transport: public HTTPS stateless Streamable HTTP `/api/mcp`, plus local
stdio. Local stdio requires the Mac; it cannot satisfy Mac-off operation.
Hosted authentication supports workspace-bound bearer tokens and OAuth access
tokens. OAuth discovery, S256 PKCE, DCR, refresh and revocation routes exist.

A concrete blocker remains: `src/lib/oauth/connector-auth.ts` restricts OAuth
redirect hosts to `claude.ai`, `www.claude.ai`, `claude.com`, `www.claude.com`.
Both dynamic registration and `/api/oauth/authorize` reject other hosts. Existing
authorization is Claude-specific and issues `read_write` codes from a signed-in
session without a new permission chooser. **No OAuth/security changes were made.**

[OpenAI developer-mode documentation](https://developers.openai.com/api/docs/guides/developer-mode)
confirms a **web** setup route for Plus, Pro, Business, Enterprise and Education,
subject to workspace policy: Settings → Security and login → Developer mode;
ChatGPT Plugins → plus button → name/description + remote MCP URL + OAuth setup.
It supports SSE/streaming HTTP and configured DCR.
[The connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt)
requires endpoint discovery/authentication and actual tool-call tests, then
Refresh after metadata changes.

These documents do not prove this particular dot's iOS tool catalog can use the
custom connection. There is currently no connected PawPlan tool/read acceptance.
The exact supported dot setup route and official callback/client-registration
requirements remain unresolved. Do not propose a broad allowlist expansion;
first establish that route and its precise callbacks, then seek per-action
approval for minimal authentication/consent changes and any DCR/OAuth grant.
No credential, registration, grant, account/security setting, or access expansion
was performed. Public directory absence does not prove custom setup is impossible.

## Migration and rollout

Staged migration: `drizzle/0024_cloud_assistant.sql`, generated snapshot and
journal entry. Adds only `assistant_drafts`, `continuation_records`,
`assistant_reminder_preferences` and their indexes/FKs. It passed isolated PostgreSQL tests. Charlotte explicitly approved production
deployment and this additive database update on 2026-09-30. Production migration
0024 was applied in one transaction; all prior 0000–0023 ledger entries matched,
and new tables, indexes, foreign keys and the migration hash were read back.
No existing schedule rows, OAuth settings or reminder activation were changed.
The reviewed source is prepared for the approved production release.

For chat connection acceptance: refresh the supported connection's tool catalog,
run an authenticated read in the actual
dot on iOS with Mac off, then a user-confirmed disposable write with exact-ID
readback. Account eligibility/ownership, precise OAuth route and the actual dot
client must be verified before claiming availability. Reminder activation needs
an independently supported, approved cloud delivery adapter and chosen settings.

## Mobile-web and display scope

- Today: compact “接着做” entry and per-task progress action. Save flow previews the exact report, confirms explicitly, verifies the persisted record, and keeps task status/calendar unchanged. Failed verification retains the same draft for retry; history can be reopened after cancellation.
- Recommendations: explicit Beijing start time, available minutes and energy. Suggestions do not reserve work.
- Plan/actual: selected actual-records date plus up to 31-day range; unknown duration stays unknown, approximate records stay approximate, and captured estimates remain separate from current estimates.
- Review import cards: one status hierarchy and quantity summary, neutral unimported state, reversible collapsed old/conflict cards, readable deduplicated conflicts, full explanation/technical details initially collapsed. Existing final submission/apply logic remains unchanged. No actual suggestion was accepted/rejected during implementation.
- Calendar: wider desktop week with one page scroll and stronger text/category borders. Exact-duration bands remain exact; separate short-event shortcuts provide at least 44px targets. Phone uses a single-day agenda with full times/duration, full titles and explicit overlap notices. Existing recurrence, privacy and schedule editing contracts remain unchanged.
- Original Library screenshots could not be transferred to this executor. Parent inspected them; equivalent isolated Review/calendar fixture pixels were inspected locally before and after changes. No original-pixel inspection is claimed.

## Acceptance evidence

- Database-free full suite: 587 passed, 57 skipped (96 passed files, 8 skipped), including two assistant MCP schema/permission/annotation discovery tests.
- Seven assistant PostgreSQL tests passed on isolated `pawplan_assistant_check`:
  pre-confirm no live mutation, completion/create/readback, concurrent retries,
  permissions, ownership, stale/expired drafts, retry-key mismatch, continuation,
  meeting feedback, recommendations, disabled reminder storage, comparisons,
  committed readback failure/retry, later-edit mismatch, and audit-failure rollback.
- Existing timing PostgreSQL suite: 19 passed on isolated `pawplan_timing_check`, covering protected slots, fixed-block changes, capacity, approval, expiry, ownership and concurrent/stale apply.
- TypeScript: 66 baseline errors; diagnostics are semantically identical to the original repository at current concurrent commit `f8f0529` (also 66 at `03ae24f`). No new errors.
- Normal `next build` succeeded. Google font stylesheet optimization was skipped because it could not download; no TypeScript checking configuration was weakened.
- Browser acceptance: 24 passed, 2 intentional duplicate viewport-matrix skips; desktop Chromium and iPhone WebKit against isolated `pawplan_records_check`. Includes 320px sheets, 375/390/430px agenda matrix, 1440/1920px week, preview/cancel/confirmed persistence/readback failure/retry/reload, read errors/retry/cancel loading, recommendations/comparison with real records, Review no-Apply, exact short-event durations, overlap preservation, existing constraints and actual-record flows.
- Final source was verified before the approved release; production migration 0024 is applied. Deployment status and exact live commit must be checked after publishing. Connected dot-client acceptance remains unverified. Temporary fixture workspaces and local servers are removed at completion.
