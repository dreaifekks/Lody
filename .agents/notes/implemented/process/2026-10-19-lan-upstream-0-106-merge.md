# LAN fork integration of upstream 0.106.0

Status: implemented
Translation: current

[中文](2026-10-19-lan-upstream-0-106-merge.zh.md)

## Abstract

The LAN fork integrates the 13 upstream commits ending at `76aa567ac` on top of
`0180ed40f`, using a merge rather than rewriting fork history. Upstream dispatch,
resource cleanup and conversation fixes coexist with LAN and Board behavior.
The later Role, Repo/Streams and residency changes are outside this integration;
submodule pins and release workflows remain unchanged.

## Integration decisions

- Keep the fork's 32 KiB completion preview and 64 KiB aggregate bound, while
  incorporating upstream's pre-submission Inbox withdrawal and resource recovery
  rules. The preview size is an intentional fork difference, not a cleanup fix.
- Retain both the Board execution tests and upstream's access-retry and ended-input
  tests in the existing execution suite.
- Use upstream's pending-message hook, local message anchoring and live turn timing
  inside the fork's conversation layout. Retain GitHub sender avatars, Board header
  controls, visibility/file navigation and the Agent Surface provider.
- Preserve every key from both locale versions and all fork values. Shared keys
  follow each upstream file's order; fork-only keys retain their relative order.
- There are no patch-equivalent commits among the 13 incoming commits. Upstream
  turn timing complements Board family completion and LAN Live Activities; its
  permission layout complements Role permission restrictions. Roost pending rows
  remain behind the existing platform boundary; LAN does not enable Roost authoring.

## Verification

The final `pnpm check`, `pnpm format:check` and `pnpm run docs check` passed
with the official Node runtime. CLI: 4,902 passed / one skipped; components:
5,972 passed; shared: 1,750 passed; UI: 299 passed.
Adapter patches are applied before the typecheck's adapter builds. Test and static
check results are reported with the merge; they do not establish a deployed LAN or
Electron end-to-end result. The separate read-only review checks both merge-parent
comparisons for lost fork behavior.

The baseline execution test reopened its database with the real clock after creating
it with a fixed 2026-10-12 clock. Once the retention interval elapsed, open-time
cleanup removed the batch under test. The same failure was reproduced with the
full baseline source restored; both opens now share the fixture clock. Production
retention and replay behavior are unchanged.
