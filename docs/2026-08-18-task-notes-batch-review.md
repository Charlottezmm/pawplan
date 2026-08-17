# Task notes batch Review contract

## Goal and non-goals

`propose_task_notes_batch` turns 1–50 exact task-notes replacements into one PawPlan Review. The user approves or rejects the whole set once; partial approval is intentionally unsupported. The feature does not extend `update_tasks_batch` and does not add notes operations to generic agent patches.

## Permission and API contract

- `propose_task_notes_batch` has the `review` capability, so `review_only` tokens may create the Review but cannot write task notes.
- Proposal calls require their own idempotency key, so an identical retry returns the original Review instead of creating a second card.
- `apply_task_notes_batch` has the `write` capability and accepts only `approval_id`, `preview_token`, and `idempotency_key`.
- The signed Preview binds workspace, active plan, task IDs, old notes, old `updatedAt`, new notes, and a 30-minute expiry.
- Approval authorizes the exact Preview. It is not evidence that the mutation has been applied.

## Apply transaction

The backend locks every task in task-ID order and verifies that every task is still active, still belongs to the same workspace and plan, and still matches the approved old notes and `updatedAt`. It then consumes the approval, updates all notes, writes an audit record for each task, verifies every note by transaction-local readback, and marks the idempotent operation succeeded in the same database transaction. Any failure rolls the entire transaction back.

After commit, the backend reads all tasks again and compares every persisted note. A post-commit readback failure returns `applied_with_readback_error`, `persistedStatus: succeeded`, and `mutationApplied: true`; it does not claim the committed transaction was rolled back.

## Review UI

The Review page renders one card with the batch count, one approve button, one reject button, and a collapsed list of every task title plus its exact before/after notes. The approval record also keeps a string-list fallback so older Review clients do not silently hide the proposed content.
