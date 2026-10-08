// The conversations a LAN published, kept by its hub. Members manage them
// behind the gate; readers open them on a listener of their own that knows no
// credential and serves nothing else. See `.agents/docs/lan-sharing.md#shared-conversations`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { Readable, type Writable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import {
  LAN_SHARES_COPY_PATH,
  LAN_SHARES_PATH,
  LAN_SHARES_SETTINGS_PATH,
  LanShareCommitSchema,
  LanShareIdSchema,
  LanShareSettingsSchema,
  normalizeLanSharePublicUrl,
  type LanShare,
  type LanShareList,
  type LanShareSource,
} from '@lody/shared/lan-share';
import {
  SHARE_LIMITS,
  SharePackageManifestSchema,
  assertShareAttachmentPolicy,
  type SharePackageManifest,
} from '@lody/shared/session-sharing';
import { z } from 'zod';
import { ByteReader } from './lan-files';

export const LAN_HUB_SHARES_DIR = 'shares';
const INDEX_FILE_NAME = 'index.json';
const OBJECTS_DIR = 'objects';
/** A reader that opened the previous deployment keeps reading it this long. */
const RETIRED_GRACE_MS = 10 * 60_000;
/** An object no share names yet may be part of an upload still in progress. */
const UPLOAD_GRACE_MS = 60 * 60_000;
const COLLECT_INTERVAL_MS = 60 * 60_000;
const COMMIT_BODY_MAX_BYTES = SHARE_LIMITS.manifestBytes + 256 * 1024;
const SMALL_BODY_MAX_BYTES = 64 * 1024 * 1024;
const LINE_MAX_BYTES = 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const SHA256_SCHEMA = z.string().regex(SHA256);

const StoredShareSchema = z
  .object({
    title: z.string(),
    rootSourceId: z.string(),
    sources: z.array(z.object({ sourceId: z.string(), conversationId: z.string() }).strict()),
    conversationCount: z.number().int().positive(),
    revision: z.number().int().positive(),
    deployment: SHA256_SCHEMA,
    retired: z.array(z.object({ deployment: SHA256_SCHEMA, until: z.number() }).strict()),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
type StoredShare = z.infer<typeof StoredShareSchema>;

const IndexSchema = z
  .object({
    version: z.literal(1),
    publicUrl: z.string().nullable(),
    shares: z.record(LanShareIdSchema, StoredShareSchema),
  })
  .strict();
type Index = z.infer<typeof IndexSchema>;

const EMPTY_INDEX: Index = { version: 1, publicUrl: null, shares: {} };

export function getLanHubSharesDirectory(dataDir: string): string {
  return path.join(dataDir, LAN_HUB_SHARES_DIR);
}

function readIndex(directory: string): Index {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(directory, INDEX_FILE_NAME), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(EMPTY_INDEX);
    throw error;
  }
  return IndexSchema.parse(JSON.parse(raw));
}

function writeIndex(directory: string, index: Index): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, INDEX_FILE_NAME);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(index)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

function objectPath(directory: string, sha256: string): string {
  if (!SHA256.test(sha256)) throw new Error('Invalid object digest');
  return path.join(directory, OBJECTS_DIR, sha256);
}

function readManifest(directory: string, deployment: string): SharePackageManifest {
  return SharePackageManifestSchema.parse(
    JSON.parse(fs.readFileSync(objectPath(directory, deployment), 'utf8'))
  );
}

/** Deployments a share still serves: its current one and those retired within the grace. */
function liveDeployments(share: StoredShare, now: number): string[] {
  return [
    share.deployment,
    ...share.retired.filter((entry) => entry.until > now).map((entry) => entry.deployment),
  ];
}

/** Every object the shares of `index` still need, manifests included. */
function referencedObjects(directory: string, index: Index, now: number): Set<string> {
  const referenced = new Set<string>();
  for (const share of Object.values(index.shares)) {
    for (const deployment of liveDeployments(share, now)) {
      referenced.add(deployment);
      try {
        for (const object of readManifest(directory, deployment).objects) {
          referenced.add(object.sha256);
        }
      } catch {
        // A manifest that is gone names nothing more to keep.
      }
    }
  }
  return referenced;
}

