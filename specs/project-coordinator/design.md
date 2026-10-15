# Boards and the coordinator mode

Status: draft
Translation: current

[中文](design.zh.md)

Bring the Claude Projects pattern into Lody: several parallel threads within a
scope, a coordinator that delegates work, and a user who can enter any thread
at any time. This design describes intent, data ownership and delivery guarantees.
Module `AGENTS.md` files own implementation constraints. The decisions at the end
were confirmed for PR1; the complete specification remains a draft.

## Scenario

The user creates a Board, supplies its goal and chooses a coordinator agent. The
coordinator uses `lody_session_create` to start implementation threads in worktrees
and a research chat on another LAN member, then ends its turn.

When a member finishes, fails, needs the user, or finishes its own reviewer session,
Lody batches those events and delivers them when the coordinator is idle. Agents
need not forward conclusions manually. Overview shows what each thread is doing,
who it waits for, its round and latest conclusion. Opening a row enters the ordinary
session composer: the user talks directly to its agent.

After four delegated rounds, the coordinator hands work to a new generation sharing
the original worktree. Members share Board notes; a daily schedule asks the coordinator
to append progress and save durable knowledge through its own nmem tools.

## Concepts and naming

| Concept | Meaning | Identifier |
| --- | --- | --- |
| Board | Sessions for one effort, one coordinator, shared notes and rules | `board`, `bd_*` |
| Coordinator | Fixed ordinary session receiving coordinator instructions and reports | `boardRole` |
| Thread | Non-coordinator root session, without `parentSessionId` | Root session id |
| Generation | A successor child Tab under the thread root, sharing its directory | `boardGeneration` |
| Report | A system turn containing new member events, delivered at an idle boundary | `board_report` |

Lody already uses Project for repositories and local folders (`ProjectRef`,
`['localProject', id]`, `lody_project_list`). This container is **Board / 看板**.

## Data model

### Board row

Add `['board', boardId]` to the workspace Flock document in
`packages/shared/src/workspace-flock.ts`. It shares the Agent Role catalog's local
durability followed by explicit upload:

```ts
type BoardMeta = {
  version: 1;
  id: BoardId; // 'bd_' + uuid
  name: string; // <= 80 Unicode code points
  purpose: string; // <= 4000; also the coordinator's first message
  coordinatorSessionId: SessionId;
  createdAtMs: number;
  createdByUserId: string;
  rules: {
    maxRoundsPerThread: number; // default 4
    reportHumanTurns: boolean; // default false
    executorConstraints: string; // <= 2000; injected into each thread's first message
  };
  digestScheduleId?: string;
  archivedAtMs?: number;
};
```

At most 50 active Boards per workspace. Archived Boards (`archivedAtMs` set) do not count toward this limit. Do not store a second member list: session metadata
is the membership authority, and Overview/tools filter by `boardId`.

### Membership

Add to `SessionMeta` in `packages/shared/src/schema.ts`:

```ts
boardId?: BoardId;
boardRole?: 'coordinator'; // absent on execution threads
boardGeneration?: number; // successors: 2, 3, ...; absent on reviewer Tabs
```

Creation writes membership:

- The coordinator receives `boardId` and `boardRole`.
- `lody_session_create` and `create_many` inherit the invoker's Board for child Tabs,
  independent work contexts and plain chats alike. Reviewers therefore join too.
- A child Tab inherits its root's Board.
- Overview's future New thread action sets `boardId`; future Join/Remove actions
  change only membership, without moving a session.

Coordinator and threads remain ordinary sessions. Archive/restore/delete/worktree
cleanup follow `specs/session-relations.md` and `specs/session-worktree-lifecycle.md`;
Board does not introduce another lifecycle target set. Archiving a Board archives
its coordinator and member roots with their existing children, then sets `archivedAtMs`.

### Threads, generations and children

