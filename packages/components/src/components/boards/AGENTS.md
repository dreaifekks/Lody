# Boards

Parent instructions apply. `CLAUDE.md` symlinks here; edit `AGENTS.md` only.
Intent: [Board design](../../../../../specs/project-coordinator/design.md).

- Board rows share the workspace Flock catalog and its durability/upload split.
  Membership is `SessionMeta.boardId`, never a second member list.
- CLI/MCP independent creates inherit the invoking session's board; contained Tabs
  inherit only their parent, including when that parent has no Board. The renderer's `createSession` and `startSession` must do
  this too. Never inherit `boardRole` or `boardGeneration` implicitly.
- The 50-Board creation limit counts only unarchived rows and is checked once
  in the catalog writer.
- Overview acquires machine localProject catalogs at list level, once per machine.
  Live activity takes priority over waiting markers; without presence, only a
  marker newer than `lastMessageAt` means waiting for the user.
- Overview uses visible session metadata and live presence. Only expanded rows
  acquire session documents; the coordinator starts expanded. History reads use
  ConversationView, never a materialized full-history mirror.
- The experiment gates navigation and the page. Turning it off retains data and
  does not stop ordinary sessions or their membership inheritance.
- PR1 is read-only except Board/coordinator creation. Reports, notes, handoff,
  round enforcement and digest scheduling remain separate implementation steps.
