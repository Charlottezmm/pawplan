# Connect Claude To PawPlan

PawPlan v1 formal is invite-gated. Do not use these steps as open signup instructions; each invited user still needs a valid invite link to create a workspace.

## Hosted MCP URL

Use the hosted PawPlan MCP endpoint:

```text
https://pawplan.charlottezmm.info/api/mcp
```

Claude connects through the PawPlan OAuth connector flow. If Claude asks for a static client id, use:

```text
pawplan_claude_custom_connector
```

## Connect

1. Create or open an invited PawPlan workspace.
2. Open PawPlan `/settings`.
3. Add the hosted MCP URL in Claude Custom Connector.
4. Complete the browser authorization flow.
5. Return to PawPlan Settings and confirm the Claude authorization appears.

OAuth access is read-write only when the authorization grants write tools. Write access still means "can create Review drafts"; it does not mean Claude can apply changes.

## What Claude Can Do

Claude can read PawPlan data through MCP tools such as `get_today`, `get_week`, `get_month`, `get_constraints`, `get_checkins`, and `get_tasks`.

For routine task movement, Claude should use high-level rebalance tools:

- `propose_daily_rebalance` for daily task moves.
- `propose_week_rebalance` for weekly task moves.

Claude should not hand-write `propose_patch` for routine daily or weekly task movement.

## Review Safety

Every planning change must stop at PawPlan Review:

- Rebalance tools create Review drafts only.
- Claude must inspect the returned `status`.
- Claude may say a new Review draft was created only when `status = draft_created`.
- `duplicate` with `patchId` means an existing draft is available.
- `no_change` means no draft was created.
- `failed` means Claude must report the error and must not claim success.
- PawPlan has no auto-apply path.

Open PawPlan `/review` to approve or reject each operation.

## Revoke Access

If Claude access should stop, open PawPlan `/settings` and revoke the Claude authorization. After revocation, Claude should no longer be able to call the hosted MCP endpoint for that workspace.