```text
Board
├─ Coordinator S0                 boardRole=coordinator
├─ Thread A (root)                boardId=...
│  ├─ Reviewer Tab A'             parentSessionId=A
│  └─ Generation A2               parentSessionId=A, boardGeneration=2
├─ Thread B                      openedBySessionId=S0
└─ Thread C                      openedBySessionId=A (independent root)
```

The current generation is the root or its child with the highest `boardGeneration`.
Rounds, report thread status and chat round checks use that generation. Successors
are child Tabs because the root owns and cleans its worktree. CLI already supports
`--parent`; MCP currently exposes only `useCurrentSessionAsParent`.

### Shared notes

Each Board has a Loro document `board-<id>`, stream `<ws>:bd:<id>`:

- `notes`: Markdown in LoroText, at most 256 KiB.
- `meta`: `{ updatedAtMs, updatedBy }`, with a session id or `'user'`.

Flock replaces whole row values, so concurrent appends would overwrite each other.
LoroText merges them. Follow `schedule-repository.ts` and `useScheduleDocument` for
document acquisition/subscription; Board rows provide discovery, with no new registry.

### Machine-local state and LAN sync

The coordinator machine's `operations.sqlite3` owns `board_report_cursors`:
`(board_id, session_id, last_reported_user_turn_id, last_reported_awaiting_since,
last_reported_notice_id)`. A report is a finished Operation with a Delivery, committed
with its cursor changes in one transaction.

| Data | Owner | Transport |
| --- | --- | --- |
| Board rows, membership, notes | Workspace/session/Board documents | Durable hub streams; offline changes merge |
| Report cursors and Operations | Coordinator machine SQLite | Not synced, like existing Operations |
| Status | Session metadata and presence | Durable metadata plus existing ephemeral presence, read-only |

Threads may run on any LAN member. The coordinator reads synced session documents,
as `reconcileItem` already does for Operation results. No new inter-machine RPC or
presence payload is needed; follow the Loro sync stack's ephemeral-channel constraints.

## Coordinator session

### Creation

`/boards` offers New board: name, goal, coordinator and three rules. Reuse
`schedule-agent-controls.tsx` for Agent Role or machine + agent + run config. Write
the Board row, create a plain chat coordinator with the goal as its first message,
and open Overview. Remember the last coordinator choice; Claude is not mandatory.

### Built-in instructions

The producer freezes Agent Config prompt + Role prefix + task into `inputConfig.prompt`.
The daemon's creation-only `buildPrompt` adds existing MCP/file-path/LAN reminders.
Board instructions use that same path:

- Coordinator first message: append coordinator instructions.
- Thread first message: append thread instructions.
- A report carries its fixed instructions in the system turn itself, like `completionText`.

Coordinator instructions state:

1. Its Board name and goal.
2. Delegate with `lody_session_create`, end the turn and await automatic reports,
   including descendants; do not ask executors to forward results. Use
   `lody_board_overview` and `lody_session_history` for detail.
3. The configured round limit; hand off when reached; chat refuses during auto review;
   use `followUp: true` only for additions to the same assignment.
4. Lody automatically appends the Board's executor constraints to each thread's first
   message; the coordinator does not need to repeat them.
5. Record conclusions/decisions with `lody_board_notes_*`.
6. Report conclusions and decisions the user needs to make.

Thread instructions state the Board name, goal, coordinator id, automatic completion/
waiting/failure reports, notes tools and executor constraints. A successor also gets
handoff facts before the coordinator-authored prompt.

### Product logic versus instructions

| Product logic | Agent judgment/instructions |
| --- | --- |
| Membership, event sources, batching and delivery | Task decomposition, agent choice and review combinations |
| Round accounting/limits and follow-up flag | Whether input supplements the same task |
| Shared-directory child successor and handoff facts | The handoff narrative |
| Refuse agent messages during auto review | How to act on review findings |
| Notes document, size, append/replace | What and when to write |
| Daily schedule and destination | Digest content and nmem commands |

Agent Role preferences remain in user memory rules. Constraints such as “commit,
do not push” are editable `executorConstraints`, not hard-coded product policy.

