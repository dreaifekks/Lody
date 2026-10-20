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
Successful polls replace the provider's quota snapshot so a switch to Ultra removes
stale Argon rows; failed or signed-out fetches retain the last snapshot. A follow-up
correction moved the request to the host and User-Agent the agy CLI uses: the old
request never received the Argon group or real usage.

## Decision and evidence

The sanitized three-group response contains `gemini-argon-wtu-weekly`, a weekly
window and remaining fraction `0.5653113126754761`, mapped to 43.5% used. Explicit
ids avoid overlapping Gemini/Argon model names and input-order-dependent provider
selection. Other Gemini models select only Gemini. Claude/GPT quota remains
excluded from provider rows and session usage; other providers are unchanged.
This extends [subscription display eligibility](2026-10-07-subscription-env-eligibility.md)
without changing credentials, polling cadence or provider-scoped ownership.
Implementation responsibilities are recorded in the [CLI library index](../../../../apps/cli/src/lib/README.md#provider-quota).

Review found that per-limit upserts retained Argon after switching to an account
without that bucket. The poller now submits one complete result per config through
workspace and machine `replaceRateLimits`. The machine's existing quota queue
writes current groups and deletes absent keys for the same config and CLI type,
then flushes and marks the document dirty. Claude/Codex incremental writes are
unchanged. A successful empty result clears that snapshot; null or thrown fetches
leave it untouched.

Existing CLI, session-usage and provider-row suites cover mapping, model selection,
Ultra's combined bucket and Argon-first input order. Storybook Pro/compact scenes
exercise the rendered labels. Verification uses fixtures, not live Google quota
or account credentials.
The poller suite uses a real in-memory LoroRepo and MachineDocument to verify
Pro-to-Ultra replacement, other config/type isolation, empty snapshots, and
signed-out/failed fetch preservation followed by recovery.

## Correction: request host and User-Agent

The first version kept the production host and the bare `antigravity` User-Agent.
Probed live with one account on 2026-10-20, that request returned only the Gemini
and Claude/GPT groups, every window at 100% remaining with a reset exactly seven
days out: an untouched window, not the account's usage. agy `/usage` for the same
account showed real Gemini usage and the Argon group. The daily host
(`daily-cloudcode-pa.googleapis.com`), which agy calls, answers with both once the
User-Agent names a versioned client: `antigravity/cli/<version> <os>/<arch>` and
`antigravity/hub/3.0.0` did; `antigravity/hub/2.9.1` gave real Gemini usage without
Argon; `antigravity/agy/<version>` and the bare agent gave only Claude/GPT. The
OS/arch part did not change the answer. The daemon now sends
`antigravity/cli/1.4.2 <os>/<arch>` to the daily host. The version gate is Google's
and undocumented, so a later Antigravity release may require a newer version string.
CodexBar reads the summary from the same host for the same reason.
