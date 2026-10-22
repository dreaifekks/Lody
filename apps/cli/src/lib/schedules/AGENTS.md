# Scheduled automation

`CLAUDE.md` is a symlink to this file.

- Definitions live in `schedule-<id>` docs; the `:sr` Registry gates execution by
  published fingerprint. Discovery must never republish or enable an orphan.
- `schedule-workspace.ts` owns subscriptions, clock wakeups and target facts;
  `schedule-engine.ts` owns serialized planning and handoff; `schedule-store.ts`
  owns the Host-local SQLite ledger. Cursor advancement and a run intent share
  an IMMEDIATE transaction. Preserve cursor/run ids across restarts.
- Session history goes through `sessionData` (`readSessionHistory` reads,
  `commands.appendTurn` appends missing entries); there is no whole-list rewrite.
- Freeze the task name in `userTurn.scheduleRun`, bound to the exact input id,
  for notification presentation; never infer scheduled execution from Session metadata.
- Freeze JSON `PreparedSessionInput` before Session mutation. Its fixed user turn
  uses `prepared`, inert until `latestUserMsgId` is committed. After this pointer,
  the ordinary watcher owns execution. Never retry with another Session or Turn,
  reset Session status/title, or unwind a committed dispatch.
- A disconnected cloud Registry blocks new handoffs. `schedule-sync-gate.ts`
  requires the initial and current connection sync; a previously resolved
  first-sync promise is insufficient after reconnect. Pure local bypasses only
  this cloud gate, never ownership/config validation.
- `AgentExecutionSlots` is host-local, per-Agent-config Schedule admission.
  Restore accepted occupancy before evaluating; retain it while Session
  dispatch, queues, Operations or deliveries still have work. Release before
  prehandoff retry.
- Configuration unavailability is recoverable without consuming an attempt.
  Infrastructure failures use bounded backoff; all prehandoff work expires after
  its fixed dispatch age. Only unprepared pending automatic runs may be superseded.
- The command service is transport-neutral. Local CLI/MCP uses the authenticated
  user's private daemon socket; cloud one-shot commands use their workspace repo.
  Official MCP has list/show/propose/pause for every Agent session, plus
  create/edit/resume when the daemon's Session tool path passes the invoking
  Session's permission tier: the stored and the resulting definition, and an
  existing chat it sends into (what that chat runs with now), must all run
  within it (`permission-tier.ts`, unknown = person only), else the Agent
  proposes. A retry rebuilds an interval rule at the stored write's anchor, so the
  same `requestId` replays instead of conflicting. Each Agent write records `requesterSessionId` in the timeline and a
  system notice in that Session. The service re-checks that the caller owns the
  invoking Session on this machine. A proposal takes effect only after the person
  confirms its card. Human commands are not a security boundary against an Agent with shell access:
  the `lody schedule` CLI applies no tier cap ([why](../../mcp/README.md#agent-config-writes)).
  `propose` takes a NAMED rule (`ScheduleProposalRuleSchema`), never cron, and
  validates it as a trigger before writing; it publishes one idempotent
  `schedule_proposal` system notice per `requestId` through
  `schedule-proposal.ts` and reports the person's outcome on a repeated call.
  Tool guidance must ask when prompt, rule or destination is unclear and match
  what the card can resolve.
- `mcpServerIds` is optional: new/owned chats use workspace `enabledByDefault` ids
  when absent, and `[]` means none. Freeze the choice on the prepared turn; retries
  keep it. Existing-chat destinations inherit the chat's choice, else defaults. CLI/MCP writes
  resolve names to catalog ids, except ids the edited Schedule already stores (a
  removed server must not block unrelated edits); MCP update `null` clears the
  field. UI edits and proposal confirmation preserve the field.
- Schedule v2 preserves ACP string/boolean values. Legacy boolean strings are
  projected against target capability types at handoff, never migrated in the
  definition/ledger (their fingerprints authorize execution).
- Schedules use ordinary Session run-config defaults and validation; do not add
  a schedule-specific explicit-permission or capability-cache gate beyond the
  Agent tier bound above. No credentials
  or provider exception content may enter Registry runtime rows or Schedule logs.
- `definition.project` is OPTIONAL. Absent means a chat-only run: no local-project
  ledger lookup, no `project` on the resolved target, and `buildProjectOptions`
  contributes nothing to the prepared Session. A project that IS set is still
  validated against the owning machine's Flock before handoff. Never substitute a
  default project for an absent one. `schedule-session-preparation.test.ts` calls
  the PRODUCTION `prepareSessionInput` for this — an `ownerTarget` bypasses
  project resolution, so only that path proves the resulting `SessionMeta`
  carries no `project`, `repoFullName` or `baseBranch`.
- A `manual` trigger has no next slot; Registry manual requests alone plan it.
  `new_session` derives a Session per run; `existing_session` names an owned,
  unarchived chat on this machine with the same Agent. `own_session` selects the
  first usable id from schedule + epoch + sequence, skipping archived/deleted
  and (for Boards) detached chats; zero preserves the original id. Preparation and the selected `sessionId` commit together in the
  ledger, before mutation. Retries validate that frozen id, never select again.
  A destination archived after preparation fails that run as `SESSION_UNAVAILABLE`;
  before preparation it is recoverable, with no attempt or retained slot.
- Optional `boardId` belongs to the definition and Registry fingerprint. Missing or
  archived Boards block with `BOARD_UNAVAILABLE`; existing destinations must be
  members other than the coordinator. Created Sessions carry only `boardId`, never
  `boardRole`. Agent writes check both stored and requested Board membership;
  proposal cards retain it. Board schedules default to `own_session`.
- `_lodyScheduleId` follows scheduled input and its Inbox continuations, not human
  follow-ups or edit-and-resend. It produces passive `schedule` Board events.
  Archived dispatched chats release slots once live work drains. [Flow](README.md).
- `definition.agentRole` (`roleId`, optional `instanceId`) is a reference, never a
  copy. `prepare` reads the Role as it is then (`resolveScheduleRunRole`: the
  owner's readable catalog, shared target selector held to this machine, the
  named target or sole target) and freezes the result; later
  attempts of that run validate the Agent it froze. A Role that is gone, or has
  no unambiguous usable target here, blocks the run as `ROLE_NOT_FOUND` /
  `ROLE_INSTANCE_UNAVAILABLE`, a recoverable configuration problem: never run the
  saved `definition.agent`, an instance on another machine or another Agent.
  `agent` beside a reference is what the Role resolved to at the last save; the
  Registry row, listing and slot admission read it, no run does. The Role's
  `promptPrefix` goes only on the run that creates the chat
  (`buildScheduleRunPrompt`); every run records Role, revision and instance on
  its Turn, and on the Session it creates, as an MCP Role create does. The command
  service resolves a draft's reference (overwriting `agent`, except on a replay of
  a landed `requestId`, which keeps the `agent` saved then), refuses it with
  `existing_session` or on a machine without the `scheduleAgentRoles` capability,
  and ranks a bound Schedule's tier by what its Role resolves to now
  (unresolvable = unknown). The editor saves that resolution; choosing an Agent
  ends the reference. Unresolved references are invalid. Older builds reject the definition.
- Dispose Schedule workers before tearing down a workspace's Lody runtime.
  Timers and active evaluations must not survive workspace revocation.
- Deterministic tests use injected clocks, explicit sync barriers and temporary
  SQLite files. Do not add wall-clock sleep or live-provider timing assertions.
