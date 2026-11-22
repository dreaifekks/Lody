# Ephemeral `/btw` side chat

Provider-agnostic, memory-only side questions inside an active session without
creating a Loro session document, polluting the main conversation context, or
displacing another secondary panel / Article split. On standalone wide desktop
pages it opens in a resizable right side panel; when another split is active or
the viewport is narrow, it overlays the current conversation in place.

## Cross-module architecture

- **Shared contract** (`packages/shared/src/btw.ts`): defines the multiplexed
  `session/btw` request (`action: 'ask' | 'cancel' | 'close'`), progress
  (`status` / `delta`), response schemas, and `pickBtwFastConfigOptions` for
  dynamic fast-model + low-reasoning selection from live ACP `configOptions`:
  - `antigravity` / `antigravity-acp`: prefers `gemini-4-hydrogen` (`low`,
    `plan`), falling back to `gemini-3.8-flash` / `hydrogen` / `flash`.
  - `claude`: prefers `haiku` (`low`, `plan` / `dontAsk`), falling back to
    `claude-haiku-*` / `sonnet`.
  - `codex`: prefers `gpt-6-luna` / non-legacy `luna` / `gpt-6.2-sol` (`low`,
    `read-only`).
  - Other ACP providers: fall back to `leastPermissionModeRank` + lowest
    reasoning option.
- **Streaming transport** (`packages/loro-streams-rpc`,
  `packages/components/src/providers/workspace-machine-rpc-facade.ts`):
  `session/btw` is intentionally excluded from `DIRECT_RPC_METHODS` and bypasses
  `canUseLocalMachineRpc` so local and cross-machine LAN callers share the same
  Streams RPC SSE `onProgress` path. `BtwService` flushes the first non-empty
  text chunk immediately and coalesces subsequent chunks every 90 ms.
- **Target-machine daemon pool** (`apps/cli/src/btw/`):
  - `btw-service.ts`: memory-only `BtwService` wired into `message-handler.ts`
    (disposed on shutdown). Never touches `SessionManager`, `LoroDocumentManager`,
    `SessionMeta`, presence, push, or `turn-diff-store`.
  - Pool invariants: `maxActive = 2` with synchronous slot reservation
    (`handles.size + reservedSlots.size <= maxActive`) and LRU idle eviction;
    4-minute idle TTL sweep; dedicated 2-slot startup gate independent of
    `AcpSessionStartGate`; per-turn `Symbol` token fencing (`turnToken`); dirty
    handle eviction on cancel if the raw ACP prompt is still pending; bounded
    15 s config timeout + abort-driven child cleanup on `cancel`/`close`/`dispose`.
  - `btw-context.ts`: reads the main session's trailing 8 turns transiently from
    `SessionBackend` via `buildReplayPromptFromHistory` (`maxChars = 16_000`,
    `terminalTailChars = 512`, thinking stripped, tokens redacted) and combines
    it with frontend-supplied `articleContext` (`excerpt <= 12_000`,
    `selection <= 4_000`) on cold start / re-warm. Warm follow-ups send only the
    new question (plus changed `selection` / `path`).
- **Frontend UI** (`packages/components/src/components/sessions/btw/`):
  - Per-session Jotai `atomFamily` (`btw-atoms.ts`) and controller
    (`use-btw-controller.ts`): 1 ephemeral `/btw` thread per main `sessionId`
    (re-opening, typing `/btw <question>`, or clicking `/btw` on a document
    selection enters and appends; clearing aborts, resets memory turns/draft,
    and sends `action: 'close'`). Re-entering a session defaults back to Main:
    hiding (`isVisible: true -> false`), switching tabs/sidebars, or unmounting
    resets `isOpen` to `false` while preserving turns, `btwId`, `hasUnread`,
    and background streams (explicit open/selection triggers still open and
    focus on entry, guarded against StrictMode remounts).
  - Adaptive presentation (`btw-layout.ts`, `btw-side-panel.tsx`,
    `btw-stream-view.tsx`):
    - **Wide standalone desktop page** (`allowBtwSidePanel` — no other side
      panel, Board thread, Article, or Worktree Review split active, not
      compact desktop/mobile — and `ResizeObserver` surface width `>= 900px`):
      opens `/btw` in a resizable right `BtwSidePanel` (default `380px`, min
      `300px`, main column min `460px`, max `50%`) with its own `ChatComposer`
      so Main stays visible beside it.
    - **Overlay fallback** (any other split active, inside a side thread, or
      width `< 900px` / mobile): overlays the current conversation and shares
      the single main composer (`session-chat-input-area.tsx`,
      `session-chat-interface.tsx`) with separate Main vs `/btw` drafts,
      smoothing focus handoff across mode transitions.
  - Single-icon toggle in `SessionInfoBar` (`btw-info-bar-toggle.tsx`) right
    after `relations`: shows `MessageCircleDashed` (with busy/unread/history
    corner dot) while in Main, and swaps to the Main status icon colored with
    global Lody status tones (`Hand` warning > pulsing `MessageCircle` accent >
    `CircleAlert` danger > `MessageCircle` success > neutral `MessageCircle`,
    with 1-line hover tooltip) while in `/btw`.
  - Routing, shortcuts, and Escape scoping (`session-chat-input-area.tsx`,
    `session-chat-interface.tsx`, `session-conversation-page.tsx`,
    `session-detail.tsx`): intercepts `/btw` in Main (preserving main
    attachments and Article annotations, without interrupting an already
    streaming side-panel `/btw` turn); keeps Article "Send annotations" routed
    explicitly to Main; allows opening `/btw` even while a Main permission card
    is pending; intercepts `Escape` in capture phase scoped to the focused
    conversation root (`data-btw-open-surface`, skipping search bars/menus) so
    closing `/btw` never dismisses `BoardArticleDialog` or steals focus across
    visible panes; bound to `Mod+/` via `session.toggleBtw`, using
    `resolveSessionBtwCommandTarget` so Worktree Review / Article side threads
    target the visible thread and standalone Worktree Review does not hijack a
    background coordinator.
  - Article & File Viewer integration (`document-selection-surface.tsx`,
    `session-file-content-view.tsx`): adds `/btw` next to `Comment` on text
    selection and maintains a priority-ordered `ownerId` context stack per
    session (Article priority 2, File Viewer priority 1) so closing an Article
    restores the underlying File Viewer context automatically.
  - Storybook coverage: `packages/components/src/stories/BtwSessionBar.stories.tsx`.

