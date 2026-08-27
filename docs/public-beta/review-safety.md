# PawPlan Review Safety

Review is the only apply boundary in PawPlan. Claude or Codex may create a draft only after the user explicitly asks for a planning adjustment or provides a concrete event; they cannot apply planning changes directly.

## What Counts As Applied

A planning change is applied only after the user opens PawPlan `/review`, accepts operations, and applies them.

These are not applied changes:

- Agent summaries.
- Review drafts.
- Suggestions.
- `duplicate` agent runs.
- Skipped operations.
- Failed agent runs.

## Draft And Readback Rules

Agents must inspect structured tool results:

- `draft_created`: a new Review draft exists.
- `duplicate` with `patchId`: an existing Review draft is available.
- `no_change`: no Review draft was created.
- `failed`: the run failed; report the error and do not claim success.

Agents must not say "I moved the task" or "the plan is updated" after creating a draft. The correct claim is that a Review draft exists, or that no draft was created.

## Skipped Operations

Skipped operations are not applied. They may appear because a task was already done, skipped, not movable, missing, or already in the requested date and segment.

The user can use skipped details as context, but skipped rows are not hidden writes.

## No Auto-Apply

PawPlan v1 formal does not include:

- app-owned AI
- built-in scheduler
- auto-apply
- direct agent edits to task dates
- direct MCP edits to constraints

High-level rebalance tools still stop at Review:

- `propose_daily_rebalance`
- `propose_week_rebalance`

The user decides what becomes real plan state.
