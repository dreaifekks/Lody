# Experimental features

Features that are opt-in and still change. This page lists each one: what it
does, where it is turned on, what it needs, its known limits and where its
code starts. The fork keeps voice and agent tools; upstream retired automatic
review and merge.

## The switches

Settings > Preferences has **Experimental features** just above Advanced
(`packages/components/src/components/settings/experimental-features-setting.tsx`).
Its master switch, "Enable experimental features", is
`experimentalFeaturesEnabledAtom` in `packages/components/src/atoms/settings.ts`.
While it is on, its rows follow the master switch in the same section:

| Switch | Atom (localStorage key) |
| --- | --- |
| Voice | `voiceExperimentEnabledAtom` (`lody-voice-experiment-enabled`) |
| Notifications from agents | `agentNotifyExperimentEnabledAtom` (`lody-agent-notify-experiment-enabled`) |
| Plan review | `planReviewExperimentEnabledAtom` (`lody-plan-review-experiment-enabled`) |
| Interactive widgets | `inlineWidgetExperimentEnabledAtom` (`lody-inline-widget-experiment-enabled`) |
| Article window (under Boards) | `boardArticleExperimentEnabledAtom` (`lody-board-article-experiment-enabled`) |

Every switch is this device's own. A feature is on where both the master switch
and its own switch are (`*FeatureEnabledAtom`). Turning the master switch off
hides the features and keeps each choice, so turning it on again restores them.

The agent tools are also a workspace setting, because the machine that starts
an agent decides which tools it lists. Flipping one of them, or the master
switch, writes the tools this device has on into the workspace row
`['setting', 'agentTools']` (`writeWorkspaceAgentTools` in
`packages/components/src/lib/workspace-catalog-write.ts`); nothing is written
on mount, so a device that never touched the switches turns nothing off. The
whole list is written and the last device to write wins: turning the master
switch off writes an empty list, which takes the three tools away from every
agent the workspace's machines start afterwards.

```text
 Settings ─ agentTools row ─▶ workspace document ─ synced at agent start ─▶ agent service
 (this device)                                       loadSessionWorkspaceSettings   │
                                                                                     ▼
                                       lody MCP server lists the tools ◀─ LODY_MCP_AGENT_TOOLS
                                                                            x-lody-mcp-agent-tools
```

Each agent start syncs the workspace document once and reads the row
(`apps/cli/src/agent/session-mcp-resolver.ts`); the tool ids travel to the lody
MCP server as `LODY_MCP_AGENT_TOOLS` (stdio) or the `x-lody-mcp-agent-tools`
header (HTTP), defined in `apps/cli/src/mcp/lody-mcp-http-protocol.ts`. Only
agents started afterwards see a change. The ids, tool names and input schemas
are in `packages/shared/src/lody-agent-tools.ts`; the tool descriptions in
`apps/cli/src/mcp/agent-surface-tools.ts` say when to use each, because several
agents (Codex code mode, Kimi, Pi) never read the server instructions. A device
renders the calls specially only while its own switch is on; otherwise they
are ordinary tool steps. Widgets an agent shows without Lody's tool (below)
depend on that device switch alone, not on the workspace row.

Roost history remains disabled for the LAN platform, including its developer switch.
Existing conversations retain Loro history; the native Roost runtime is still packaged
because the upstream daemon imports it during startup.

## Voice

Dictation into the composer, and a spoken conversation with a session. Voice
runs as a realtime call of a Codex agent the user chooses, on its own throwaway
thread in a separate adapter process of that agent config, not the session's
agent. The machine only negotiates the WebRTC call and reports what was said;
the renderer holds the microphone and the audio goes between the device and
OpenAI. A spoken request is sent as an ordinary message of the current session,
whatever agent and machine run it, and its finished reply is handed back to the
voice to speak.

- Turned on: the Voice switch, then the rows under it
  (`packages/components/src/components/settings/voice-agent-select.tsx`):
  - Scope: "All devices" (default) keeps one choice in the workspace row
    `['setting', 'voice']`, synced to every device; "This device only" keeps
    it in localStorage (`voiceAgentSelectionAtom`, `voiceNameAtom`).
  - Agent: a built-in Codex agent config on any machine, so its account pays.
  - Voice: one from the Codex list, or Codex's default. Settings plays bundled
    clips for each (`packages/components/src/assets/voice-previews/`, recorded
    by `scripts/generate-voice-previews.mjs`).