## Automatic reports

### Event sources

Observe every member except the coordinator, including child Tabs, through synced
session documents:

| Event | Evidence |
| --- | --- |
| `finished` | New user turn has a terminal assistant entry (`isTerminalAssistantEntry`) |
| `failed` | User turn status `failed`, or same-turn `chat_failed` system notice |
| `cancelled` | User turn status `canceled` |
| `waiting_user` | Newly set `awaitingUserSince`: permission, question, review handoff |
| `notice` | Changed `agentNotice.id` from `lody_notify_user` |

Events include session/title/machine/current generation, rounds/limit, context usage,
origin (`author.kind`), a tail-weighted 32 KiB assistant preview (as Operation output),
and a waiting-request summary when applicable.

### Observer and delivery

Extend `LodyOperationCoordinator` on the coordinator's Host-lease Worker only,
using `meta.machineId === this.machineId` as the ownership boundary:

```text
Member document change → wake → level-check members against cursors
                                    ↓ coordinator idle
                      finished board_report Operation + Delivery + cursor advance
                                    ↓ existing Delivery pipeline
                      claim → system report card → continue coordinator
```

Idle means no active turn, pending human input or pending Delivery, exactly as
`deliverIfRunnable` determines. Busy-time events accumulate in documents. At the next
idle boundary, batch everything into one wake; do not add timers or count thresholds.
Pending user input wins. Existing claim, two-attempt, uncertain, eight-hour expiry
and Operation-list semantics apply. Event count is uncapped, but the existing 64 KiB
completion-body head/tail limit applies; agents can read truncated output through
history. Advance cursors transactionally so repeated scans do not report twice.

### Deduplication and boundaries

- Skip `(sessionId, userTurnId)` still covered by an active delegated Operation;
  its own receipt delivers those results. Subsequent turns remain reportable.
- Human thread turns do not wake the coordinator by default: Overview/digest only.
  A Board can enable `reportHumanTurns`. Waiting, failures and notices report
  regardless of origin. A user speaking in a thread is taking over its work.
- Reports never write to execution threads, so cannot interrupt their auto review.
  Review termination already writes `awaitingUserSince` and handoff text.
- Archiving/removing the coordinator stops observation and retains cursors.

### Chain depth

Report depth is the maximum source `inputConfig.chainDepth` plus one. Reuse
`LODY_MAX_CHAIN_DEPTH = 32`: delegation plus report wake is two hops, permitting
16 autonomous coordinator wakes. At the cap, write a report card with
`continuation.reason = CHAIN_DEPTH_EXCEEDED`, without waking. Any human message to
the coordinator starts at depth zero and allows work at the next idle boundary.
Overview shows `n/32`. A separate Board budget is future work.

### Failure and offline behavior

Events remain in documents while the coordinator machine is offline and are scanned
when it returns. An offline executor produces no new document events. Existing
`DELIVERY_ATTEMPTS_EXHAUSTED` and `DELIVERY_EXECUTION_UNCERTAIN` semantics apply;
failed report writes do not advance cursors.

## Rounds, handoff and auto-review protection

Rounds derive from current-generation history: user turns authored by an agent,
excluding `inputConfig.boardFollowUp`. Human input does not count. Add
`followUp?: true` to `lody_session_chat`.

Before accepting a chat Operation, refuse a thread at its limit without follow-up
as `THREAD_ROUND_LIMIT`, naming the current id, rounds and handoff tool. Refuse a
superseded generation as `THREAD_SUPERSEDED` with the current id. UI human input
remains unrestricted.

Coordinator-only `lody_board_thread_handoff({ threadId, prompt })`:

1. Create a child Tab under the root with the same machine/directory, inherited
   frozen dispatch defaults (`resolveSessionTurnDispatchDefaults`), Board id and
   incremented generation.
2. First message: Lody-generated directory/branch/HEAD/previous session/generation/
   context-usage facts, followed by the coordinator's prompt.
