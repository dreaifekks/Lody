# Board project scope

Status: implemented
Translation: current

[中文](2026-10-20-board-project-scope.zh.md)

## Abstract

A Board's agents could open sessions in any project, so a Board about one repository
had no way to keep its threads there. A Board row may now name the projects it
works in; members' startup instructions list them with the work context that opens
each, and an agent's create in any other project is rejected with
`BOARD_PROJECT_OUT_OF_SCOPE`. Chats, Tabs of a parent and threads the user starts by
hand stay unlimited, and a Board without a scope covers every project as before.
Because one repository has a different local project id on every machine, the picker
merges projects by name and stores every machine's pair; a machine that adds the
same repository later joins only when the user ticks the row again. Verified by unit
and component tests and Storybook stories; not yet run against real agents on the
LAN.

## Decision and responsibilities

The intent is in the [Board design](../../../../specs/project-coordinator/design.md),
"Board context › Project scope" and decisions 16–19; the user confirmed it on
2026-10-20.

- **Data.** `BoardMeta.context?.projects` holds `{ kind: 'local', machineId,
  localProjectId, name }` or `{ kind: 'github', repoFullName }`
  (`packages/shared/src/board.ts`). Absent or empty means every project, so rows made
  before the field existed need no migration. `boardProjectScope` returns the
  narrowed list or `undefined`; `isProjectInBoardScope` matches a local project on its
  exact machine pair and a repository by name, case-insensitively as GitHub does.
  The design's optional `githubRepoFullName` on local entries was left out: nothing
  reads it yet.
- **Instructions.** `buildBoardInstructions` adds one section for coordinator and
  thread alike, only when the scope is narrowed: each project with its machine id
  and the exact `workContext` (plus `machineId` for a local project, since a local
  create otherwise targets the caller's machine), the rejection code, and that chats
  and `useCurrentSessionAsParent` are unlimited. Machine names are not resolved: the
  prompt path has no machine read, and the id is what `lody_session_create` takes.
- **Check.** `assertBoardProjectInScope` (`apps/cli/src/lib/board-directory.ts`)
  runs inside `resolveCreateContext` once the target machine and project are known,
  only when the caller's session has `boardId`, no parent is used and a project was
  chosen. It reads the row with `readSyncedBoard`, like the Board directory, so a
  daemon whose catalog replica predates the Board still sees it. Putting it there
  covers `lody_session_create`, `lody_session_create_many`, the legacy waiting create
  and a terminal `lody session create` inside a Board session; durable creates are
  checked before the Operation is accepted. The MCP layer maps the error to its own code instead of
  `COMMAND_REJECTED` / `INVALID_ITEM`; in a batch only that item fails.
- **UI.** `BoardProjectScopePicker` is a `Menu` of checkbox rows (`@lody/ui`) in the
  create dialog's slot beside the coordinator and in Settings › General. Its rows come
  from `buildBoardScopeOptions` (`board-project-scope.ts`): visible local projects
  merged by name, GitHub repositories from `useWorkspaceGitHubRepositories`, and any
  scoped project nobody can see any more, so it can still be unticked. A row with
  some of its machines in scope shows a partial mark; ticking it adds the missing
  pairs. "+ New thread" gained the ordinary project chip and worktree checkbox
  (`ProjectRefSelector`, `WorktreeCheckboxPill`) and starts the thread like a new chat
  in that project; it is not filtered by the scope. The selector names no branch
  for a repository, so creation asks GitHub for its default branch first
  (`githubFetchDefaultBranch`), as the chat landing does.

## Alternatives considered

- **Filter "+ New thread" by the scope**, as the first design said. Dropped by the
  user: a thread they start by hand needs no guard, and filtering would push them to
  settings just to start one.
- **Store one entry per project name.** Simpler to show, but a name does not
  identify a directory, and the check would have to guess which machine's copy is
  meant. Pairs keep the check exact; merging happens only in the picker.
- **Add new machines' copies automatically.** Rejected: a project of the same name
  is not proven to be the same repository, and the scope would widen silently.

## Limits

- An older client that saves Board settings drops `context`, as it does
  `instructions`; every writer must run the same version (no compatibility layer).
- A thread keeps the scope it read at start; a later change reaches it only through
  the create check.
- Not verified on real agents or across LAN members; the dialog and settings were
  seen in Storybook and component tests only.
