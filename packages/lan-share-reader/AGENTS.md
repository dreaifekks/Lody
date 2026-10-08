# lan-share-reader

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

The page a LAN hub serves to readers of a shared conversation (fork-only, see
[shared conversations](../../.agents/docs/lan-sharing.md#shared-conversations)).

## Invariants

- It runs on the hub's share origin under a CSP of `'self'` only: one script,
  one stylesheet and Lody's icon, no inline code, nothing loaded from elsewhere.
- Thinking is never shown to a reader, as on the desktop's share page; it only
  counts toward a turn's work.
- Conversation content reaches the DOM as text, except Markdown rendered by
  micromark with its defaults: raw HTML stays escaped and unsafe link targets
  are dropped. Never enable `allowDangerousHtml` or `allowDangerousProtocol`.
- It reads only `/s/<id>/share.json` and objects under the deployment that
  answer named; it holds no credential and writes nothing to storage.
- It stays small and imports nothing of the desktop: no React, no
  `@lody/components`, no Zstd (the hub refuses compressed histories).

## Build

`pnpm build` bundles `dist/lan-share-reader.{js,css}` with esbuild and copies
the packaged Lody icon (`packages/components/src/assets/lody-icon.png`) as
`dist/lan-share-reader-icon.png`;
`apps/cli/scripts/copy-share-reader.js` copies them beside the CLI bundle,
where `apps/cli/src/lib/lan/hub-shares.ts` reads them. The hub, not this page,
writes the page's head (title, favicon, link-preview tags).