3. Return the new id; its round count begins at zero.

While a thread's `autoReview` document is nonterminal, agent chat rejects with
retryable `THREAD_UNDER_AUTO_REVIEW`. Reuse the review automation predicate; Overview
shows Auto review. Human and agent inputs otherwise pause review through the same path.

## Overview

### Navigation

Add `boards` to `LoroSidebarNavKey` beside Schedules, `/boards` for the list/create
page and `/boards/$boardId` for Overview; register it in
`WORKSPACE_ROUTE_CHILD_SEGMENTS`. Keep existing sidebar machine/project grouping.
Mobile renders the same page, following Schedules.

### Contents and status

The header contains name/goal, coordinator agent/machine/status, autonomous chain,
digest time and Open. Future actions are Notes, Settings and Archive board.
Threads show title, agent/model, machine/work context, state, rounds/limit,
generation when present, recent activity and existing PR/diff hints. Archived
threads are collapsed separately. Child Tabs indent below their root; independent
sessions use the existing opened-by tree.

Only an expanded row opens its session document. Its preview shows the last
assistant text's tail (conclusion) and the last user turn's first line (current task),
following archive preview behavior. Keep idle rows free of invented resource status.

A shared status helper serves rendering and `lody_board_overview`:

| State | Source |
| --- | --- |
| Running / Starting / Finalizing | Presence (`sessionLiveStatusAtomFamily`), never durable `SessionMeta.status` |
| Waiting for you | Presence `requestPermission`, or no live status and `awaitingUserSince` newer than `lastMessageAt` |
| Auto review | Nonterminal review document |
| Failed | Current generation's last user turn failed or same-turn `chat_failed` |
| Idle · waiting for coordinator | Idle and last user turn authored by agent |
| Idle | Otherwise |

### Actions

A row opens the ordinary session route, using `?tab=` for the current generation.
The normal composer supports direct user input. Future row menus offer Open,
Remove from board and Archive. Settings edits name, goal, rules, coordinator agent
and digest; Notes opens the shared-note panel. These write actions are outside
PR1's read-only Overview.

## Shared notes

Overview provides Markdown textarea/preview, reusing plan-review rendering and
saving to LoroText. Tools: get all notes; append a section with optional heading
(default date + session title); replace all notes. Members append; coordinator and
human can replace. Concurrent append during replace may land at the end, which is
acceptable; no content is intentionally discarded.

Lody does not call nmem. Board notes are visible, local-to-the-Board work records;
agents own durable-memory writes with their own tools. The existing memory Provider
only handles identity/environment, not recall/save, and is not extended. Shared
folders require a separate multi-machine sync design and are deferred.

## Daily digest

The Board setting uses the existing Schedule command service to create one daily
cron (selectable time, default 04:00 Asia/Tokyo). Destination is `existing_session`
with the coordinator id. A fixed prompt reads Overview/notes, appends the day's
progress, conclusions and unresolved work, and saves it to nmem. Store
`digestScheduleId`; disable/archive pauses the schedule.

The coordinator already has Board tools, no Schedule schema extension is needed,
and scheduled turns reset chain depth to zero. The trade-off is one extra daily
turn in coordinator context.

## MCP tools

Only sessions with `boardId` receive Board tools. Pass it at agent startup via
`x-lody-mcp-board-id` / `LODY_MCP_BOARD_ID` for registration. Every daemon call
rechecks current membership (`BOARD_NOT_MEMBER`). All are Session tools through
`session/call-tool`, without a second writer.

| Tool | Audience | Result/action |
| --- | --- | --- |
| `lody_board_get` | Members | Name, goal, rules, coordinator id and own role |
| `lody_board_overview` | Members | Same status rows, <=100 rows and <=64 KiB |
| `lody_board_notes_get` | Members | Complete notes |
| `lody_board_notes_append` | Members | Append section |
| `lody_board_notes_replace` | Coordinator | Replace notes |
| `lody_board_thread_handoff` | Coordinator | Create successor |

