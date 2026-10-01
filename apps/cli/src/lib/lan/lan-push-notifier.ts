// The notifications port of a LAN workspace: instead of a hosted backend, the
// member reports to the hub of its LAN, which pushes to the phones that
// registered there. A hub without push answers 404 and the report is dropped.
import type { CloudNotificationsPort } from '@lody/platform';
import type { LanHub } from '@lody/shared/node/lan-hub';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import {
  LAN_PUSH_EVENTS_PATH,
  type LanPushEvent,
  type LanPushLiveActivityResult,
} from './lan-push-protocol';

const REPORT_TIMEOUT_MS = 8_000;

type WithoutMachine<E> = E extends LanPushEvent ? Omit<E, 'machineId'> : never;
type Report = WithoutMachine<LanPushEvent>;

export function createLanNotificationsPort(options: {
  /** Read at each report, so a LAN that moved is followed. */
  resolveHub: () => LanHub | null;
  machineId: string;
  logger: Logger;
  fetch?: typeof fetch;
}): Required<CloudNotificationsPort> {
  const request = options.fetch ?? fetch;

  const report = async (event: LanPushEvent): Promise<LanPushLiveActivityResult | null> => {
    const hub = options.resolveHub();
    if (!hub) return null;
    try {
      const response = await request(`${hub.url}${LAN_PUSH_EVENTS_PATH}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${hub.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
        redirect: 'error',
        signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
      });
      if (!response.ok) {
        options.logger.debug(`[lan-push] ${event.type} answered ${response.status}`);
        return null;
      }
      return (await response.json()) as LanPushLiveActivityResult;
    } catch (error) {
      options.logger.debug(`[lan-push] ${event.type} not delivered: ${formatErrorMessage(error)}`);
      return null;
    }
  };

  const send = async (event: Report) => await report({ ...event, machineId: options.machineId });

  return {
    notifySessionCompleted: async (input) => {
      await send({
        type: 'session-completed',
        sessionId: input.sessionId,
        occurrenceId: input.occurrenceId,
        sessionTitle: input.sessionTitle,
        workspaceId: input.workspaceId,
        workspaceSlug: input.workspaceSlug,
        userId: input.userId,
      });
    },
    notifySessionFailed: async (input) => {
      await send({ type: 'session-failed', ...input });
    },
    notifyPermissionRequested: async (input) => {
      await send({
        type: 'permission-requested',
        sessionId: input.sessionId,
        sessionTitle: input.sessionTitle,
        requestId: input.requestId,
        toolTitle: input.toolTitle,
        requestKind: input.requestKind,
        workspaceId: input.workspaceId,
        workspaceSlug: input.workspaceSlug,
        userId: input.userId,
      });
    },
    // A LAN has no inbox to record into; the alert is the whole effect.
    recordPermissionRequested: () => Promise.resolve(),
    resolvePermissionRequested: () => Promise.resolve(),
    notifyScheduleEvent: async (input) => {
      await send({ type: 'schedule', ...input });
    },
    syncLiveActivitySummary: async (input) => {
      const result = await send({
        type: 'live-activity',
        ...input,
        // The member does not know the LAN's slug; the phone supplies its own.
        workspaceSlug: input.workspaceId,
      });
      return result && 'sent' in result ? result : { sent: false, reason: 'hub_unavailable' };
    },
  };
}
