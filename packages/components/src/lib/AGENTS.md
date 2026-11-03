# Shared UI helpers and file surfaces

Callers follow these rules. [Background](../../../../.agents/docs/components-package.md).

- Ordinary uploads require trusted account/workspace mode admission, not provisional
  runtimes. Protected failures never permit ordinary HTTP/plaintext local fallback.

- Send/RPC await local commits, never Repo flush. Save `humanInputReceipts` before activation; RPC is redundant.
- Encrypted sends refuse a host-verified machine withdrawal before any write. [Gate](../../../../.agents/notes/proposed/architecture/2026-10-28-e2ee-machine-sharing.md#sender-withdrawal-gate).
- Retry immutable Roost input; absent receipts stay unknown. Cache/refresh keeps
  all input. Resolve owner routing per call.

- Markdown caches hold bounded raw ASTs per grammar; clone per use; skip streams.

Organization queries require matching authenticated sessions.

## Electron IPC types

- `electron-ipc-client.ts` imports main's `ElectronIpcServices` with `import type`
  only. Browser/mobile erase it; shared UI has no Node APIs/Electron runtime dependency.

- Keep `experimentalDecorators`/direct catalog-pinned `@types/node`. Constructors
  own invoke signatures; never duplicate them in contracts/Specs/ports. Resolve
  erasure here or reconsider ownership. Push/one-way types use `@lody/shared/electron-ipc`.

## Crash recovery and diagnostics

- E2EE repair archives originals and uses account-bound native reads; keep conflicts.
  Readable evidence skips native work. Isolate bad intents.

- Every build shows the real error and one-click report from
  `error-boundary-report.ts`; `showErrorDetails` alone opts out of visible details.

- Error/not-found screens use `components/status-page.tsx`. Pre-React
  `boot-failure.ts` uses its V2 tokens in plain DOM, never React/StyleX/Tailwind.

- Crash screens never reload/restart/reset themselves. `resetKeys` cannot clear
  captured errors; retain copyable reports until explicit recovery.

- Cloud queries keep throwing into render; optional surfaces own inline
  `ErrorBoundary` instances to contain backend failures.

- `lib/clear-local-cache.ts` owns `restartIntoCacheClear` (rebuildable `lody*` caches,
  one-window reload, retain sign-in) and confirmed `startHardReset` (full wipe/sign-out,
  host-native first). Delete at next boot; clear synchronous storage before the flag.
  Record results; never repeat unasked.

- IndexedDB clearing deletes only `clear-local-cache.ts`'s listed rebuildable
  caches/replica/cursor families, for both discovered and caller-supplied names.
  Preserve unknown databases, custody, installation receipts and unresolved originals.
  Explicitly list new caches; durable host stores never use disposable cache names.

- Clear localStorage with a DELETE list, never a keep-allowlist. Include Streams
  JWT/gateway, cursor-bypass, workspace-info and new `lody:*` caches; preserve auth
  tokens/preferences.

- Reports include the compact `lib/session-render-trace.ts` tail. Traces never
  drive behavior; mount/unmount traces use layout effects.

- `client-log.ts` records crashes/unretried failures for bug reports using events/IDs,
  never prompts, history or file content.

- `maybeClearLodyCacheOnBoot` runs once per page load; `RuntimeProvider` awaits it
  before opening repo IndexedDB.
- Route waits use `BlockingWaitPlaceholder` with recovery at 30s, never bare
  `LoadingPlaceholder`/`BootShell`. Failures use `RouteMessage` with `gate` (`null`
  is not failure). `MainLayout`'s `stuck-connection-banner.tsx` opens the same
  recovery page after 45s loading. Never clear replicas automatically.

## File Preview and Code Collab

- Remote file surfaces read owner file-index Flock. Local trees/All Changes first
  use `code-collab/get-file-index` Machine RPC, then Flock subscriptions. Failed/late
  subscriptions never block IPC or fall back to cloud. CLI reconciliation converges
  stale joins. Exact content/save/LSP/diffs also use Machine RPC.

- `openFile` uses File Preview v3 without watches, All Changes recomputation or
  Flock writes. Electron verifies disk identity and reads IPC independently of
  daemon/index readiness. Unknown targets never use Streams; confirmed remotes
  use restricted, bounded `file/preview`.

- Encrypted remote roles come from verified ledger status, never organization
  listings. Before signing, refuse non-reader-list methods for non-writers and all
  remote file methods without host feature RPC, with non-retryable copy. The machine
  still authorizes. [Decision](../../../../.agents/notes/implemented/feature/2026-10-28-e2ee-file-preview-availability.md#browser-and-mobile-consumers).

- Only small local text enters full-document editors/caches. `paged-text` is readonly
  and bounded; never use it for saves, executable HTML, rendered Markdown/SVG or
  full copy/download. Hidden viewers abort reads; virtual rows plus one page bound
  memory independently of file size. Local binary previews use resource URLs, never
  base64; neither local nor remote binaries enter text-open caches.

- Indexes never gate opens: send unindexed paths and leave binary
  `unavailableReason` unset. `external: true` forces readonly; saves stay in the
  Session workspace.

- Shared Zod helpers validate index rows. Preserve lazy-directory structures;
  `@file` initializes directories before refreshing.
- Turn diffs use only CLI-local evidence, never disk, All Changes or removed v1
  capture. Cross-render file/diff concurrency limits release slots only on settlement.

- Preview/More shell actions share `useSessionFileActions`, available only to
  same-machine Electron. Preserve explicit absolute artifact paths; never launch
  remote paths on the viewer's machine.

- Native file/PNG sharing uses complete authorized bytes, never paths. Preserve
  limits; isolate caches and clean on handoff/failure/cancel. Distinguish cancellation
  while retaining preview/selection.

- Before changing conversation Markdown/PNG exports, read the
  [conversation export rules](../AGENTS.md#conversation-exports).

## File identity, caching, and errors

- `session-file-open-target.ts` preserves canonical paths/other local worktrees
  and decodes Markdown URL/line suffixes/host roots. `resolveDirectMarkdownFileOpenTarget`
  opens absolute/index-confirmed conversation paths without discovery. Copy retains
  authored paths; anchors remain fields.

- Cache opens under `response.path` for saves and requested paths for viewers/change
  checks. Saves refresh every `cacheKeys` alias. Preview tolerates case; `save-text`
  requires exact case.

- In `session-file-error-state.tsx`, "outside the workspace" means policy rejection,
  never "Access denied"; CLI retains that phrase. "owner session mismatch" means
  startup race; advise "try again".

- Read [path provenance and skipped entries](../../../../.agents/docs/components-file-paths.md#known-gaps)
  before repairs. Distinguish directory failures; preserve `openFile`'s index
  `readonly`; opening a file must not make it uneditable.

## Dropped files and folders

- `file-drop.ts` splits OS `files`/`directories` via `webkitGetAsEntry().isDirectory`;
  folders never upload. Only `dropped-local-path.ts` bridges Electron
  `webUtils.getPathForFile` to absolute forward-slash paths. Web/mobile directory
  drops insert nothing. Commit all paths together via `mentionActionsRef.insertPathMentions`,
  one `dir` range each, preserving POSIX/Windows roots (`/`, `C:/`).

## ACP dispatch

- Independent Plan toggles retain Roles; match other pins.

- Role cleanup requires fresh matching runtime schema/owner access. Conditional
  transactions retain concurrent edits and model/permission pins.
  [Contract](../../../../specs/agent-role-schema-reconciliation.md).

- `formatAgentRateLimitWindowLabel` shows every reported window with localized
  duration, even when duration/utilization/reset match.

- Before creating top-level or child sessions, call `filterAcpSessionConfigOptionValues()`
  so cached values outside the current selector schema are neither dispatched nor persisted.

Attachment lifetime: [workspace ownership](../providers/AGENTS.md#attachment-transfer-ownership).
