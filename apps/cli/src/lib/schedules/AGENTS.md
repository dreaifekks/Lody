# Scheduled automation

`CLAUDE.md` is a symlink to this file.

- Encrypted workspaces sync definitions and Registry through the existing protected
  Repo. Generated turns use the ordinary verified-signer execution gate and shared
  userTurnId journal claim. Both handoff and actual start require the definition's
  verified original signer, and manual runs also require the request signer.
  Schedule ownership fields and machine-derived turn signatures never grant that
  authority. [Origin contract](../../../../../.agents/notes/implemented/bug-fix/2026-10-28-e2ee-schedule-origin-authorization.md).
- Schedule definitions live in `schedule-<id>` Loro docs. The workspace `:sr`
  Flock Registry is the execution gate. A definition must match its published
  fingerprint; existence discovery must never republish or enable an orphan.
- `schedule-workspace.ts` owns subscriptions, clock wakeups and target facts;
  `schedule-engine.ts` owns serialized planning and handoff; `schedule-store.ts`
  owns the Host-local SQLite ledger. Cursor advancement and a run intent share
  an IMMEDIATE transaction. Preserve cursor/run ids across restarts.
- Session history goes through `sessionData` (`readSessionHistory` reads,
  `commands.appendTurn` appends missing entries); there is no whole-list rewrite.
- Freeze the task name in `userTurn.scheduleRun`, bound to the exact input id,
  for notification presentation; never infer scheduled execution from Session metadata.
- Freeze PreparedSessionInput before mutation. Its fixed Turn stays prepared until
  latestUserMsgId commits, after which the ordinary watcher owns execution. Never change
  Session/Turn ids, reset status/title, or unwind committed dispatch on retry.

- Disconnected cloud Registry blocks handoff. schedule-sync-gate.ts requires initial
  and current-connection sync; local bypasses only transport, never ownership/config checks.

- Due runs do not wait for other runs of the same Schedule or Agent configuration.
  Session dispatch owns conversation ordering; complete messages still defer while
  their destination chat's own Turns are busy. Delegated Operations the chat still
  awaits block run completion, never message admission, so a manager chat waiting on
  its children still receives the message. Preserve ledger completion and recovery tracking.
- Configuration unavailability is recoverable without consuming an attempt.
  Infrastructure failures use bounded backoff; all prehandoff work expires after
  its fixed dispatch age. Only unprepared pending automatic runs may be superseded.
- Commands are transport-neutral: local CLI/MCP uses the private daemon socket;
  cloud one-shot commands use the workspace Repo. MCP list/show/propose/pause are
  available to all Agent Sessions. Create/edit/resume recheck current Session ownership
  and cap both stored/resulting definitions and existing-chat execution by the invoking
  permission tier; unknown requires a person. Human CLI has no Agent tier cap.
  Retry interval rules use the landed request anchor, preserving requestId replay.
  Record requesterSessionId and one idempotent system notice per Agent write.
- Proposals use validated named rules, never cron, and take effect only after human
  confirmation. Repeated requestIds report the card outcome. Ask when prompt, rule or
  destination is unclear. Keep guidance aligned with the card.
- Preserve optional `mcpServerIds`: explicit selection, including `[]`, wins; absent
  new-chat selection uses project then workspace defaults. Existing chats inherit their
  latest choice. Freeze before preparation and retain on retry. Resolve names to ids,
  allowing stored removed ids during unrelated edits. MCP update null clears the field;
  UI and proposal edits preserve it.

- Schedule v2 preserves string/boolean configuration. At handoff project exact legacy
  boolean literals for declared booleans and omitted semantic fast/fast-mode options;
  explicit select declarations retain strings. Never migrate definitions or ledger
  fingerprints. See the [Fast decision](../../../../../.agents/notes/implemented/bug-fix/2026-10-26-schedule-fast-compatibility.md).

- Use ordinary Session configuration defaults/validation plus the Agent tier bound.
  Never put credentials or provider exception text in Registry runtime rows or logs.

- An absent definition.project means chat-only: no project lookup, target project,
  repoFullName or baseBranch. Never infer a default. Validate present local projects
  against the owning machine's Flock. Keep the production prepareSessionInput coverage
  in schedule-session-preparation.test.ts; ownerTarget alone bypasses resolution.

- Manual triggers have no next slot; Registry requests plan them. new_session derives
  one Session per run. existing_session requires this owner's unarchived same-Agent chat.
  own_session selects the first usable schedule/epoch/sequence id, skipping archived,
  deleted and Board-detached chats; sequence zero preserves legacy identity. Persist the
  selected Session with preparation; retries only validate it. Archiving after preparation
  fails SESSION_UNAVAILABLE; before preparation it blocks recoverably without an attempt.

- Optional `boardId` belongs to the definition and Registry fingerprint. Missing or
  archived Boards block with `BOARD_UNAVAILABLE`; existing destinations must be
  members other than the coordinator. Created Sessions carry only `boardId`, never
  `boardRole`. Agent writes check both stored and requested Board membership;
  proposal cards retain it. Board schedules default to `own_session`.
- `_lodyScheduleId` follows scheduled input and its Inbox continuations, not human
  follow-ups or edit-and-resend. It produces passive `schedule` Board events.
  Archived dispatched chats finish once live work drains. [Flow](README.md).
- A Role reference resolves at preparation from the owner's readable catalog through
  `resolveScheduleRunRole`, pinned to this machine and the named or sole usable target.
  Freeze its target/config/revision/prompt on the run; retries validate that Agent.
  Missing/ambiguous Roles block recoverably as ROLE_NOT_FOUND/ROLE_INSTANCE_UNAVAILABLE;
  never run the saved `definition.agent` copy or another target. Capacity delay uses this
  final resolution too. Prefix only a newly created chat; record the Role snapshot on
  its Turn and new Session. Saves resolve and overwrite the display Agent copy except
  landed requestId replays. Reject existing_session and machines without scheduleAgentRoles.
  Permission tiers use the current Role; unresolved means unknown. Explicit Agent selection
  clears the reference; older builds reject these definitions.

- Dispose Schedule workers before workspace teardown; timers/evaluations must not
  survive revocation.

- Tests use injected clocks, sync barriers and temporary SQLite, never sleeps or live providers.

- Complete messages require schedules v3/messageVersion 1. Fingerprints and frozen
  ledgers retain complete payloads and staged attachment bytes, never prompt projections.
  Busy destination chats defer without interruption. Cancellation waits for durable
  dispatch reconciliation; committed dispatch wins.
- Skip only unprepared legacy Claude quota shortcuts without Turn association; retain
  prepared/dispatched work and ordinary/changed-message schedules. See the
  [decision](../../../../../.agents/notes/implemented/bug-fix/2026-10-30-discard-unassociated-quota-reservations.md).
- Retain terminal one-time messages for seven days from runtime projection, then purge
  document/Registry/runtime/manual rows and tombstone them. Busy documents retry;
  pending/active messages and generic Schedules are never swept. CRDT compaction is separate.

- A complete-message Schedule ID is consumed by durable dispatch across all later
  activations. Consult the persistent ledger before planning/processing another run;
  derive cross-activation sent state from that ledger, never a cached runtime row.
  Complete-message prompt reads derive from atomic input blocks, and their activation
  floor is the once instant so concurrent same-reservation creates share a fingerprint.