Existing tools change as follows:

- Create/create_many: no new agent arguments; inherit and return `boardId`.
- Chat/chat_many: follow-up flag and the three round/superseded/review refusals.
- Session list: `boardId` filter, accepting `'current'`.
- Operation get/list: additional `board_report` kind.

Existing Role/Schedule permission-tier ceilings stay unchanged. Board tools write
only Lody-owned data.

## Implementation steps

Each step should merge and validate independently, in dependency order.

### PR1 Boards, membership and read-only Overview

- Shared: `board.ts` metadata/normalization/status; Flock row family; three session
  fields; workspace route segment.
- CLI `prepareSessionInput` accepts Board fields; MCP create inherits membership
  and session list filters it.
- Components: both routes/pages, creation dialog reusing Schedule agent controls,
  navigation, Experimental · Sessions > Boards, locales.
- Tests: normalization/status; MCP creation for parent/independent work contexts;
  real-atom Overview component behavior, following archive-list tests.

### PR2 Coordinator instructions, Board tools and notes

- Overview New thread and session-menu Join board / Remove from board actions.

- `buildPrompt` adds coordinator/thread instructions by role.
- Shared Board document read/write and CLI acquisition/size bounds; components
  `useBoardDocument` and notes panel following Schedule documents.
- Register get/overview/notes tools, MCP HTTP Board header and agent-client wiring.
- Tests: prompt output; daemon-routed member/nonmember/size behavior; concurrent
  LoroText appends on two replicas.

### PR3 Automatic reports

- Operation store kind, cursor table and atomic `acceptFinishedReport()`.
- Coordinator member subscriptions, level scans, idle boundaries, dedupe and chain.
- Shared completion reason, orchestration kind, report card rendering and model semantics.
- Tests with injected clocks and real Mirror subscriptions: busy batching, human
  priority, descendant completion, Operation dedupe, human-report switch, depth cap,
  offline catch-up and transactional persistence.

### PR4 Rounds, handoff and auto-review protection

- Shared round derivation and `inputConfig.boardFollowUp`.
- Chat refusals; handoff tool using child creation, facts and generation.
- Overview rounds, generations and auto-review state.
- Tests: agent/human/follow-up accounting; refusal paths; successor directory/config
  inheritance; nonterminal review document behavior.

### PR5 Daily digest and completion

- Board toggle creates/pauses a Schedule targeting the coordinator.
- Update experimental documentation, Spec evidence and Agent Note.
- Test cron/destination/prompt and pause behavior.
- Exercise a real LAN with coordinator and threads on different members: reports,
  handoff and notes.

## Risks

- Many threads may wake the coordinator at every idle boundary. Batching and
  excluding human completions reduce this; a minimum wake interval may be needed later.
- Sixteen autonomous wakes may stop overnight work; show the limit before adding a budget.
- Expanded rows acquire session documents; keep the 100-thread view bounded and expand few.
- Replace racing with append can move appended notes to the end.
- Older clients ignore unknown Board rows/metadata; upgrade the coordinator's machine
  first for reports.
- Codex may need stronger coordination discipline in practice, but creation does not
  prohibit any agent and prompts do not special-case it.

## Decided

The user explicitly confirmed these eight choices in the PR1 task:

1. Name: **Board / 看板**, not Project.
2. Human thread completion does not wake the coordinator by default; Overview and
   digest still include it. Each Board may enable `reportHumanTurns`.
3. Use the existing 32-hop cap and show depth/limit in Overview.
4. Successors are child Tabs of the thread root and share its worktree.
5. Send the daily digest directly into the coordinator session.
6. First release adds Board navigation/pages without sidebar regrouping.
7. Default four rounds, counting agent-authored user turns, excluding follow-up.
8. Do not require Claude; remember the last coordinator choice.

## Later

