# Preserve subscription limits with unrelated environment settings

Status: implemented
Translation: current

[中文](2026-10-07-subscription-env-eligibility.zh.md)

## Abstract

Adding `NMEM_AGENT_ID=lody` hid both subscription windows because display eligibility
rejected every nonempty environment dictionary. Eligibility now uses shared,
agent-specific authentication and routing classification, ignoring blank values,
proxies, and tool settings. Persisted/inferred brands and Antigravity keep their
existing behavior. Grok's opaque official runtime and unconfirmed legacy Moonshot
variables require conservative provider-prefix matching, which can over-classify
future unrelated variables in those namespaces.

## Decision and evidence

The [display Spec](../../../../specs/session-usage-indicator.md) owns this change.
`hasBuiltinEnvAuthRouting` lives beside the existing shared authentication helpers;
it does not change interactive sign-in requirements or daemon quota reporting.
This extends [new-session subscription display](2026-09-28-session-tab-rate-limit-ring.md)
and preserves [Provider-scoped snapshots](2026-09-30-provider-rate-limit-isolation.md).

- Claude reuses `hasBuiltinEnvAuthentication` and its `CLAUDE_ENV_AUTH_KEYS`.
  The CLI's `CLAUDE_AUTH_ROUTING_KEYS` additionally identifies cloud auth-bypass
  switches, which are included. Model selectors (`ANTHROPIC_MODEL`, default models,
  small/fast model, subagent model) and `CLOUD_ML_REGION` are excluded: the CLI also
  explicitly excludes model selectors from auth/routing intent triggers. The pinned
  Claude adapter's `paths.ts`, `auth-status.ts`, and provider-cache keys justify
  including `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`, and its file descriptor.
- Codex shares `isCodexAuthRoutingEnvKey` with its existing profile validator.
  It covers `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `XDG_CONFIG_HOME`,
  `MODEL_PROVIDER`, `DEFAULT_AUTH_REQUEST`, and case-insensitive `CODEX_`, `OPENAI_`,
  `LODY_CODEX_` prefixes. The validator's broader transport/process protection and
  rejection of blank protected keys are preserved.
- Grok's pinned adapter forwards env to the official runtime; its synthetic
  `scripts/probe-session-fork.mjs` isolates `GROK_HOME`. No public adapter source
  establishes the official runtime's full auth list. `XAI_` is therefore conservative,
  as are `GROK_API_KEY` and `GROK_BASE_URL`; `GROK_HOME` is included. `GROK_PATH` and
  `GROK_DISABLE_AUTOUPDATER` remain ordinary runtime settings.
- Kimi's pinned `packages/kosong/src/providers/kimi.ts` uses `KIMI_API_KEY` and
  `KIMI_BASE_URL`. `apps/kimi-code/src/cli/sub/acp.ts` binds login to `KIMI_CODE_HOME`.
  `packages/node-sdk/src/config/env-model.ts` identifies `KIMI_MODEL_API_KEY`,
  `KIMI_MODEL_BASE_URL`, and `KIMI_MODEL_PROVIDER_TYPE`. The v2 provider definitions
  also expose OpenAI, Anthropic, Google Gemini, and Vertex key/base-URL pairs,
  which are included. No pinned source establishes `MOONSHOT_` handling, so that
  prefix is conservative. Matching every `KIMI_` variable would again hide usage
  for unrelated update, cache, telemetry, and model-tuning settings.

## Verification

The existing shared authentication and component session-usage suites cover
nonblank account/routing overrides, blank values, unrelated settings, agent
isolation, brands, and unchanged Antigravity behavior. The shared suite also checks
that Codex profile validation retains its stricter environment boundary.
The shared full suite passes 1,424 tests across 116 files; its final targeted
authentication rerun passes 76 tests. The component usage, popover, and provider
reauthentication suites pass 47 tests across three files. Both package typechecks
(`tsgo --noEmit`), type-aware lint, repository formatting, documentation checks,
and the public boundary check pass. An additional full component run was stopped
after the targeted checks passed; full component coverage is not claimed.

`pnpm check` stops before repository-wide checks because this worktree has no
initialized submodule Git metadata for the fork's patch step. Pinned public
submodule sources and locally built Core/DSH contracts were sufficient for the
affected checks. No manual application UI verification was performed.
