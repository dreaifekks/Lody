# Record workspace MCP selection on agent- and CLI-written Turns

Status: implemented
Translation: current

[中文](2026-10-17-agent-session-workspace-mcp.zh.md)

## Abstract

Sessions opened or continued through `lody_session_create`, `lody_session_chat`, their
batch forms and `lody session create/chat` started without any workspace MCP server:
their Turns recorded no `mcpServerIds`, and dispatch reads an absent selection as `[]`.
These producers now record a selection the way the desktop composer would: a new
Session takes the driving Turn's explicit choice (an explicit `[]` included), else the
workspace `enabledByDefault` servers; a chat follow-up takes the target's latest choice,
else those defaults, never the sender's. MCP Operations freeze the choice per target at
acceptance, so recovery reproduces it after the catalog or history changes. The tools
gain no MCP parameter.

## Problem and evidence

`buildCliHistoryInputConfig` in `commands/session.ts` never wrote `mcpServerIds`, so
every Turn written by the CLI or MCP Session tools lacked it. The dispatch watcher fills
an absent selection with `[]` (`session-dispatch-watcher.ts`), and ACP startup only
loads selected catalog servers, so the agent got Lody's built-in server and nothing
else. The omission dates from the upstream commit that introduced per-turn MCP
selection; Schedules had already been fixed separately
([Schedule note](2026-10-14-schedule-workspace-mcp.md)).

The stored meaning is three-state: absent means "no choice stated" (the composer then
preselects `enabledByDefault` servers) and `[]` means "none". By the time a Turn reaches
the running agent the distinction is gone: the active invocation context carries the
dispatched config, where absent has already become `[]`. A create therefore reads the
driving Turn from the requester's stored history by its `sourceTurnId`, falling back to
the invocation config only when that Turn cannot be read (a terminal caller has no
Turn and gets defaults).

## Decision

- One helper, `lib/session-mcp-selection.ts`, keeps a stated selection and otherwise
  reads `enabledByDefault` servers from the workspace catalog. Schedules use it too.
  Like the composer, a default may come from this machine's catalog copy: a failed
  catalog sync is logged and does not refuse the Turn, matching the rule that
  default-only work does not require confirmed catalog freshness.
- Create (MCP): the tool resolves the selection before validation and passes it as
  `ResolvedTurnDispatchConfig.mcpServerIds`; the effective create config carries it
  into `targetDispatchConfigs`, and `prepareSessionInput` writes it on the Turn.
  A batch resolves it once for all items.
- Create (CLI, legacy Operation replay): `prepareSessionInput` resolves it when the
  caller supplied none, from the frozen inherited input config or the opener Session's
  latest recorded choice, else defaults.
- Chat: the target's latest choice (`resolveSessionConversationConfig`, the composer's
  own source), else defaults. MCP chat Operations now store
  `targetDispatchConfigs: [{ mcpServerIds }]`; daemon replay passes it through, so an
  accepted chat does not reread the target.
- `FrozenConfigSchema` strips unknown keys from target configs, so it declares
  `mcpServerIds` explicitly.
- Schedule existing-chat runs now fall back to workspace defaults when the chat never
  recorded a selection (previously `[]`), which is what that chat's composer shows.

Not chosen: removing the dispatch watcher's `?? []`. It would keep the three states
through dispatch, but changes every runtime consumer of the dispatched config and does
not by itself give agent-written Turns a selection.

## Validation

- CLI command tests: a frozen selection is written without any catalog read; the
  opener's `['x']`, `[]` and absent choice produce `['x']`, `[]` and the defaults; chat
  resolution follows the target's latest Turn and falls back to defaults.
- MCP tests with the real MCP server, SQLite store and Loro history: create inherits
  the opener's choice, freezes it, and replays it unchanged after the defaults change;
  chat uses the target's choice rather than the sender's, freezes it, and replays it.
  Mocked-boundary tests cover the absent-versus-`[]` collapse in the invocation context
  and the per-item batch freeze.
- Operation store round-trip keeps `mcpServerIds`, including an explicit `[]`.

A live agent session on a multi-machine LAN was not exercised. A target machine that
lacks a selected server's environment variables still skips it with the existing
warning.
