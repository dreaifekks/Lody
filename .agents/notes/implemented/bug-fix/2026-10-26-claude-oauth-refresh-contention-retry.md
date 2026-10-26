# Retry a Claude prompt that lost the OAuth refresh race

Status: implemented
Translation: current

[中文](2026-10-26-claude-oauth-refresh-contention-retry.zh.md)

## Abstract

Claude Code processes that share one `~/.claude` login refresh its OAuth token
under a lock. A process that starts while another holds the lock fails its first
request at once with "Failed to refresh OAuth token: another Claude Code process
is refreshing it…", which the adapter reports as ACP `-32603`. Lody treated that
as a fatal internal error, killed the agent and failed the turn, so a scheduled
run on a machine with many idle Claude sessions was simply lost. The prompt is
now sent again to the same agent after 30, 60 and 120 seconds while the turn has
seen no tool call, no steer and carries no Inbox results; if every repeat loses, the
turn fails as before with the number of repeats in its message. A related
adapter fix stops a confirmWithUser question (`confirm_<uuid>`) that nobody
answered from turning a finished turn into "ended without returning results".

## Decision and evidence

- Evidence (homenucserver, 2026-10-18 to 10-26): four scheduled `new_session`
  runs failed this way within seconds of start; about 18 idle Claude Code
  processes shared the credential. `connection.prompt` rejected after the
  ACP session was established, the turn was recorded as `acp_internal_error`
  and the process force-terminated. A later `loadSession` of the same ACP
  session succeeded, so the agent itself was healthy.
- Matching: `isClaudeOAuthRefreshContentionError` requires `-32603` and the
  contention clause. Claude Code 2.1.305 also has a disk-full refresh failure
  with the same `Failed to refresh OAuth token:` prefix that does not clear on
  its own, so the prefix alone is not enough. Expired sign-in stays
  `acp_auth_required` and is never repeated; the existing LAN failure push
  already tells the phone.
- Placement: the repeat lives in the shared `prompt` step of a visible turn, so
  `startSession` (every scheduled `new_session`) and `continueSession` both get
  it, and Stop interrupts the wait like any other owner-fiber wait. The
  alternative, re-running the schedule, was rejected: the Schedule ledger never
  retries with another Session or Turn after dispatch, and a second turn would
  duplicate the user message.
- Same agent, not a new one: the failure comes from a result message, the
  Claude Code process stays in streaming mode, and its next request re-reads
  the token the winning process wrote. Retiring and restoring would add a
  `loadSession` without fixing anything.
- Output guard: Claude Code shows the failed request as a synthetic assistant
  message, which the adapter forwards to Lody (no AIR session-failure
  capability), so "no output" never holds here. The guard is "no tool call in
  this turn" (`hasToolCallInTurn`, tracked when a `tool_call`,
  `tool_call_update`, `subagent_event` or plan update is buffered; a subagent's
  tools reach Lody only inside `subagent_event`, Claude's TodoWrite/Task tools
  only as plan updates): without one the request that failed was the turn's
  first model call, and nothing ran. A steer changes the turn id and ends the
  repeats.
- Inbox: with the Operation Inbox installed (every daemon) each human or task
  turn runs as an Inbox input whose submit can repeat, so the guard is the same
  as stale-ACP recovery: no repeat for `dispatchSource: 'inbox'` or a turn that
  claimed a batch of Operation results, whose fence never submits twice. A repeat
  clears the failed prompt's settled `cancellationDrain`, otherwise Stop during
  the repeat would answer success without cancelling the new prompt.

## confirm_ tool calls (10-22 failures)

Claude Code's `confirmWithUser` (for example after "safeguards flagged this
session") asks through `canUseTool` with tool `AskUserQuestion` and a synthetic
id `confirm_<uuid>`; it never streams a `tool_use` or `tool_result` for it. The
adapter recorded that id as a foreground tool call, so when nobody answered a
scheduled run (Lody cancels the question after 20 minutes) and Claude finished
the turn, the adapter failed it with "Claude ended the turn without returning
results for tool calls: confirm_…". Fork patch
`patches/submodules/acp-extension-claude/0003-confirm-with-user-not-a-tool-call.patch`
treats these ids like `SandboxNetworkAccess`, another permission-only callback.
The flag itself comes from the provider; scheduled prompts that read security
material can still trigger it.

## Known limits

- The synthetic error text of the failed attempt stays at the start of the
  reply when a repeat succeeds; it also counts as output, so a repeat that ends
  silently is not reported as `agent_no_output`.
- A steer sent during the wait finds no prompt in flight and is queued as the
  next turn; the repeat still sends the original prompt first.
- A `confirm_` tool call stays unclosed in the client, as `SandboxNetworkAccess`
  already does, and counts as tool activity, so that turn is not repeated.

## Not done

- Startup jitter for schedules: the workspace evaluates due schedules every 15
  seconds, and spacing several handoffs in one evaluation would change the
  serialized engine. With the repeat in place a same-minute collision recovers
  on its own.
- Reclaiming idle Claude Code processes: the idle timer already recycles
  sessions; fewer processes would lower the odds, not remove the race.

## Verification

- `apps/cli/tests/session-execution-service.test.ts` (Claude OAuth refresh
  contention): a second attempt completes the turn; delays are exactly 30/60/120
  seconds under fake timers and the final failure names three repeats; Stop
  during a repeat sends the ACP cancel (fails without the drain reset); with a
  real SQLite Operation Inbox, an ordinary human turn is repeated and a turn
  that claimed waiting results is not (each fails with the wrong guard); a turn
  with a tool call, an auth-required error and the disk-full text are not
  repeated.
- `acp-error-classification.test.ts`: contention is not auth; disk-full and
  sign-in texts do not match.
- Adapter `incomplete-tools.test.ts`: an unanswered `confirm_` question no
  longer fails the turn (fails without the patch).
- Not verified on a real machine; the next contention on homenucserver will show
  "lost the OAuth refresh race" warnings in the daemon log.
