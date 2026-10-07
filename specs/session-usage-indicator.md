# Composer usage indicator

Status: draft
Translation: current

[中文](session-usage-indicator.zh.md)

When a provider reports both weekly and five-hour subscription usage, a composer
without context usage shows the five-hour percentage in its compact indicator.
For example, weekly usage of 29% and five-hour usage of 11% produces an 11% indicator.

## Display contract

Valid context usage takes precedence. While context is compacting, the indicator
shows the compacting state. Subscription usage is eligible only when the caller
enables display without context, using the selected provider and model's limits.

For subscription usage, select a valid five-hour window even when its usage is 0%.
If no valid five-hour window exists, keep the existing longest-window selection.
If neither valid context nor eligible subscription usage exists, hide the
indicator unless context is compacting.

The detail popover displays all valid reported windows in descending duration
order, retaining provider-supplied labels and reset information. Compact indicator
selection is independent of that presentation order.

## Subscription eligibility

Built-in Claude, Codex, Grok, and Kimi configurations may display subscription
limits when explicit environment variables do not override the agent's account,
credentials, or provider routing. Tool settings, proxies, and `NMEM_AGENT_ID`
alone must not hide either the five-hour or weekly limits. Empty and whitespace-only
values do not count as overrides. A persisted or environment-inferred provider
brand still hides subscription limits. Registry Antigravity retains its existing
eligibility because its quota comes from the ACP server's own sign-in.

Claude credential/provider variables, OAuth token/config-directory overrides,
and cloud auth-bypass switches hide limits; model selectors and cloud regions
alone do not. Codex account/config locations, provider selectors, and variables
with `CODEX_`, `OPENAI_`, or `LODY_CODEX_` prefixes hide limits, excluding unrelated
transport and process settings. Grok account-store and endpoint/key overrides
hide limits, with `XAI_` conservatively treated as provider configuration. Kimi
account-store and known provider endpoint/key overrides hide limits, with
`MOONSHOT_` conservatively treated as legacy provider configuration; ordinary
`KIMI_` tool/update settings do not hide limits.

This display heuristic does not determine whether an agent needs sign-in or
change quota collection and Provider-scoped snapshot ownership.

## Evidence

- [Indicator and detail popover](../packages/components/src/components/sessions/session-usage-popover.tsx)
- [Behavioral tests](../packages/components/tests/session-usage-popover.test.tsx)
- [Eligibility helper and tests](../packages/components/tests/session-usage.test.ts)
- [Shared environment classification](../packages/shared/src/agent-authentication.ts)
- [Eligibility decision](../.agents/notes/implemented/bug-fix/2026-10-07-subscription-env-eligibility.md)
- [Decision](../.agents/notes/implemented/bug-fix/2026-10-01-five-hour-usage-indicator.md)