- Needs: a machine that advertises the `realtimeVoice` protocol capability
  (version 3 lists voices and starts a call with one), and the patched Codex
  adapter and ACP core (`patches/submodules/acp-extension-codex/0001-*`,
  `patches/submodules/acp-extension-core/0001-*`).
- Limits: the new-chat composer offers dictation only, as there is no session
  to talk with. A dictation call still has a voice, which the renderer never
  plays. The voice thread runs with whatever the chosen agent config loads,
  such as its Codex home's MCP servers and hooks.
- Code: `apps/cli/src/agent/voice-host.ts` (the call on the machine), the
  `machine/voice` request in `packages/shared/src/machine-voice.ts`,
  `packages/components/src/hooks/use-voice-call.ts`,
  `packages/components/src/components/sessions/session-voice-controls.tsx`,
  `packages/components/src/lib/voice-conversation.ts`.

## Notifications from agents

`lody_notify_user` lets an agent ask for the user's attention: a decision it
needs, a block it cannot pass, or a long task that finished while the user may
be away. The notice lands in the session's metadata (`agentNotice`), which
desktops watch for their own alert. In a LAN workspace it also goes to phones
as a push after the same grace period as a completion alert, unless someone
read the conversation meanwhile.

- Turned on: "Notifications from agents"; the workspace `agentTools` row
  offers the tool, and this device's switch decides whether the desktop shows
  the alert.
