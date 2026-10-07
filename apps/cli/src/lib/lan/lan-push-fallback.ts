// Alerts a member sends to the phones itself while its hub is away, from its
// copy of the hub's APNs key and phone registrations (see
// `lan-credential-sync.ts`). Only alerts: a Live Activity merges what every
// member reports, which only the hub sees. The hub collapses an alert by the
// same id, so one the hub sent as well shows once.
import { getLanCredentialsDirectory } from '@lody/shared/node/lan-credentials';
import type { LanHub } from '@lody/shared/node/lan-hub';
import type { Logger } from '@/utils/logger';
import { createApnsSender, readApnsConfig, type ApnsSender } from './apns';
import { createLanHubPush, type LanHubPush } from './hub-push';
import { readLanCredentialsRevision } from './lan-credential-sync';
import type { LanPushEvent } from './lan-push-protocol';

const ALERT_EVENTS = new Set<LanPushEvent['type']>([
  'session-completed',
  'session-failed',
  'agent-message',
  'permission-requested',
  // Only an alert this copy sent itself is withdrawn; it never saw the rest.
  'permission-resolved',
  'schedule',
]);

export type LanPushFallback = {
  /** Whether the event was sent from this machine's copy. */
  deliver(hub: Pick<LanHub, 'id'>, event: LanPushEvent): Promise<boolean>;
  close(): void;
};

export function createLanPushFallback(options: {
  logger: Logger;
  dataDir?: string;
  createSender?: (directory: string) => ApnsSender & { close(): void };
}): LanPushFallback {
  const createSender =
    options.createSender ??
    ((directory: string) => createApnsSender({ loadConfig: () => readApnsConfig(directory) }));
  // One per LAN, kept while its copy stays the same: a sender reuses its
  // provider token, which APNs refuses to see renewed too often.
  const senders = new Map<
    string,
    { revision: string; push: LanHubPush; sender: ApnsSender & { close(): void } }
  >();

  const pushFor = (hubId: string): LanHubPush | null => {
    const directory = getLanCredentialsDirectory(hubId, options.dataDir);
    const revision = readLanCredentialsRevision(directory);
    if (!revision) return null;
    try {
      if (!readApnsConfig(directory)) return null;
    } catch {
      return null;
    }
    const current = senders.get(hubId);
    if (current?.revision === revision) return current.push;
    current?.sender.close();
    const sender = createSender(directory);
    const push = createLanHubPush({
      dataDir: directory,
      send: sender,
      isConfigured: () => true,
      log: (line) => options.logger.debug(`[lan-push] ${line}`),
    });
    senders.set(hubId, { revision, push, sender });
    return push;
  };

  return {
    deliver: async (hub, event) => {
      if (!ALERT_EVENTS.has(event.type)) return false;
      const push = pushFor(hub.id);
      if (!push) return false;
      await push.deliver(event);
      return true;
    },
    close: () => {
      for (const { sender } of senders.values()) sender.close();
      senders.clear();
    },
  };
}
