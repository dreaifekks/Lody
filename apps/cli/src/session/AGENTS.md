# apps/cli/src/session

`CLAUDE.md` links here; edit this file.

The 1,340-word ceiling preserves complete dispatch identity, commit identity precedence and
output-lifetime rules alongside existing authorization and execution boundaries, including
encrypted starts that run only signed input; the default ceiling had no room for those rules.

[Docs](README.md); [worktree rules](worktree/AGENTS.md).

## Identity

- Authorize machines through injected access with the source CLI token; MCP verifies the frozen Turn requester under [MCP rules](../mcp/AGENTS.md).

- Never send an untrusted requester through workspace Machine RPC: it authenticates no member identity.
- Live status is a target-daemon Machine RPC read; durable metadata never substitutes for it.
- Require frozen human identity and pre-launch `humanInputReceipts`; recover via receipts,
  never role/author. [Rules](../orchestration/AGENTS.md).
- Host-scope Machine/Provider credentials. Use frozen Turn identity for attribution,
  authorization and commits; trusted conversation owner for GitHub network auth.
- Git: the owner's repository identity, an approved requester, the owner's native config,
  then LodyAI. Only a decided identity is exported as env. Non-owners never read machine config.
  `CloudPort` profiles: 60s deadline, retry failures, reject placeholders.
  Commit attribution never restarts ACP; owner changes retire the runtime.

## Dispatch

- Reconcile with four global slots, filling free slots independently. Follow README bounds; no per-trigger scans/throttles. Close dead turns. Acknowledge empty queues only with causal proof.
- Promotion preserves frozen fields and removes input only after history+activation succeed. Queue/history dispatch share normalized config; JS undefined fields cannot invalidate unchanged encrypted inputs. Hold missing metadata as unknown in the TTL-bounded RPC stash until metadata or a definitive verdict arrives. Subscribe before Doc Room join/sync; never dispatch from the RPC handler. History sync is the durable fallback.
- Missing-history recovery never advances `lastHandledUserMsgId`: retain failed IDs in
  `missingHistoryUserMsgIds`, read legacy acknowledgements, and surface `chat_failed`.
- Retire a terminal stale activation into `settledActivationUserMsgId`; never claim the
  marker or rewrite `latestUserMsgId`, and report settled only if none survives.
- Late history never replays; recovery sends anew. Use last rows by id; stop no-progress repairs. Only hasPendingUserTurnActivation decides pending work, never pointer comparisons. Keep Stop data in control docs, pointers in meta. Never scan old docs or change presence owned by ../lib/loro/session-active-presence.ts.
- Encrypted promotion marks the row `queuedInput` and copies the queue item's signed
  `e2eeIntent`; start verifies that signature, never the row's writer, and encrypted rows
  take their resume target from Session metadata. An encrypted start runs only its signed
  input config, never the row's unsigned items. Only the owner principal may name the
  machine account as requester
  ([evidence](../../../../.agents/notes/implemented/architecture/2026-11-10-e2ee-signed-execution-intent.md)).
- Encrypted requesters come from the verified signer; access is decided locally; row
  `userId` is display only ([decision](../../../../.agents/notes/implemented/bug-fix/2026-11-06-e2ee-verified-requester.md)).

## Execution

- Machine identity recovery seals actual Turn admission before restart. Recheck after
  pre-owner awaits; sealed requests retain pending history and Inbox inputs without
  marking them handled, failed or canceled. Registered Turns block recovery even
  before presence publication.
- Gate LIST writes on user-entry sync (`turn-history-gate.ts`, 60s), including pre-open
  writes, never status/meta. Timeout preserves live metadata creation; disposal aborts it and releases waiters.
- Goals obey [this contract](../../../../specs/session-goal-control.md).
- Stop ends steer waits, not the owner fiber. Drain raw ACP or confirm termination before
  reusing an Agent. If release fails, detach that Agent, return the turn slot and report
  bounded background cleanup; the next input creates a new ACP. [Inbox admission](../orchestration/AGENTS.md); execution IDs stay fixed.
  Assistant ids use `userTurnId`; `invocation` owns source/requester/config; steer replaces it.
- Only dispatch producers publish `latestUserMsgId`, with history in `appendUserTurn`
  or Roost's `accept_input_and_dispatch` writer queue. Save human provenance first;
  guard live history/meta and newer activation; keep producer-specific tombstones.
- Turn execution writes only `processingUserMsgId` and `lastHandledUserMsgId`; no start
  or terminal path may read-await-rewrite the other slots.
- Never steer after cancellation or infer delivery from it. Stop uses
  preserve/discard and cancels pre-Stop queued eligibility; Edit & Resend uses preserve/keep,
  access revocation preserve/discard. Limit create/restore fences to initialization.
- Promote only proven non-delivery via `steerTurnStatuses`, never producer pointers.
  Unknown never replays; RPC ACKs never revive history. Encrypted recovery preserves terminal
  decisions and newer pointers, closes partial replies with one notice, and isolates unrelated failures.
