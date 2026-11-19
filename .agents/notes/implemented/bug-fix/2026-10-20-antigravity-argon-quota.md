# Separate Antigravity Argon quota

Status: implemented
Translation: current

[中文](2026-10-20-antigravity-argon-quota.zh.md)

## Abstract

Antigravity reports separate model-group quota, including Argon. Lody now obtains
all groups from the selected agy executable's `--print /usage --output-format json`
command for both builtin and persisted registry Providers. It preserves named weekly
and five-hour windows without parsing old ACP credentials or calling Cloud Code.
The historical direct-reader measurements below explain why returning to the old
endpoint or inventing one combined bucket is incorrect.

## Historical direct-reader decision and evidence

The sanitized three-group response contains `gemini-argon-wtu-weekly`, a weekly
window and remaining fraction `0.5653113126754761`, mapped to 43.5% used. Explicit
ids avoid overlapping Gemini/Argon model names and input-order-dependent provider
selection. Other Gemini models select only Gemini. Claude/GPT quota remains
excluded from provider rows and session usage; other providers are unchanged.
This extends [subscription display eligibility](2026-10-07-subscription-env-eligibility.md)
without changing credentials, polling cadence or provider-scoped ownership.
Implementation responsibilities are recorded in the [CLI library index](../../../../apps/cli/src/lib/README.md#provider-quota).

Review found that per-limit upserts retained Argon after switching to an account
without that bucket. The retired poller submitted one complete result per config through
workspace and machine `replaceRateLimits`. The machine's existing quota queue
wrote current groups and deleted absent keys for the same config and CLI type,
then flushes and marks the document dirty. Claude/Codex incremental writes are
unchanged. A successful empty result clears that snapshot; null or thrown fetches
leave it untouched.

Existing CLI, session-usage and provider-row suites cover mapping, model selection,
Ultra's combined bucket and Argon-first input order. Storybook Pro/compact scenes
exercise the rendered labels. Verification uses fixtures, not live Google quota
or account credentials.
The former poller suite used a real in-memory LoroRepo and MachineDocument to verify
Pro-to-Ultra replacement, other config/type isolation, empty snapshots, and
signed-out/failed fetch preservation followed by recovery.

## Historical measurement: request host and User-Agent

The first version kept the production host and the bare `antigravity` User-Agent.
Probed live with one account on 2026-10-20, that request returned only the Gemini
and Claude/GPT groups, every window at 100% remaining with a reset exactly seven
days out: an untouched window, not the account's usage. agy `/usage` for the same
account showed real Gemini usage and the Argon group. The daily host
(`daily-cloudcode-pa.googleapis.com`), which agy calls, answers with both once the
User-Agent names a versioned client: `antigravity/cli/<version> <os>/<arch>` and
`antigravity/hub/3.0.0` did; `antigravity/hub/2.9.1` gave real Gemini usage without
Argon; `antigravity/agy/<version>` and the bare agent gave only Claude/GPT. The
OS/arch part did not change the answer. The retired reader sent
`antigravity/cli/1.4.2 <os>/<arch>` to the daily host. The version gate is Google's
and undocumented, so a later Antigravity release may require a newer version string.
CodexBar reads the summary from the same host for the same reason.

## Current quota reader boundary

The builtin and persisted registry entries both launch agy. Neither sends `/usage`
as an ACP prompt or creates a quota conversation. `queryLocalAcpRateLimits` runs
print mode with the selected launch environment, validates `num_turns: 0`, and
preserves all groups in one Provider snapshot. Extra ACP launch arguments and
Magpie routing remain unsupported for quota, so account selectors are never silently
dropped. The old `lib/antigravity-quota.ts` reader and its tests are removed.
See the [agy CLI decision](../feature/2026-11-15-antigravity-agy-cli-acp.md).

Settings and composer both prefer the native `antigravity` limit row for builtin and
legacy registry Providers, retaining every agy window label. A successful nonempty
query replaces that Provider/type's snapshot through the existing quota queue and
removes obsolete `gemini`, `argon` and `third-party` rows. The queue rechecks the
query's unchanged revision and the exact persisted Provider config after opening
Flock, before writes or deletes; other Providers and other types are untouched.
Empty/failed reads keep cache. This supersedes the retired poller's empty-result
clearing behavior described above. The existing machine-document suite covers the
manager forwarding, scoped replacement and delayed push/config/deletion races.

Legacy capability source versions add `+agy-usage:1`, so old quota-incapable catalogs
are reprobed even when the agy binary version is unchanged. Zed identity remains a
separate suffix and a registry-only setting. Builtin agy needs no Claude/GPT switch.
Ordinary tool variables such as `NMEM_AGENT_ID` remain eligible under the shared
[account environment policy](2026-10-25-subscription-quota-environment.md); account,
home/config discovery and code-loading overrides remain excluded.
