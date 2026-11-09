# packages/loro-streams-rpc

Edit `AGENTS.md`.
Machine RPC contracts: [transport map](../../.agents/docs/rpc-loro-streams-rpc.md).

## Invariants

- `./e2ee-client` is the shared Node-free implementation. Its effectful immutable
  original store retains/readbacks before success; whole response batches are
  atomic. `./e2ee-native` only supplies the SQLite adapter. Keep finite local
  sealing/retention owned through completion and wipe plaintext on failure as well
  as success. Acquire returned plaintext and owned decoded buffers atomically
  with wipe registration; never put remote policy waits under that uninterruptible section.

- Encrypted machine RPC uses one feature DTO/chunk codec and shared complete-response assembler.
  The closed pure-read list uses fresh read authority, never execution journals; other admitted
  Code Collab/preview actions require write authority and execution claims. Keep same-member
  machine binding, exact originals and explicit size errors; never fall back to ordinary RPC.
- Encrypted dispatch fails with `e2ee_machine_not_shared` only if `authorizeTarget`
  returns a verified `false`. An unknown policy signs, because senders withhold input
  only for a known withdrawal and the receiving machine decides.
- A fully verified ledger view that no longer contains the requester classifies
  dispatch/read as exact `e2ee_device_revoked` (membership retained) or
  `e2ee_member_removed`; never as generic `e2ee_rpc_denied`.
- Encrypted dispatch retains exact frames across retry/fallback. Receipt ACK never
  completes the shared execution claim. [Ownership/close](README.md#encrypted-dispatch).
- Request stream ids are workspace/machine scoped:
  `getLoroMachineRpcRequestStreamId(workspaceId, machineId)` returns
  `<workspaceId>:rpc:req:<machineId>`.
- Web runtimes share one response stream: `getLoroWorkspaceRpcResponseStreamId`
  returns `<workspaceId>:rpc:res`; append `:<uuid>` and send that exact `replyTo`.
- `getLoroMachineRpcResponseStreamId(workspaceId, machineId)` remains the legacy
  response base for direct clients. Servers append to request `replyTo`, accepting
  both naming schemes.
- Define methods in `src/rpc.ts` `LoroStreamsRpcMethodSchema` and convenience
  methods on `LoroStreamsMachineRpcClient`.
- `createLoroStreamsJsonStreamClient` append must select its shard **stably** per stream
  id (`selectStableShardUrl`), never randomly.
- JSON append timeout: `uploadTimeoutMs ?? connectTimeoutMs ?? 10000`; keep
  RPC deadlines independent of bulk uploads.
- `readJsonLive` keeps `liveIdleTimeoutMs` (default 120s; `0` disables) and aborts
  with plain `AbortError`, so `runResponseLoop` / `runLoop` resume saved offsets.
- Web responses use SSE first and bounded long-poll fallback through
  `LoroStreamsLiveModePolicy` (`src/live-mode-policy.ts`), passed as `liveModePolicy`
  to `LoroStreamsRpcResponseDispatcher`. Select per read; do not pin static web
  `liveMode`. Fall back for unsupported SSE, failed reads or response starvation.
  Appended Roost inputs renew the shared response read once after 2s, preserving
  offsets, calls and deadlines without replaying writes or inferring acceptance.
  Stop/cancel removes recovery; explicit pins disable it. Read the Machine RPC map
  before changes. CLI requests keep static `sse` and the watchdog.
- The CLI owns/listens to the request stream via `src/machine-rpc-server.ts`
  `LoroStreamsMachineRpcServer`.
- Acquire permits inside tracked tasks without blocking intake. Bound ordinary
  admission (default 128) and overload replies separately. Reserve independent
  history-write and `CONTROL_METHODS` pools. Owners serialize mutations, not intake.
  `session/history-watch` retains owner encryption and readiness checks. Bound its
  separate admission at 128; checkpoint waits hold no ordinary read permit. Acquire
  that permit only for the subsequent body/change read. Stop aborts parked waits.
- `session/dispatch-turn` only stashes/wakes, never runs agents inline. Its TTL
  equals the client deadline. Stop fences queued handlers and retains started work
  through raw completion.
- Persist history precondition refusals before replying; replay retains them until
  expiry. Conflicting ID reuse or unavailable request state fails closed. Details: [history readiness](../../.agents/docs/rpc-loro-streams-rpc.md#history-readiness-and-error-provenance).
- Authorize orchestration source-side with its CLI token; workspace RPC cannot
  authenticate claimed requesters. Automation controls need target-verified,
  operation-bound proof. `session/live-status` reads target active presence, never
  infers liveness from `SessionMeta.status` or message pointers.
- Remote lifecycle: [ACK contract](../../specs/machine-lifecycle-ack.md).
  RPC handlers never run installers inline. Accepted work exits via the CLI process
  boundary after a bounded ACK attempt, including delivery failure or timeout.
- `machine/acp-capabilities-refresh` and `machine/acp-binary-install` may send
  `machine/acp-binary-progress`. Call progress callbacks without settling pending
  requests before their final response/error. Key capability refresh context and
  pending correlation by `configId`.
- Capability refresh cancellation uses the control-lane
  `machine/acp-capabilities-refresh-cancel` method keyed by original RPC id. Client
  abort, response timeout, and response-dispatcher stop/owner cancellation all discard
  that exact pending entry and, once original request was appended, best-effort append
  one cancel request. A pending request must return at its response deadline even if the original
  append POST is still half-open; if that append later succeeds, append the cancel then. The server
  must abort that request's work and suppress all later
  progress/final envelopes; a cancel for one shared CLI probe consumer must not abort other
  consumers of same launch/config work.
- `machine/acp-authenticate` similarly may append
  `machine/acp-authentication-progress` envelopes before its final response. Progress never settles the pending authentication request. Browser-returned
  codes, method/form replies, and other authentication input must never appear in retained
  request JSON: the target server advertises an ephemeral ECDH public key in progress, the
  client persists only an AES-GCM envelope bound to the authentication request and interaction,
  and the server decrypts only in target-process memory. Redact plaintext and encrypted input fields
  from invalid-request logging. Generic interaction keys appear only on the versioned method/form/
  URL-consent progress shapes; built-in code submission keeps its old progress shape so strict older
  clients still accept it. Custom/Registry ACP authentication stays on that same long-running request
  so method selection, URL/form elicitation, cancellation, and timeout all target the temporary ACP
  process that owns the login.
  Version 2 binds every process-launching authentication/capability request to a
  daemon-resolved persisted `configId`. Start requests never carry launch fields;
  cancel/code/form replies carry only the established authentication request and
  interaction ids. Do not reintroduce caller-supplied `customAcp`, `env`, or runtime
  overrides on Workspace Machine RPC: that transport cannot authorize a caller to
  choose a command for the target daemon.
- Code Collab v2 file/LSP work uses ordinary `code-collab/*` Machine RPC methods
  with workspace-relative paths, never per-file ids.
- Remote Streams wraps Code Collab params, results and business error `data` in
  v2 owner-session content-key envelopes. Keep business schemas unchanged;
  `ownerSessionId` is transport metadata and children use the parent owner key.
- Validate envelope ownership against resolved `sessionId` ownership before dispatch.
  Mismatches return `permission_denied` without file operations.
- Add Code Collab v2 only under machine `code-collab/*`, never session-scoped methods.
- `file/preview` v3 stays outside `code-collab/` and never activates it.
  Use its owner-session envelope and verification; every encrypt/decrypt/error-decode
  site calls `isOwnerScopedEncryptedRpcMethod`.