Board sidebar grouping/hiding members from other groups; split Overview/coordinator
conversation; synced folders; context-usage-based handoff hints; Board wake intervals
or budgets; mobile report push through the existing notify path; Board templates.

## Evidence and PR1 implementation

Design evidence: `operation-coordinator.ts`, `operation-store.ts`, shared
`session-orchestration.ts`; `session-execution-helpers.ts`, CLI `session.ts`,
`lan-session-command.ts`, `lody-mcp-server.ts`, `lody-mcp-http-protocol.ts`;
`message-handler.ts`, review automation, agent notices, shared schema/presence;
workspace Flock/Schedule repository/registry, LAN and catalog-durability docs;
workspace routes/sidebar, metadata/presence atoms, archive/Schedule components;
`specs/session-relations.md`, `session-worktree-lifecycle.md`,
`session-orchestration.md`, `agent-role-memory.md`.

PR1 implements Board rows, three membership fields, CLI/MCP and UI child inheritance,
list filtering, experiment, creation, desktop/mobile entry and read-only Overview.
See the [PR1 Agent Note](../../.agents/notes/implemented/feature/2026-10-15-board-overview.md).
PR2–PR5 above remain intent, not implemented behavior. Overview’s **New thread**
and the session menu’s **Join board / Remove from board** are not implemented in
PR1; they are assigned to PR2.

Adjustments to the original file plan: UI creation bypasses CLI preparation, so
both paths in `session-submission.ts` also inherit membership. Reuse the shared
catalog room. Collapsed threads display only presence/meta facts; expansion adds
failure/waiting-coordinator facts and message previews. The coordinator starts
expanded to show chain depth. Rounds/generation switching/review remain PR4.
Like existing catalog operations, the count limit and cross-document creation
are not distributed transactions across devices.

## PR2 implemented

PR2 adds new threads in Overview, join/remove actions in desktop and mobile Session menus,
role instructions, five Board MCP tools and a shared notes panel. New threads reuse the
Board dialog's Agent/Role controls and ordinary Session admission with a chat work context;
they do not overwrite the remembered coordinator choice. Manual membership edits affect
only the selected Session, not existing child Tabs; creation-time Tab inheritance remains
as in PR1. The fixed coordinator cannot be removed through this action.

Instructions are appended by `buildPrompt` on the creation path, not repeated on continuation.
They explicitly state that Board-wide reports, round refusal and handoff are not implemented.
Existing Operation completions still work; other events need an agreed explicit reporting
path. The full built-in template's PR3/PR4 promises await those implementations so the
coordinator does not wait for nonexistent notifications. Existing Sessions added to a Board
receive the tool list on the next ACP establishment; removed members are rejected immediately
against current metadata.

`lody_board_overview` uses the same metadata/presence status as collapsed UI rows without
opening all Session documents. Failures and conclusions are read on demand with
`session_history`. Replies are bounded to 100 rows and 64 KiB with `truncated` on overflow.
Generation and round presentation remain PR4 work.

Notes are native LoroText in `board-<id>`, with shared reads/writes and UTF-8 capacity checks.
CLI opens/syncs through the daemon's existing repo; the renderer subscribes only while the
panel is open and offers textarea editing and Markdown preview. The 256 KiB limit applies
to each local write, not a global cross-machine lock. Merging individually valid concurrent
appends can exceed it: preserve all content, reject further growth, and allow the coordinator
or user to reduce it through replacement. Board rows remain the discovery mechanism, with
no new registry. Long-term memory, automatic reports, handoff, round enforcement and daily
digests remain outside this PR.

Implementation and validation: [PR2 Agent Note](../../.agents/notes/implemented/feature/2026-10-15-board-tools-notes.md).

PR2 review corrections: catalog and notes sync failures log a warning, while creation and
tool calls continue from the local replica. Local durability completes writes; upload
remains in the background. Coordinator identity and default note headings use the invoking
Session id rather than requiring an id in sparse metadata. Lody injects thread constraints
once in the first message; the coordinator does not repeat them.