## Isolation and known provider boundaries

Three-layer isolation (`apps/cli/src/btw/btw-isolation.ts`,
`apps/cli/src/agent/agent-client.ts`, `apps/cli/src/agent/acp-runner.ts`):

1. **Lody layer**: omits `memoryEnvironment`, strips all `NMEM_*` after
   login-shell merge, sets `LODY_BTW_AGENT=1`, forces `disableBuiltinMcp: true`
   (`mcpServers: []`), `terminalEnabled: false`, `readOnlyFs: true`, and
   `disableReadTextFile: true` in default text-only mode.
2. **Provider layer**:
   - `antigravity` / `antigravity-acp`: temp `--gemini-dir` (`0o700`) with
     copied (`0o600`) OAuth token + `installation_id`, dropping
     `--process-per-session` and `--dangerously-skip-permissions`, adding
     `--include-default-customizations=false --disable-telemetry`.
   - `codex` (file-backed `auth.json`): temp `CODEX_HOME` with symlinked
     `auth.json` (preserving single-file OAuth token rotation; managed profiles
     also symlink sibling `processes`), stripped `config.toml` (no hooks,
     plugins, or `mcp_servers`), and `CODEX_CONFIG` disabling project docs,
     environment context, and skills.
   - `codex` (legacy OS keyring profile): keeps canonical `CODEX_HOME` for
     keyring lookup while disabling `features.hooks`, `features.plugins`, and
     user `mcp_servers.*` / `plugins.*` via `CODEX_CONFIG` and
     `LODY_CODEX_PROFILE_CONFIG`. Untrusted repo `.codex/config.toml` entries
     are not injected as partial overrides.
   - `claude`: sets `CLAUDE_CODE_SAFE_MODE=1`.
3. **Fail-closed `nmem` guard**: sets `NMEM_IGNORE_HOST_CONFIG=1`,
   `NMEM_API_URL=http://127.0.0.1:1`, `NMEM_API_KEY=""`,
   `NMEM_CONFIG_PATH=/dev/null`, and `NMEM_COMMAND=/bin/false`.

Read-only escalation (`readOnlyTools: true`) delivers the main session workdir
only to providers with native read-only mode enforcement (`antigravity`,
`claude`, `codex`) and verifies the returned `currentValue` from
`setSessionConfigOption` (or legacy `modes`) before accepting the handle.

Known provider boundaries (accepted for personal LAN fork):
- **Built-in `pi`**: never receives the real session workdir and is downgraded
  to text-only mode, but `packages/acp-extension-pi` does not expose a native
  no-tools/read-only switch to block its own absolute-path file/shell tools.
- **Codex legacy keyring profiles**: hooks, plugins, MCP, and Lody session
  storage are isolated, but upstream `acp-extension-codex` uses non-ephemeral
  `thread/start`, leaving a local rollout entry under `~/.codex/sessions/`.

## Deferred Phase 2 scope

- Promote `/btw` thread into a real worktree-sharing child Tab (`createDraftSessionTab`).
- In-drawer model switcher / global pinned `/btw` provider preference.
- Message-body selection (`MessageQuoteAction`) and HTML Article iframe selection hooks.
