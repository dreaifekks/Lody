# apps/cli/src/session

[Docs](README.md); [worktree rules](worktree/AGENTS.md).

## Identity

- Authorize machines through injected access with the source CLI token; MCP verifies the frozen Turn requester under [MCP rules](../mcp/AGENTS.md).

- Never send an untrusted requester through workspace Machine RPC: it authenticates no member identity.
- Read live status from target-daemon RPC, never durable metadata.
- Freeze human identity and persist pre-launch humanInputReceipts; recovery uses receipts, never role/author. Follow [orchestration rules](../orchestration/AGENTS.md).
- Scope credentials to the host. Frozen Turn identity owns attribution, authorization and commits; conversation owner owns GitHub auth. Only the owner reads local Git config, without profile queries. CloudPort profiles have a 60s deadline, retry failures and reject placeholders. Attribution changes never restart ACP; owner changes retire it.

## Dispatch

- Reconcile with four global slots, filling free slots independently. Follow README bounds; no per-trigger scans/throttles. Close dead turns. Acknowledge empty queues only with causal proof.
- Promotion preserves frozen fields and removes input only after history+activation succeed. Queue/history dispatch share normalized config; JS undefined fields cannot invalidate unchanged encrypted inputs. Hold missing metadata as unknown in the TTL-bounded RPC stash until metadata or a definitive verdict arrives. Subscribe before Doc Room join/sync; never dispatch from the RPC handler. History sync is the durable fallback.
- Missing-history recovery writes permanent lastMissingHistoryUserMsgId and chat_failed, never lastHandledUserMsgId. Retire terminal stale activation to settledActivationUserMsgId; never claim that marker or rewrite latestUserMsgId. Report settled only with none remaining.
- Late history never replays; recovery sends anew. Use last rows by id; stop no-progress repairs. Only hasPendingUserTurnActivation decides pending work, never pointer comparisons. Keep Stop data in control docs, pointers in meta. Never scan old docs or change presence owned by ../lib/loro/session-active-presence.ts.
- Encrypted `queuedInput` requires its signed original or local receipt to start;
  machine signatures do not establish authorship. Only the owner principal may
  use the machine account as requester.
- Encrypted requesters come from verified signers; authorize locally. Row `userId` is display only.

## Execution

- Gate LIST writes on user-entry sync (`turn-history-gate.ts`, 20s), never status/meta.
- Goals obey [this contract](../../../../specs/session-goal-control.md).
- Stop ends steer waits, not the owner fiber. Reuse an Agent only after raw ACP drains or termination is confirmed. Failed release detaches that Agent, returns its slot and reports bounded background cleanup; the next input creates a new ACP. Follow [Inbox admission](../orchestration/AGENTS.md) with fixed execution ids. Assistant ids use userTurnId; invocation owns source/requester/config and is replaced by steer.

- Only producers publish latestUserMsgId with appendUserTurn or Roost's accept_input_and_dispatch queue. Save human provenance first; guard live history/meta and newer activation, retaining producer tombstones. Execution writes only processingUserMsgId/lastHandledUserMsgId; start/terminal paths never read-await-rewrite the other slots.
- Never steer after cancellation or infer delivery from it. Stop and access revocation preserve/discard; Stop also cancels prior queued eligibility. Edit & Resend preserves/ keeps. Create/restore fences apply only during initialization. Promote only proven non-delivery via steerTurnStatuses; unknown never replays and RPC ACKs cannot revive history. Surface recovery errors.
- Use the config owner's signal and fence mutations after interrupt. Resume reopens only the in-progress assistant entry, clearing finished/endedAt/permissionWaitMs; teardown never writes finished=false.
- Keep transport matching in acp-error-classification.ts: disposed/stale -32603 means agent_disconnected; Harness compression mismatch means acp_session_storage_incompatible. Retry stale ACP once before any event, retaining turn and cleanup after retirement. Never retry submitted Inbox inputs, including human-plus-batch.

- Completion publication follows [notification ownership](../lib/notifications/AGENTS.md).
- Without content, use recordSilentTurnFailure, never setDispatchHandled. Await turnProducedVisibleOutput before finalizeTurn; finalize, advance pointers and fail open.

- Use CLI-local ACP diff evidence and PR-compare GitHub diffStats. session-diff-stats-target.ts skips good totals, never overwrites them.

## Lifecycle

- Finish workspace results before release under the statistics budget. Timeout/shutdown cancels remaining work and fences late writes. Presentation/turn-bound image uploads may follow with owned bounded waits. Shutdown prioritizes release receipts; its final second fails stuck Inbox releases and clears execution ids, never during normal operation. All waits use turn-budgets.ts with tested ordering and Desktop's longer grace. Only freeTurnSlot releases slots.

- [Roost](README.md#roost-history-paging) gates by owner/backend. Never add keyring, rotation, fallback, removed-history revival, uncertain steer replay/retry or receipt/log pruning. Keep edits/digests/meta atomic and agent v2/renderer v3. SDK owns input/permission/ branch; errors retain local causes and RPC stage/code/id. Native proofs gate path reuse and goal-read elision; head/watch replaces Loro cursors.
- Session.createAgent gates ACP spawn; failures reject JSON-RPC. Terminals use argv (shell only for unsplit lines), direct exit and bounded drain. Only managed Codex reused-refresh retries once, after process cleanup, delay and live Provider recheck.
- Child Tabs share parent workspaces. Publish only machine dotlodyPath, never Session paths; frontends derive them. Captured sandbox.spawn output requires captureOutput:true and a 4 MiB cap; ACP stdio does not capture.

- Keep startup stderr: [rules](README.md#start-failures).
- Shutdown: `cleanUp({ keepWorkspaceDocumentOpen: true })`, MessageHandler's final flush, then `cleanUp()`; never close the doc first.

## Sagas

- Start ACP/worktrees only at dispatch. session/prepare and -cancel return no-ops without access checks (prepare: accepted duplicate).

- Credential leases release on creation failure; local has none.
- Reject nested Tabs; resolve ownership one hop.
- Fork/continuation use resolveSessionAcpTargetId; copy runtime config only at its matching User fence.
- Fork commits via persistPendingChanges, never cloud sync. Persist placeholders before ACP; failed commits terminate/delete targets durably. Post-commit display stays outside compensation. Active forks require `_meta.lody.forkAtTurn = { version: 1 }`; forward `_meta.lody.turnId` unchanged as acpTurnId. Source Git identity requires an exact requester. New-worktree forks need native support and durable forkOperation before return; publish meta after commit. Failure cleans ACP/worktree/branch with durable receipts; retry is idempotent. Recovery fails closed, using local withForkOperationLock markers only, never room scans/unowned-document cleanup.

- Edit-and-resend prepares forkAtTurn (session/new for the first User), cancels the exact turn, joins release, then commits history/meta. Block promotion/dispatch/steer meanwhile. Keep queue/attribution/config/attachments; allocate new Turn/ACP ids. Never replay transcripts or roll back files.

## Access

- Never write sessionLaunchConfig. Initial create payloads are transient; resolve Agent config/project on resume/dispatch, using legacy rows only as fallback.
- Check local policy then cloud three-state access. Owner cache/member allow verified <1h ago may allow offline. remote_missing/denied fails; indeterminate retries through verifyMachineAccessWithRetry(). Throws never imply denial.

- Cache only confirmed backend verdicts: allow refreshes verifiedAt, deny clears, indeterminate writes nothing. forceBackendVerification rechecks owner hits; bind member entries to requester/project/CLI account/Machine.
