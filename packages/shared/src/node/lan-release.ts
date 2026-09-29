import crypto from 'node:crypto';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import {
  LAN_RELEASE_MANIFEST_NAME,
  LanReleaseManifestSchema,
  findLanReleaseAsset,
  getLanReleaseBaseUrl,
  sameLanReleaseSource,
  type LanReleaseAsset,
  type LanReleaseManifest,
  type LanReleaseSource,
} from '../lan-release';

/**
 * - `unreachable`: the release did not answer, or not with what was asked for.
 * - `not_published`: the repository has no release under this tag.
 * - `invalid_manifest`: what describes the release cannot be read.
 * - `other_release`: the description is of another repository or tag.
 * - `mismatch`: a file is not the one the description names. A release
 *   replaces its files one by one, so this is what a download meets while a
 *   newer build is being published.
 * - `aborted`: the caller gave up.
 */
export type LanReleaseErrorCode =
  | 'unreachable'
  | 'not_published'
  | 'invalid_manifest'
  | 'other_release'
  | 'mismatch'
  | 'aborted';

export class LanReleaseError extends Error {
  readonly code: LanReleaseErrorCode;

  constructor(code: LanReleaseErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LanReleaseError';
    this.code = code;
  }
}

export type LanReleaseFetch = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string>; redirect: 'follow' }
) => Promise<Response>;

export type LanReleaseRequestOptions = {
  /** The desktop passes the one of its network stack, which knows the proxy of the system. */
  fetch?: LanReleaseFetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
};

const MANIFEST_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const MANIFEST_MAX_BYTES = 256 * 1024;

/**
 * `LODY_LAN_BASE_URL` names a mirror of the release, as it does for the
 * install scripts. A mirror is trusted like the release itself: it serves the
 * description the files are checked against.
 */
export function resolveLanReleaseBaseUrl(
  source: Pick<LanReleaseSource, 'repository' | 'tag'>,
  env: NodeJS.ProcessEnv = process.env
): string {
  const mirror = env.LODY_LAN_BASE_URL?.trim();
  return (mirror || getLanReleaseBaseUrl(source)).replace(/\/+$/u, '');
}

function deadline(options: LanReleaseRequestOptions, fallbackMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? fallbackMs);
  return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
}

async function request(
  url: string,
  accept: string,
  options: LanReleaseRequestOptions,
  signal: AbortSignal
): Promise<Response> {
  const send = options.fetch ?? (globalThis.fetch as unknown as LanReleaseFetch);
  let response: Response;
  try {
    response = await send(url, { signal, headers: { accept }, redirect: 'follow' });
  } catch (error) {
    if (options.signal?.aborted) {
      throw new LanReleaseError('aborted', 'The request was cancelled', { cause: error });
    }
    throw new LanReleaseError('unreachable', `The release did not answer at ${url}`, {
      cause: error,
    });
  }
  if (response.status === 404) {
    throw new LanReleaseError('not_published', `Nothing is published at ${url}`);
  }
  if (!response.ok) {
    throw new LanReleaseError('unreachable', `The release answered ${response.status} at ${url}`);
  }
  return response;
}

/** The description of the newest build of the release a build follows. */
export async function fetchLanReleaseManifest(
  source: LanReleaseSource,
  options: LanReleaseRequestOptions = {}
): Promise<LanReleaseManifest> {
  const url = `${resolveLanReleaseBaseUrl(source, options.env)}/${LAN_RELEASE_MANIFEST_NAME}`;
  const response = await request(
    url,
    'application/json',
    options,
    deadline(options, MANIFEST_TIMEOUT_MS)
  );

  let body: unknown;
  try {
    const text = await response.text();
    if (text.length > MANIFEST_MAX_BYTES) throw new Error('too large');
    body = JSON.parse(text) as unknown;
  } catch (error) {
    throw new LanReleaseError('invalid_manifest', `${url} is not a release description`, {
      cause: error,
    });
  }
  const manifest = LanReleaseManifestSchema.safeParse(body);
  if (!manifest.success) {
    throw new LanReleaseError('invalid_manifest', `${url} is not a release description`, {
      cause: manifest.error,
    });
  }
  if (!sameLanReleaseSource(manifest.data, source)) {
    throw new LanReleaseError(
      'other_release',
      `${url} describes ${manifest.data.repository}@${manifest.data.tag}`
    );
  }
  return manifest.data;
}

