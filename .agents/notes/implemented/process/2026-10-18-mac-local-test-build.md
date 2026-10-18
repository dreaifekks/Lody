# A separate macOS application for local LAN-fork testing

Status: implemented
Translation: current

[中文](2026-10-18-mac-local-test-build.zh.md)

## Abstract

Trying desktop changes previously required publishing a dev release or starting a
development server. A local arm64 build now produces Lody Test with an independent
desktop identity, data root and CLI host port. A build-time switch makes Finder
launches isolated without depending on the caller's environment. The installation
starts empty because joining a LAN shares writable data rather than a preview.

## Decision

The CI dev channel changes the release stamp to `lan-dev`, but keeps the Lody OSS
product name and application ID. Renaming a bundle alone therefore does not isolate
its stores or its CLI. Packaged builds also ignore `LODY_ELECTRON_USER_DATA_DIR`.

`scripts/mac-local-test-build.sh` selects a dedicated build-time test profile,
reuses the normal build/package pipeline and its native dependency probes, and
disables certificate signing, notarization, publishing and release stamping. The
existing ad-hoc signing hook remains for local execution. Startup sets the
short CLI data root and `LODY_LOCAL_CLI_HOST_PORT` before application modules
open stores; the packaged desktop retains its normal single-instance lock. The
default build remains unchanged. The profile also separates protocol registration
and the desktop stores outside userData.

Port selection must not enable E2E mode: that also changes Codex capability probes
to use and delete `<cwd>/.codex`, which fails at `/` on Finder launches. The shared
TS/CJS endpoint resolvers accept the dedicated port override with the existing
port validation, and the test bootstrap clears `LODY_E2E`. Codex keeps normal
credential and home-directory behavior.

The script merges the latest `origin/lan-hub` into a dedicated clone's current
branch, never resets local work, and retains caches. Renderer builds still run in
full. A running Lody Test must be closed before its bundle is replaced.

## Data and verification

No installed profile, machine identity or LAN credential is copied. A user may
join through Settings with a fresh identity, but the resulting catalog is live
and writable, including startup reconciliation. An isolated LAN is preferable for
migration experiments. See [usage and paths](../../../../DEV.md#local-macos-test-application).

The desktop profile regression test, all 307 Electron tests, typecheck, lint,
boundary checks, arm64 native packaging probes and a real packaged launch passed.
After separating the port override, 17 host/profile tests and 11 Codex environment
tests passed, including TS/CJS parity and the root-directory capability-probe case.
The full repository check failed in two untouched CLI tests: inbox recovery passed
when rerun in isolation; speculative-worktree ownership still failed. That failure
remains outside this change. Document checks had no errors and 71 warnings.
Certificate signing, notarization and real-LAN compatibility were not tested.
