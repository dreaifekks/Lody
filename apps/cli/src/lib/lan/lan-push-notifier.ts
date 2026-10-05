// The notifications port of a LAN workspace: instead of a hosted backend, the
// member reports to the hub of its LAN, which pushes to the phones that
// registered there. A hub without push answers 404 and the report is dropped.
import type { CloudNotificationsPort } from '@lody/platform';
import type { SessionId } from '@lody/shared';
import type { LanHub } from '@lody/shared/node/lan-hub';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import type { LanPushFallback } from './lan-push-fallback';
import {
  LAN_PUSH_EVENTS_PATH,
  LAN_PUSH_PERMISSION_ANSWERS_PATH,
  type LanPermissionAnswer,
  type LanPushEvent,
  type LanPushLiveActivityResult,
} from './lan-push-protocol';

const REPORT_TIMEOUT_MS = 8_000;
/**
 * Long enough for a device showing the conversation to mark the reply read,
 * or for someone at a desktop to answer a permission request first.
 */
export const LAN_ALERT_GRACE_MS = 10_000;
/** The host holds a poll for 25 seconds; give it room to answer. */
const ANSWER_POLL_TIMEOUT_MS = 35_000;
const ANSWER_RETRY_MS = 5_000;

type WithoutMachine<E> = E extends LanPushEvent ? Omit<E, 'machineId'> : never;
type Report = WithoutMachine<LanPushEvent>;

export function createLanNotificationsPort(options: {
  /** Read at each report, so a LAN that moved is followed. */
  resolveHub: () => LanHub | null;
  machineId: string;
  /**
   * Read at each report; `lody lan name` renames a running member, and a
   * short name given in the LAN takes the place of the name.
   */
  machineName?: () => string | null | Promise<string | null>;
  logger: Logger;
  fetch?: typeof fetch;
  /** Sends alerts from this machine while the hub cannot be reached. */
  fallback?: LanPushFallback;
}): Required<CloudNotificationsPort> {
  const request = options.fetch ?? fetch;

  const report = async (event: LanPushEvent): Promise<LanPushLiveActivityResult | null> => {
    const hub = options.resolveHub();
    if (!hub) return null;
    let failure: string;
    try {
      const response = await request(`${hub.url}${LAN_PUSH_EVENTS_PATH}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${hub.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
        redirect: 'error',
        signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
      });
      if (response.ok) return (await response.json()) as LanPushLiveActivityResult;
      // A hub without push keeps no key this machine could have copied.
      if (response.status === 404) {
        options.logger.debug(`[lan-push] ${event.type} answered 404`);
        return null;
      }
      // Any other answer, such as 503 while the hub hands over or 410 once it
      // moved, means the hub did not send it.
      failure = `answered ${response.status}`;
    } catch (error) {
      failure = formatErrorMessage(error);
    }
    // The hub did not take it, which is when this machine sends alerts itself.
    const sent = await options.fallback?.deliver(hub, event).catch((fallbackError: unknown) => {
      options.logger.debug(
        `[lan-push] ${event.type} not sent from here either: ${formatErrorMessage(fallbackError)}`
      );
      return false;
    });
    options.logger.debug(
      `[lan-push] ${event.type} not delivered to the hub: ${failure}${
        sent ? '; sent from this machine' : ''
      }`
    );
    return null;
  };

  const send = async (event: Report) =>
    await report({
      ...event,
      machineId: options.machineId,
      machineName: (await options.machineName?.()) ?? null,
    });

  return {
    alertGraceMs: LAN_ALERT_GRACE_MS,
    deliversOffline: true,
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
    syncLiveActivityDetail: async (input) => {
      await send({ type: 'session-detail', ...input, workspaceSlug: input.workspaceId });
    },
    watchPermissionAnswers: (onAnswer) => {
      // Changed by the returned stop function, not inside the loop.
      const watch = { stopped: false };
      let controller: AbortController | null = null;
      const poll = async () => {
        while (!watch.stopped) {
          const hub = options.resolveHub();
          if (!hub) {
            await new Promise((resolve) => setTimeout(resolve, ANSWER_RETRY_MS).unref?.());
            continue;
          }
          controller = new AbortController();
          const timeout = setTimeout(() => controller?.abort(), ANSWER_POLL_TIMEOUT_MS);
          try {
            const url = `${hub.url}${LAN_PUSH_PERMISSION_ANSWERS_PATH}?machineId=${encodeURIComponent(options.machineId)}`;
            const response = await request(url, {
              headers: { Authorization: `Bearer ${hub.token}` },
              redirect: 'error',
              signal: controller.signal,
            });
            // A host without push answers 404; ask again much later.
            if (response.status === 404) {
              await new Promise((resolve) => setTimeout(resolve, 60_000).unref?.());
              continue;
            }
            if (!response.ok) throw new Error(`status ${response.status}`);
            const body = (await response.json()) as { answers?: LanPermissionAnswer[] };
            for (const answer of body.answers ?? []) {
              await onAnswer({ ...answer, sessionId: answer.sessionId as SessionId }).catch(
                (error: unknown) =>
                  options.logger.debug(
                    `[lan-push] answer not applied: ${formatErrorMessage(error)}`
                  )
              );
            }
          } catch (error) {
            if (watch.stopped) return;
            options.logger.debug(`[lan-push] answer poll failed: ${formatErrorMessage(error)}`);
            await new Promise((resolve) => setTimeout(resolve, ANSWER_RETRY_MS).unref?.());
          } finally {
            clearTimeout(timeout);
          }
        }
      };
      void poll();
      return () => {
        watch.stopped = true;
        controller?.abort();
      };
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
