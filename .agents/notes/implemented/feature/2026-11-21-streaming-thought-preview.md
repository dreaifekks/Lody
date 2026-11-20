# Streaming thought preview under collapsed live activity headers

Status: implemented
Translation: current

[中文](2026-11-21-streaming-thought-preview.zh.md)

## Abstract

Agents that narrate work primarily through `agent_thought_chunk` (notably Antigravity CLI) leave running turns showing only a collapsed tool-count header because adjacent thoughts and tool calls merge into one default-closed activity group. This fork adds an opt-in, render-only two-line preview of the latest thought paragraph directly beneath the trailing collapsed activity header while a turn runs. It reads synced turn history rather than presence, preserves completed-turn folding, and adds low-stimulus pacing. Real-session chunk granularity and native iOS rendering remain outside this change.

## Decision

Keep the feature strictly in the conversation rendering layer (`streaming-thought-preview.ts` and `streaming-thought-preview-row.tsx`, with minimal wiring in `view.tsx`) behind the per-device experimental switch `streamingThoughtPreviewFeatureEnabledAtom` (`lody-streaming-thought-preview-enabled`).

- **Prerequisite upstream sync.** Cherry-picked upstream #2896 (`1c2a979cb`, keeping live status inside the streaming row's measurement boundary) first so live chrome and the streaming thought preview share the same virtual-row measurement boundary and minimize future merge conflicts in `view.tsx`.
- **Uniform across providers, render-only.** The preview scans the trailing collapsed activity group's `block.entries` backwards for the latest `thought` entry that yields a valid preview (falling back to earlier thoughts in the same group when the newest chunk is placeholder-only or unclosed) without branching on provider or model. Row matching skips trailing `footer` and `subagent_tasks` rows of the same assistant turn and stops on terminal turns (`finished === true || typeof endedAt === 'number'`, aligned with `history-apply.ts`). Stored history, ACP adapters, presence, and completed-turn answer-tail folding (#2353) remain untouched.
- **Avoids #807 regressions.** Upstream #807 omitted thoughts from history and pushed live thought lines over presence, flooding heartbeats. Reading synced history avoids presence traffic and keeps full thoughts in history, while working identically on LAN remote sessions.
- **Safe extraction for 138k+ thoughts.** A single O(n) forward index scan tracks cross-paragraph HTML comments continuously and checks unclosed leading `**` headings against full line bounds without slicing mid-line or using backtracking regexes. Inline Markdown cleanup runs only on a bounded 1024-char prefix of the selected candidate line, removing the Antigravity placeholder (`"I'm thinking through how to approach this."`), preserving inline code literals and balanced-parenthesis links, and capping output at 260 characters (`line-clamp-2`, `select-none`, aligned to `conversation.railInset`).
- **Anti-flicker and low-stimulus pacing.** Identical text deduplicates without resetting the hold clock. Updates hold for at least 1500 ms (4000 ms when `lowStimulusModeEnabledAtom` is on) and coalesce to the newest paragraph; transient empty/unclosed chunks retain the current preview and any pending throttled update within the same group, and switching groups resets immediately. Preview selection does not depend on `agentActivityShimmer`, so non-shimmer and low-stimulus states remain visible. Expanding the group or finishing the turn hides the preview immediately.

## Alternatives

- **Auto-expanding thought groups while streaming:** Exposes full tool lists and multi-thousand-character thoughts mid-turn, creating scroll churn and visual flicker.
- **Rewriting Antigravity thoughts as commentary text in the ACP stream:** Leaks full reasoning into `lody_session_history`, leaves trailing thoughts outside completed-turn folds on turns where a thought immediately precedes the final answer, triggers repeated unread indicators, and mutates stored message semantics.
- **Streaming latest thought over presence:** Reintroduces the heartbeat congestion that caused upstream #807 to be reverted (#852).

## Verification

- Extraction, placeholder/comment/unclosed-bold handling, 138k+ payload bounds, tool-tail retention, and row-key selection: [streaming-thought-preview.test.ts](../../../../packages/components/tests/streaming-thought-preview.test.ts).
- Throttle hold windows (1500 ms / 4000 ms low-stimulus), deduplication, group reset, virtual-row co-measurement, manual expand/finish hiding, and settings switch wiring: [streaming-thought-preview-ui.test.tsx](../../../../packages/components/tests/streaming-thought-preview-ui.test.tsx).
- Visual states (thought-only, tools retaining thought, expanded, low-stimulus, finished, disabled): [StreamingThoughtPreview.stories.tsx](../../../../packages/components/src/stories/StreamingThoughtPreview.stories.tsx).
- Unverified in this change: live Antigravity ACP chunk cadence on a running daemon and native iOS conversation rendering.
