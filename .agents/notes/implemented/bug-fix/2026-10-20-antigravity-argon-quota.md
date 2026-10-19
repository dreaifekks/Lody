# Separate Antigravity Argon quota

Status: implemented
Translation: current

[中文](2026-10-20-antigravity-argon-quota.zh.md)

## Abstract

Antigravity Pro reports a separate weekly Argon bucket, but model-name matching
would select the longer Gemini name and provider rows displayed only one group.
The daemon now maps `gemini-argon-wtu` to the shared `argon` limit id and Argon
label. Session usage explicitly prefers Argon for Argon models and uses Gemini
when that separate bucket is absent, as on Ultra. Provider rows show Gemini and
Argon together; the compact view already preserves separate labeled rows.

## Decision and evidence

The sanitized three-group response contains `gemini-argon-wtu-weekly`, a weekly
window and remaining fraction `0.5653113126754761`, mapped to 43.5% used. Explicit
ids avoid overlapping Gemini/Argon model names and input-order-dependent provider
selection. Other Gemini models select only Gemini. Claude/GPT quota remains
excluded from provider rows and session usage; other providers are unchanged.
This extends [subscription display eligibility](2026-10-07-subscription-env-eligibility.md)
without changing credentials, endpoints, polling or provider-scoped ownership.
Implementation responsibilities are recorded in the [CLI library index](../../../../apps/cli/src/lib/README.md#provider-quota).

Existing CLI, session-usage and provider-row suites cover mapping, model selection,
Ultra's combined bucket and Argon-first input order. Storybook Pro/compact scenes
exercise the rendered labels. Verification uses fixtures, not live Google quota
or account credentials.
