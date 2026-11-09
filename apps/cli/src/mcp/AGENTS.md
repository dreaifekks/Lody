# Lody MCP rules

Parent rules apply; see [README](README.md).

- Route Session/catalog tools through daemon `session/call-tool` in every composition,
  never a second writer, replica or child CLI. Reuse SDK-parsed arguments; validate in
  `session-tool-router.ts` and scope identity/replica with `session-command-environment.ts`
  ALS. Require exact workspace/machine and active Turn (local: its user).
  `cli/call-tool` permits only read-only TERMINAL_SESSION_TOOLS under daemon identity.
  Cloud retains authenticated commands and recovery confirmation.

- MCP sharing requires the active Turn user to equal the CLI authenticated account.
  Fail closed on shared-machine account mismatch; never substitute the machine owner.

- `lody_mcp_configure` derives the workspace from MCP context and reauthorizes with the
  daemon credential. Require an explicit human request for configuration/credentials.
  Create random ids without default selection; UI/CLI owns review, updates and selection.
  Credential fields allow only ${VAR} or daemon passthrough; never echo connection values.
  Changes affect future starts, never the running Agent.

- End responses; GET /mcp returns 405.
- Apply withLoopbackNoProxy last in session/acp-runner environments, preserving both
  NO_PROXY and no_proxy for loopback. See [proxy rationale](README.md#http-and-loopback).

- Bound every Agent-authored persisted field, collection, complete configuration, and catalog.
  Serialize per-workspace Agent config writes before checking local name/count bounds;
  the shared CRDT is not a global CAS. Keep catalog writes locally durable while surfacing sync
  failures as unsynced.
- Explicit Role ids need no mention grant. Freeze target/config/prompt/revision.
  Local-project children stay on the caller machine; remote Roles use enabled linked
  GitHub repositories. Delegation requires both machine-owner and invoking-human access.

- Operation identity comes from active Host dispatch, never credentials or Session
  ownership. Freeze requester/source ids and notification origins; unresolved exact
  input provenance rejects retryably before acceptance. Recovery checks current access.
- Role creates accept stable `agentRoleInstanceId`, or a machine plus an unambiguous
  target. `agentRoleMachineId` and `machineId` must agree. Work context must match;
  no automatic fallback. Manual Agent/run-config overrides are ignored.
- Role/Schedule direct writes retain the [permission cap](../../../../packages/platform/AGENTS.md#agent-authored-configuration).
  Role proposals/CLI publish [review cards](README.md#agent-role-proposals);
  Save checks ownership and patches current text.

## Tools

- Align chain caps and MCP guidance; create/chat forbid courtesy, duplicate callbacks
  and depth-limit evasion. Reject new chats to the active input's Agent sender; isolate
  rejected batch items.
  Prefer the active Turn's frozen audience for sender checks; read exact input history
  only when the sender is unresolved. Sender provenance does not grant user authority.

- Single and batch chats pass `steerActiveTurn` to the owning daemon, locally or over
  LAN; recovery replay never steers. Never activate a steered or existing `pending_apply`
  turn. Uncertain delivery fails the item with `STEER_DELIVERY_UNKNOWN`, never a replay.
  [Contract](../../../../specs/session-orchestration.md#agent-chat-to-a-busy-session).

- Catalog uncertainty is retryable, not INVALID_ITEM. Agent defaults require fresh
  catalogs and inferred defaults rederive until authored; explicit access remains strict.
  Follow [freshness rules](README.md#machine-catalog-retry-guidance).

- Native-app tools use ios_simulator_preview/android_emulator_preview; web uses
  report_preview_candidate. Bind local control to the MCP Session and resolve the active
  user in the daemon. Return operation handles, never viewer URLs/raw transport errors.
  Reuse the existing lifecycle owner and schema.

- Share lib/resource-discovery.ts. Daemon catalogs report catalog_syncing before baseline;
  Role targets require fresh sync. Standalone CLI syncs unless offline. Use active-Turn
  identity and canReadAgentRole; explicit creation retains its grant contract. Preserve
  unavailable readable Roles, three-state presence and credential allowlists.

- MCP defaults wait at most one second for the daemon baseline. Only a persisted remote
  workspace checkpoint permits cold cached defaults; local rows do not. Otherwise reject
  retryably before Operation acceptance. Freeze ids; explicit [] bypasses defaults.
  Startup may warn and use complete selected rows locally; missing rows fail. Timeouts
  never stop the shared reader.

- Directory cursors bind resource, workspace, user and filters. Operations additionally
  bind requester Session and query only that user's machine-local rows; list replies
  contain no canonical prompt or assistant output. See
  [discovery Spec](../../../../specs/resource-discovery.md).

- Use stable ids and strict inputs. Create/chat require caller-chosen Operation ids.
  Persist creates before availability checks; transient post-accept failures leave fixed
  targets for replay. resume=true recovers without a prompt. Deliver completion through
  Inbox; expose no wait tool and disallow new uses of legacy wait=true.

- Chat inherits omitted mode/model/options from the target's last model turn, otherwise
  last matching turn. Explicit fields/category options win; model changes drop old options.
  Validate effort/Fast against the final model; missing per-model data defers to runtime.
  Drop incompatible inherited selectors even with uncertain freshness; only explicit misses
  block. Fill builtin mode only when empty. [Rationale](README.md#chat-configuration).
- Create MCP order is explicit input, exact sourceTurnId selection, target project defaults,
  then workspace defaults. Chat uses its target's latest choice. Preserve [] and freeze
  every target at Operation acceptance.

- `lody_session_create_options` publishes modes and option ids/types/choices per config,
  never current values. Defaults stay sparse: online machines, one config, current local
  project and no GitHub fetch. Expand only explicit queries. Permissions follow user
  authorization. Daemon reads use its replica without starting Streams sync; unresolved
  selection returns retryable SYNC_UNAVAILABLE. See [freshness](README.md#machine-catalog-retry-guidance).

- Machine presence is online/offline/unknown. absence from an unsynced `classifyMachinePresence` view means
  unknown; block dispatch/report `MACHINE_OFFLINE` only for definite offline, never on
  an RPC timeout. Unknown proceeds under its own deadline. Expose three-state liveness,
  never a boolean.
  Contract: `specs/loro-ephemeral-presence-channel.md`;
  [cold-start rationale](README.md#machine-presence).
- session_list defaults to 20, max 100; session_history defaults to 10, max 50/128 KiB.
  CLI history --all remains available. List/status_many share history, queue, presence
  and Machine RPC state. Remote Sessions use [transient reads](../lib/loro/AGENTS.md);
  one unreadable item must not fail others. Follow [Operation rules](../orchestration/AGENTS.md).

- `session_history` uses `SessionData.history.readVisiblePage`, never getHistory.
  Limits count displayable turns; cursors retain raw positions through hidden/empty rows.
  hasMore follows raw rows, so scan-budget exhaustion cannot claim completion.
  Mentions use `[@Title](lody://session/<id>?workspace=<id>)`; bare ids and legacy
  session:// remain accepted, with explicit workspace matching tool context.

- Single create/chat attachments require durable Operations and sessionInputAttachments
  on the calling daemon. Resolve within the calling Session's workspace; freeze references
  before acceptance and reuse on retry. Legacy wait/batch inputs reject attachments.

- The user-owned inherited `collaborationStopped` barrier rejects delegation. Agents and
  completion callbacks must never clear it; execution also fences setup and prompt dispatch.
