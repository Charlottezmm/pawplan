# Inbox Life-Admin

Inbox is a capture buffer. It is not Today and not a hidden project plan.

## Capture Only

Use Inbox for low-commitment items:

- quick chores
- errands
- vague reminders
- unclear project seeds
- things that need triage later

Inbox items stay unscheduled until promoted. Capturing an item should not imply that it is committed work.

## Today Is Committed Work

Today should contain work the user has actually committed to doing today, with date, day segment, and estimate.

If a chore should happen today, promote it from Inbox into Today with visible scheduling metadata. If it is just a thought, leave it in Inbox.

## Chores And Routines

Small chores can be captured quickly and promoted later:

```text
buy paper towels
wash laundry
take out trash
```

Recurring chores should become Routine instead of repeated Inbox items. Routine gives the chore a predictable pattern and keeps Inbox from becoming a duplicate reminder list.

## Project Seeds

Use one Inbox item when a project is not ready:

```text
Clarify hardware sourcing project
```

Do not dump a structured project conversation into many Inbox rows.

If the project already has concrete tasks, dates, or milestones, use `import_plan_bundle` or create Review drafts instead of Inbox. Inbox is for capture; project task batches belong in the planning flow.

## Agent Rules

Agents should use `create_inbox_item` only for:

- low-commitment capture
- chores
- errands
- unclear project seeds

Agents should use `import_plan_bundle` for structured project plans and high-level rebalance tools for moving already planned tasks.
