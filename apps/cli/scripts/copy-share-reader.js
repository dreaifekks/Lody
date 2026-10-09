#!/usr/bin/env node

import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const cliDirectory = path.resolve(scriptDirectory, '..');
const readerDirectory = path.resolve(cliDirectory, '../../packages/lan-share-reader/dist');

/** Copy the page a LAN hub serves to readers of a shared conversation beside the bundle. */
export async function copyShareReader(outputDirectory) {
  for (const name of [
    'lan-share-reader.js',
    'lan-share-reader.css',
    'lan-share-reader-icon.png',
    'lan-share-reader-banner.png',
  ]) {
    await copyFile(path.join(readerDirectory, name), path.join(outputDirectory, name));
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const outputDirectory = path.resolve(cliDirectory, process.argv[2] ?? 'dist');
  await copyShareReader(outputDirectory);
}
