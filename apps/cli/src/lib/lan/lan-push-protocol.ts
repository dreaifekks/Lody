// What members of a LAN tell its hub so the hub can push to phones, and what
// a phone registers. Both sides run from this package, so the shapes live here.
import type {
  LiveActivityConversationItem,
  LiveActivityPermissionAlert,
  LiveActivityStatusCounts,
} from '@lody/shared';

export const LAN_PUSH_DEVICES_PATH = '/push/devices';
export const LAN_PUSH_EVENTS_PATH = '/push/events';
export const LAN_PUSH_STATUS_PATH = '/push/status';
export const LAN_PUSH_TEST_PATH = '/push/test';

type LanPushEventBase = {
  /** The member that observed the event. */
  machineId: string;
  /** Shown on alerts once a LAN has more than one member. */
  machineName?: string | null;
  workspaceId: string;
  workspaceSlug: string;
  userId: string;
};

export type LanPushEvent =
  | (LanPushEventBase & {
      type: 'session-completed';
      sessionId: string;
      occurrenceId: string;
      sessionTitle?: string | null;
    })
  | (LanPushEventBase & {
      type: 'session-failed';
      sessionId: string;
      sessionTitle?: string | null;
      reason: string;
      message?: string | null;
    })
  | (LanPushEventBase & {
      type: 'permission-requested';
      sessionId: string;
      sessionTitle?: string | null;
      requestId: string;
      toolTitle?: string | null;
      requestKind?: 'permission' | 'ask_user_question';
    })
  | (LanPushEventBase & {
      type: 'schedule';
      phase: 'dispatched' | 'blocked' | 'skipped';
      scheduleId: string;
      runKey: string;
      title: string;
      sessionId?: string | null;
      code?: string | null;
    })
  | (LanPushEventBase & {
      type: 'live-activity';
      activityId: string;
      totalCount: number;
      statusCounts: LiveActivityStatusCounts;
      items: readonly LiveActivityConversationItem[];
      updatedAt: number;
      permissionAlert?: LiveActivityPermissionAlert;
    });

export type LanPushLiveActivityResult =
  | { sent: true; ended: boolean }
  | { sent: false; reason?: string };

/** Everything a phone tells the hub; each registration replaces the last. */
export type LanPushDevice = {
  deviceToken: string;
  environment: 'development' | 'production';
  bundleId: string;
  userId: string;
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
  /** BCP 47, e.g. `zh-Hans-CN`; picks the language of alerts. */
  locale: string;
  alerts: boolean;
  liveActivities: boolean;
  pushToStartToken: string | null;
  /** Update tokens of the activities running on the phone, by activity id. */
  activities: Record<string, string>;
  /** Widget copy in the phone's language; the hub does not translate it. */
  liveActivityCopy?: Record<string, string> | null;
  liveActivityLabels?: Partial<
    Record<'permission' | 'question' | 'running' | 'unread', string>
  > | null;
  updatedAt: number;
};
