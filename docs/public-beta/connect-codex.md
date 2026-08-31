# Connect Codex To PawPlan

PawPlan v1 formal is invite-gated. These steps assume the user already has an invited workspace; they are not open signup instructions.

## Hosted MCP URL

Use the hosted PawPlan MCP endpoint:

```text
https://pawplan.charlottezmm.info/api/mcp
```

## Create A Token

1. Open PawPlan `/settings`.
2. Create a workspace-scoped MCP token.
3. Use a `review_only` token if Codex should read plans and create Review drafts.
4. Copy the raw token once and store it as an environment secret.

Review-only tokens can read and create Review drafts, but cannot apply them or call direct task, archive, delete,
replace, import, or time-block writes. Use `read_write` only for explicitly authorized direct-write workflows.

## Codex MCP Config

```toml
[mcp_servers.pawplan]
url = "https://pawplan.charlottezmm.info/api/mcp"
bearer_token_env_var = "PAWPLAN_MCP_TOKEN"
startup_timeout_sec = 30
tool_timeout_sec = 60
default_tools_approval_mode = "prompt"
```

Before starting Codex:

```bash
export PAWPLAN_MCP_TOKEN="<raw-token-from-settings>"
```

Do not commit the raw token, paste it into planning docs, or include it in screenshots.

## What Codex Can Do

Codex can read PawPlan data through MCP tools such as `get_today`, `get_week`, `get_month`, `get_constraints`, `get_checkins`, and `get_tasks`.

For routine task movement, Codex should use high-level rebalance tools:

- `propose_daily_rebalance` for daily task moves.
- `propose_week_rebalance` for weekly task moves.

Codex should not hand-write `propose_patch` for routine daily or weekly task movement.

## Review Safety

After a rebalance tool call, Codex must inspect the returned `status`:

- `draft_created`: a new Review draft was created.
- `duplicate` with `patchId`: an existing draft is available.
- `no_change`: no draft was created.
- `failed`: report the error and do not claim success.

The user still has to open PawPlan `/review` and approve or reject each operation. There is no auto-apply.

## Revoke Access

Open PawPlan `/settings`, revoke the MCP token, and restart Codex without the old token. A revoked token should no longer be able to call the hosted MCP endpoint.
