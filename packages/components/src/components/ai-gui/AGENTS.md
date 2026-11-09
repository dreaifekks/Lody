# components/ai-gui

Ownership: [README.md](README.md).

## Stream And Search

- Search indexes prose only: user/assistant text, thinking, and proposed-plan
  markdown, including folded prose; matches open their groups. Never index tools
  (titles/JSON/output), terminals, diffs, plan checklists, goals, or worktree script
  output. Never wire `searchBlockId` to tool, terminal, or diff renderers.
- Window stream readiness must use same hydration/initial-scroll conditions as
  viewport visibility; hydrated history alone cannot reveal a native window.
- Stream scrolling uses `ConversationListHandle` and the
  [engine](../../lib/conversation-scroll/AGENTS.md) only. Use turn-ID keys through
  local/history handoff. Local UI stays outside history/outline/export and owner
  facts; its selection has no history lease.
  Map history indexes to rows. Collapsed activity is one row; expanded details
  are siblings, never nested scrollers or fixed-height panels.
- Native selection retains its row corridor and history leases: hold prose/folding,
  keep actions live, release on clear. [Contract](README.md#native-text-selection).
- `buildChatStreamItems()` must drop empty assistant entries and de-duplicate
  history ids.
- `leadingContent` is a real first row: include it in sticky counts and scroll
  targets; never overlay or persist it.
- Empty state stays outside the list even with an empty leading Fragment; zero-height
  caches can hide the first user row. Keep activity labels/tones and one header inset.
- Creation cards: [contract](README.md#creation-progress). Bind status to the
  target Turn (a Board main session's follows the thread) and subscribe only to its title; `progressMessageId` prevents
  duplicates. Share a five-card scroller; retain full hydration.
  Keep concrete cards; hide contentless successes and their empty batch rows.
- Reveal scroll-to-latest during live work on hover/focus with StyleX selectors, not presence state.

## Turn Folding And Layout

- Work regions start expanded while streaming and may be folded by the reader.
  Finished turns keep the final contiguous text run before trailing attachments,
  plans, independent cards and notices visible; all earlier prose folds with thoughts and tools.
  Keep LAN share publication independent.
  Apply this rule per plan segment regardless of ACP phase or provider.
  Interrupted work without a visible result stays expanded. Expanded details keep
  chronological order, with the header before the first work item.
- Plan approval cuts a live turn by ACP kind `switch_mode`, never title.
  `plan-surface.ts` prefers nonempty `rawInput.plan` over replaceable tool content.
  Keep `workBlockKeys`, `hasVisibleFinalContent`, last-item visibility and expansion
  keys per segment. Only the last segment shows duration; earlier segments say
  "Finished working".
- Standalone tool surfaces remain independent cards outside activity groups.
- A finished `shouldUseWorkedGroup` requires foldable work and visible final
  content outside `workBlockKeys`. A cancelled/interrupted or tool-only turn
  with no answer stays expanded; `message.finished` cannot prove completion
  alone. Reopened entries clear `finished` and `endedAt`.
- Thought/tool timelines are transparent, 13px and glyph-free, with verb labels.
  Execute calls are not cards. Disclosure labels lead; chevrons trail (desktop:
  hover-only, body type, no fill). Only DSH shows thoughts, using answer type and
  secondary ink. Default thoughts open/tools closed; explicit toggles win. Footers show config.
- Expanded steps use `ToolDetailSheet`: composer fill, card shadow, no duplicate
  header, ordered sections, Shiki commands and ANSI output without command echoes.
- Duration appears once: desktop folded header or footer after buttons; mobile
  footer before buttons. Preserve `MOBILE_TURN_ACTION_LEADING_INSET_PX`.
  Mobile buttons rest hidden but the newest turn's; a tap reveals one message's.
- Live status precedes a trailing subagent task summary, including when the turn
  has no footer.
- Streaming replies show Copy and initial turn-config info; Fork needs a finished turn.
- `ConversationColumn` owns the gutter; row shells add no horizontal pad. EVERY
  row shares one rail: prose, process labels/steps, live status and the mobile
  footer sit at `conversation.railInset`; thought prose aligns with its label.
  Footer bleed is trailing-only (`-mr-[7px]`). See `AssistantTurnAlignment.stories`.
- The trailing row (`trailingContent`: pending sends, continuation notes) is
  full-bleed like the scroller, so each item mounts its own `ConversationColumn`.
  Stream rows never rely on the row shell for width or gutter.
- Follow the StyleX [spacing contract](../../../../../specs/conversation-rhythm.md).
  User rows own `responseGap`; assistant tails own `roundGap` (desktop: including
  footer/metadata; mobile: below the footer).

## Conversation Outline

- Outline, arrival-intent and row-index-to-scroll changes follow
  [conversation-outline.md](conversation-outline.md): only `scrollRowToTop` converts,
  group toggles never scroll, and each jump issues once; the engine holds its row at top.

## Content Contracts

- Only absolute or owning-index-confirmed paths become interactive. Keep other
  paths as text/code. Open known targets directly; copy the authored path.

- Child cancel requires subagentCancellation/subagentEvents v1, `support.cancel`
  and an exact parent turn; never Stop the parent or invent state. Dialogs reuse
  parent renderers/grouping, one scroller, and read run bodies only while open:
  [task/dialog contract](README.md#subagent-tasks).

- Text roles: `@lody/ui`; prose: `conversation.readingLeading`; compact prose/code:
  subheadline, no nested `em`. Message sizes: `conversation-font-size-classes.ts`;
  hosts require CSS typed division. Stream engine: live turns only;
  remounts show existing text immediately and animate only additions.
- Rendering and search share CJK emphasis rules.
- Mermaid starts as a still preview, activates on click and never takes an
  unmodified wheel. Deactivation preserves pan/zoom; activation adds no outline.
  Follow the [inline contract](../../../../../specs/mermaid-inline-view.md).
  `mermaid-diagram-viewer.tsx` stays the only full-screen surface, reached from
  the block's action bar. Invariants:
  [mermaid-diagram-rendering.md](mermaid-diagram-rendering.md).
- `chat_failed` and `agent_warning` share ONE always-open `AgentNoticeBanner`,
  never a modal, and fold onto the emitting assistant row at RENDER time only —
  never into the `ConversationView` that copy/share/replay read. Extraction
  stays in `chat-failed-error-report.ts`. Invariants, tones, and capacity-retry
  consent: [agent-notices.md](agent-notices.md).
- Terminal persistence and legacy preview bounds live in
  `context/terminal-output-lifecycle.md`. Never send full legacy output through
  ANSI parsing, search, or React rendering.
- `assistant-edited-files.tsx` shows four paths before expanding, no per-file
  pills, list on `--background`.
- Update `message-content-guards.ts` with every shared `MessageContent` variant.
  `isMessageContent` gates rendering; a missing case silently drops the item.
- `lastMissingHistoryUserMsgId` renders "Not delivered", the sole recovery entry.
  Its dialog resends as a new message, cancels the old entry and retains the
  tombstone. Never automatically revive or dispatch the old turn.
- Frozen Agent/Role names/icons never use human profiles or live catalogs. Human names
  sit right of time; only desktop avatars open accessible name/email cards.
- Attachment layout, preview continuity, and mobile previews follow
  [session-files-rendering.md](session-files-rendering.md).
- Markdown images remember each source's natural size or failure for the page's
  life: a virtualized remount must render at its final height (failed sources show alt text).
- Live file Markdown images and plain-text image links use owning file provider:
  same-machine reads are automatic; remote ones need a per-image click. Anonymous
  shares never get this resolver. Release own Blob URLs; drop late reads.