function view(shareId: string, share: StoredShare): LanShare {
  return {
    shareId,
    title: share.title,
    rootSourceId: share.rootSourceId,
    sources: share.sources,
    conversationCount: share.conversationCount,
    revision: share.revision,
    deployment: share.deployment,
    createdAt: share.createdAt,
    updatedAt: share.updatedAt,
  };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function readBody(request: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        request.destroy();
        reject(new HttpError(413, 'body too large'));
        return;
      }
      chunks.push(chunk);
    });
    request.once('end', () => resolve(Buffer.concat(chunks)));
    request.once('error', reject);
  });
}

async function readJson(request: http.IncomingMessage, maxBytes: number): Promise<unknown> {
  try {
    return JSON.parse((await readBody(request, maxBytes)).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'invalid JSON');
  }
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function writeLine(stream: Writable, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

async function digestFile(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** The reader page's script and style, as a build carries them beside its bundle. */
export type LanShareReaderAssets = { script: Buffer; style: Buffer };

const READER_SCRIPT_FILE_NAME = 'lan-share-reader.js';
const READER_STYLE_FILE_NAME = 'lan-share-reader.css';

/**
 * Beside the entry the hub was started from, beside or above the chunk this
 * module was bundled into, or the reader package of a source checkout.
 */
export function loadLanShareReaderAssets(): LanShareReaderAssets | null {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const directories = [
    ...(process.argv[1] ? [path.dirname(path.resolve(process.argv[1]))] : []),
    moduleDirectory,
    path.dirname(moduleDirectory),
    path.resolve(moduleDirectory, '../../../../../packages/lan-share-reader/dist'),
  ];
  for (const directory of directories) {
    try {
      return {
        script: fs.readFileSync(path.join(directory, READER_SCRIPT_FILE_NAME)),
        style: fs.readFileSync(path.join(directory, READER_STYLE_FILE_NAME)),
      };
    } catch {
      /* not carried here */
    }
  }
  return null;
}

const READER_SCRIPT_PATH = '/_lody/share-reader.js';
const READER_STYLE_PATH = '/_lody/share-reader.css';
const READER_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lody</title>
<link rel="stylesheet" href="${READER_STYLE_PATH}">
</head>
<body>
<main id="app"></main>
<script src="${READER_SCRIPT_PATH}"></script>
</body>
</html>
`;

/** Every answer of the share listener: private, unindexed, never framed. */
const READER_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
const PAGE_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
/** An object opened by itself runs nothing, whatever its type. */
const OBJECT_POLICY = "default-src 'none'; sandbox; frame-ancestors 'none'";

const PAGE_ROUTE = /^\/s\/([A-Za-z0-9_-]{32})\/?$/u;
const SHARE_JSON_ROUTE = /^\/s\/([A-Za-z0-9_-]{32})\/share\.json$/u;
const OBJECT_ROUTE = /^\/s\/([A-Za-z0-9_-]{32})\/d\/([a-f0-9]{64})\/([a-zA-Z0-9_-]{1,128})$/u;
const MANAGE_OBJECT_ROUTE = /^\/lan\/shares\/objects\/([a-f0-9]{64})$/u;
const MANAGE_SHARE_ROUTE = /^\/lan\/shares\/([A-Za-z0-9_-]{32})$/u;

/** The groups of a route pattern, or `null` when the route is another one. */
function groups(pattern: RegExp, route: string): string[] | null {
  const match = pattern.exec(route);
  return match ? match.slice(1).map((group) => group ?? '') : null;
}

export type LanHubShares = {
  /** Whether a gate route is a management route of the shares. */
  handles(url: string | undefined): boolean;
  /** A management request of a member; the gate checked its credential. */
  handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void>;
  /** A request to the share listener, from anyone. */
  read(request: http.IncomingMessage, response: http.ServerResponse): void;
  /** Resolves once no commit, revoke or setting is being written. */
  idle(): Promise<void>;
  /** Deletes the objects no share needs any more. */
  collect(): Promise<void>;
  close(): void;
};

export function createLanHubShares(options: {
  dataDir: string;
  /** The port readers reach; `null` when the hub serves none. */
  sharePort: () => number | null;
  readerAssets?: () => LanShareReaderAssets | null;
  /**
   * Whether the hub still serves its LAN. A write whose body arrives after a
   * handover began is refused: the new host already copied the shares.
   */
  isServing: () => boolean;
  now?: () => number;
  log?: (line: string) => void;
}): LanHubShares {
  const directory = getLanHubSharesDirectory(options.dataDir);
  const now = options.now ?? Date.now;
  let assets: LanShareReaderAssets | null | undefined;
  const readerAssets = () => {
    if (assets === undefined) assets = (options.readerAssets ?? loadLanShareReaderAssets)();
    return assets;
  };
  let index = readIndex(directory);

  // Writes of the index one at a time, so a commit never reads what another
  // is about to replace and a handover waits for the last one.
  let writing: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(task: () => Promise<T> | T): Promise<T> => {
    const guarded = () => {
      if (!options.isServing()) throw new HttpError(503, 'this LAN is served elsewhere');
      return task();
    };
    const run = writing.then(guarded, guarded);
    writing = run.catch(() => undefined);
    return run;
  };

  const collect = () =>
    exclusive(async () => {
      const objects = path.join(directory, OBJECTS_DIR);
      let names: string[];
      try {
        names = await fs.promises.readdir(objects);
      } catch {
        return;
      }
      const at = now();
      const keep = referencedObjects(directory, index, at);
      let removed = 0;
      for (const name of names) {
        if (keep.has(name)) continue;
        const filePath = path.join(objects, name);
        const stat = await fs.promises.stat(filePath).catch(() => null);
        if (!stat || at - stat.mtimeMs < UPLOAD_GRACE_MS) continue;
        await fs.promises.rm(filePath, { force: true });
        removed += 1;
      }
      // Retired deployments past their grace are no longer served.
      let pruned = false;
      for (const share of Object.values(index.shares)) {
        const live = share.retired.filter((entry) => entry.until > at);
        if (live.length !== share.retired.length) {
          share.retired = live;
          pruned = true;
        }
      }
      if (pruned) writeIndex(directory, index);
      if (removed > 0) options.log?.(`[shares] Removed ${removed} object(s) no share needs.`);
    });

  const collector = setInterval(() => void collect().catch(() => undefined), COLLECT_INTERVAL_MS);
  collector.unref?.();

  const list = (): LanShareList => ({
    shares: Object.entries(index.shares)
      .map(([shareId, share]) => view(shareId, share))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    sharePort: options.sharePort(),
    publicUrl: index.publicUrl,
  });

  const putObject = async (request: http.IncomingMessage, sha256: string): Promise<number> => {
    const target = objectPath(directory, sha256);
    if (fs.existsSync(target)) {
      request.resume();
      // Touched, so a collection while an update uploads does not take it.
      const at = new Date(now());
      await fs.promises.utimes(target, at, at).catch(() => undefined);
      return 204;
    }
    await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.incoming-${crypto.randomBytes(6).toString('hex')}`;
    const hash = crypto.createHash('sha256');
    let size = 0;
    try {
      const handle = await fs.promises.open(temporary, 'wx', 0o600);
      try {
        for await (const chunk of request as AsyncIterable<Buffer>) {
          size += chunk.length;
          if (size > SHARE_LIMITS.objectBytes) throw new HttpError(413, 'object too large');
          hash.update(chunk);
          await handle.write(chunk);
        }
      } finally {
        await handle.close();
      }
      if (hash.digest('hex') !== sha256) throw new HttpError(400, 'object digest mismatch');
      await fs.promises.rename(temporary, target);
      return 201;
    } finally {
      await fs.promises.rm(temporary, { force: true });
    }
  };

  const commit = (body: unknown) =>
    exclusive(() => {
      const parsed = LanShareCommitSchema.safeParse(body);
      if (!parsed.success) throw new HttpError(400, 'invalid share');
      const { shareId, expectedRevision, rootSourceId, sources } = parsed.data;
      const manifestResult = SharePackageManifestSchema.safeParse(parsed.data.manifest);
      if (!manifestResult.success) throw new HttpError(400, 'invalid manifest');
      const manifest = manifestResult.data;
      try {
        assertShareAttachmentPolicy(manifest);
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : 'invalid attachments');
      }
      // The reader page decodes no Zstd.
      if (manifest.objects.some((object) => object.contentEncoding)) {
        throw new HttpError(400, 'compressed history is not accepted');
      }
      if (sources.length !== manifest.conversations.length) {
        throw new HttpError(400, 'sources do not match the manifest');
      }
      for (const object of manifest.objects) {
        let size: number;
        try {
          size = fs.statSync(objectPath(directory, object.sha256)).size;
        } catch {
          throw new HttpError(409, `object ${object.id} was not uploaded`);
        }
        if (size !== object.sizeBytes) throw new HttpError(400, `object ${object.id} differs`);
      }
      const manifestBytes = Buffer.from(JSON.stringify(manifest));
      const deployment = crypto.createHash('sha256').update(manifestBytes).digest('hex');
      const manifestPath = objectPath(directory, deployment);
      fs.mkdirSync(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
      if (!fs.existsSync(manifestPath)) {
        fs.writeFileSync(`${manifestPath}.tmp`, manifestBytes, { mode: 0o600 });
        fs.renameSync(`${manifestPath}.tmp`, manifestPath);
      }

      const at = now();
      const stamp = new Date(at).toISOString();
      const root = manifest.conversations.find(
        (conversation) => conversation.id === manifest.rootConversationId
      );
      const fields = {
        title: root?.title ?? '',
        rootSourceId,
        sources: sources satisfies LanShareSource[],
        conversationCount: manifest.conversations.length,
        deployment,
        updatedAt: stamp,
      };
      const next: Index = { ...index, shares: { ...index.shares } };
      let id: string;
      let record: StoredShare;
      if (shareId) {
        const existing = index.shares[shareId];
        if (!existing) throw new HttpError(404, 'no such share');
        if (expectedRevision !== undefined && expectedRevision !== existing.revision) {
          throw new HttpError(409, 'the share changed meanwhile');
        }
        id = shareId;
        record = {
          ...existing,
          ...fields,
          revision: existing.revision + 1,
          retired:
            existing.deployment === deployment
              ? existing.retired
              : [
                  ...existing.retired.filter((entry) => entry.until > at),
                  { deployment: existing.deployment, until: at + RETIRED_GRACE_MS },
                ],
        };
      } else {
        id = crypto.randomBytes(24).toString('base64url');
        record = { ...fields, revision: 1, retired: [], createdAt: stamp };
      }
      next.shares[id] = record;
      writeIndex(directory, next);
      index = next;
      return view(id, record);
    });

  const revoke = (shareId: string) =>
    exclusive(() => {
      if (!index.shares[shareId]) return false;
      const next: Index = { ...index, shares: { ...index.shares } };
      delete next.shares[shareId];
      writeIndex(directory, next);
      index = next;
      return true;
    });

  const setPublicUrl = (body: unknown) =>
    exclusive(() => {
      const parsed = LanShareSettingsSchema.safeParse(body);
      if (!parsed.success) throw new HttpError(400, 'publicUrl required');
      let publicUrl: string | null;
      try {
        publicUrl = normalizeLanSharePublicUrl(parsed.data.publicUrl);
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : 'invalid address');
      }
      const next: Index = { ...index, publicUrl };
      writeIndex(directory, next);
      index = next;
      return publicUrl;
    });

  const handle = async (
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> => {
    const route = (request.url ?? '').split('?')[0] ?? '';
    try {
      const [sha256] = groups(MANAGE_OBJECT_ROUTE, route) ?? [];
      if (sha256) {
        if (request.method === 'HEAD') {
          response.writeHead(fs.existsSync(objectPath(directory, sha256)) ? 200 : 404);
          response.end();
          return;
        }
        if (request.method !== 'PUT') throw new HttpError(405, 'method not allowed');
        response.writeHead(await putObject(request, sha256));
        response.end();
        return;
      }
      if (route === LAN_SHARES_PATH && request.method === 'GET') {
        sendJson(response, 200, list());
        return;
      }
      if (route === LAN_SHARES_PATH && request.method === 'POST') {
        const share = await commit(await readJson(request, COMMIT_BODY_MAX_BYTES));
        sendJson(response, 200, share);
        void collect().catch(() => undefined);
        return;
      }
      if (route === LAN_SHARES_SETTINGS_PATH && request.method === 'PUT') {
        sendJson(response, 200, {
          publicUrl: await setPublicUrl(await readJson(request, 64 * 1024)),
        });
        return;
      }
      if (route === LAN_SHARES_COPY_PATH && request.method === 'POST') {
        const parsed = z
          .object({ have: z.array(SHA256_SCHEMA).max(1_000_000) })
          .strict()
          .safeParse(await readJson(request, SMALL_BODY_MAX_BYTES));
        if (!parsed.success) throw new HttpError(400, 'have required');
        await idle();
        response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        await writeLanHubSharesCopy({ dataDir: options.dataDir, have: parsed.data.have }, response);
        response.end();
        return;
      }
      const [revoked] = groups(MANAGE_SHARE_ROUTE, route) ?? [];
      if (revoked && request.method === 'DELETE') {
        if (!(await revoke(revoked))) throw new HttpError(404, 'no such share');
        response.writeHead(204);
        response.end();
        void collect().catch(() => undefined);
        return;
      }
      throw new HttpError(404, 'not found');
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (error instanceof HttpError) {
        sendJson(response, error.status, { error: error.message });
        return;
      }
      options.log?.(`[shares] ${request.method} ${route} failed: ${String(error)}`);
      sendJson(response, 500, { error: 'share storage failed' });
    }
  };

  const notFound = (response: http.ServerResponse) => {
    response.writeHead(404, {
      ...READER_HEADERS,
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Security-Policy': OBJECT_POLICY,
    });
    response.end('Not found\n');
  };

  const read = (request: http.IncomingMessage, response: http.ServerResponse): void => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { ...READER_HEADERS, Allow: 'GET, HEAD' });
      response.end();
      return;
    }
    let route: string;
    try {
      route = new URL(request.url ?? '/', 'http://share.invalid').pathname;
    } catch {
      notFound(response);
      return;
    }
    const send = (status: number, headers: http.OutgoingHttpHeaders, body: Buffer | string) => {
      response.writeHead(status, { ...READER_HEADERS, ...headers });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    if (route === READER_SCRIPT_PATH || route === READER_STYLE_PATH) {
      const loaded = readerAssets();
      if (!loaded) {
        notFound(response);
        return;
      }
      const script = route === READER_SCRIPT_PATH;
      send(
        200,
        {
          'Content-Type': script ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8',
          'Content-Security-Policy': OBJECT_POLICY,
        },
        script ? loaded.script : loaded.style
      );
      return;
    }
    const [pageId] = groups(PAGE_ROUTE, route) ?? [];
    if (pageId) {
      if (!index.shares[pageId]) {
        notFound(response);
        return;
      }
      send(
        200,
        { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PAGE_POLICY },
        READER_HTML
      );
      return;
    }
    const [jsonId] = groups(SHARE_JSON_ROUTE, route) ?? [];
    if (jsonId) {
      const share = index.shares[jsonId];
      if (!share) {
        notFound(response);
        return;
      }
      let manifest: SharePackageManifest;
      try {
        manifest = readManifest(directory, share.deployment);
      } catch {
        notFound(response);
        return;
      }
      send(
        200,
        { 'Content-Type': 'application/json', 'Content-Security-Policy': OBJECT_POLICY },
        JSON.stringify({
          title: share.title,
          updatedAt: share.updatedAt,
          deployment: share.deployment,
          manifest,
        })
      );
      return;
    }
    const [objectShareId, deployment = '', objectId] = groups(OBJECT_ROUTE, route) ?? [];
    if (objectShareId) {
      const share = index.shares[objectShareId];
      if (!share || !liveDeployments(share, now()).includes(deployment)) {
        notFound(response);
        return;
      }
      let descriptor: SharePackageManifest['objects'][number] | undefined;
      try {
        descriptor = readManifest(directory, deployment).objects.find(
          (entry) => entry.id === objectId
        );
      } catch {
        descriptor = undefined;
      }
      if (!descriptor) {
        notFound(response);
        return;
      }
      const filePath = objectPath(directory, descriptor.sha256);
      response.writeHead(200, {
        ...READER_HEADERS,
        'Content-Type': descriptor.mediaType,
        'Content-Length': descriptor.sizeBytes,
        'Content-Security-Policy': OBJECT_POLICY,
      });
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      fs.createReadStream(filePath)
        .once('error', (error) => response.destroy(error))
        .pipe(response);
      return;
    }
    notFound(response);
  };

  const idle = async () => {
    await writing;
  };

  return {
    handles: (url) => {
      const route = url?.split('?')[0] ?? '';
      return route === LAN_SHARES_PATH || route.startsWith(`${LAN_SHARES_PATH}/`);
    },
    handle,
    read,
    idle,
    collect,
    close: () => clearInterval(collector),
  };
}

