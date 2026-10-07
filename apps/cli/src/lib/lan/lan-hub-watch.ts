import { normalizeLanHubUrl } from '@lody/shared/lan-hub';
import type { LanHub } from '@lody/shared/node/lan-hub';

/** Requests in a row that never reached a hub before it is asked whether it moved. */
const FAILURES_BEFORE_ASKING = 3;

type Fetch = typeof globalThis.fetch;

/**
 * Watches every request this process makes to its hubs for what a move
 * explains: a hub that answers 410 because it now points elsewhere, or one
 * that requests keep failing to reach. Nothing here trusts the answer; it only
 * says when to ask the hub where it is, which checks the signature.
 *
 * Streams clients take the global `fetch` when they are built, so this wraps
 * it before any of them exists and leaves every other request untouched.
 * Returns what restores the previous `fetch`.
 */
export function watchLanHubRequests(options: {
  hubs: () => readonly LanHub[];
  onTrouble: (hubId: string) => void;
  target?: { fetch: Fetch };
}): () => void {
  const target = options.target ?? globalThis;
  const original = target.fetch;
  const failures = new Map<string, number>();

  const hubOf = (input: Parameters<Fetch>[0]): LanHub | null => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return (
      options.hubs().find((hub) => {
        const base = normalizeLanHubUrl(hub.url);
        return url === base || url.startsWith(`${base}/`);
      }) ?? null
    );
  };

  const watched: Fetch = async (input, init) => {
    const hub = hubOf(input);
    if (!hub) return await original.call(target, input, init);
    let response: Response;
    try {
      response = await original.call(target, input, init);
    } catch (error) {
      if (!isAbort(error, input, init)) {
        const count = (failures.get(hub.id) ?? 0) + 1;
        failures.set(hub.id, count);
        if (count >= FAILURES_BEFORE_ASKING) options.onTrouble(hub.id);
      }
      throw error;
    }
    failures.delete(hub.id);
    // A hub also answers 410 for offsets it no longer holds; only a pointer
    // says it moved. Both are a few bytes of JSON, read before the caller's turn.
    if (response.status === 410 && response.headers.get('content-type')?.includes('json')) {
      const body: unknown = await response
        .clone()
        .json()
        .catch(() => null);
      if ((body as { error?: unknown } | null)?.error === 'moved') options.onTrouble(hub.id);
    }
    return response;
  };

  target.fetch = watched;
  return () => {
    // Something wrapped it again since; unwinding that is not ours to do.
    if (target.fetch === watched) target.fetch = original;
  };
}

/** A request its caller gave up on says nothing about the hub. */
function isAbort(error: unknown, input: Parameters<Fetch>[0], init: Parameters<Fetch>[1]): boolean {
  if (init?.signal?.aborted || (input instanceof Request && input.signal.aborted)) return true;
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}
