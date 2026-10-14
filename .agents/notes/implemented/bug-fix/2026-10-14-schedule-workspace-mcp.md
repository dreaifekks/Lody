# Preserve workspace MCP selection in scheduled turns

Status: implemented
Translation: current

[中文](2026-10-14-schedule-workspace-mcp.zh.md)

## Abstract

Scheduled turns omitted workspace MCP selection, so their agents received only
Lody's built-in server. Schedule definitions now carry optional catalog ids;
unset uses current workspace defaults, while an empty list selects none. The
choice is frozen in the prepared turn, preserving retry behavior. MCP, CLI,
editor and proposal confirmation carry the same choice; existing-chat runs keep
the chat's selection. Packaged multi-machine behavior still needs deployment
verification.

## Decision and evidence

This extends the [machine-owned scheduling decision](../feature/2026-09-24-machine-owned-scheduled-tasks.md)
and [execution settings Spec](../../../../specs/scheduled-task-permissions.md).
The daemon reuses `getDefaultSelectedMcpServerIds`, also used by the new-chat UI.
Defaults resolve at preparation, so later runs follow catalog changes without
rewriting definitions; retrying a prepared run retains its frozen list. The
existing MCP CLI id/name resolver is shared with Schedule writes. Registry
fingerprints and idempotency comparisons include explicit MCP selection, and
proposal history and confirmation preserve it. No connection secrets are added
to Schedule definitions.

The ordinary `lody_session_create` path has the same omission: its dispatch
config and history builder do not carry MCP ids. It was inspected and left
unchanged as requested. Fixing Schedule preparation locally avoids changing
all agent-created conversations implicitly.

### Review follow-up

Edits no longer resolve ids the Schedule already stores: the runtime skips a
removed server with a problem, so a title-only update (or its replay) must not
fail with `MCP server not found`. Newly supplied names and ids still resolve.
`lody_schedule_update` accepts `mcpServerIds: null` to clear the choice and
follow workspace defaults again; omission still keeps it and `[]` still selects
none. The editor's MCP menu gains a "Follow workspace defaults" checkbox:
checked means unset, unchecking pins the current defaults, and picking a server
pins the list. The proposal card shows an MCP row (workspace defaults with
their names, none, or the pinned names) unless runs go into an existing chat.

Checks: CLI command-service tests cover a removed stored id surviving a rename,
its replay, a new missing name still failing, and `null` clearing the field;
UI tests cover the menu toggle and the card wording under zh_CN.

## Validation

Behavioral tests cover engine/SQLite/Loro handoff for new and owned chats with
explicit, default and empty selections, existing-chat inheritance, create/edit/get
and proposal name resolution, retries, and cross-replica definition fingerprints.
The editor reuses the composer menu with interactive Schedule stories. CLI/MCP (153), shared (25) and UI (49) targeted tests pass, as do shared/CLI/UI
typechecks, root lint, formatting, i18n, boundary and docs checks. Root `pnpm check`
stops at ACP adapter preparation because this worktree has no initialized
submodule Git metadata; local source and dependency copies were used for the
scoped checks. No live Schedule was dispatched or deployed.

Browser verification confirmed the editor menu initially checks Mail and shows no MCP servers after unchecking it.

Commands (all completed before commit):

```sh
pnpm --dir apps/cli exec vitest run src/lib/schedules src/mcp/lody-mcp-server.test.ts src/mcp/workspace-mcp-configure.test.ts src/lib/workspace-mcp-store.test.ts --maxWorkers=2
pnpm --dir packages/shared exec vitest run tests/schedule.test.ts --maxWorkers=2
NODE_ENV=test pnpm --dir packages/components exec vitest run tests/schedule-form.test.tsx tests/schedule-agent-defaults.test.ts tests/schedule-save-blockers.test.ts tests/schedule-write-sync.test.ts tests/attachment-add-menu.test.tsx --maxWorkers=2
pnpm --filter @lody/shared --filter @lody/components --filter lody typecheck
pnpm lint
pnpm format
pnpm run docs check
pnpm lint:i18n
pnpm check:code-collab-imports
pnpm check:platform-boundaries
pnpm check:public-boundary
pnpm check
```
