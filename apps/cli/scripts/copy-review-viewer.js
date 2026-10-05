#!/usr/bin/env node

import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const cliDirectory = path.resolve(scriptDirectory, '..');
const sourceFile = path.resolve(cliDirectory, '../../packages/code-review-viewer/standalone.html');

/**
 * Copy the viewer this build pinned beside the bundle. A fork publishes no
 * viewer package, so `lody review` reads the one it was built with from there.
 */
export async function copyReviewViewer(outputDirectory) {
  await copyFile(sourceFile, path.join(outputDirectory, 'code-review-viewer.html'));
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const outputDirectory = path.resolve(cliDirectory, process.argv[2] ?? 'dist');
  await copyReviewViewer(outputDirectory);
}
