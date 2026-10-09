#!/usr/bin/env node
// Bundles the reader page into one script, one stylesheet, the Lody icon and
// the default link preview banner, which the CLI build copies beside its
// bundle for the hub to serve.
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.join(packageDirectory, 'dist');

await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [path.join(packageDirectory, 'src/main.ts')],
  outfile: path.join(outputDirectory, 'lan-share-reader.js'),
  bundle: true,
  format: 'iife',
  minify: true,
  target: 'es2020',
  legalComments: 'none',
});
await copyFile(
  path.join(packageDirectory, 'src/reader.css'),
  path.join(outputDirectory, 'lan-share-reader.css')
);
// The packaged Lody icon the desktop's share page leads with: the page's mark,
// and the favicon and link preview of a hub that set none of its own.
await copyFile(
  path.join(packageDirectory, '../components/src/assets/lody-icon.png'),
  path.join(outputDirectory, 'lan-share-reader-icon.png')
);
// The link preview's picture of a hub that set none of its own.
await copyFile(
  path.join(packageDirectory, '../components/src/assets/lan-share-banner.png'),
  path.join(outputDirectory, 'lan-share-reader-banner.png')
);
