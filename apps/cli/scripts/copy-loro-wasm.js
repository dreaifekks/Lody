#!/usr/bin/env node
'use strict';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// streams-crdt loads its zstd runtime from `new URL('./zstd.wasm', import.meta.url)`,
// so the wasm must sit beside whichever emitted file holds that code. manualChunks
// moves it into `dist/chunks/`; a wasm left only at `dist/` makes the runtime fall
// back to fetch(file://), which Node rejects, and every snapshot decompression then
// waits forever.
const WASM_FILE_NAME = 'zstd.wasm';
const WASM_REFERENCE = `"./${WASM_FILE_NAME}"`;

function listJavaScriptFiles(dirPath) {
  return fs.readdirSync(dirPath, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) return listJavaScriptFiles(entryPath);
    return entry.isFile() && entry.name.endsWith('.js') ? [entryPath] : [];
  });
}

function copyWasm() {
  const outputDir = path.resolve(__dirname, '..', 'dist');
  const zstdEntrypoint = fileURLToPath(import.meta.resolve('@loro-dev/streams-crdt/zstd'));
  const zstdSourcePath = path.join(path.dirname(zstdEntrypoint), WASM_FILE_NAME);

  const referencingDirs = new Set(
    listJavaScriptFiles(outputDir)
      .filter((filePath) => fs.readFileSync(filePath, 'utf8').includes(WASM_REFERENCE))
      .map((filePath) => path.dirname(filePath))
  );
  if (referencingDirs.size === 0) {
    throw new Error(
      `No bundled file references ${WASM_REFERENCE}; check how @loro-dev/streams-crdt/zstd loads its wasm.`
    );
  }
  for (const dirPath of referencingDirs) {
    fs.copyFileSync(zstdSourcePath, path.join(dirPath, WASM_FILE_NAME));
    console.log(`Copied ${WASM_FILE_NAME} to ${path.relative(outputDir, dirPath) || '.'}`);
  }
}

try {
  copyWasm();
} catch (err) {
  console.error('Failed to copy wasm bundle:', err);
  process.exitCode = 1;
}
