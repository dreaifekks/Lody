#!/usr/bin/env node
// Bundles the reader page into one script and one stylesheet, which the CLI
// build copies beside its bundle for the hub to serve.
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
