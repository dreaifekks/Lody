# Repository rules

`CLAUDE.md` symlinks here; edit `AGENTS.md` only.

## Where to read

Read ancestor/scoped `AGENTS.md`, relevant Specs, docs, READMEs and linked notes.
Search notes before reversing decisions. Topic triggers also bind outside callers.
[Repository map](README.md#repository); archives are history, not authority.

- E2EE, pairing, recovery, identity, key delivery, sharing or outage execution: read
  [platform E2EE](packages/platform/AGENTS.md#e2ee-workspace-control),
  [e2ee-core](packages/e2ee-core/AGENTS.md), and the
  [bootstrap guide](.agents/docs/e2ee-workspace-bootstrap.md). Personal-device
  hosts also read [e2ee-client](packages/e2ee-client/AGENTS.md). Machine-service
  policy also reads [e2ee-machine-sharing](packages/e2ee-machine-sharing/AGENTS.md).
- History, quotes, steer, queued input, delegation and MCP/Role catalogs/UI:
  [shared](packages/shared/AGENTS.md). MCP acceptance/replies: [CLI MCP](apps/cli/src/mcp/AGENTS.md).
- Automations, including external checks and cross-session control: read
  [automations](apps/cli/src/automations/AGENTS.md).
- Native iOS or Android: read [mobile](apps/mobile/AGENTS.md), then that platform's file.
- Desktop composition, packaging, quit, or the embedded CLI: read
  [electron](apps/electron/AGENTS.md).
- Provider auth, Lody Agent connections or ACP sign-in: read
  [agent](apps/cli/src/agent/AGENTS.md) and
  [Lody Agent setup](packages/components/src/components/settings/README.md#lody-agent-setup).
- Code Collab diffs or content-addressed snapshots: read
  [turn-diff-store](packages/turn-diff-store/AGENTS.md) and
  [code-collab](apps/cli/src/lib/code-collab/AGENTS.md).
- Composition, capability-gated settings, telemetry, or managed-runtime downloads:
  read [platform contracts](packages/platform/AGENTS.md).

## Context and documentation

- Fix relied-on notes that are stale, unlinked or misclassified in the same change:
  [maintenance](.agents/notes/AGENTS.md#maintenance-on-read).
- Specs express intent, docs implementation, notes decisions. Use code/evidence to
  distinguish defects from stale docs or unimplemented intent; never justify a bug
  by changing a Spec. Read [Spec rules](specs/AGENTS.md); prefer existing Specs and
  reserve new ones for consequential decisions requiring human review.
- Notes record durable rationale, not routine fix logs. Follow [when to write](.agents/notes/AGENTS.md#when-to-write)
  and [supersession](.agents/notes/AGENTS.md#supersession); keep facts current.
  Read-only work reports deferred notes.
- Update affected docs/READMEs. Run `pnpm run docs status` at start and `pnpm run docs check`
  at finish; inspect SHA-protected changes before confirming. Checks and translations
  prove neither correctness nor approval. Follow [maintenance](.agents/README.md).
- Consolidate PR decisions, evidence and limits under [submission rules](.agents/AGENTS.md#documentation-at-submission).
- Binding rules stay in the nearest `AGENTS.md`, within its
  [word ceiling](.agents/README.md#word-ceilings). New scopes need a `CLAUDE.md` symlink.
  Relocate topics rather than fragment them; explanations belong in docs/notes.

## Effect reference

Use the [Effect skill](.agents/skills/effect-ts/SKILL.md), including its resolved-version
read; explicit v3 migrations also use [migration](.agents/skills/effect-v3-to-v4/SKILL.md).
Consider a complete native v4 lifecycle unit only when it helps this change, dependencies
are ready and behavior is verifiable. Keep pure code ordinary and scope reviewable;
never extend into unfinished dependencies. Follow the [selection guide](.agents/docs/cli-effect-ts.md#small-migrations-during-feature-and-fix-work)
and update changed facts in the [charter ledger](.agents/notes/proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.md#unit-ledger).

## Repository boundary

- Public source: `apps/{cli,electron,mobile}` and packages. Exclude hosted backends,
  operator/billing config, secrets/records and private Web sources. No captured
  user/agent transcripts; use synthetic fixtures.
- Never depend on `@lody/convex`, private workspace packages, or generated backend
  API declarations. Optional-cloud protocol names/DTOs belong in `packages/cloud-api`;
  shared product code uses `packages/platform` capabilities and ports.
- Native mobile clients keep independent builds and public cloud protocol clients;
  they must not import private backend code.
- The OSS desktop is local-only; authenticated product-cloud requests are forbidden.
  Public managed-runtime downloads and fork releases are exceptions. Shared packages stay
  platform-neutral; local telemetry is hard-disabled.
- Kimi/Pi ACP submodules stay outside root pnpm; consume separately built,
  checksummed runtimes and versioned ACP contracts. Shared contracts belong in
  public `LodyAI/acp-extension-core`, consumed through root; never duplicate them.
- For Magpie import or builtin Pi migration, read
  [Magpie](specs/magpie-provider-import.md) and [builtin Pi](specs/builtin-pi.md).
  Preserve confirmation, loopback, identity and catalog constraints.
- Before LAN work, read [LAN rules](packages/platform/AGENTS.md#lans).
- Before Board work, read [Board contracts](packages/components/src/components/boards/AGENTS.md).
- Viewer packaging/version changes must follow its [rules](packages/code-review-viewer/AGENTS.md).
  Package-scope or cloud/local composition changes require `pnpm check:public-boundary`.

## Contributions and checks

- Identify once: Lody team if the user says so, or GitHub login is `zxch3n`,
  `Leeeon233`, or `wibus-wee`; otherwise community. Read [.github/AGENTS.md](.github/AGENTS.md)
  before community planning or any PR/Issue work.
- Use `package.json` engines and packageManager (Node-API 10+): [runtime floor](.agents/notes/implemented/bug-fix/2026-10-22-node-security-runtime-floor.md).
  Run `pnpm install` except in nested checkouts; standalone work uses a separate clone.
  `pnpm start:local` and root `pnpm build` use local desktop composition.
- Before commit run `pnpm check` and `pnpm format`. If tests are skipped, report
  type/build/static checks. Manifest changes update `pnpm-lock.yaml`.
- Root packages share `.oxfmtrc.json`; callers declare Oxfmt in their own devDependencies.
  Root checks skip ACP internals, whose tests/formatting are independent; retain
  root integration and packaging coverage.
- Conventional Commits: `feat:`, `fix:`, `docs:`, `chore:`, `test:`; AI commits end
  with `Model: <runtime-model-id>`.
- Tests use explicit signals, injected clocks, fake timers and synthetic fixtures,
  never sleeps, wall-clock races, network, machine load or scheduler luck.
- Keep concrete product/domain, installation, compilation, packaging and release
  coverage. Remove shallow source-text, mock-count and ineffective duplicate tests
  in scope; assert real boundaries, state and failures. Retain compile-failure
  contracts and meaningful behavior coverage. Extend owning suites for small fixes.
- Before teardown, retry, fencing or readiness changes, read [failure containment](.agents/docs/failure-containment.md).
  Preserve verified safe reuse and bounded ownership; isolate independent work.
- Preserve unrelated work; changes must trace to the request. Prefer explicit contracts
  over hidden fallbacks, remove only unused code, and update the nearest AGENTS for
  changed invariants or boundaries.
- Agent-facing prompts, receipts, tools, skills and examples carry requested work and
  otherwise unavailable facts. Never inject unasked workflow, review, verification,
  rechecking or commit steps (including their negations): repeated delivery steers work.

## Code Review Rules

Report only P0/P1, security first. If the PR solves the linked Issue and no P0/P1
remains, react 👍. Details: [.github/codex-review.md](.github/codex-review.md).

- P0: exploitable security, secret leak, auth/capability bypass, data loss, or a
  broken public/cloud/local boundary.
- P1: likely shipped breakage, including a failure-containment regression, or a
  durable catalog/session contract violation.
- Skip style, nits, P2+, extra tests, and duplication under 100 lines.
