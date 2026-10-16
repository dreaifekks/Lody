# Boards and the coordinator mode

Status: draft
Translation: current

[中文](design.zh.md)

Bring the Claude Projects pattern into Lody: several parallel threads within a
scope, a coordinator that delegates work, and a user who can enter any thread
at any time. This design describes intent, data ownership and delivery guarantees.
Module `AGENTS.md` files own implementation constraints. The end records the
decisions the user confirmed, including the six upstream 0.105.0 revision choices,
and the PR1/PR2 implementation records.

This revision follows upstream 0.105.0: Delivery is gone (#1523) and every result
goes through the Operation Inbox's batched wake; the delegation chain cap is 16
and a conversation-tree stop exists (#1428); automatic review is gone (#1393);
child sessions have a compact task panel and `REVERSE_CHAT_FORBIDDEN` (#1481);
a manual user Stop no longer wakes anyone automatically (#1553).

## Scenario

The user creates a Board, supplies its goal and chooses a coordinator agent. The
coordinator uses `lody_session_create` to start implementation threads in worktrees
and a research chat on another LAN member, then ends its turn.

When a member finishes, fails, needs the user, or a reviewer it opened stalls on
the user, Lody records that as one durable result for the coordinator, and the
coordinator's Operation Inbox delivers the accumulated results as one batch when
it is idle. Agents need not forward conclusions manually; upstream refuses chats
back to the sender anyway (`REVERSE_CHAT_FORBIDDEN`). Overview shows what each
thread is doing, who it waits for, its round and latest conclusion. Opening a row
enters the ordinary session composer: the user talks directly to its agent. A
user Stop in any session follows upstream rules: the stopped result wakes nobody.

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
| Report | One member event, stored as a finished `board_report` Operation on the coordinator machine and delivered by the Inbox in a batch | `board_report` |

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
  purpose: string; // <= 4000, may be empty; members read it when they start
  instructions: string; // <= 16000; the user's instructions, in every member's first message
  coordinatorSessionId: SessionId;
  createdAtMs: number;
  createdByUserId: string;
  rules: {
    maxRoundsPerThread: number; // default 4
    reportHumanTurns: boolean; // default false
    executorConstraints: string; // <= 2000; injected into each thread's first message
  };
  files?: { machineId: MachineId }; // keeps the shared directory; default: the coordinator's machine
  digestScheduleId?: string;
  archivedAtMs?: number;
};
```

At most 50 active Boards per workspace. Archived Boards (`archivedAtMs` set) do not
count toward this limit. Do not store a second member list: session metadata is the
membership authority, and Overview/tools filter by `boardId`.

### Membership

Board fields on `SessionMeta` in `packages/shared/src/schema.ts`:

```ts
boardId?: BoardId; // membership (PR1)
boardRole?: 'coordinator'; // absent on execution threads (PR1)
boardGeneration?: number; // successors: 2, 3, ...; absent on reviewer Tabs (PR1)
boardJoinedAtMs?: number; // manual join time; absent when the session joined at creation (PR3)
```

Creation writes membership, on the CLI path (`prepareSessionInput`) and the two UI
creation entries (`session-submission.ts`):

- The coordinator receives `boardId` and `boardRole`.
- `lody_session_create` and `create_many` inherit the invoker's Board for child Tabs,
  independent work contexts and plain chats alike. Reviewers therefore join too,
  which is why reports can cover grandchildren.
- A child Tab inherits its root's Board.
- Overview's New thread action sets `boardId`; Join/Remove actions change only
  membership, without moving a session. Joining an existing session also writes
  `boardJoinedAtMs`; reports consider only state after that moment.

Coordinator and threads remain ordinary sessions. Archive/restore/delete/worktree
cleanup follow `specs/session-relations.md` and `specs/session-worktree-lifecycle.md`;
Board does not introduce another lifecycle target set. Archiving a Board archives
its member roots with their existing children, then the coordinator, then sets
`archivedAtMs`; restoring restores every root, then the coordinator, then clears it.
The coordinator and the row change last both ways: a failure leaves the Board where it
was, and every entry (the page's menu follows the coordinator) still offers the same
action to retry; there is no rollback.

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

### Machine-local state

Reports live only in the coordinator machine's Operation store (`operations.sqlite3`,
`apps/cli/src/orchestration/operation-store.ts`) and, like Operations today, are not synced:

- One `operations` row of kind `board_report`: the requester is the coordinator
  session, the row is `finished` at creation, and its completion carries one member
  event (see Automatic reports).
- Its `inbox_results` row, written by the existing `InboxSqlite.indexCompletion()` in
  the same transaction, identical in shape to an ordinary Operation receipt.
- `board_report_cursors(board_id, session_id, last_turn_id, last_awaiting_since,
  last_awaiting_turn_id, last_notice_id)`: how far each member has been processed.

All three commit in one `BEGIN IMMEDIATE` transaction. There is no Delivery table and
no second delivery state: claim, batching, settlement and expiry are the Inbox's
existing semantics.

### LAN sync

| Data | Owner | Transport |
| --- | --- | --- |
| Board rows, membership, notes | Workspace/session/Board documents | Durable hub streams; offline changes merge |
| Report Operations, Inbox results, cursors | Coordinator machine SQLite | Not synced, like existing Operations |
| Status | Session metadata and presence | Durable metadata plus existing ephemeral presence, read-only |

Threads may run on any LAN member. The coordinator reads synced session documents,
as `reconcileItem` in `coordinator-workflow.ts` already does for Operation results. No
new inter-machine RPC or presence payload is needed; follow the Loro sync stack's
ephemeral-channel constraints.

## Coordinator session

### Creation

The "+" on the sidebar Boards group creates a Board: a name (required), a goal
(optional) and the coordinator, chosen with `schedule-agent-controls.tsx` (Agent Role
or machine + agent + run config). Write the Board row (`files.machineId` is the
coordinator's machine), create a coordinator session with no message yet
(`createSession`, plain chat), and open the Board. Nothing is sent: the user speaks
first, and the chosen run config waits in the coordinator's composer. Remember the
last coordinator choice.

### Built-in instructions

The producer freezes Agent Config prompt + Role prefix + task into `inputConfig.prompt`.
The daemon's creation-only `buildPrompt` adds existing MCP/file-path/LAN reminders.
Board instructions use that same path:

- Coordinator first message: append coordinator instructions.
- Thread first message: append thread instructions.
- A report turn is upstream's Inbox batch turn: its body is the fixed `batchPreview`
  text plus member JSON (`inbox/model.ts`); no Board text is injected.

Coordinator instructions state:

1. Its Board name and goal (left out when the goal is empty).
2. It coordinates and does not implement, but keeps the whole picture: which threads
   exist, what each concluded, what is left, what the user must decide. Delegate with
   `lody_session_create` (threads appear in the Board panel; sessions a thread opens
   stay under it), end the turn and await reports. Reports arrive
   like its own delegation receipts, as a "completed asynchronous work" batch whose
   members have `operationKind: 'board_report'`, one member event each; failures,
   waits and notices of any member, including sessions a thread opened, arrive this
   way. Do not ask executors to forward results (upstream refuses chats back to the
   sender). Use `lody_board_overview` and `lody_session_history` for detail.
3. The configured round limit; `lody_session_chat` is refused at the limit, hand off
   with `lody_board_thread_handoff`; use `followUp: true` only for additions to the
   same assignment. The delegation chain is capped at 16 hops: on
   `CHAIN_DEPTH_EXCEEDED`, stop and report to the user. After the user presses Stop,
   accumulated reports arrive together with the user's next message.
4. Lody automatically appends the Board's executor constraints to each thread's first
   message; the coordinator does not need to repeat them.
5. Record conclusions/decisions with `lody_board_notes_*`.
6. Report conclusions and decisions the user needs to make.
7. Shared directory and memory: members on the machine that keeps it get its absolute
   path, others use `lody_board_files_*`. `files/` holds what everyone should see;
   `memory/` holds memory, indexed by `MEMORY.md`: read the index at the start, and
   record what later members should remember as one short file. The coordinator
   maintains `MEMORY.md`.
8. The user's Board instructions, when set, come last; every member follows them.

Thread instructions state that the session is a thread of the Board (name, goal), that sessions it opens belong to it, the coordinator id, automatic completion/
waiting/failure reports (forwarding is neither needed nor possible), notes tools and
executor constraints. When conclusions from reviewer or other child sessions arrive,
include them verbatim in your reply. Do not make changes based on those conclusions
yourself; the coordinator decides which changes to make. A successor also gets handoff
facts before the coordinator-authored prompt.

### Product logic versus instructions

| Product logic | Agent judgment/instructions |
| --- | --- |
| Membership, event sources, durable results, Inbox batching and wake | Task decomposition, agent choice and review combinations |
| Round accounting/limits and follow-up flag | Whether input supplements the same task |
| Shared-directory child successor and handoff facts | The handoff narrative |
| Tree stop, Inbox pause, no wake on user Stop, 16-hop cap (all upstream) | How to act on review findings |
| Notes document, size, append/replace | What and when to write |
| Daily schedule and destination | Digest content and nmem commands |

Cross review has no product logic: a thread opens its own reviewer child session with an
ordinary `lody_session_create` (`useCurrentSessionAsParent: true`), and the reviewer's
own receipt wakes the thread. Agent Role preferences remain in user memory rules.
Constraints such as "commit, do not push" are editable `executorConstraints`, not
hard-coded product policy.

## Automatic reports

In one sentence: an observer writes each new member state as one finished Operation of
the coordinator; the Inbox decides when, at what depth and in how large a batch the
coordinator sees it. The Board has no delivery pipeline of its own.

### Event sources

Observe every member except the coordinator, including child Tabs and independent
sessions threads opened, through synced session documents. First find the member's
latest **driving turn**: the latest user turn, or a system turn carrying
`inputConfig.chainDepth` (continuations, Inbox batches and schedules are system
driven), then the first assistant entry after it. Looking only at user turns misses
system-driven turns, so "the executor finished applying the review" would never report.

| Event | Evidence | Origin filter |
| --- | --- | --- |
| `finished` | First assistant entry after the driving turn is terminal (`isTerminalAssistantEntry`) and newer than the cursor | Not reported by default when the driving turn's `author.kind === 'human'` |
| `failed` | Driving turn status `failed`, or same-turn `chat_failed` notice | Reported regardless of origin |
| `waiting_user` | Newly set `awaitingUserSince` later than the driving turn: permission request, question | Regardless of origin; once per driving turn |
| `notice` | Changed `agentNotice.id` from `lody_notify_user` | Regardless of origin |

The human filter is `author.kind !== 'human'`, never `=== 'agent'`: system-driven turns
are not human and must not be muted. With `reportHumanTurns` on, human-driven
`finished` reports too. `cancelled` is not an automatic report event (see Decided: Inbox revision, item 3): per #1553 a user Stop on a member must not wake anyone, and a synced
document only shows "cancelled", not by whom; the coordinator already knows about its
own `lody_operation_cancel`. Cancellation is Overview-only.

Events include session id/title/machine/current generation, `contextWindowUsage`,
origin (`author.kind`), a tail-weighted 32 KiB assistant preview (as Operation item
`output`, 25% head / 75% tail), a waiting-request summary when applicable and the
notice text. State a member left before joining (`boardJoinedAtMs`) is not reported:
a manually joined session starts its cursor at the join moment.

### Observer

The observer is a Board branch in `LodyOperationCoordinator` / `coordinator-workflow.ts`
that runs only on the coordinator session's Host-lease Worker, using
`meta.machineId === this.machineId` as the boundary; where a thread runs does not
matter, so a cross-machine event is never reported twice. The coordinator itself is
outside observation and cannot wake itself.

- Membership is maintained from events, not full scans: subscribe to the workspace
  catalog's `board` family and to session `doc-metadata` events (fields `boardId`,
  `isArchived`, `awaitingUserSince`, `agentNotice`, `lastMessageAt`,
  `collaborationStopped`, through the same `repo.watch` entry `message-handler.ts`
  uses for `collaborationStopped`); member history changes mark members dirty through
  their own document subscriptions.
- Wakes coalesce: at most one reconcile runs and one waits; a reconcile re-reads only
  dirty members and skips archived ones. Otherwise every streaming import triggers a
  workspace-wide scan.
- The observer runs after Operation reconciliation in the same pass, so the receipt of
  a turn the coordinator delegated is always visible to the dedupe check.
- It does not judge coordinator idleness: an event becomes a result as soon as it is
  confirmed; idle, busy, pause and stop belong to the Inbox. The old "check the idle
  boundary before and after" logic is no longer needed.

### Durable results and the Inbox interface

One event = one Operation, through a new `acceptBoardReport()` in `operation-store.ts`,
doing three things in one `BEGIN IMMEDIATE` transaction:

1. Insert the `operations` row: `kind = 'board_report'`, `requesterSessionId` = the
   coordinator, `ownerMachineId` = this machine, `state = 'finished'`, `items: []`,
   completion `{ type: 'result', value: { items: [], boardReport: { boardId, events: [event] } } }`
   (`OperationResultSchema` gains optional `boardReport`; `LodyOperationKind` gains
   `board_report`). `initiatorChainDepth` and `frozenContinuationConfig.inputConfig`
   come from the coordinator's latest driving turn, including its `chainDepth`, the
   same source upstream uses for continuation turns.
2. Call the existing `inbox.indexCompletion()`: it writes `inbox_results` and, when the
   coordinator is idle, unpaused and has no accepted input, records one pending intent.
   No Board special case exists here.
3. Advance that member's cursor.

The Operation id is deterministic: hash the JSON tuple of member id, driving turn id,
event and `awaitingUserSince` / `agentNotice.id` for waiting/notices. Use `board-` plus
the first 58 SHA-256 hex characters to fit the existing 64-character id contract. The
`operations` primary key `(requester_session_id, operation_id)` and the
`operation_retired_ids` trigger therefore implement "receiving coordinator + source
event" deduplication: restarts, repeated scans and seven-day expiry never accept the
same event twice. The completion obeys the existing 64 KiB bound
(`assertCompletionBound`); truncated previews direct the coordinator to
`lody_session_history`.

### Batching and chain depth

Batching is entirely upstream:

- When the coordinator is idle, the first wakeable result records an intent; while it
  is busy, results only queue, and the normal release (`release()`) records one intent.
  `prepare()` snapshots the watermark when claiming and freezes every unconsumed,
  unclaimed result into one batch; later arrivals wait for the next one. No timers, no
  count thresholds.
- A user message to the coordinator always wins: a prepared automatic batch is
  superseded by human input, and queued results travel with it (human-plus-batch).
- `batchPreview` inlines at most 50 members and 64 KiB; the coordinator reads the rest
  with `lody_operation_batch_get` (128 KiB pages).
- Batch depth `batchDepth` (`inbox/model.ts`): automatic = max(config `chainDepth`,
  member `chain_depth`) + 1; human or scheduled (`task`) = that input's own depth,
  usually 0. An automatic batch at depth >= 16 (`LODY_MAX_CHAIN_DEPTH`, the claim check
  in `inbox/sqlite.ts`) marks the intent `depth_limited` without claiming; results
  stay queued until the user's next message carries them at depth 0.

A report row's `chain_depth` is the depth of the coordinator's latest driving turn at
observation time (Decided: Inbox revision, item 1). Each autonomous wake then costs exactly one hop, a
user or scheduled turn resets to 0, grandchild events cost no extra hops, and the value
matches the coordinator's own delegation receipts (`initiatorChainDepth` = depth at
delegation) in the common case. From one user message the coordinator wakes
autonomously at most 15 times (depths 1–15); the sixteenth is refused by the Inbox. At
depth 15 the coordinator may still delegate (upstream refuses initiators at >= 16);
the member at 16 cannot delegate further.

Overview's coordinator row shows `chain n/16`, with n from the coordinator's latest
driving turn. At the cap the observer writes an idempotent `board_chain_limit` system
notice: "Autonomous chain reached its limit; send a message to continue", once per
chain. Overview uses it to show Stopped.

### Deduplication

Three layers, none relying on memory state:

1. Cursors: each member reports only driving turns / waiting moments / notice ids newer
   than `board_report_cursors`; filtered events (human-driven, covered by a receipt)
   also advance the cursor, so enabling `reportHumanTurns` later cannot replay old ones.
2. Operation id: one member, one driving turn, one event can be accepted once (primary
   key plus retired ids).
3. Receipt coverage: a `finished` / `failed` whose `(sessionId, userTurnId)` is a target
   of any of the coordinator's own `session_create` / `session_chat` (including
   `_many`) Operations, active or finished-and-retained, is not reported: that receipt
   delivers itself. Checking only active Operations would duplicate the result on the
   scan after completion. `waiting_user` and `notice` have no receipt and report
   normally. Unfinished targets of timed-out or cancelled roots are not permanently
   hidden: their terminal turns are newer than the cursor and report normally.

Reports are the only upward channel for member state. Instructions neither require nor
rely on forwarding: in the turn a coordinator chat started, the member's
`lody_session_chat` to the coordinator is refused with `REVERSE_CHAT_FORBIDDEN`. A
grandchild's (reviewer's) result first wakes its parent member; the parent's subsequent
completion is reported by the observer. A grandchild's own `finished` is not reported
separately, avoiding two wakes per review cycle; `failed` / `waiting_user` / `notice`
still report. The parent includes the child's conclusions verbatim in its reply without
making changes itself; the coordinator selects the changes.

### Stop and pause

Everything is reused from upstream; the Board adds no rule and only states the scope:

- Tree stop (`collaborationStopped`): stopping the whole tree from Related sessions
  writes `collaborationStopped` on the root and every descendant
  (`readSessionOperationTargets(…, 'collaboration')` climbs `parentSessionId` /
  `openedBySessionId` to the root, then collects descendants); the daemon cancels
  running turns and preserves pending input (`reconcileCollaborationStops`). For the
  Board: while the coordinator's tree is stopped, the Inbox launches no batch for it
  (`launchInboxBatch` checks `isSessionCollaborationStopped`) and its MCP delegation is
  refused with `COLLABORATION_STOPPED`; the observer keeps writing member events as
  results, and after restoration upstream's stop semantics decide whether and when they
  are delivered (`specs/session-orchestration.md`, User-controlled conversation-tree stop).
- Upstream's stop scope is the conversation tree: threads the coordinator opened and
  their descendants. A Board may manually join unrelated root sessions; they are
  outside the coordinator's stop scope, keep running and keep queuing events. The first
  release does tree stop only; Board-level "stop all members" is deferred (Decided:
  Inbox revision, item 6).
- Inbox pause: a Stop on the coordinator from an Inbox v2 client (`cancelId` /
  `pauseInbox`) runs `pause()`: the session is paused, queued inputs cancelled, claims
  of prepared batches released; results stay queued. No intent is recorded while
  paused; only fresh trusted human input (`humanInputReceipts`) clears the pause and
  carries accumulated results. Agent chats, scheduled turns and reports cannot clear it.
- User Stop on a member (#1553): the manually stopped target appears in the
  coordinator's Operation receipt as `cancelled` with `cancellationReason: 'user_stop'`;
  `operationInboxCompletion` drops it from automatic admission, and a fully stopped
  Operation yields no wakeable result at all. The observer does not report
  `cancelled`, so no second path turns it into a wake.

### Failure and offline behavior

- While the coordinator machine is offline, events remain in documents; on return the
  observer catches up on the latest state and does not reconstruct intermediate events:
  a member that changed three times reports once. An offline executor produces no new
  document events.
- A failed report write (busy SQLite, failed transaction) rolls back all three writes,
  leaves the cursor in place and retries on the next wake through the existing bounded
  backoff in `coordinator-activity`; no new timer.
- Results are not silently dropped by long daemon downtime: unconsumed `inbox_results`
  rows never expire, pending intents are durable and recovered by the startup scan
  (`repo.pending`); report Operations are finished at creation and never enter deadline scheduling;
  consumed payloads are cleaned after seven days, but the batch card in history remains.
- When a batch was submitted but model delivery is uncertain (`unknown` settlement),
  upstream never re-batches it and the history card says delivery is uncertain. The
  Board does not resend: Overview and `lody_board_overview` remain the truth about
  current state, and the coordinator reads them on its next wake.
- Archiving/removing the coordinator or archiving the Board stops observation and
  retains cursors and results; permanent session deletion removes Inbox rows through
  `deleteSession`.

## Rounds and handoff

### Rounds

Rounds derive from current-generation history: user turns authored by an agent,
excluding `inputConfig.boardFollowUp`. Human input and system-driven turns (Inbox
batches, schedules, continuations) do not count. Add `followUp?: true` to
`lody_session_chat`, stored as `inputConfig.boardFollowUp`.

Before accepting a chat Operation, refuse a thread at its limit without follow-up
as `THREAD_ROUND_LIMIT`, naming the current id, rounds and handoff tool. Refuse a
superseded generation as `THREAD_SUPERSEDED` with the current id. Both checks run
after upstream's `COLLABORATION_STOPPED`, `CHAIN_DEPTH_EXCEEDED` and
`REVERSE_CHAT_FORBIDDEN`. UI human input remains unrestricted.

### Handoff

Coordinator-only `lody_board_thread_handoff({ threadId, prompt })`:

1. Create a child Tab under the root with the same machine/directory, inherited
   frozen dispatch defaults (`resolveSessionTurnDispatchDefaults`), Board id and
   incremented generation.
2. First message: Lody-generated directory/branch/HEAD/previous session/generation/
   context-usage facts, followed by the coordinator's prompt.
3. Return the new id; its round count begins at zero.

When the thread root is stopped (`isSessionCollaborationStopped(root)`), handoff is
refused with `COLLABORATION_STOPPED`, like upstream delegation: only the user restores it.

## Board home

Redesigned on 2026-10-16 and confirmed by the user (see "Decided" below). This
section replaces the former Overview section. Steps 1 and 2 are implemented; see
"Board home implemented" at the end. Status derivation and how reports render in the
conversation carry over from the earlier design; see "Carried over" below.

### Shape

A Board is one coordinator conversation plus one aggregated context. Opening a Board
opens the coordinator conversation. Threads, files and a single thread take turns in
the panel on the right; the rarely used settings live in a dialog.

```text
Sidebar
├─ Boards ─┬─ Board A ──opens──▶ coordinator conversation (centre) + Board panel (right)
│          │                       ├─ Threads: member sessions, grouped Needs you / Working / Idle / Archived
│          │                       └─ Files: the shared notes + the Board's shared directory
│          │                     ⚙ Settings dialog: name, goal, context, memory, rules, digest, archive
│          └─ Board B
├─ Machine / project groups (threads stay under their project; the coordinator is no longer listed)
└─ Chats
```

- **A Board sits at the same level as a chat.** The sidebar's Boards group sits beside
  the machine and chat groups. Board rows have the same height, selected state and
  status mark as session rows. The group's "+" creates a Board, the same action as a
  project group's "+" starting a chat. PR1's Boards navigation item and the `/boards`
  list page are removed; archived Boards go to the Archive page.
- **The coordinator is the Board's own conversation.** It is no longer listed in the
  session groups. Its metadata does not change; the lists only filter out
  `boardRole === 'coordinator'`.
- **A Board's conversations stay in the Board.** Threads remain ordinary sessions with
  real directories and worktrees, but neither the coordinator nor the threads appear
  in the sidebar's chat and project groups, the mobile home or the Archive page; the
  Board panel lists them. A project-bound thread shows "machine · project" at the top
  right of its conversation. This overturns decision 1 below (see "Board home, second
  round").
- **Projects and Boards.** A project is still a repository or local folder. A Board
  refers to some projects through its project scope but does not own them.

### Layout

Desktop (≥ 1024px) has three columns:
- Left: the sidebar.
- Centre: the coordinator conversation. Its header shows the Board icon, the name, a
  scope badge (only when the Board is narrowed to chosen projects), the panel toggle
  and ⚙.
- Right: a 420px panel.

The panel has four states: closed, threads, files, one thread.

- **Threads tab.** Threads are grouped. Empty groups are not drawn, and Archived is
  folded by default. Each row shows:
  - a status mark, only for needs-you, failed, stopped and running;
  - the title and a time;
  - a second line with the latest conclusion already read, or agent · machine ·
    project when none has been read.

  Clicking a row opens the thread in the panel. It shows a breadcrumb "← Threads ›
  title", the thread's own conversation and composer, Open as a full conversation,
  and Close. The coordinator's own Tabs and Side Chats are already mounted by the
  session page, so their rows switch to that Tab instead: one composer per session.
- **Board files tab.** A fixed Shared notes row on top opens the existing notes editor;
  below it is the Board's shared directory (see "Board context › Shared directory").
  On a Board page the session side panel's own Files is named Workspace files, so the
  two no longer share a name.
- **Settings.** ⚙ opens the Board settings dialog; it does not use the side panel.
- **While the panel is closed**, its toggle reads "✋ N waiting for you". While the
  panel is open, the count is not repeated.

Narrow windows (< 1024px, including 390px):
- The coordinator conversation fills the screen.
- The panel covers the conversation; closing it returns there.
- Opening a thread pushes the full session page through the existing mobile
  navigation. The panel does not hold a second composer.

The implementation reuses existing pages:
- The centre is the existing session page (`session-detail.tsx`) of the coordinator.
- The right panel is a new session side-panel kind, `board`. It keeps
  `DesktopSessionDetailLayout`'s behavior: a resizable panel on desktop, an overlay on
  compact desktop, and a Drawer on mobile.
- Viewing a thread in the panel follows how Side Chat renders `SessionChatInterface`
  in the side panel.
- `/boards/$boardId` becomes an alias: it resolves the coordinator id and opens that
  session page with the `board` panel. Like the sidebar and the command palette, it
  selects the coordinator's own Tab explicitly instead of restoring the last child
  Tab. The command palette shows a coordinator as its Board.

### What stays out, what goes into settings

| Out (frequent)                         | Why                                                       |
| -------------------------------------- | --------------------------------------------------------- |
| Sidebar Board rows and status marks    | A Board opens like a chat; state is visible at a glance   |
| Coordinator conversation and composer  | The most common action: ask the coordinator, read reports |
| Thread list (Needs you first)          | Next most common: who waits for me; go in and steer       |
| A thread open in the panel, with its composer | Steer without leaving the coordinator              |
| Files tab                              | Threads and the user read and write notes and files often |
| New thread "+"                         | The same level as a chat's "+"                           |
| Rename, share and archive the Board    | Where a chat has them: the header "…" menu and its sidebar row |
| Scope badge (only when narrowed)       | Says which projects the Board uses; nothing for "all"     |

| Settings dialog (rare)                                        | Why                              |
| ------------------------------------------------------------- | -------------------------------- |
| Name, goal                                                    | Written once at creation         |
| Project scope                                                 | Chosen at creation, rarely changed |
| Board memory (switch, preview, edit, nmem space)              | Maintained automatically; checked occasionally |
| Coordinator agent                                             | Rarely changed                   |
| Rounds per thread, reporting human turns, executor instructions | Rules, set once                |
| Daily digest switch and time                                  | Set once                         |
| Archive Board                                                 | Destructive                      |

These are not shown anywhere persistently:
- Chain n/16: it appears in the conversation only at the limit, through the existing
  `board_chain_limit` notice.
- Rounds n/limit: PR4's rejection explains it.
- Agent and machine: shown on a thread's second line while no conclusion is known.

### Creating a Board

The dialog asks only what the first message needs:
- Goal: required and focused.
- Name: optional; defaults to the goal's first line.
- Coordinator: the existing machine + agent or Agent Role controls.
- Project scope: all projects by default.

Rules, memory and the digest start from defaults and change later in settings.

The clipped focus ring the user reported is fixed. The form is a scroll container,
which clipped the ring drawn outside each field. The fix gives the scroller an inset
padding and offsets it with a negative margin (`board-view.tsx`, `boardStyles.form`).

### Board context

| Part         | Built on                                                         | New                                              |
| ------------ | ---------------------------------------------------------------- | ------------------------------------------------ |
| Project scope | The Board row; none chosen = all                                | `BoardMeta.context.projects?: BoardProjectRef[]` |
| Shared directory | The data directory of the host (the coordinator's machine at creation) | `BoardMeta.files: { machineId }`     |
| Board memory | Instructions on the Board row, given to every member; automatic memory in the directory's `memory/`; optionally mirrored to an nmem space | `BoardMeta.instructions`; `BoardMeta.memory?` |

**Project scope**

```ts
type BoardProjectRef =
  | {
      kind: 'local';
      machineId: MachineId;
      localProjectId: LocalProjectId;
      name: string;
      githubRepoFullName?: string;
    }
  | { kind: 'github'; repoFullName: string };
// BoardMeta.context?: { projects?: BoardProjectRef[] }; absent = all
```

A local project id is a hash of its path on one machine, so the same repository has a
different id on each machine. The scope therefore stores `machineId + localProjectId`
pairs, matching `getLocalProjectVisibilityKey`. A name and an optional GitHub
repository name are stored for display and as a cross-machine hint.

The scope is used in four places:
1. Coordinator and thread startup instructions list the projects in scope (name,
   machine, path).
2. `lody_board_get` returns the scope.
3. When a Board member calls `lody_session_create`, a work context outside the scope
   is rejected with `BOARD_PROJECT_OUT_OF_SCOPE`. Chat is unrestricted.
4. The project picker under "+ New thread" lists only projects in scope.

When the scope is empty (all projects), none of this applies; the instructions only
say that `lody_project_list` lists every project.

**Shared directory**

- **Location.** On the host, the machine the coordinator ran on when the Board was
  created: `<data directory>/boards/<workspaceId>/<boardId>/files/`. The data
  directory comes from `getLodyDataDir()` (`~/.lody-oss` on the local platform) and is
  split by workspace like `session-files/<workspaceId>/…`. The directory is named by
  Board id, not name, so renaming a Board moves nothing.
- **Record.** The Board row stores `files: { machineId }`. The host derives the path
  itself; the row does not store it. The host daemon creates the directory on the
  first listing or write.
- **Why the coordinator's machine.** The coordinator is the one fixed member, and its
  machine must be online for reports anyway, so the directory is available exactly
  when the Board is. If the coordinator later moves, the host stays: the row stores a
  machine, not a session. While the host is offline the directory cannot be read;
  the UI and tools say so, and nothing is cached elsewhere.
- **Members on the host.** The startup instructions give the absolute path, and the
  agent uses its own file tools without going through Lody.
- **Members on other machines.** New Board tools:
  - `lody_board_files_list`: list the shared directory;
  - `lody_board_files_read({ name, saveTo })`: copy a file to a path in the caller's
    workspace;
  - `lody_board_files_write({ path, name? })`: put a file from the caller's workspace
    into the shared directory.

  In the daemon these use the LAN's existing `files` connection: reads use the
  existing `range`; two verbs are added, `list` and `put`, where `put` reuses the
  attachment handoff's announce / ready / bytes / sha256 handshake. Authorization is
  by `boardId`: the caller must be a Board member and the path must stay inside the
  Board directory. The new verbs are announced by the capability key
  `lanBoardFiles`, so older members never receive them. `lody-lan lan shell` is not
  used: the Codex sandbox blocks it, binaries would need base64 over a PTY, and it
  cannot be authorized per Board.
- **Files tab.** A new `BoardDirectoryFileProvider`, built on
  `LazyDirectoryFileProvider` after `LocalProjectRpcFileProvider`, feeds the existing
  `ProjectFileBrowser` and file tree. Previews use the existing `file/preview` and
  member file resources (media, large downloads). Dropping a file onto the tab is a
  `put` on the host.
- **Shared notes.** They stay a LoroText rather than becoming `notes.md` in the
  directory. They already sync across machines and merge offline edits; the three
  existing tools and the capacity rules stay unchanged, and no data moves. The
  directory holds arbitrary files; the notes hold the text everyone appends to.

**Board memory**

**Changed (second round):** memory has two parts, neither in a LoroText of the
Board document.
- **Instructions:** the user's `BoardMeta.instructions` (≤ 16,000 characters), edited on
  the settings dialog's Memory page, appended to every member's first message
  (coordinator included) in `buildPrompt`'s Board section; an edit reaches sessions
  started afterwards.
- **Automatic memory:** `memory/` in the shared directory, `MEMORY.md` as the index and
  one file per memory. Agents learn where it is from their instructions and read and
  write it themselves; the coordinator maintains the index. The Memory page lists the
  files (name, update time) and previews them. There is no `lody_board_memory_update`:
  the directory tools serve both.

Optionally, the memory is mirrored to Nowledge Mem:
- The existing memory provider does one thing: it injects `NMEM_AGENT_ID` at ACP
  start (`apps/cli/src/lib/memory-providers.ts`). A `memoryId` is an agent identity on
  one machine, not a shared store, so it cannot serve as Board memory by itself.
- nmem shares memory through spaces. The local `nmem` binary contains the variable
  name `NMEM_SPACE_ID`; its meaning still needs testing.
- The plan:
  - The Board row gains `BoardMeta.memory?: { providerId: 'nowledge-mem'; spaceId: string }`.
  - Each Board member turn freezes it into `inputConfig`, like Role memory, so it is
    part of the preparation compatibility key; forks and restores read the frozen
    value.
  - The daemon then injects `NMEM_SPACE_ID` at ACP start.
- The agent identity still comes from the Role instance. The two variables do not
  conflict, so no precedence rule is needed.
- This requires every member machine's nmem to talk to the same Mem server. Settings
  mark machines that cannot reach it; they still run.
- It changes `MemoryBindingSchema` (which is `.strict()`) or adds a field, which is a
  provider contract change. That is why it is the last step (decision 5).

### Connection to the existing foundation

Carried over, unchanged:
- membership fields and their inheritance;
- the body of the coordinator and thread instructions;
- PR3 reports and Inbox batching and waking;
- status derivation by `deriveBoardSessionStatus` (table below);
- the compact report rows in the conversation;
- the notes LoroText and its capacity rules;
- how MCP tools are authorized;
- PR4 rounds and handoff, and the PR5 daily digest.

| State | Source |
| --- | --- |
| Running / Starting / Finalizing | Presence (`sessionLiveStatusAtomFamily`), never durable `SessionMeta.status` |
| Waiting for you | Presence `requestPermission`, or no live status and `awaitingUserSince` newer than `lastMessageAt` |
| Stopped | `collaborationStopped` on the session or an ancestor |
| Failed | Current generation's latest driving turn failed or same-turn `chat_failed` |
| Cancelled | Current generation's latest driving turn `canceled` |
| Idle · waiting for coordinator | Idle and latest driving turn not authored by a human |
| Idle | Otherwise |

Grouping (`boardThreadGroup`): waiting for you, failed and stopped go to Needs you;
running, starting and finalizing go to Working; everything else goes to Idle;
archived threads form their own group.

In the coordinator conversation, reports remain upstream's
`operation_completion_batch` system turn. `board_report` members render as compact
task rows, one event per row, with no second kind of card.

Changed:
- **Navigation.** Remove the Boards navigation item and the `/boards` list page; add
  the sidebar Boards group; make `/boards/$boardId` an alias for the coordinator's
  session page; filter the coordinator out of the sidebar session lists.
- **Overview.** The read-only `BoardsWorkspace` page is replaced by the `board` side
  panel. Thread rows use metadata and presence only and never read member
  documents; the second line shows agent · machine · project. Failed therefore does
  not appear in the list: it shows once the thread is opened, and the coordinator
  receives the failure report. A latest-conclusion line comes later.
- **Settings.** Name, goal and rules are edited in the dialog ⚙ opens; saving writes
  the Board row.
- **Create dialog.** Goal first, name optional (defaults to the goal's first line), no
  rule fields; the project scope joins with step 3.
- **Board row and document.** The row gains `context`, `files` and an optional
  `memory`. The document gains `memory`.
- **Instructions.** Coordinator and thread instructions each gain a project-scope
  section and a Board-memory section.
- **MCP.** Add `lody_board_files_list/read/write` and `lody_board_memory_update`. Add
  the scope check to `lody_session_create`. The notes tools do not change.

### Implementation steps

Each step merges on its own; the order is the dependency order.

1. **UI shell (implemented).** Existing data only.
   - Contents: the sidebar Boards group; the `board` side-panel kind (Threads and
     Files tabs, a thread in the panel); filter out the coordinator; remove the
     navigation item and list page; the `/boards/$boardId` alias; archived Boards on
     the Archive page. In this step the Files tab holds the shared notes and a
     placeholder for the shared directory.
2. **Settings dialog and create dialog (implemented).** The settings dialog writes the
   Board row (name, goal, rules) and archives the Board; the new create dialog
   replaces the old one. Project scope, memory and the daily digest stay hidden until
   their steps land.
3. **Project scope.** `BoardMeta.context`, the instruction section, `lody_board_get`
   output, the `lody_session_create` scope check, project filtering for new threads,
   and the choice in the settings and create dialogs.
   - Modules: `packages/shared/src/board.ts`,
     `apps/cli/src/session/session-execution-helpers.ts`,
     `apps/cli/src/mcp/lody-mcp-server.ts`, `components/boards/*`.
4. **Shared directory (implemented).** `BoardMeta.files`, the directory on the host, `list` / `put`
   on the `files` connection (`lanBoardFiles`), `lody_board_files_list/read/write`,
   the path in the instructions, and `BoardDirectoryFileProvider` for the Files tab.
   - Modules: the data directory and capability key in `packages/shared`,
     `apps/cli/src/lib/lan/lan-files.ts` and `lan-file-handoff.ts`,
     `apps/cli/src/mcp/board-tools.ts`, `components/boards/*`, and a file provider
     under `lib/`.
5. **Board memory (implemented, plan changed).** Instructions on the Board row,
   injected into first messages; automatic memory in the directory's `memory/` (see
   "Board context › Board memory"). Digest tidying comes with PR5.
6. **Optional: nmem space mirror.** `BoardMeta.memory`, freezing into turns,
   `NMEM_SPACE_ID` injection, and an update to the provider contract in
   `specs/agent-role-memory.md`.

PR4 (rounds, handoff) and PR5 (daily digest) are independent of these steps and keep
their plan.

### Decided

On 2026-10-16 the user confirmed the questions of the first round, changing two of
the recommendations:

1. Threads are not hidden from machine and project groups; only the coordinator is.
   This changes decision 6 of "Decided".
2. A Board is created only from the "+" on the sidebar Boards group; the landing page
   is unchanged.
3. The `/boards` list page is removed; the sidebar is the list, and archived Boards go
   to the Archive page.
4. The project scope is enforced: `lody_session_create` outside it is rejected; chat
   is unrestricted.
5. Board memory is mainly Lody's own text, with an nmem space as an optional mirror,
   after testing `NMEM_SPACE_ID`.
6. **Changed:** shared files become a real directory on disk holding any kind of
   file, not only text. The former `files` container in the Board document is
   dropped. See "Board context › Shared directory".
7. Opening a thread on a narrow screen pushes the full session page.
8. **Changed:** settings are a dialog, not part of the side panel; the side panel has
   only the Threads and Files tabs.

After using the dev build, the user settled a second round on 2026-10-16 (implemented
in "Board home, second round"):

9. **Changed (overturns 1):** neither the coordinator nor the threads appear in
   outside lists (sidebar chat and project groups, mobile home, Archive page); they are
   seen only in the Board. The command palette shows "Board › thread" and opens it in
   the panel through the Board entry.
10. The goal is optional; a new Board needs only a name, and nothing is sent to the
    coordinator.
11. A Board opens with the conversation and the panel at half each; the settings
    button sits at the top right of the conversation.
12. The settings dialog has section navigation on the start and the content on the end:
    General (name, goal, rules, archive) and Memory (instructions, automatic memory).
    Files stay in the side panel's Files tab, which shows the directory's `files/`;
    the shared notes remain one of its rows.
13. The shared directory and automatic memory are done in this round (former steps 4
    and 5).
14. The conversation only coordinates, delegating concrete work to threads and keeping
    the whole picture; sessions a thread opens stay under it, indented in the panel.

On 2026-10-17 the user reported that a Board offered "nothing to act on" and asked for
the same top-right actions a chat has, at least archive and share (implemented in
"Board entry actions"):

15. The Board page's header keeps the chat header's "…" menu and share control beside the
    settings gear; the sidebar Board row is a chat row's twin, with ⋯ and Archive on
    hover and the same menu on right click. Rename, archive and restore act on the whole
    Board; share shares the coordinator's conversation.

## Shared notes

Overview provides Markdown textarea/preview, reusing plan-review rendering and
saving to LoroText. Tools: get all notes; append a section with optional heading
(default date + session title); replace all notes. Members append; coordinator and
human can replace. Concurrent append during replace may land at the end, which is
acceptable; no content is intentionally discarded.

Lody does not call nmem. Board notes are visible, local-to-the-Board work records;
agents own durable-memory writes with their own tools. The existing memory Provider
only handles identity/environment, not recall/save, and is not extended. Shared
folders require a separate multi-machine sync design and are deferred. (The
2026-10-16 redesign replaces this with Board memory, an optional nmem space mirror,
and a shared directory on the host; see "Board home › Board context".)

## Daily digest

The Board setting uses the existing Schedule command service to create one daily
cron (selectable time, default 04:00 Asia/Tokyo). Destination is `existing_session`
with the coordinator id. A fixed prompt reads Overview/notes, appends the day's
progress, conclusions and unresolved work, and saves it to nmem. Store
`digestScheduleId`; disable/archive pauses the schedule.

The coordinator already has Board tools, so no Schedule schema extension is needed. A
scheduled turn has depth 0 and enters the Inbox as a `task` input: it carries the
results queued at that moment at depth 0, so the autonomous chain restarts once a day.
The trade-off is one extra daily turn in coordinator context.

The digest must respect stop and pause:

- A scheduled turn has no human receipt (`humanInputReceipts`), so the Inbox admits it
  as `task`; while the coordinator is paused, `inputAcceptance('task', paused)` refuses
  it (`inbox-paused` in `session-execution-service.ts`) and the pause is not cleared.
  PR5 must not forge a human receipt for the digest turn.
- While the coordinator's tree is stopped, dispatch cancels the turn and preserves its
  input; upstream already does this.
- PR5 checks destination pause/stop before handoff and records skipped runs as skipped,
  avoiding refused turns left pending in history. PR3 only records this decision;
  it does not implement the digest.

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
- Chat/chat_many: follow-up flag and the `THREAD_ROUND_LIMIT` / `THREAD_SUPERSEDED`
  refusals. Upstream's `COLLABORATION_STOPPED`, `CHAIN_DEPTH_EXCEEDED` and
  `REVERSE_CHAT_FORBIDDEN` apply unchanged and run first.
- Session list: `boardId` filter, accepting `'current'`.
- Operation get/list: additional `board_report` kind; `lody_operation_batch_get` is
  unchanged and pages Board members like ordinary ones.

Existing Role/Schedule permission-tier ceilings stay unchanged. Board tools write
only Lody-owned data.

## Implementation steps

Each step should merge and validate independently, in dependency order. PR1 and PR2
are implemented (records at the end); only their differences from the new mechanisms
are listed.

### PR1 Boards, membership and read-only Overview — implemented

- See "PR1 implemented". Differences from this revision: the chain limit shown in
  Overview is 16 (the `/32` copy changes with PR3); the status helper's "latest user
  turn" becomes "latest driving turn" with PR3.

### PR2 Coordinator instructions, Board tools and notes — implemented

- See "PR2 implemented". Differences: the placeholder "reports are not implemented,
  report explicitly" text is replaced by the coordinator/thread instructions above with
  PR3; there is no automatic-review copy.

### PR3 Inbox-based automatic reports

- `packages/shared`: `LodyOperationKind` gains `board_report` and `OperationResultSchema`
  gains optional `boardReport` (`BoardReportEventSchema`, one event per Operation) in
  `session-orchestration.ts`; `schema.ts` gains `boardJoinedAtMs`; `board.ts` gains pure
  functions `readLatestDrivingTurn`, event derivation and `boardReportOperationId`.
- `apps/cli/src/orchestration/operation-store.ts`: `board_report_cursors` table;
  `acceptBoardReport()` (finished Operation + `inbox.indexCompletion()` + cursor in one
  `BEGIN IMMEDIATE`); `boardCoveredTargets()` (targets of `operations` in any state);
  `MemberRow.operation_kind` in `inbox/sqlite.ts` accepts `board_report`.
- `apps/cli/src/orchestration/coordinator-workflow.ts` / `operation-coordinator.ts`:
  the Board branch (catalog and `doc-metadata` subscriptions, dirty member set,
  single-flight reconcile, event derivation, dedupe, acceptance); query `depth_limited`
  intents here and write the idempotent chain-limit notice. `operation-model.ts` stays untouched unless scheduling semantics change.
- `apps/cli/src/mcp/lody-mcp-server.ts`: `lody_operation_get/list` accept the kind.
- `session-execution-helpers.ts` `buildPrompt`: coordinator/thread instructions from
  this revision.
- `packages/components`: `OperationCompletionView` branch for `board_report` (compact
  rows plus two labels); coordinator row `chain n/16` and Stopped; `boards/AGENTS.md`;
  locales.
- Tests (injected clocks, real Mirror / `repo.watch` subscriptions, explicit reconcile
  barriers, in `operation-coordinator.test.ts` and `operation-store.test.ts`): busy
  accumulation then one batch after release; human input carries queued results at
  depth 0; no intent while paused and the next human input carries them; a stopped tree
  launches no batch; a member stopped by the user yields no event; grandchild
  `waiting_user` arrives; receipt-coverage dedupe including finished retained
  Operations; `reportHumanTurns` on, and cursor advance while off; a system-driven
  (continuation) completion reports; repeated permission requests in one driving turn
  report once; depth 15 → 16 yields `depth_limited`; results and intents survive
  restart; an injected cursor write failure rolls back everything; archived members are
  skipped; state before `boardJoinedAtMs` is not reported; streaming imports do not
  trigger full scans (subscription counting); a grandchild `finished` produces no
  report, while its parent's subsequent continuation completion does.

### PR4 Rounds and handoff

- Shared round derivation (agent-authored user turns minus `followUp`; human and
  system-driven turns excluded) and `inputConfig.boardFollowUp`.
- MCP: the two chat refusals after upstream's three; `lody_board_thread_handoff`
  (`--parent` path, handoff facts, `boardGeneration`, refused when the root is stopped).
- Overview rounds and generations.
- Tests: history → rounds (follow-up, human input, Inbox batch turns); refusal order;
  successor Tab shares the directory and inherits run config; handoff refused on a
  stopped root; `THREAD_SUPERSEDED` on an old generation.

### PR5 Daily digest and completion

- Board toggle creates/pauses a Schedule (`schedule-command-service.ts`) targeting the
  coordinator as `existing_session`, with the fixed prompt; archiving pauses it.
- Pause and stop: no human receipt for the digest turn; before handoff, add a
  Board-agnostic "destination paused/stopped → skipped" check beside the destination
  checks in `schedule-run-preparation.ts`.
- Documentation: a Boards section in `.agents/docs/experimental.md`, Spec evidence, the
  Agent Note, and a Board reports section in `apps/cli/src/orchestration/README.md`.
- Tests: the definition the command service creates (cron, destination, prompt); toggle
  off pauses; a digest turn into a paused coordinator neither clears the pause nor
  runs; into a stopped tree it is cancelled with input preserved.
- Exercise a real LAN with coordinator and threads on different members: reports,
  handoff, notes and Stop.

## Risks

- Many threads may wake the coordinator at every idle boundary. Inbox batching,
  excluding human completions and not reporting grandchild completions reduce this; a
  minimum wake interval may be needed later.
- Fifteen autonomous wakes may stop overnight work, and upstream writes nothing to
  history at the cap. Show it in Overview and the idempotent system notice before adding a budget.
- An `unknown` batch settlement is never resent upstream, so the coordinator may miss a
  batch; Overview is the truth, and the digest or next wake catches up.
- Inbox pause has no synced evidence, so Overview cannot show a stopped coordinator.
- Expanded rows acquire session documents; keep the 100-thread view bounded and expand few.
- Replace racing with append can move appended notes to the end.
- Older clients ignore unknown Board rows and `boardId` / `boardJoinedAtMs`; reports
  exist only on the coordinator's machine, which must run a build with Inbox v2 and
  the `board_report` kind.
- Codex may need stronger coordination discipline in practice, but creation does not
  prohibit any agent and prompts do not special-case it.

## Decided

The user confirmed these eight choices (item 3 revised for upstream 0.105.0); the
complete specification remains a draft.

1. Name: **Board / 看板**, not Project.
2. Human thread completion does not wake the coordinator by default; Overview and
   digest still include it. Each Board may enable `reportHumanTurns`.
3. The delegation chain cap follows upstream `LODY_MAX_CHAIN_DEPTH = 16`, with no
   separate Board budget; Overview shows depth and limit.
4. Successors are child Tabs of the thread root and share its worktree.
5. Send the daily digest directly into the coordinator session.
6. First release adds Board navigation/pages without sidebar regrouping. (Superseded by "Board home › Decided" 1–3: the sidebar has a Boards group, the navigation item is gone, threads stay in project groups.)
7. Default four rounds, counting agent-authored user turns, excluding follow-up.
8. Do not require Claude; remember the last coordinator choice.

Also settled: automatic review was removed upstream, so the design has no
`THREAD_UNDER_AUTO_REVIEW`, auto-review protection or related state; cross review uses
ordinary reviewer child sessions. Upstream's global delegation prompt (`adff308b`) is not
merged; the coordinator's working method lives only in the Board prompt.

## Decided: Inbox revision

The user confirmed these six choices; the complete specification remains a draft.

1. Report depth is the coordinator's driving-turn depth at observation time (option B). Each autonomous wake adds one hop, human input resets the chain, and grandchild events cost no extra hops.
2. Grandchild (reviewer) `finished` is not reported separately; its parent includes the conclusion after its own wake. `failed` / `waiting_user` / `notice` still report. Thread instructions require verbatim child conclusions in the reply and no changes based on them; the coordinator decides what to change.
3. Do not report `cancelled`; show it only in Overview so reports cannot bypass the user Stop no-wake rule.
4. At chain depth 16, write one idempotent `board_chain_limit` system notice per chain asking the user to send a message to continue; Overview shows Stopped.
5. Check digest destinations for pause/stop before handoff and record skipped runs as skipped (option A). PR5 implements it; PR3 only updates the documentation.
6. No Board-level stop in the first release (option A). Keep conversation-tree stop; independently joined roots are outside it. Stop all Board members is deferred to Later.

## Later

Board sidebar grouping/hiding members from other groups; split Overview/coordinator
conversation; synced folders; context-usage-based handoff hints; Board wake intervals
or budgets; Board-level stop; mobile report push through the existing notify path;
Board templates. "Board home" adds the sidebar Boards group (threads stay in their
groups, decision 1) and makes the coordinator conversation and the Board panel one
split view.

## Evidence

Intent: this document. Inspected implementation (design basis, unchanged):

- Inbox and receipts: `apps/cli/src/orchestration/inbox/model.ts` (`batchDepth`,
  `batchPreview`), `inbox/sqlite.ts` (`indexCompletion`, `requestAutomatic`, the 16-hop
  check in `prepare`, `accept`, `pause`, `release`, `cleanupExpired`), `inbox/rules.ts`
  (`operationInboxCompletion`, `user_stop`), `inbox/service.ts`, `operation-store.ts`
  (`finish`, retired ids), `coordinator-workflow.ts` (`reconcileItem`,
  `writeOperationProgress`), `operation-coordinator.ts` (`launchInboxBatch`),
  `apps/cli/src/orchestration/AGENTS.md` and `README.md`, `specs/session-orchestration.md`.
- Stop and pause: `packages/shared/src/session-operation-targets.ts`
  (`readSessionOperationTargets`, `isSessionCollaborationStopped`),
  `apps/cli/src/session/session-execution-service.ts` (`cancelSession`,
  `reconcileCollaborationStops`, `acceptInboxHumanInput`, `inbox-paused`),
  `apps/cli/src/lib/message-handler.ts` (`collaborationStopped` watch),
  `packages/components/src/hooks/use-session-actions.ts` (`setTreeCollaborationStopped`).
- Chain and reverse chat: `packages/shared/src/session-orchestration.ts`
  (`LODY_MAX_CHAIN_DEPTH`), `apps/cli/src/mcp/lody-mcp-server.ts`
  (`resolveInvokingTurnContext`, `reverseChatError`, `readInvokingChatSender`).
- Prompt assembly: `apps/cli/src/session/session-execution-helpers.ts` (`buildPrompt`),
  `apps/cli/src/commands/session.ts` (`prepareSessionInput`, `resolveCreateContext`,
  `assertSupportedParentDepth`), `apps/cli/src/lib/lan/lan-session-command.ts`,
  `apps/cli/src/mcp/lody-mcp-http-protocol.ts`, `agent-surface-tools.ts`.
- Status signals: `apps/cli/src/lib/message-handler.ts` (`finalizeACPState`, permission
  requests writing `awaitingUserSince`), `apps/cli/src/lib/agent-notice.ts`,
  `packages/shared/src/schema.ts` (`SessionMeta`, `cancelRequest`,
  `getPendingUserTurnActivationId`), `packages/shared/src/presence.ts`.
- Schedules: `apps/cli/src/lib/schedules/schedule-run-preparation.ts`
  (`existing_session`), `schedule-command-service.ts`, `apps/cli/src/lib/schedules/AGENTS.md`.
- Workspace documents and sync: `packages/shared/src/workspace-flock.ts`,
  `schedule-repository.ts`, `schedule-registry.ts`, `.agents/docs/lan.md`,
  `.agents/docs/workspace-catalog-durability.md`, `.claude/skills/lody-loro-sync-stack/SKILL.md`.
- UI: `packages/components/src/routes/$workspaceName/_auth/`, `loro-app-sidebar.tsx`,
  `atoms/doc-meta.ts`, `atoms/presence.ts`, `components/archive/`, `components/schedules/`,
  `components/boards/`, `components/ai-gui/view.tsx` (`OperationCompletionBatchView`),
  `components/ai-gui/created-session-list.tsx`, `.agents/docs/sessions-live-status.md`,
  `.agents/docs/experimental.md`.
- Relations and lifecycle: `specs/session-relations.md`,
  `specs/session-worktree-lifecycle.md`, `specs/agent-role-memory.md`.
- The old PR3 implementation `08c5c26e0` (built on the removed Delivery; reference only)
  and its review findings.
- Redesign (2026-10-16; read-only inspection, foundation unchanged):
  `apps/cli/src/lib/memory-providers.ts` (`environment` injects only `NMEM_AGENT_ID`),
  `packages/shared/src/memory-provider.ts` (strict `MemoryBindingSchema`),
  `apps/cli/src/session/session.ts` (injection at ACP start),
  `session-execution-service.ts` (a changed binding restarts the process),
  `packages/shared/src/project.ts` (`ProjectRef`),
  `packages/shared/src/node/local-project.ts` (a local project id hashes its path),
  `components/chat/unified-project-selector.tsx`, `lib/visible-local-project-index.ts`,
  `components/loro-sidebar.tsx`, `components/sessions/desktop-session-detail-layout.tsx`
  and `session-side-panel-tab-bar.tsx`. The local `nmem` binary contains
  `NMEM_SPACE_ID` (meaning untested). Prototype:
  `components/boards/board-{home-view,thread-list,files-view,settings-panel,sidebar-section,create-dialog-view}.tsx`
  and the prototype story of that round, checked in Storybook screenshots at 1440px
  and 390px.

## PR1 implemented

PR1 implements Board rows, three membership fields, CLI/MCP and UI child inheritance,
list filtering, experiment, creation, desktop/mobile entry and read-only Overview.
See the [PR1 Agent Note](../../.agents/notes/implemented/feature/2026-10-15-board-overview.md).
At the end of PR1, PR2–PR5 remained intent. Overview's **New thread** and the session
menu's **Join board / Remove from board** are not part of PR1; they are assigned to PR2.

Adjustments to the original file plan: UI creation bypasses CLI preparation, so
both paths in `session-submission.ts` also inherit membership. Reuse the shared
catalog room. Collapsed threads display only presence/meta facts; expansion adds
failure/waiting-coordinator facts and message previews. The coordinator starts
expanded to show chain depth. Rounds and generation switching remain PR4.
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

## PR3 implemented

PR3 now uses the upstream Operation Inbox. Catalog/metadata and history subscriptions
mark affected members dirty; the native coordinator reconciles ordinary Operations
before deriving and accepting Board events. Each event is a finished `board_report`
Operation, committed with its Inbox index and member cursor. Busy accumulation, human
priority, pause, stop and batching retain upstream semantics. Grandchild completion
returns through its parent's continuation reply; waiting, failure and notices still
report. Thread startup instructions require verbatim child conclusions and leave
change decisions to the coordinator.

The upstream execution writer saves `invocation.inputConfig` only for automatic `inbox:completion:*` turns and places each batch before its assistant turn; human-attached `operation-batch:*` rows carry no configuration, preserving driving-turn selection, continuation reports and chain depth. The history message schema also accepts `board_report` so real batches pass write validation.

Minimal adjustments to the design notation: source identities hash to `board-` plus
the first 58 SHA-256 hex characters to fit the existing Operation ID contract. Finished
rows retain the required `deadlineAt` field, set to creation time, without deadline
scheduling. Cursors add `last_awaiting_turn_id` so one wait report per turn depends on
identity, not timestamp precision. Shallow history directories expose system input
configuration and `chainDepth`, selecting continuation work without reading the full
transcript. A cohesive module is called by the existing native coordinator; there is
no additional scheduling loop.

Limit notices observe actual `depth_limited` intents. The claim check retains its
watermark for observation without changing admission or depth calculation. Notices
are history-only and idempotent per driving turn; fresh human input makes old notices
inactive in Overview. The coordinator row reads its latest driving depth and its own
or inherited collaboration stop. Batch reports reuse compact task rows, navigation and
live titles, with waiting/notice labels. PR4/PR5 remain unimplemented and startup
instructions do not promise round refusal, handoff or digests.

Implementation and validation: [PR3 Agent Note](../../.agents/notes/implemented/feature/2026-10-16-board-inbox-reports.md).

## Board home implemented

Steps 1 and 2 are implemented:

- **Sidebar.** The Boards section sits after Pinned and shows in both organize modes.
  A Board row carries its members' strongest state (waiting > working), computed from
  the presence map the sidebar already builds, with no new subscription. The "+" on
  its header opens the create dialog.
- **Coordinators stay out of session lists.** The sidebar, the mobile home and the
  Archive page each drop coordinators at their own source; shared atoms are untouched.
- **Board panel.** The session side panel gains the `board` kind, offered only on a
  coordinator's page and persisted like the other panels. A thread opens in the panel
  as a `SessionChatInterface` whose workspace session is the thread itself; the
  coordinator's Tabs and Side Chats switch in the page instead. Panel state is rebuilt
  per workspace and Board id, so switching Boards never carries a settings draft
  over. On compact
  desktop and phones a thread opens its own full page; on phones the full-screen Board
  drawer opens from the session's tab sheet.
- **Addresses.** `?board=1` opens the panel once and then leaves the URL;
  `/boards/<id>` redirects to the coordinator; `/boards` redirects to chat. The sidebar,
  `/boards/<id>` and the command palette all select the coordinator's own Tab. PR1's
  navigation item, list page, read-only Overview and mobile Boards tab are removed.
- **Settings dialog.** It writes the Board row (name, goal, rules); a rename also
  renames the coordinator Session. Archiving a Board archives the coordinator and the
  member roots in turn, then writes `archivedAtMs` (members now come first and the
  coordinator after them; see "Board entry actions"). The Archive page lists archived
  Boards; restoring checks the 50-Board limit in the catalog writer, restores each
  root, and clears `archivedAtMs` last. A failure shows its reason and leaves the Board
  where it was, to retry.
- **Create dialog.** Goal first, optional name, default rules.
- **Board files tab.** The shared notes, plus a note saying where the shared directory
  will come. The page's session Files panel is named Workspace files.

Deviation from the design: thread rows never read member documents, so Failed does
not appear in the list (see "Connection to the existing foundation"). PR1–3
foundation logic is unchanged; the only shared additions are the session route's
`board` search parameter and the `board` value in the persisted side-panel schema.

Not verified: the real desktop app (devnuc has no display; the real components were
checked in Storybook), the phone drawer's gestures, and behavior across LAN machines.
Implementation and checks:
[Board home Agent Note](../../.agents/notes/implemented/feature/2026-10-16-board-home.md).

## Board home, second round implemented

Decisions 9–14:

- **Outside lists.** The sidebar, mobile home and Archive page each drop Board
  conversations at their source with `isBoardSession`: coordinators always, threads
  while the Boards experiment is on (off, threads are ordinary sessions again). Shared
  atoms are untouched. The command palette shows a coordinator as its Board and a
  thread as "Board › thread"; opening it carries `boardThread` and opens it in the
  panel (its own page on narrow windows).
- **Creation.** Name required, goal optional; the coordinator comes from
  `createSession` with no first message. The chosen model and other run config wait as
  a run-config draft in its composer (in memory on this device); a chosen Role comes
  from the session's Role provenance.
- **Page.** A Board page opens half and half every time and remembers no split (see
  "lan.4 field corrections"). The settings button sits at the right of the conversation header (on phones,
  in the Board drawer's header); the page owns the dialog, whose draft is rebuilt per
  workspace and Board id.
- **Panel.** Threads and Board files tabs. Threads show as families: a thread with the
  sessions it opened and its Tabs, together and indented, under the family's strongest
  state. A thread open in the panel shows "machine · project" at its top right, and so
  does a thread's own page.
- **Shared directory.** The host is `files.machineId`, or the coordinator's machine for
  Boards without it. The directory is `<data dir>/boards/<workspaceId>/<boardId>/{files,memory}/`,
  created by the host's daemon on demand. The host checks against its own replica that
  the caller is a member, and that a path stays in one area, refusing escapes through
  links too. The LAN `files` connection gains `board-list` and `board-put` (capability
  `lanBoardFiles`); reads use `range` with a `boardId`. Three local entries: the MCP
  `lody_board_files_list/read/write`, the desktop's local RPC `board/files-list`, and
  the member file resource desktop previews use (`openMemberFile` with `boardId`). All
  go through the local daemon, which reads its own disk or the LAN.
- **Instructions.** Members on the host get the absolute path, others the tools. The
  coordinator's text now says it only coordinates and keeps the whole picture, reading
  thread progress and conclusions with `lody_board_overview` and `lody_session_history`
  (enough as they are; no new Board tool). The user's instructions come last.
- **Foundation changes.** `BoardMeta.purpose` may be empty; `instructions` and `files`
  are new; `range` gains an optional `boardId`; a local RPC method and a capability key
  are new. Membership, coordinator/thread roles, Inbox reports and status derivation
  are unchanged.

Not verified: the real desktop app and real multi-machine LAN reads and writes (LAN
reads and writes are tested between two real TLS daemon endpoints); the full path of a
coordinator started by the user's first message is confirmed from code only
(`session/create`).

## Board home, second-round review corrections

- **Local paths.** `saveTo` of `lody_board_files_read` and `source` of
  `lody_board_files_write` follow the attachment workspace rule: after links are
  resolved they must lie in the session working directory the daemon holds (for a chat
  session, its actual working directory), or the call is refused; the source is handed
  on by its resolved real path. An agent cannot use the Board tools to read from or
  write to outside its sandbox or workspace. Where the daemon knows no working
  directory for the session, both tools fail.
- **Directory root.** An area's root is derived from the data directory: every level of
  `boards/<workspaceId>/<boardId>/<area>` is checked with lstat and must be a directory,
  never a link; every existing level of a path inside the area must not be a link
  either, and a leaf that is a link is refused. Leaves open with `O_NOFOLLOW` (local
  reads and LAN `range` alike). **Known limit:** a parent replaced between the check
  and the open is not closed off with directory handles. Every machine of a LAN belongs
  to one user and `lody-lan lan shell` already runs commands on the others; this guards
  against agents stepping past their own limits and against mistakes, not against the
  same user swapping directories on the host concurrently.
- **Closing a coordinator's Tab.** A coordinator exists before anyone speaks and has no
  `lastMessageAt`, but it never takes the empty-session delete: closing writes
  `isTabClosed` only, and both the session and the Board entry stay.
- **`boardThread`.** The thread named in the address goes to the Board panel, which
  opens it with the same split as its row: a direct child Tab of the coordinator is
  selected in the main area, a Side Chat in its existing panel tab, and only an
  independent thread opens in the Board panel (its own page on narrow windows). The
  page removes the parameters from the URL first and then hands over, so a thread's
  own page is never replaced by the coordinator's.
- **Binary files.** A file without a preview offers Download through the existing
  `saveMemberFile`; the desktop writes it as it arrives, whatever its size.
- **Settings navigation.** Focus draws only an inset accent ring, no fill; the selected
  fill appears on the current page alone. This is local to the Board dialog; the row
  style the global settings window shares is unchanged (there, focus and hover use the
  same light fill, see the Agent Note).

**Not implemented yet:** dropping files onto the tab does not upload; previews cover text
and pictures only, media does not play, and large files can only be downloaded. (The
file tree came with the "lan.4 field corrections".)

**Known limit: mixed-version clients drop fields on write-back.** Clients from before
the second round (desktop or daemon) strip the `instructions` and `files` they do not
know when they read a Board row, and do not accept a Board without a goal. Once such a
client writes the row (saving settings, a rename included; archiving; restoring), the
instructions are gone and later members no longer receive them; `files.machineId` is
gone too, and the host falls back to the coordinator's machine (the same machine at
creation, so the directory usually stays put). A Board with no goal is invisible to an
older client, and Board tools on an older daemon answer `BOARD_NOT_FOUND`. The code
adds no compatibility: Boards are still behind the experiment, and every client that
can write Boards is required to run the same upgraded version.

## Board lan.4 field corrections

Used on a real five-machine LAN, `dev-v0.105.0-lan.4` needed three fixes:

- **Shared directory unreadable (`BOARD_NOT_FOUND`).** A daemon read the Board row from
  its own replica of the workspace catalog, which it syncs only when something asks. A
  member that had not synced since the Board was made on another machine (mba, in the
  field) did not have the row and failed before the request reached the host. Reading
  a Board row now syncs the catalog first; a failed sync warns and uses the local rows,
  as the Board tools and member start prompts already do.
- **Side panel not at half.** The panel reopened at the width another layout left (a
  chat dragged to 38%), which `board-detail-panels` then remembered. A Board page now
  remembers no split and opens half and half on every entry (sidebar, command palette,
  refresh): another Board or another entry resets the split without remounting the
  page, and reopening widths are kept per layout, so a Board never overwrites the width
  a chat was dragged to.
- **Board files tab.** It is the session Files tree (`FileTreeProviderView`) over
  `BoardDirectoryFileProvider`: the agent service lists the whole area at once (500
  files at most) and the tree builds folders from the paths. Opening a file still uses
  the Board preview (text, pictures, everything else downloads), and the row menu offers
  Download. Past 500 files, a line above the tree says only the first 500 are listed. The shared notes stay the Loro document, one row above the tree, not moved
  to `notes.md`.

## Board entry actions

This implements decision 15. The Board page's header is the chat header
(`SessionHeaderMenu` and the share control), whose menu names Board actions on a
coordinator; the sidebar Board row uses a chat row's leading slot, end-slot Archive
button and right-click menu.

| Chat header action                     | On a Board                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------- |
| Open in new window                     | Kept; it opens the Board page                                                               |
| Machine, repository, branch, path      | Kept; the coordinator's                                                                     |
| Full width, find, copy, share as image | Kept; on the coordinator's conversation                                                     |
| Share (static, LAN, with team)         | Kept; shares the coordinator's conversation through the existing editor                     |
| Fork session                           | Kept; forks an ordinary session from the coordinator's conversation                         |
| Open in IDE                            | Kept; opens the coordinator's working directory                                             |
| Rename                                 | "Rename Board": writes the row's name and the coordinator's title, as settings do           |
| Archive / restore                      | "Archive Board / Restore Board": the Board's archive and restore, not the coordinator alone |
| Delete permanently (when archived)     | Hidden: deleting the coordinator would strand the Board row                                 |
| Change owner                           | Hidden: a Board has no owner of its own                                                     |
| Join / leave Board                     | Already hidden on a coordinator                                                             |

The mobile session menu does the same: with the coordinator's Tab current, rename and
archive act on the Board, and an archived Board offers only restore. The "Rename current
chat" and "Archive current chat" shortcuts act on the Board on the coordinator's Tab.

The sidebar Board row (desktop): on hover the Board glyph becomes ⋯ and the status mark
becomes the two-step Archive button; right click and ⋯ open a menu with Rename Board,
Copy Board URL (the coordinator's link), Share (where publishing is available), Open in
new window (desktop app) and Archive Board. Pin, mark unread and copy branch are left
out: Boards are not pinned, and unread and branches belong to member sessions. The
mobile sidebar has no row menus, as for chats.

Archiving the Board on screen returns to the chat page; a failed archive or restore says
why and leaves the Board where it was. The page's menu offers archive or restore by
whether the coordinator is archived, so the coordinator comes after the members: when a
member fails, the coordinator is untouched and the menu still offers the same action.
Every entry uses `useBoardActions`, which reads the members from the metadata cache when
an action runs, so an entry subscribes to no session list; the settings dialog and the
Archive page use it too. Rename changes only the name of the row as it stands
(`renameWorkspaceBoard`), so instructions, rules or an archive saved elsewhere while the
dialog was open are kept.

Not verified: these menus in the real desktop app (seen in Storybook and component
tests only).
