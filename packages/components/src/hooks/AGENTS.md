# React hooks

Parent rules apply. Edit `AGENTS.md`; `CLAUDE.md` links here. Read [README](README.md).

## Conversation scrolling

- The scroll engine owns the viewport: [its rules](../lib/conversation-scroll/AGENTS.md).
- Only viewport/tail/selection render bodies; other reads keep placeholders.
- Key readiness/window by the view; a new view resets both. Before the
  first viewport report the window is the tail plus the restored anchor's turn;
  ignore reports until the initial window is ready.
- A cached session renders in the frame after its click: no promise tick,
  effect-only state or deferred setState before its first cycle.

## GitHub PR access

- Public PR reads grant no hosted write access and never reuse authenticated
  caches. Known repository IDs must match.

## Sharing errors

- Keep error operation context independent of React progress state (which resets in
  `finally`). `lib/session-share-errors.ts` maps only known codes to localized advice;
  never display raw errors or claim a lost mutation response proves failure.

## Session and auth

- Native iOS layout follows observed document width during folds; other hosts use
  window width.
- Authenticated cloud queries share one subscription/retry budget per client,
  session and arguments. Retry only opaque server failures; show loading, not stale
  access rows, then throw on exhaustion. Auth recovery stays separate; crash recovery
  is user initiated. [Implementation](README.md#cloud-query-recovery).

- Cloud auth recovery has a per-session budget and per-attempt deadline; loading or
  visibility changes never reset it. Exhaustion requires explicit retry or sign-in.
  Preserve mounted routes and local data.
  [Contract](../../../../specs/auth-recovery.md).

- Provider overrides govern model catalogs and command previews. Sessions own actual commands.

- History uses SessionData commands.
- Existing-session run-config drafts store only edited fields, scoped to account,
  workspace and session. Only successful local admission retires captured field
  generations; remote Turns never consume them. Never retain history IDs or empty
  visited-session entries. Deletion/account teardown invalidates edit callbacks;
  navigation preserves intent. [Contract](../../../../specs/session-run-config-drafts.md).
- Held-send config is a session/runtime selection input, never stored resolved
  selection. Preserve its logical Turn fence across history/queue handoff. Draft
  edits win; attachment progress never rebuilds the catalog.

- A proven-undelivered steer (`no-active-turn` or `promotion-failed`) repairs ordinary
  dispatch for pending/seen entries even if CLI already changed their status. Never
  repair active, terminal, removed, or delivery-unknown turns.

- `useStableSession` verifies an `authClient.useSession()` HTTP 401 once with
  current credentials. Only a second 401 on the unchanged token is terminal:
  stop retries, ignore cached user/bootstrap/grace state and confirm unauthenticated
  so root sign-out clears Lody auth and platform credentials. Token rotation or
  successful verification fences old replies. Honor `nativeSignInInProgressAtom`
  from initial native sign-in through page replacement. Timeouts, 5xx,
  `Client disconnected` and userless in-flight refetches never sign out users.

- `use-session-doc.ts` publishes the initial snapshot immediately. Coalesce
  history-only events to the latest snapshot once per frame through
  `lib/latest-frame-subscription.ts`, never direct `setState`. Keep control state
  (`session`, message queue, fork, preview, external cursor) synchronous.

- `use-safe-area-insets.ts` owns one module store, stable snapshots for unchanged
  values and document-lifetime resize listeners. Never call `getComputedStyle`
  per instance.

- `use-keyboard-navigation.ts` navigates at most once per painted frame. With no
  frame owed, navigate/re-anchor on press; otherwise advance only the target.
  Never time-debounce navigation.

Legacy cloud machine, project, inbox, GitHub and usage catalogs require the
runtime admission atom's explicit ordinary or legacy descriptor bound to the current
account, workspace ID and route slug. Unknown mode stays pending; local runtime
opening, reading and input remain available. Encrypted workspaces never query
these catalogs, even after pairing. Use the shared legacy query/mutation/action
wrappers; imperative operations recheck live admission before sending and retained
callbacks cannot cross accounts. The repository legacy-cloud check rejects direct
references; its inventory owns the exact control/CLI exceptions. Preserve ordinary errors and owner-only local
visibility; skipping a catalog grants no machine or execution authority.

## Workspace catalog

- `use-workspace-catalog.ts` borrows `lib/workspace-catalog-room.ts`'s ref-counted
  room. Never open/subscribe/join per mount. MCP and Roles share its one Flock
  document and preserve snapshot identity across consumers.

- Role/MCP catalog `upsert`/`remove` resolve on DURABILITY; upload runs independently
  and no surface waits for or reports it.
- MCP: [rules](../../../../specs/project-default-mcp.md).
- Role filtering uses shared `listAccessibleAgentRoles` / `resolveAgentRoleAvailability`,
  never local predicates. Availability stays `unknown` until bound machine configs load;
  subscribe exactly those machines. Settings rows describe their own binding;
  `machine_offline` belongs to the group pill.

## Code Collab

- File-index hooks borrow owner-session resources from the workspace Effect
  `ScopedCache`, never open/scan/subscribe/join per mount. Subscribe before cold scan,
  advance by batches and compare Flock versions before remote catch-up rescans.
- Each cache entry owns a loro-repo Flock lease. LRU eviction closes room/Flock
  subscriptions, releases the lease, then unloads. Late joins unsubscribe and
  best-effort unload again. Never cache failed opens; invalidate failed resources
  when their last borrower releases.

- Workspace disposal closes borrower Scopes before destroying the repo. Provider
  memoization includes cache-resource identity. Local-machine RPC snapshots seed the
  shared resource before exposure; later Flock events stay deduplicated across mounts.

## Mobile prompts and Live Activity

- `use-app-store-review-prompt.ts` seeds eligibility from the first ready/synced
  snapshot without prompting for hydrated turns. Process finalized turns once;
  streaming without a new outcome never rewrites storage synchronously. The idle
  timer keys on the stable candidate turn, not the outcomes array; its negative
  context gate reads a ref.

- Persisted state (`lody:app-store-review:v2:<userId>`) is device-local, not synced, and
  deliberately NOT in `clear-local-cache.ts` (user state, not cache). Store only the
  newest 50 completed-turn timestamps plus the last attempt time.
- NO stored time may ever be in the future: reject future input (deferred, not lost)
  and drop stored future times.
- Keep the product gates at engagement + cooldown + a narrow negative-context check;
  never add a rate limiter on top of StoreKit's own cap.
- Emit `mobile/app_store_review_prompt_requested` once per bridge call.
  `_blocked` identifies the first blocking gate (`resolveAppStoreReviewBlockReason`,
  missing bridge, text entry, interaction cancellation or hidden app), deduplicated
  per user/reason for the process lifetime. Preserve both bounds for new gates.

- `use-lody-live-activity.ts` sends every summary input through one leading-edge
  throttle, with the trailing deadline anchored to the last emit. Bridge debounce
  alone cannot prevent starvation.

- Nothing reaching the payload memo may carry a per-render identity: depend on the
  permission candidate's key.
- Keep the bridge debounce at 250ms.
- Pending permissions from the UNTHROTTLED list flush the window. Summaries stay
  silent and refresh all rows; ordinary Push owns alerts.
- Compute nothing when disabled: both `iosLiveActivitiesEnabledAtom` and the native
  iOS shell are required, not equivalent. Derive activity id separately so disable
  and unmount can end an activity the payload no longer describes.
