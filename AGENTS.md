# Repository rules

`CLAUDE.md` symlinks here; edit `AGENTS.md` only.
[Repository map](README.md#repository).

## Context and documentation

- Read applicable ancestor/scoped `AGENTS.md`, relevant Specs, docs, module READMEs
  and linked notes. Search notes before reversing decisions. Required topic links
  also bind outside callers. Archives are history.
- A note you rely on that is stale, unlinked, or in the wrong lifecycle is fixed in
  the same PR ([maintenance on read](.agents/notes/AGENTS.md#maintenance-on-read)).
- Specs express intent, docs implementation, notes decisions. Use code and evidence
  to distinguish bugs, stale docs and unimplemented intent; never justify a bug by changing a Spec.
- Before editing a Spec, read [Spec rules](specs/AGENTS.md). Prefer existing Specs;
  reserve new ones for consequential decisions needing human review, not ordinary fixes.
- Add/update an [Agent Note](.agents/notes/AGENTS.md#when-to-write) only for durable
  rationale, alternatives, unenforceable constraints, measurements, formats or ownership.
  Routine results belong in PRs/tests. New notes require the
  [supersession check](.agents/notes/AGENTS.md#supersession); keep cited facts current
  and report deferred notes for read-only work.
- Update affected docs/READMEs. Run `pnpm run docs status` at start and
  `pnpm run docs check` at finish; review SHA-protected changes before confirming.
  Checks and translations establish neither correctness nor approval; translation
  may follow later. See [document maintenance](.agents/README.md).
- Keep PR docs compact, with decisions, evidence and limits rather than fix/run logs.
  Follow [submission consolidation](.agents/AGENTS.md#documentation-at-submission).
- Keep complete binding rules in the nearest `AGENTS.md`, below 8 KiB and its
  [word ceiling](.agents/README.md#word-ceilings). New scopes need a `CLAUDE.md`
  symlink. Relocate topics rather than use fragments; explanations belong in docs/notes.

## Effect reference

Use the [Effect skill](.agents/skills/effect-ts/SKILL.md) for Effect work. Read the
consumer's resolved `effect/AGENTS.md` once per version/context, then relevant source.
Preserve locked versions and behavior. Explicit v3 migrations also use
[the migration skill](.agents/skills/effect-v3-to-v4/SKILL.md).

Assess a complete native Effect v4 unit only when it helps the fix, dependencies
are ready and behavior is verifiable. About 500 extra lines is guidance, not an
approval gate. Keep pure computation ordinary and preserve unrelated behavior.
For migrations, read the [charter/ledger](.agents/notes/proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.md#unit-ledger)
and [selection guide](.agents/docs/cli-effect-ts.md#small-migrations-during-feature-and-fix-work).
Meet completion criteria; update changed dependencies, boundaries, consumers and
ownership in the ledger. Split a module only when cohesion improves.

## Repository boundary

- Public source: `apps/{cli,electron}` and their packages. Exclude hosted backends,
  operator/billing config, private secrets/records, and Web/mobile app sources.
  Never commit captured user/agent transcripts; fixtures must be synthetic.
- Never depend on `@lody/convex`, private workspace packages, or generated backend
  API declarations. Optional-cloud protocol names/DTOs belong in `packages/cloud-api`;
  shared product code uses `packages/platform` capabilities and ports.
- The OSS desktop is local-only; authenticated product-cloud requests are forbidden.
  Public runtimes and fork releases are exceptions. Shared packages stay platform-neutral;
  local telemetry is hard-disabled.
- Before LAN work, read [LAN rules](packages/platform/AGENTS.md#lans).
- Before changing Board membership, creation, Overview, notes, prompts or tools, read [Board contracts](packages/components/src/components/boards/AGENTS.md).
- Before changing composition, capability-gated settings, telemetry, or runtime
  downloads, read [platform contracts](packages/platform/AGENTS.md).
- Before changing daemon protocol negotiation, MCP/Role catalogs or their UI
  consumers, per-turn MCP selection, or Role creation/dispatch, read [shared contracts](packages/shared/AGENTS.md).
- `packages/acp-extension-kimi` and `packages/acp-extension-pi` stay outside the root pnpm graph in isolated
  submodule workspace; consume only its separately built, checksummed managed-runtime
  artifact and versioned ACP contract. Shared ACP extension contracts belong in the
  public `LodyAI/acp-extension-core` submodule, consumed through the root workspace;
  never duplicate them locally.
- Magpie: desktop confirmation or explicit local CLI import; loopback mappings and public token.
  Keep gateway metadata outside env and catalogs under Lody data, never user profiles.
  [Contract](specs/magpie-provider-import.md).
- Pi provider migration requires owner confirmation and the target's `builtinPi`
  protocol capability. Preserve provider IDs and settings; never convert legacy
  native session IDs. Contract: [builtin Pi](specs/builtin-pi.md).
- Viewer packaging/version changes must follow its [rules](packages/code-review-viewer/AGENTS.md).
  Package-scope or cloud/local composition changes require `pnpm check:public-boundary`.

## Contributions and checks

- Identify once: Lody team if the user says so or GitHub login is `zxch3n`,
  `Leeeon233`, or `wibus-wee`; otherwise community. Read [.github/AGENTS.md](.github/AGENTS.md)
  before planning community contributions or any PR/Issue work.
- Node.js 22.23.4+ (22.x), 24.22.1+ (24.x), or 26.12.1+ (26.x), with Node-API 10+; use the pnpm in `package.json`. See the
  [runtime security decision](.agents/notes/implemented/bug-fix/2026-10-22-node-security-runtime-floor.md).
  `pnpm install` (nested checkouts skip it); standalone work uses a separate clone.
  `pnpm start:local` starts the desktop; root `pnpm build` uses the same local composition.
- Before commit: `pnpm check` and `pnpm format`. Root packages share `.oxfmtrc.json`;
  ACP submodules stay independently formatted. If tests are skipped, report
  type/build/static checks. Manifest changes update `pnpm-lock.yaml`.
- Packages invoking Oxfmt declare it in their own devDependencies: an embedded
  parent workspace does not install this repository's root package.
- Conventional Commits: `feat:`, `fix:`, `docs:`, `chore:`, `test:`. AI commits
  end with `Model: <runtime-model-id>`.
- Tests use explicit signals, injected clocks, fake timers, and deterministic
  fixtures; no real sleeps, wall-clock races, network, machine load, or scheduler
  luck. Assert observable behavior, not mock call counts.
- Root checks skip `packages/acp-extension-*` internals; retain Lody integration
  and packaging checks. Adapter tests and formatting are independently maintained.

- Tests must protect Lody behavior or installation, compilation, packaging and
  release guarantees. Remove shallow source-string, mock-call-only and ineffective
  duplicate tests in scope. Test real boundaries, state and failures; retain compile-failure
  contracts and meaningful behavior coverage. Extend the owning suite for small fixes.
- Before changing teardown, retry, fencing or readiness, read
  [failure containment](.agents/docs/failure-containment.md); preserve verified safe
  reuse and bounded ownership while isolating independent work.
- Keep edits traceable to the request and preserve unrelated work. Prefer explicit
  contracts over hidden fallbacks; remove only unused code. Update the nearest
  public `AGENTS.md` when an invariant or boundary changes.

## Code Review Rules

Report only P0/P1, security first. If the PR solves the linked Issue and no P0/P1
remains, react 👍. Details: [.github/codex-review.md](.github/codex-review.md).

- P0: exploitable security, secret leak, auth/capability bypass, data loss, or a
  broken public/cloud/local boundary.
- P1: likely shipped breakage, including a failure-containment regression, or a
  durable catalog/session contract violation.
- Skip style, nits, P2+, extra tests, and duplication under 100 lines.