/**
 * The shares a hub keeps, as one consistent reading: the index as it is on
 * disk and the objects it still needs. A hub that never published has none.
 */
export function readLanHubShareFiles(
  dataDir: string,
  now = Date.now()
): { index: Buffer; objects: string[] } | null {
  const directory = getLanHubSharesDirectory(dataDir);
  let raw: Buffer;
  try {
    raw = fs.readFileSync(path.join(directory, INDEX_FILE_NAME));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const index = IndexSchema.parse(JSON.parse(raw.toString('utf8')));
  return {
    index: raw,
    objects: [...referencedObjects(directory, index, now)]
      .filter((sha256) => fs.existsSync(objectPath(directory, sha256)))
      .sort(),
  };
}

/** Sends one file of the shares: a line that names it, then exactly its bytes. */
async function writeShareFile(
  stream: Writable,
  dataDir: string,
  name: string,
  bytes: Buffer | null,
  type = 'file'
): Promise<void> {
  const filePath = path.join(dataDir, name);
  if (bytes) {
    writeLine(stream, {
      type,
      name,
      sizeBytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    });
    stream.write(bytes);
    return;
  }
  const { size } = await fs.promises.stat(filePath);
  writeLine(stream, { type, name, sizeBytes: size, sha256: await digestFile(filePath) });
  if (size > 0) {
    await pipeline(fs.createReadStream(filePath, { end: size - 1 }), stream, { end: false });
  }
}

export const LAN_HUB_SHARES_INDEX_FILE = `${LAN_HUB_SHARES_DIR}/${INDEX_FILE_NAME}`;

/**
 * Sends the shares of a data directory that stands still, in the framing of
 * a handover; returns how many files it sent.
 */
export async function writeLanHubShareFiles(
  dataDir: string,
  stream: Writable,
  type: string
): Promise<number> {
  const shares = readLanHubShareFiles(dataDir);
  if (!shares) return 0;
  await writeShareFile(stream, dataDir, LAN_HUB_SHARES_INDEX_FILE, shares.index, type);
  for (const sha256 of shares.objects) {
    const name = `${LAN_HUB_SHARES_DIR}/${OBJECTS_DIR}/${sha256}`;
    await writeShareFile(stream, dataDir, name, null, type);
  }
  return 1 + shares.objects.length;
}

/** Whether `name` is a file of the shares as `listLanHubShareFiles` names one. */
export function isLanHubShareFile(name: string): boolean {
  const parts = name.split('/');
  return (
    parts.length >= 2 &&
    parts[0] === LAN_HUB_SHARES_DIR &&
    ((parts.length === 2 && parts[1] === INDEX_FILE_NAME) ||
      (parts.length === 3 && parts[1] === OBJECTS_DIR && SHA256.test(parts[2] ?? '')))
  );
}

const CopyHeaderSchema = z
  .object({ type: z.literal('shares'), objects: z.array(SHA256_SCHEMA) })
  .strict();
const CopyFileSchema = z
  .object({
    type: z.literal('file'),
    name: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    sha256: SHA256_SCHEMA,
  })
  .strict();
const CopyEndSchema = z.object({ type: z.literal('end') }).strict();

/**
 * What a standby needs to keep the shares with its copy: the objects the hub
 * keeps, the index, and the objects the standby does not hold already.
 */
export async function writeLanHubSharesCopy(
  options: { dataDir: string; have: readonly string[] },
  stream: Writable
): Promise<void> {
  const shares = readLanHubShareFiles(options.dataDir);
  writeLine(stream, { type: 'shares', objects: shares?.objects ?? [] });
  if (shares) {
    await writeShareFile(stream, options.dataDir, LAN_HUB_SHARES_INDEX_FILE, shares.index);
    const have = new Set(options.have);
    for (const sha256 of shares.objects) {
      if (have.has(sha256)) continue;
      const name = `${LAN_HUB_SHARES_DIR}/${OBJECTS_DIR}/${sha256}`;
      await writeShareFile(stream, options.dataDir, name, null);
    }
  }
  writeLine(stream, { type: 'end' });
}

/**
 * Writes the shares a hub sent into `target` (a data directory being
 * assembled), taking the objects the hub left out from `previous`.
 */
export async function readLanHubSharesCopy(
  stream: Readable,
  target: string,
  previous: string | null
): Promise<{ objects: number; received: number }> {
  const reader = new ByteReader(stream, Buffer.alloc(0));
  const readLine = async () => {
    const line = await reader.readLine(LINE_MAX_BYTES * 64);
    if (line === null) throw new Error('The hub stopped sending the shares before it was done');
    return JSON.parse(line) as unknown;
  };
  const header = CopyHeaderSchema.parse(await readLine());
  const objects = path.join(getLanHubSharesDirectory(target), OBJECTS_DIR);
  await fs.promises.mkdir(objects, { recursive: true, mode: 0o700 });
  let received = 0;
  for (;;) {
    const value = await readLine();
    if (CopyEndSchema.safeParse(value).success) break;
    const file = CopyFileSchema.parse(value);
    if (!isLanHubShareFile(file.name)) throw new Error(`The hub sent ${file.name} as a share file`);
    await receiveFile(reader, path.join(target, file.name), file);
    received += 1;
  }
  for (const sha256 of header.objects) {
    const filePath = path.join(objects, sha256);
    if (fs.existsSync(filePath)) continue;
    const kept = previous ? path.join(getLanHubSharesDirectory(previous), OBJECTS_DIR, sha256) : '';
    if (!kept || !fs.existsSync(kept)) throw new Error(`The hub did not send object ${sha256}`);
    await fs.promises.link(kept, filePath).catch(async () => {
      await fs.promises.copyFile(kept, filePath);
    });
  }
  return { objects: header.objects.length, received };
}

/** The objects a copy of a hub's data holds, which the hub need not send again. */
export function listLanHubShareObjects(dataDir: string): string[] {
  try {
    return fs
      .readdirSync(path.join(getLanHubSharesDirectory(dataDir), OBJECTS_DIR))
      .filter((name) => SHA256.test(name));
  } catch {
    return [];
  }
}

/** Writes one file of a handover or copy and checks it against its digest. */
export async function receiveFile(
  reader: ByteReader,
  filePath: string,
  file: { name: string; sizeBytes: number; sha256: string }
): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const handle = await fs.promises.open(filePath, 'wx', 0o600);
  const hash = crypto.createHash('sha256');
  try {
    await reader.readBytes(file.sizeBytes, async (chunk) => {
      hash.update(chunk);
      await handle.write(chunk);
    });
  } finally {
    await handle.close();
  }
  if (hash.digest('hex') !== file.sha256) throw new Error(`${file.name} arrived damaged`);
}