- MCP selection changes retire ACP between prompts; changed-selection steer returns to dispatch for a new turn.
- Config uses its owner signal; fence mutations after interrupt.
- Resume must REOPEN the in-progress assistant entry, clearing
  `finished`/`endedAt`/`permissionWaitMs` there only; never write `finished=false` from teardown.
- Keep JSON-RPC/transport matching in `acp-error-classification.ts`: disposed/stale `-32603` =
  `agent_disconnected`, Harness compression mismatch = `acp_session_storage_incompatible`.
- Stale ACP: retry once before any event; retire, retain cleanup, keep the turn. Never retry submitted
  Inbox inputs (human-plus-batch too).
- Completion publication follows [notification ownership](../lib/notifications/AGENTS.md).
- No content: `recordSilentTurnFailure`, not `setDispatchHandled`. Await
  `turnProducedVisibleOutput` before `finalizeTurn`; finalize, advance pointers, fail open.
- Turn summaries and diff content share CLI-local ACP evidence. Git statistics never populate turn history.
  Workspace totals follow [Code Collab rules](../lib/code-collab/AGENTS.md#invariants).

## Lifecycle

- Finish workspace results before release under the statistics budget. Timeout/shutdown cancels remaining work and fences late writes. Presentation/turn-bound image uploads may follow with owned bounded waits. Shutdown prioritizes release receipts; its final second fails stuck Inbox releases and clears execution ids, never during normal operation. All waits use turn-budgets.ts with tested ordering and Desktop's longer grace. Only freeTurnSlot releases slots.

- [Roost](README.md#roost-history-paging) gates by owner/backend. Never add keyring, rotation, fallback, removed-history revival, uncertain steer replay/retry or receipt/log pruning. Keep edits/digests/meta atomic and agent v2/renderer v3. SDK owns input/permission/ branch; errors retain local causes and RPC stage/code/id. Native proofs gate path reuse and goal-read elision; head/watch replaces Loro cursors.
- Session.createAgent gates ACP spawn; failures reject JSON-RPC. Terminals use argv (shell only for unsplit lines), direct exit and bounded drain. Only managed Codex reused-refresh retries once, after process cleanup, delay and live Provider recheck.
- Child Tabs share parent workspaces. Publish only machine dotlodyPath, never Session paths; frontends derive them. Captured sandbox.spawn output requires captureOutput:true and a 4 MiB cap; ACP stdio does not capture.

- Keep startup stderr: [rules](README.md#start-failures).
- Shutdown: `cleanUp({ keepWorkspaceDocumentOpen: true })`, MessageHandler's final flush, then `cleanUp()`; never close the doc first.

## Sagas

- ACP processes and worktrees start at dispatch, never while a draft is typed
  ([decision](../../../../.agents/notes/implemented/simplification/2026-10-16-remove-draft-session-preparation.md)).
- Credentials are runtime leases: a failed creation releases that generation; local has none.
- Nested child Sessions are rejected: ownership resolves one parent hop only.
- Fork and continuation share `resolveSessionAcpTargetId`; source runtime config copies only at its matching user-turn fence.
- Fork commits at `persistPendingChanges()`, never cloud sync. Persist its placeholder
  before ACP; failed commits terminate and durably delete the target. Post-commit
  display projections stay outside compensation.
- Active-turn fork requires advertised `_meta.lody.forkAtTurn = { version: 1 }`; pass adapter
  `_meta.lody.turnId` unchanged as `acpTurnId`, and reuse source Git identity only for an exact requester.
  New-worktree forks require native support, persist target-doc `forkOperation` before return,
  publish target meta only after final commit, clean ACP/worktree/branch with a durable failed
  receipt, and stay idempotent on retry.
- Fork recovery fail-closes interrupted operations and finds them ONLY in machine-local markers
  under `withForkOperationLock`; never enumerate rooms/open docs for candidates or clean an unowned doc.
- Edit-and-resend prepares `forkAtTurn` (`session/new` for the first User), cancels the exact
  turn, waits for release, then commits history/meta. Its barrier excludes queue promotion,
  dispatch and steer. Keep the queue, User attribution/config/attachments; use new turn/ACP ids.
  Never replay transcript or roll back files.

## Access

- Never write sessionLaunchConfig. Initial create payloads are transient; resolve Agent config/project on resume/dispatch, using legacy rows only as fallback.
- Check local policy then cloud three-state access. Owner cache/member allow verified <1h ago may allow offline. remote_missing/denied fails; indeterminate retries through verifyMachineAccessWithRetry(). Throws never imply denial.

- Cache only confirmed backend verdicts: allow refreshes verifiedAt, deny clears, indeterminate writes nothing. forceBackendVerification rechecks owner hits; bind member entries to requester/project/CLI account/Machine.