/**
 * Downloads one file of a release to `destination`, which exists afterwards
 * only if the file is the one the description names.
 */
export async function downloadLanReleaseAsset(
  options: LanReleaseRequestOptions & {
    source: LanReleaseSource;
    asset: LanReleaseAsset;
    destination: string;
    onProgress?: (receivedBytes: number, totalBytes: number) => void;
  }
): Promise<void> {
  const { asset, destination } = options;
  const url = `${resolveLanReleaseBaseUrl(options.source, options.env)}/${asset.name}`;
  const signal = deadline(options, DOWNLOAD_TIMEOUT_MS);
  const response = await request(url, 'application/octet-stream', options, signal);
  if (!response.body) {
    throw new LanReleaseError('unreachable', `The release sent nothing for ${asset.name}`);
  }

  const partial = `${destination}.partial`;
  const hash = crypto.createHash('sha256');
  let received = 0;
  try {
    await pipeline(
      Readable.fromWeb(response.body as unknown as NodeWebReadableStream<Uint8Array>),
      async function* (chunks: AsyncIterable<Uint8Array>) {
        for await (const chunk of chunks) {
          received += chunk.byteLength;
          if (received > asset.size) {
            throw new LanReleaseError(
              'mismatch',
              `${asset.name} is larger than the release describes; a newer build may be on its way`
            );
          }
          hash.update(chunk);
          options.onProgress?.(received, asset.size);
          yield chunk;
        }
      },
      fs.createWriteStream(partial, { mode: 0o600 }),
      { signal }
    );
    if (received !== asset.size || hash.digest('hex') !== asset.sha256) {
      throw new LanReleaseError(
        'mismatch',
        `${asset.name} is not the file the release describes; a newer build may be on its way`
      );
    }
    fs.renameSync(partial, destination);
  } catch (error) {
    fs.rmSync(partial, { force: true });
    if (error instanceof LanReleaseError) throw error;
    if (options.signal?.aborted) {
      throw new LanReleaseError('aborted', 'The download was cancelled', { cause: error });
    }
    throw new LanReleaseError('unreachable', `Downloading ${asset.name} failed`, { cause: error });
  }
}

/**
 * Downloads a file of the newest build. A release replaces its files one at a
 * time, so the file can already belong to a build newer than the description
 * read before it. The description is read again once, and the file of the
 * build it names is downloaded; `onManifest` hears of that build. Returns the
 * description the downloaded file belongs to.
 */
export async function downloadNewestLanReleaseAsset(
  options: LanReleaseRequestOptions & {
    source: LanReleaseSource;
    manifest: LanReleaseManifest;
    assetName: string;
    destination: string;
    onProgress?: (receivedBytes: number, totalBytes: number) => void;
    onManifest?: (manifest: LanReleaseManifest) => void;
  }
): Promise<LanReleaseManifest> {
  let manifest = options.manifest;
  for (let attempt = 0; ; attempt += 1) {
    const asset = findLanReleaseAsset(manifest, options.assetName);
    if (!asset) {
      throw new LanReleaseError('not_published', `The release carries no ${options.assetName}`);
    }
    try {
      await downloadLanReleaseAsset({ ...options, asset });
      return manifest;
    } catch (error) {
      if (attempt > 0 || !(error instanceof LanReleaseError) || error.code !== 'mismatch') {
        throw error;
      }
      manifest = await fetchLanReleaseManifest(options.source, options);
      options.onManifest?.(manifest);
    }
  }
}
