import crypto from 'node:crypto';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
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
  /** How long reading the description may take. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
};

export type LanReleaseDownloadOptions = LanReleaseRequestOptions & {
  /** How long a download may go without receiving anything before it is tried again. */
  idleTimeoutMs?: number;
  /**
   * How long to wait before each further attempt that follows one that
   * received nothing; once they are used up, the download fails.
   */
  retryDelaysMs?: readonly number[];
};

const MANIFEST_TIMEOUT_MS = 20_000;
const MANIFEST_MAX_BYTES = 256 * 1024;
// A slow connection is no reason to give up, as long as it still delivers.
const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;
const DOWNLOAD_RETRY_DELAYS_MS = [2_000, 10_000, 30_000];

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
  headers: Record<string, string>,
  options: LanReleaseRequestOptions,
  signal: AbortSignal
): Promise<Response> {
  const send = options.fetch ?? (globalThis.fetch as unknown as LanReleaseFetch);
  let response: Response;
  try {
    response = await send(url, { signal, headers, redirect: 'follow' });
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
  // A range the file does not have is answered to whoever asked for one.
  if (!response.ok && !(headers.range && response.status === 416)) {
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
    { accept: 'application/json' },
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

type AssetDownload = LanReleaseDownloadOptions & {
  source: LanReleaseSource;
  asset: LanReleaseAsset;
  destination: string;
  onProgress?: (receivedBytes: number, totalBytes: number) => void;
};

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

async function sha256Of(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function contentRangeStart(header: string | null, size: number): number | null {
  const match = header?.match(/^bytes (\d+)-\d+\/(\d+|\*)$/u);
  if (!match || (match[2] !== '*' && Number(match[2]) !== size)) return null;
  return Number(match[1]);
}

/**
 * Asks for what `partial` still lacks of the file and appends it, or writes
 * the whole file again if that is what is sent. The idle deadline starts
 * again with every piece received.
 */
async function downloadRest(options: AssetDownload, url: string, partial: string): Promise<void> {
  const { asset } = options;
  const offset = sizeOf(partial);
  const idleMs = options.idleTimeoutMs ?? DOWNLOAD_IDLE_TIMEOUT_MS;
  const idle = new AbortController();
  let timer = setTimeout(() => idle.abort(), idleMs);
  const signal = options.signal ? AbortSignal.any([options.signal, idle.signal]) : idle.signal;
  try {
    const response = await request(
      url,
      { accept: 'application/octet-stream', ...(offset > 0 ? { range: `bytes=${offset}-` } : {}) },
      options,
      signal
    );
    let start = 0;
    if (offset > 0 && response.status !== 200) {
      const continued =
        response.status === 206 &&
        contentRangeStart(response.headers.get('content-range'), asset.size) === offset;
      if (!continued) {
        // What is kept cannot be continued with this answer; the next attempt starts over.
        fs.rmSync(partial, { force: true });
        throw new LanReleaseError('unreachable', `The release sent another part of ${asset.name}`);
      }
      start = offset;
    }
    if (!response.body) {
      throw new LanReleaseError('unreachable', `The release sent nothing for ${asset.name}`);
    }

    let received = start;
    await pipeline(
      Readable.fromWeb(response.body as unknown as NodeWebReadableStream<Uint8Array>),
      async function* (chunks: AsyncIterable<Uint8Array>) {
        for await (const chunk of chunks) {
          clearTimeout(timer);
          timer = setTimeout(() => idle.abort(), idleMs);
          received += chunk.byteLength;
          if (received > asset.size) {
            throw new LanReleaseError(
              'mismatch',
              `${asset.name} is larger than the release describes; a newer build may be on its way`
            );
          }
          options.onProgress?.(received, asset.size);
          yield chunk;
        }
      },
      // A server that ignores the range sends the whole file, which replaces what is kept.
      fs.createWriteStream(partial, { flags: start > 0 ? 'a' : 'w', mode: 0o600 }),
      { signal }
    );
  } catch (error) {
    if (error instanceof LanReleaseError) throw error;
    if (options.signal?.aborted) {
      throw new LanReleaseError('aborted', 'The download was cancelled', { cause: error });
    }
    if (idle.signal.aborted) {
      throw new LanReleaseError(
        'unreachable',
        `Nothing of ${asset.name} arrived for ${Math.round(idleMs / 1000)} s`,
        { cause: error }
      );
    }
    throw new LanReleaseError('unreachable', `Downloading ${asset.name} failed`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

async function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  try {
    await sleep(ms, undefined, { signal });
  } catch (error) {
    throw new LanReleaseError('aborted', 'The download was cancelled', { cause: error });
  }
}

/**
 * Downloads one file of a release to `destination`, which exists afterwards
 * only if the file is the one the description names.
 *
 * A download that breaks off continues where it stopped, in this call and in
 * a later one for the same file: what arrived is kept as `<destination>.partial`
 * beside the digest of the file it belongs to, so the part of another build is
 * never continued. The whole file is checked once it is complete. A download
 * fails only once it went `idleTimeoutMs` without receiving anything, and was
 * tried again after each of `retryDelaysMs` without receiving anything either.
 */
export async function downloadLanReleaseAsset(options: AssetDownload): Promise<void> {
  const { asset, destination } = options;
  const url = `${resolveLanReleaseBaseUrl(options.source, options.env)}/${asset.name}`;
  const partial = `${destination}.partial`;
  const digest = `${partial}.sha256`;
  const discard = () => {
    fs.rmSync(partial, { force: true });
    fs.rmSync(digest, { force: true });
  };

  let kept = false;
  try {
    kept = fs.readFileSync(digest, 'utf8').trim() === asset.sha256;
  } catch {
    // Nothing was kept.
  }
  if (!kept || sizeOf(partial) > asset.size) {
    discard();
    fs.writeFileSync(digest, `${asset.sha256}\n`, { mode: 0o600 });
  }

  const delays = options.retryDelaysMs ?? DOWNLOAD_RETRY_DELAYS_MS;
  try {
    for (let attempt = 0; ;) {
      const before = sizeOf(partial);
      if (before === asset.size) break;
      try {
        await downloadRest(options, url, partial);
        break;
      } catch (error) {
        if (!(error instanceof LanReleaseError) || error.code !== 'unreachable') throw error;
        if (sizeOf(partial) > before) attempt = 0;
        const delay = delays[attempt];
        if (delay === undefined) throw error;
        attempt += 1;
        await pause(delay, options.signal);
      }
    }
    if (sizeOf(partial) !== asset.size || (await sha256Of(partial)) !== asset.sha256) {
      throw new LanReleaseError(
        'mismatch',
        `${asset.name} is not the file the release describes; a newer build may be on its way`
      );
    }
    fs.renameSync(partial, destination);
    fs.rmSync(digest, { force: true });
  } catch (error) {
    // What arrived of the right file is kept for the next attempt.
    const resumable =
      error instanceof LanReleaseError &&
      (error.code === 'unreachable' || error.code === 'aborted') &&
      sizeOf(partial) > 0;
    if (!resumable) discard();
    throw error;
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
  options: LanReleaseDownloadOptions & {
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
