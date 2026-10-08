# lan-share-reader

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

The page a LAN hub serves to readers of a shared conversation (fork-only, see
[shared conversations](../../.agents/docs/lan.md#shared-conversations)).

## Invariants

- It runs on the hub's share origin under a CSP of `'self'` only: one script
  and one stylesheet, no inline code, nothing loaded from elsewhere.
- Conversation content reaches the DOM as text, except Markdown rendered by
  micromark with its defaults: raw HTML stays escaped and unsafe link targets
  are dropped. Never enable `allowDangerousHtml` or `allowDangerousProtocol`.
- It reads only `/s/<id>/share.json` and objects under the deployment that
  answer named; it holds no credential and writes nothing to storage.
- It stays small and imports nothing of the desktop: no React, no
  `@lody/components`, no Zstd (the hub refuses compressed histories).

## Build

`pnpm build` bundles `dist/lan-share-reader.{js,css}` with esbuild;
`apps/cli/scripts/copy-share-reader.js` copies them beside the CLI bundle,
where `apps/cli/src/lib/lan/hub-shares.ts` reads them.