- Needs: a local Lody workspace; the tool runs in the agent service, which
  re-reads the workspace row at every call, so a switch turned off since the
  agent started refuses it. Only a LAN workspace has a push port that sends it
  (`notifyAgentMessage` in `apps/cli/src/lib/lan/lan-push-notifier.ts`); the
  alert goes through the hub's push as an `agent-message` event, with the
  members' fallback
  ([credentials on every member](lan-credentials.md#credentials-on-every-member)).
- Limits: one notice per minute per session, six per session and thirty per
  machine in any hour; a refused call returns `retryAfterSeconds`. The desktop
  alert is the Electron app's only.
- Code: `apps/cli/src/lib/agent-notice.ts` (rate limit and delivery),
  `notifyUserFromAgent` in `apps/cli/src/lib/message-handler.ts`,
  `apps/cli/src/lib/lan/hub-push.ts`,
  `packages/components/src/components/electron-session-completion-notifier.tsx`.

## Plan review

`lody_request_review` lets an agent submit a plan in Markdown for review before
it implements it. The conversation shows a card, and the plan opens in a side
panel where the user comments on passages and chooses Approve or Request
changes. The decision goes as the user's next message, quoting the commented
passages; Approve also leaves plan mode, with the same turn configuration as
executing a plan. The server only answers the call; the plan travels in the
tool call, so the transcript is its only record. A later review replaces the
earlier ones, and a review is answered once the user wrote anything after it.

- Turned on: "Plan review".
- Limits: the panel has buttons only for the user's own, unarchived session;
  other sessions show the plan read-only. A plan is at most 100,000 characters.
- Code: `packages/components/src/components/agent-surfaces/` (`plan-review-model.ts`,
  `plan-review-card.tsx`, `plan-review-panel.tsx`,
  `session-plan-review-panel.tsx`), `buildPlanReviewTurnConfigOverrides` in
  `packages/components/src/lib/execution-turn-config.ts`.

## Interactive widgets

Agents draw clickable diagrams, charts and small explorables inline in the
conversation. Four forms render as widgets:

| Form                                    | Where it comes from                                          |
| --------------------------------------- | ------------------------------------------------------------ |
| `lody_show_widget {title, widget_code}` | Lody's tool, offered by the `agentTools` row                 |
| `show_widget` of the `visualize` server | Claude Desktop's tool, read with the same input              |
| A `visualize{"path":…}` line            | Codex's Visualize skill: an HTML file named in the reply     |
| `<agent-embed src="file://…">`          | Antigravity's generative UI: an HTML file named in the reply |

A file widget is read through the session's file preview on the machine that
ran the agent, also another member of a LAN, once the reply finished
streaming.

The desktop frames each widget from a page its main process serves on a
loopback port (`/widget`), sandboxed with `allow-scripts` only, under a policy
that loads scripts, styles and fonts from a few CDNs alone
(`LODY_WIDGET_CDN_ORIGINS`). Other builds frame the same page through `srcdoc`.
A link opens after the user confirms.

A node's `sendPrompt('…')` asks its question in a side chat: the conversation
forks at the widget's turn (or the latest finished turn) into a right-panel
tab named by the question, and the side chat sends it as its first message. A
question asked inside a side chat is sent there; the same question again
returns to its tab; questions asked while a fork is under way wait their turn.
Where a conversation cannot fork, the question only fills the composer. A
question counts only against a real press inside that widget's frame, which
the main process sees (`before-mouse-event`), one question per press.

- Turned on: "Interactive widgets". The workspace row decides only whether
  agents are offered `lody_show_widget`; the other three forms render wherever
  this device's switch is on.
- Limits: widget code is at most 200,000 characters; a file widget must be in
  the session's folder and at most 512 KB. The web app and Storybook have no
  main process, so their widgets ask nothing. Leaving the page while a first
  fork is pending can leave an empty, unnamed side chat.
- Code: `packages/shared/src/lody-agent-tools.ts` (forms and parsing),
  `packages/shared/src/lody-widget-shell.ts` (the page and its policy),
  `packages/components/src/components/agent-surfaces/` (`widget-tool-call.tsx`,
  `agent-text-widgets.tsx`, `widget-frame.tsx`, `widget-gesture.ts`,
  `agent-surface-context.tsx`), `apps/electron/src/main/services/widget-host.ts`,
  `widget-frame-guard.ts`, `widget-clicks.ts`; the side chat in
  `packages/components/src/components/sessions/session-detail.tsx`.

## Graduated: next message suggestions

Claude's guess at the user's next message, shown in the empty composer and
taken with Tab. It left Experimental features and is the "Next message
suggestions" switch of **Agent features** in Settings > Preferences
(`agent-features-setting.tsx`). The switch is a workspace row,
`['setting', 'promptSuggestions']`, and needs neither the master switch nor a
per-device switch.

- Needs: a Claude session. The machine running it asks the patched adapter for
  suggestions when Claude starts (`patches/submodules/acp-extension-claude/0002-*`,
  `patches/submodules/acp-extension-core/0002-*`); each guess is written to the
  session metadata as `promptSuggestion`.
- Limits: a running Claude keeps the setting it started with; turning the
  switch off hides guesses at once.
- Code: `apps/cli/src/agent/agent-client.ts`, `apps/cli/src/lib/message-handler.ts`,
  `packages/components/src/components/sessions/use-session-prompt-suggestion.ts`.


## Boards

Settings > Experimental features > Boards enables this device's Board surfaces.
The sidebar lists Boards in their own section (also in the mobile drawer); its
"+" creates one. Creating a Board asks for a name, an optional goal and the
coordinator, chosen through the Schedule agent controls. Nothing is sent: the Board
opens on an empty coordinator conversation and the user speaks first; rules start
from defaults, and the choice of agent, Role instance and run config is remembered
on the device.

Opening a Board, from the sidebar, `/boards/<id>` or the command palette (which
shows a coordinator as its Board and a thread as "Board › thread"), opens the
coordinator's Session page on its own Tab with the Board side panel (`?board=1`),
half the width each. The panel has Threads and Board files tabs; on a Board page the
session panel's Files is named Workspace files. Thread rows group thread families
(a thread with the sessions it opened, indented) into Needs you, Working, Idle and
Archived from metadata and live presence; a thread opens inside the panel with its
machine and project at the top right, or as its own page on narrow windows and
phones (where the panel is a full-screen drawer). The coordinator's own Tabs and
Side Chats open where the page already shows them. Board files holds the shared
notes and the `files/` of the Board's shared directory, kept on the coordinator's
machine and reached from other LAN members through it. The gear at the top right of
the conversation opens Board settings: General (name, optional goal, the instructions
every new member reads beside the thread instructions, rules, Archive) and Memory (the
agents' memory files under `memory/`, indexed by `MEMORY.md`). Archived Boards are listed and restored on the
Archive page; a failed archive or restore names the reason and leaves the Board
where it was, to retry. Neither the coordinator nor the threads are listed among
sessions outside the Board.

PR2 adds shared notes, Board MCP tools, New thread and Join/Remove actions; PR3
records member reports for the coordinator in its Operation Inbox. Since the
[dispatcher model](../../specs/project-coordinator/board-dispatcher-model.zh.md) the
coordinator only assigns work: reports and its own receipts wait for the user's next
message instead of waking it, threads coordinate their own sessions and report to the
user, and thread and Board rows carry the sidebar's ✋, working and unread marks. Round
limits, handoff and daily digests remain later steps in the
[Board design](../../specs/project-coordinator/design.md). Disabling the experiment
hides its surfaces and keeps sessions and Board data intact.

### Article window

A row under Boards, shown while Boards is on. In a Board, clicking a `.md`/`.html`
file link in a thread open in the side panel opens the article window over the page
instead of a file tab: the file on the left, that thread's conversation on the right
(60/40, the divider drags, nothing is remembered). Escape (after any open comment
editor), the backdrop or the × in the thread header closes it and leaves the page as
it was. The file header's ⋯ has "Open in side tab". The right pane is whichever
thread the Board panel has open: moving to another member through the thread
header's breadcrumb or a session link keeps the window and the article (still read
from its own thread); a destination outside the panel closes it. Other files, phones, the compact desktop layout and a
thread opened as its own page keep the file tab; turning the switch off or going
compact closes an open window. The agent side is a convention for the Board's thread
instructions: write `articles/<name>.md|html` and give the path in the reply. No
tool, CLI or protocol change.

- One conversation: the panel's thread conversation is always portalled into a
  relocatable host (`components/boards/relocatable-host.tsx`), so the switch never
  changes its tree. The Board panel and the open dialog each render a slot; the
  node sits in the dialog's while it is open (a higher priority, so a panel that
  remounts meanwhile does not take it back), moved with `moveBefore` where the
  browser has it. Only such a move between two places in the document keeps the
  conversation's scroll offset, so closing takes two commits: the dialog lets go
  of the conversation while it is still in the document, then unmounts. React never
  remounts the conversation, so its composer text, selection chips, scroll and
  `chatRefsMap` entry stay as they were. While open, the conversation's popups
  mount in the dialog panel (`PopupContainerProvider`), and only the backdrop
  dismisses by pointer, since its menus are not the dialog's React descendants.
- Markdown: with this switch on, selecting rendered Markdown in any file view shows
  a small Comment button beside the selection, and pressing it opens the
  document-selection comment (upstream #1649); a selection made to copy is left
  alone. An open editor takes Escape first. The source lines are found from
  the selected text (`locateMarkdownSelection` in `lib/document-selection.ts`);
  text that repeats or cannot be placed carries no lines. The comment joins the
  thread's composer as a chip and is sent as plain text. In the window, headings
  show as a rail on the left (`article-outline.tsx`); hovering lists them.
- HTML: in the window it always runs in the widget page (`article-html-frame.tsx`),
  the desktop's loopback page that hosts widgets, with the same `allow-scripts`
  sandbox (plus `credentialless`) and the widget policy: scripts, styles, fonts,
  images and `connect-src` from the widget CDNs only (`LODY_WIDGET_CDN_ORIGINS`),
  and the app's theme variables. The article's text starts at the conversation
  font size rather than the widget page's 15px (its own sizes still win); the
  widget page itself is unchanged, since inline widgets are sized for it. A `srcdoc` frame inherits the app's own policy,
  which runs no inline script or CDN code there. The page is already loaded when the
  article arrives, so the article's `DOMContentLoaded`/`load` handlers run after its
  last script. The page cannot send prompts; links ask first. File tabs keep the
  ordinary no-network HTML preview. Element comments (visual annotation) are not
  available in the window.
- Refresh: while the window is open the file is revalidated with its digest every
  5 s while the thread works, 15 s while idle, and once when a turn ends
  (`hooks/use-session-file-digest-watch.ts`). Markdown re-renders in place; an open
  selection comment holds the update. HTML waits 1 s for writes to settle and does
  not reload while the pointer or focus is in the page (or left it under 3 s ago);
  the header then shows "Updated · Reload". A check that returns after the reader
  started editing the source, or closed the window, is dropped.
- Layout: `components/boards/board-article-dialog.tsx`; the file header is the file
  view's article mode (`session-file-content-view.tsx`, `article` prop).
