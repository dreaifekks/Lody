// What the agent service does for the window with the shares of a LAN: it
// uploads a frozen package the shell wrote to disk, lists and revokes shares,
// all with the hub's credential, which the window never holds.
// See `.agents/docs/lan-sharing.md#shared-conversations`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  LAN_SHARES_OBJECTS_PATH,
  LAN_SHARES_PATH,
  LAN_SHARES_SETTINGS_PATH,
  LanShareListSchema,
  LanShareSchema,
  formatLanShareUrl,
  resolveLanShareBaseUrl,
  type LanShareList,
  type LanShareSource,
  type LanSharedConversation,
} from '@lody/shared/lan-share';
import type { LanHub } from '@lody/shared/node/lan-hub';
import { SharePackageManifestSchema, mapShareConcurrent } from '@lody/shared/session-sharing';

const REQUEST_TIMEOUT_MS = 30_000;
const OBJECT_TIMEOUT_MS = 5 * 60_000;

export class LanShareError extends Error {
  constructor(
    message: string,
    readonly status: number | null
  ) {
    super(message);
    this.name = 'LanShareError';
  }
}

type Hub = Pick<LanHub, 'url' | 'token'>;
type Options = { fetch?: typeof fetch };

async function callHub(
  hub: Hub,
  route: string,
  init: {
    method: string;
    headers?: Record<string, string>;
    body?: BodyInit;
    timeoutMs?: number;
  },
  options: Options
): Promise<Response> {
  const { timeoutMs, headers, ...rest } = init;
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${hub.url}${route}`, {
      ...rest,
      headers: { ...headers, Authorization: `Bearer ${hub.token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new LanShareError(`The hub could not be reached: ${String(error)}`, null);
  }
  if (response.ok) return response;
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  const reason = typeof body?.error === 'string' ? body.error : `answered ${response.status}`;
  // A hub of a build without shares forwards the route to its Streams server.
  if (response.status === 404 && route === LAN_SHARES_PATH) {
    throw new LanShareError('The hub of this LAN runs a build without shares; update it', 404);
  }
  throw new LanShareError(`The hub refused: ${reason}`, response.status);
}

function withLinks(hub: Hub, list: LanShareList): LanSharedConversation[] {
  const base = resolveLanShareBaseUrl(hub.url, list);
  return list.shares.map((share) => ({
    ...share,
    url: base ? formatLanShareUrl(base, share.shareId) : null,
  }));
}

export async function listLanShares(hub: Hub, options: Options = {}): Promise<LanShareList> {
  const response = await callHub(hub, LAN_SHARES_PATH, { method: 'GET' }, options);
  return LanShareListSchema.parse(await response.json());
}

export async function listLanSharedConversations(
  hub: Hub,
  options: Options = {}
): Promise<LanSharedConversation[]> {
  return withLinks(hub, await listLanShares(hub, options));
}

/**
 * Uploads the package in `directory` (`manifest.json` and `objects/<object
 * id>`, as the shell writes it) and commits it. Objects the hub holds already,
 * such as the images an update carries again, are not sent twice.
 */
export async function publishLanShare(
  hub: Hub,
  input: {
    directory: string;
    shareId?: string;
    expectedRevision?: number;
    rootSourceId: string;
    sources: LanShareSource[];
  },
  options: Options = {}
): Promise<LanSharedConversation> {
  const manifest = SharePackageManifestSchema.parse(
    JSON.parse(await fs.promises.readFile(path.join(input.directory, 'manifest.json'), 'utf8'))
  );
  // Four at a time, as upstream uploads.
  await mapShareConcurrent(manifest.objects, async (object) => {
    const bytes = await fs.promises.readFile(path.join(input.directory, 'objects', object.id));
    if (
      bytes.length !== object.sizeBytes ||
      crypto.createHash('sha256').update(bytes).digest('hex') !== object.sha256
    ) {
      throw new LanShareError(`Object ${object.id} does not match the manifest`, null);
    }
    const route = `${LAN_SHARES_OBJECTS_PATH}/${object.sha256}`;
    const held = await callHub(hub, route, { method: 'HEAD' }, options).then(
      () => true,
      (error: unknown) => {
        if (error instanceof LanShareError && error.status === 404) return false;
        throw error;
      }
    );
    if (held) return;
    await callHub(
      hub,
      route,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: bytes,
        timeoutMs: OBJECT_TIMEOUT_MS,
      },
      options
    );
  });
  const response = await callHub(
    hub,
    LAN_SHARES_PATH,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(input.shareId ? { shareId: input.shareId } : {}),
        ...(input.expectedRevision ? { expectedRevision: input.expectedRevision } : {}),
        rootSourceId: input.rootSourceId,
        sources: input.sources,
        manifest,
      }),
    },
    options
  );
  const share = LanShareSchema.parse(await response.json());
  const list = await listLanShares(hub, options);
  const base = resolveLanShareBaseUrl(hub.url, list);
  return { ...share, url: base ? formatLanShareUrl(base, share.shareId) : null };
}

export async function revokeLanShare(
  hub: Hub,
  shareId: string,
  options: Options = {}
): Promise<boolean> {
  try {
    await callHub(hub, `${LAN_SHARES_PATH}/${shareId}`, { method: 'DELETE' }, options);
    return true;
  } catch (error) {
    if (error instanceof LanShareError && error.status === 404) return false;
    throw error;
  }
}

/** Sets where readers reach the shares from outside, or takes it back with `null`. */
export async function setLanSharePublicUrl(
  hub: Hub,
  publicUrl: string | null,
  options: Options = {}
): Promise<string | null> {
  const response = await callHub(
    hub,
    LAN_SHARES_SETTINGS_PATH,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicUrl }),
    },
    options
  );
  const body = (await response.json()) as { publicUrl?: unknown };
  return typeof body.publicUrl === 'string' ? body.publicUrl : null;
}
