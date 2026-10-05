import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const viewer = '<!doctype html><title>viewer</title>';

vi.mock('lody-code-review-viewer/manifest', () => ({
  reviewViewerFileName: 'standalone.html',
  reviewViewerVersion: '0.0.0-test',
  reviewViewerSha256: createHash('sha256').update(viewer).digest('hex'),
}));

const { resolveReviewViewerTemplate } = await import('../src/lib/review-viewer');

describe('review viewer', () => {
  let dir: string;
  const originalDataDir = process.env.LODY_DATA_DIR;
  const originalOverride = process.env.LODY_REVIEW_VIEWER;
  const fetched: string[] = [];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-review-viewer-'));
    process.env.LODY_DATA_DIR = path.join(dir, 'data');
    delete process.env.LODY_REVIEW_VIEWER;
    fetched.length = 0;
    // The published package of this version does not exist, as for a fork's build.
    vi.stubGlobal('fetch', async (input: string | URL) => {
      fetched.push(String(input));
      return new Response('Not found', { status: 404 });
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (originalDataDir === undefined) delete process.env.LODY_DATA_DIR;
    else process.env.LODY_DATA_DIR = originalDataDir;
    if (originalOverride === undefined) delete process.env.LODY_REVIEW_VIEWER;
    else process.env.LODY_REVIEW_VIEWER = originalOverride;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reads the viewer a build carries beside its bundle, without the network', async () => {
    const bundled = path.join(dir, 'code-review-viewer.html');
    await fs.writeFile(bundled, viewer);
    await expect(
      resolveReviewViewerTemplate({ bundledPaths: [path.join(dir, 'absent.html'), bundled] })
    ).resolves.toBe(viewer);
    expect(fetched).toEqual([]);
  });

  it('ignores a carried viewer of another build and names what it tried', async () => {
    const bundled = path.join(dir, 'code-review-viewer.html');
    await fs.writeFile(bundled, `${viewer}<!-- another build -->`);
    await expect(resolveReviewViewerTemplate({ bundledPaths: [bundled] })).rejects.toThrow(
      'Could not obtain the code-review viewer'
    );
    expect(fetched).toHaveLength(2);
  });
});