/** Copies the shares of `from` into `to` without reading their bytes again. */
async function keepLanHubShares(from: string, to: string): Promise<void> {
  const source = getLanHubSharesDirectory(from);
  if (!fs.existsSync(source)) return;
  const target = getLanHubSharesDirectory(to);
  await fs.promises.mkdir(path.join(target, OBJECTS_DIR), { recursive: true, mode: 0o700 });
  await fs.promises.copyFile(
    path.join(source, INDEX_FILE_NAME),
    path.join(target, INDEX_FILE_NAME)
  );
  for (const sha256 of listLanHubShareObjects(from)) {
    const kept = path.join(source, OBJECTS_DIR, sha256);
    const copy = path.join(target, OBJECTS_DIR, sha256);
    await fs.promises.link(kept, copy).catch(async () => {
      await fs.promises.copyFile(kept, copy);
    });
  }
}

/**
 * Brings the shares of a standby's copy, assembled in `next`, up to the hub.
 * A hub of a build without shares has none to give. One that failed to
 * answer leaves the shares of the previous copy in place.
 */
export async function pullLanHubSharesCopy(options: {
  hub: { url: string; token: string };
  next: string;
  previous: string | null;
  fetch?: typeof fetch;
}): Promise<{ objects: number; received: number } | null> {
  let response: Response | null = null;
  try {
    response = await (options.fetch ?? fetch)(`${options.hub.url}${LAN_SHARES_COPY_PATH}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.hub.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        have: options.previous ? listLanHubShareObjects(options.previous) : [],
      }),
      signal: AbortSignal.timeout(10 * 60_000),
    });
  } catch {
    response = null;
  }
  if (response?.status === 404 || response?.status === 405) return null;
  if (!response?.ok || !response.body) {
    if (options.previous) await keepLanHubShares(options.previous, options.next);
    return null;
  }
  return await readLanHubSharesCopy(
    Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
    options.next,
    options.previous
  );
}
