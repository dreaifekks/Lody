# packages/shared/src/node

Edit `AGENTS.md`; `CLAUDE.md` symlinks here.

CLI, desktop main and supervisor helpers. Rules: [shared](../../AGENTS.md).

## Local-project Git (`local-project.ts`)

- Native workflows compose `LocalProjects` Effects directly, provided by
  `LocalProjectsLive` with paths, host environment and official spawner; no Promise facade.
- Expected Git statuses may mean absence. Expose startup/deadline/corruption/
  filesystem/release failures; failed parallel probes interrupt and join siblings.
  Preserve exact refs and canonical project identity.
- `localProjectsLegacy` is the sole deprecated CLI facade. Keep Legacy visible
  until callers receive the native service; mark synchronous path/identity methods
  blocking. Worktree setup/GC still require lifecycle migration.

## Process layer (`process.ts`)

The sole OS process implementation. Effect and boundary rules: [cli-effect-ts](../../../../.agents/docs/cli-effect-ts.md). Decision
record: [process tree layer](../../../../.agents/notes/implemented/architecture/2026-09-27-effect-process-tree-layer.md).

- Effect callers use `effect/process` commands and `ChildProcessSpawner`,
  provided by `ProcessSpawnerLive` with Lody's bounded backend. Process acquisition
  requires Scope; only legacy Promise entry points use raw handle compatibility.
  Temporary execution entry points carry the `Legacy` suffix and `@deprecated`;
  keep it visible in imports and calls. New Effect workflows compose core APIs
  and execute once at their owning application entry point.
  Use the workspace Effect v4 catalog and `Context.Service` / `Layer.effect`;
  follow the pinned-version APIs in cli-effect-ts, not v3 compatibility helpers.
- Only `process.ts` imports process libraries (`child_process`, `cross-spawn`,
  `execa`, `shell-env`) or sends OS signals. Other code uses the process service
  or shared Legacy facades; never wrap Effect through Promise and back.
  `pnpm check:cli-process-boundary` enforces this in CLI, Electron main,
  cli-supervisor, code-review-helper and this directory; exceptions need named reasons.
- Login-shell probes use `LoginShellEnvironment`; the shared `LoginShellCache`
  Layer owns one producer in the application's Scope. Reader cancellation/timeout
  does not stop siblings; application shutdown interrupts and joins the producer.
  `makeApplicationRuntime` joins concurrent disposal and retains recovery owners
  after failed Scope close. Only named Legacy application boundaries execute.
  Retry completed probe failures on the next read after five seconds; retain
  unconfirmed process-release owners and never cache failure as empty success. Read [the decision](../../../../.agents/notes/implemented/architecture/2026-10-10-effect-login-shell-probe.md)
  before changing the probe or either cache consumer.
- `process.ts` stays one module without relative imports.
- Add missing process capabilities to `process.ts` with a test and facade; callers
  must not bypass the layer.
- End processes through the official Effect handle or `terminateTree`; never add another
  SIGTERM→wait→SIGKILL loop. Every wait is bounded, and a tree that cannot be
  proven gone fails with `TerminationFailed`, never success. Scope release failure
  is a `ProcessReleaseFailed` defect carrying the unresolved tree's recovery lease;
  retain it until `isAlive` proves absence or `retryTermination` succeeds. Logging
  alone cannot turn that failure into success. Promise boundaries must use
  `squashProcessFailure` to preserve every lease alongside the primary failure.
  Acquisition error conversions preserve the full Cause, including release
  defects from the spawner's failed child Scope, before reaching that boundary.
- Bound termination waits with the clock (`waitUntilGone`), never `timeout*` or a race.
- Never signal a child without a pid (pid 0 is the caller's own group), and
  never resolve a Windows command from the working directory.
- Liveness covers the whole tree (process group, cgroup), not just the root.
  A group left with only zombies is gone; only an exact member scan proves it.
- Natural exit retains deliberately surviving children; timeout, interruption or
  output-limit cancellation terminates the tree.
- Scope owns process acquisition before configuration or other interruptible
  post-spawn work. Failed owner hooks also release the acquired process.
- Subscribe to a child's events in the same synchronous step as the spawn
  (`SpawnSpec.onSpawned`, an `Effect.callback` register).
- The Effect core forbids Promise APIs, timers, `AbortController`s and mutable module
  state; only the final facade section of `process.ts` exposes Promises. Tests use `@effect/vitest` with `TestClock` and
  `process-testing.ts` (the fake process table); a real-process test waits on
  explicit readiness output, never on elapsed time.

## File locks (`file-lock.ts`)

- Native workflows compose `withFileLock` through one owner-provided `FileLocks`
  service. Only unmigrated application entrypoints use `fileLocksLegacy`; keep
  Legacy visible and never execute it inside a native Effect workflow.
- Resolve each operation using explicit locksDir, current LODY_LOCKS_DIR, then
  current profile locks; production composition must not freeze environment paths.
- Use the owned Ref/Deferred handoff for strict FIFO and fail-fast same-context
  reentry. Preserve profile paths and deadlines beginning after local admission;
  a plain Semaphore cannot preserve immediate-reacquisition FIFO in 4.0.2.
- Publish complete metadata exclusively; register release before the body. Cancelled
  tickets leave the queue immediately. Retain failed release generations, verify
  pid plus token, and surface unreadable-lock/cleanup errors. Changed stale
  generations must return to backoff/deadline checks. Stale cleanup also collects
  crash-orphan scratch using ownership/age checks, preserving fresh live
  candidates and giving unidentified preparation a 30-minute grace period. Decision and limits:
  [file lock lifecycle](../../../../.agents/notes/implemented/architecture/2026-10-10-effect-file-lock-lifecycle.md).

- The holder waits once (5 seconds) for its file and scratch. A slow or failed
  deletion never fails that holder: the service retains it, and successors join
  it within their acquisition deadline, charged once per attempt (later ones fail fast).
  Only `LockOwnershipLost` fails the holder.
  Only settled failures permit a new deletion attempt.
- Retry acquisition only. Use `squashFileLockFailure` at Legacy boundaries
  ([holder release](../../../../.agents/notes/implemented/architecture/2026-10-16-file-lock-holder-release.md)).

## Supervised Inbox compatibility

Supervisor launch contract v3 requires Inbox protocol v2. TS and CJS constants agree.
A mismatched supervised worker exits 45 before host ownership/storage; do not downgrade
to an earlier worker contract. Foreground arbitrary old binaries are unsupported.

## Local Loro writer boundary

`local-loro-writer.ts` owns the real Node turn and socket write/drain adapters.
Applications provide one process-wide writer; never add a workspace scheduler.
Native workflow and release rules: [writer](../local-loro-writer/AGENTS.md).

## Local session control

Align history requests/receipts in Zod and both TS/CJS guards. The declared-operation
suite must admit every supported operation; advertising alone is insufficient.

E2EE uses same-user sockets only. `e2ee-identity.ts` holds sibling SQLite leases;
reset drains native owners, archives whole directories and retains idempotent receipts.

## E2EE test clock

`e2ee-clock.ts` provides the existing Effect Clock at native E2EE entry points.
The compile-time gate and runtime `LODY_E2E=1` are both required. Public builds
compile the gate to false and remove the file adapter. Test compositions alone
may enable it. Preserve the same clock object across operations; new clock
domains must not restart durable epoch grace. The private owner-only file moves
wall and monotonic readings together; sleep and process ownership use real time.
The inspector is passive and cannot initialize or mutate the clock.
