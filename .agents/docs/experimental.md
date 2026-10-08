# Experimental features

Features that are opt-in and still change. This page lists each one: what it
does, where it is turned on, what it needs, its known limits and where its
code starts. One of them, the review agent, comes from upstream; the others are
the fork's.

## The switches

Settings > Preferences has **Experimental features** just above Advanced
(`packages/components/src/components/settings/experimental-features-setting.tsx`).
Its master switch, "Enable experimental features", is
`experimentalFeaturesEnabledAtom` in `packages/components/src/atoms/settings.ts`.
While it is on, two groups follow:

| Group                      | Switch                    | Atom (localStorage key)                                                       |
| -------------------------- | ------------------------- | ----------------------------------------------------------------------------- |
| Experimental · Sessions    | Review agent              | `reviewAgentExperimentEnabledAtom` (`lody-review-agent-enabled`)              |
|                            | Voice                     | `voiceExperimentEnabledAtom` (`lody-voice-experiment-enabled`)                |
| Experimental · Agent tools | Notifications from agents | `agentNotifyExperimentEnabledAtom` (`lody-agent-notify-experiment-enabled`)   |
|                            | Plan review               | `planReviewExperimentEnabledAtom` (`lody-plan-review-experiment-enabled`)     |
|                            | Interactive widgets       | `inlineWidgetExperimentEnabledAtom` (`lody-inline-widget-experiment-enabled`) |

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

## Review agent

From upstream. A review agent checks a session's branch, hands fixes back to
the session and merges once CI is green; the user chooses it per session in the
`…` menu. A session starts it only after its machine has a reviewer configured
in the workspace's review settings. Turning the switch off hides the controls;
a run already authorized on a session keeps going.

- Needs: a reviewer agent configured per machine (Settings > Agents), and on a
  LAN the GitHub credential described in
  [LAN credentials](lan-credentials.md#github).
- Code: `reviewAgentFeatureEnabledAtom`, `auto-review-menu-item.tsx` in
  `packages/components/src/components/sessions/`,
  `review-policy-setting.tsx` and `machine-agent-settings.tsx` in
  `packages/components/src/components/settings/`.
- More: [auto review and merge](sessions-auto-review.md).

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
