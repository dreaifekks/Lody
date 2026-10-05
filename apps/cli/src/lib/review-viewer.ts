import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  reviewViewerFileName,
  reviewViewerSha256,
  reviewViewerVersion,
} from 'lody-code-review-viewer/manifest';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';

/**
 * Resolves the single-file code-review viewer HTML for `lody review`.
 *
 * The viewer (~8 MB) is NOT bundled into the CLI; it ships as the public
 * `lody-code-review-viewer` npm package (one `standalone.html`) and is fetched on
 * demand from a CDN, then cached under the active installation's `code-review-viewer/`. The CLI is
 * built against an exact viewer version and sha256 (the `./manifest` export), so we
 * always fetch that pinned version and verify its hash before trusting the HTML we
 * inject a review into and open in the user's browser.
 *
 * Resolution order:
 *   1. valid cached copy for this version,
 *   2. the copy a build carries beside its bundle,
 *   3. `LODY_REVIEW_VIEWER` override (a local file path or URL), else
 *   4. jsDelivr, then unpkg.
 * Every non-cache source is sha256-verified against the manifest.
 */

const DEFAULT_CDN_BASES = ['https://cdn.jsdelivr.net/npm', 'https://unpkg.com'] as const;

function cacheDir(): string {
  return path.join(getLodyDataDir(), 'code-review-viewer');
}

function cachePath(): string {
  return path.join(cacheDir(), `${reviewViewerVersion}.html`);
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function isUrl(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

async function loadSource(source: string): Promise<Buffer> {
  if (isUrl(source)) {
    const response = await fetch(source, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
  return readFile(path.resolve(source));
}

async function writeCache(buffer: Buffer): Promise<void> {
  // Best-effort: a read-only HOME must not break rendering.
  try {
    await mkdir(cacheDir(), { recursive: true });
    const tmp = `${cachePath()}.tmp-${process.pid}`;
    await writeFile(tmp, buffer);
    await rename(tmp, cachePath());
  } catch {
    /* ignore cache write failures */
  }
}

/** Name of the viewer a build copies beside its bundle (`scripts/copy-review-viewer.js`). */
const BUNDLED_VIEWER_FILE_NAME = 'code-review-viewer.html';

/**
 * Where a build may carry its own viewer: beside the entry it was started
 * from, or beside or above the chunk this module was bundled into.
 */
function bundledViewerPaths(): string[] {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  return [
    ...(process.argv[1] ? [path.dirname(path.resolve(process.argv[1]))] : []),
    moduleDirectory,
    path.dirname(moduleDirectory),
  ].map((directory) => path.join(directory, BUNDLED_VIEWER_FILE_NAME));
}

/** Returns the verified viewer HTML, fetching + caching it if necessary. */
export async function resolveReviewViewerTemplate(
  options: { bundledPaths?: readonly string[] } = {}
): Promise<string> {
  // 1. Reuse a cached copy whose hash still matches the expected viewer.
  try {
    const cached = await readFile(cachePath());
    if (sha256(cached) === reviewViewerSha256) {
      return cached.toString('utf8');
    }
  } catch {
    /* no usable cache */
  }

  // A build that publishes no viewer package (a fork) carries the one it was
  // built with, under the same hash.
  for (const bundled of options.bundledPaths ?? bundledViewerPaths()) {
    try {
      const buffer = await readFile(bundled);
      if (sha256(buffer) === reviewViewerSha256) return buffer.toString('utf8');
    } catch {
      /* not carried here */
    }
  }

  // 2. Build the source list: explicit override wins, else the CDN fallbacks.
  const override = process.env.LODY_REVIEW_VIEWER?.trim();
  const sources = override
    ? [override]
    : DEFAULT_CDN_BASES.map(
        (base) => `${base}/lody-code-review-viewer@${reviewViewerVersion}/${reviewViewerFileName}`
      );

  const failures: string[] = [];
  for (const source of sources) {
    try {
      const buffer = await loadSource(source);
      const actual = sha256(buffer);
      if (actual !== reviewViewerSha256) {
        failures.push(
          `${source}: sha256 mismatch (expected ${reviewViewerSha256.slice(0, 12)}…, got ${actual.slice(
            0,
            12
          )}…)`
        );
        continue;
      }
      await writeCache(buffer);
      return buffer.toString('utf8');
    } catch (error) {
      failures.push(`${source}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(
    `Could not obtain the code-review viewer (lody-code-review-viewer@${reviewViewerVersion}).\n` +
      failures.map((line) => `  - ${line}`).join('\n') +
      '\nIf you are offline or behind a firewall, download standalone.html for this ' +
      'version and point LODY_REVIEW_VIEWER at it (a file path or URL).'
  );
}
