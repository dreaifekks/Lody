// What members of a LAN tell its hub so the hub can push to phones, and what
// a phone registers. Both sides run from this package, so the shapes live here.
import {
  resolveProjectGitHubRepo,
  type LiveActivityConversationItem,
  type LiveActivityPermissionAlert,
  type LiveActivityStatusCounts,
  type ProjectRef,
} from '@lody/shared';

export const LAN_PUSH_DEVICES_PATH = '/push/devices';
export const LAN_PUSH_EVENTS_PATH = '/push/events';
export const LAN_PUSH_STATUS_PATH = '/push/status';
export const LAN_PUSH_TEST_PATH = '/push/test';
/** A phone answers a permission request from its Live Activity. */
export const LAN_PUSH_PERMISSION_PATH = '/push/permission';
/** A member collects the answers meant for it; held open until one arrives. */
export const LAN_PUSH_PERMISSION_ANSWERS_PATH = '/push/permission-answers';

export type LanPermissionAnswer = { sessionId: string; requestId: string; optionId: string };
export type LanPermissionOption = { id: string; label: string; kind: string };

type LanPushEventBase = {
  /** The member that observed the event. */
  machineId: string;
  /** Shown on alerts once a LAN has more than one member. */
  machineName?: string | null;
  workspaceId: string;
  workspaceSlug: string;
  userId: string;
};

type LanAlertEventBase = LanPushEventBase & {
  /**
   * The project of the alert's session, which groups alerts on a phone;
   * `null` for a chat. Members older than this field leave it out.
   */
  projectId?: string | null;
};

/**
 * A session's project as alerts name it: a local project of the machine that
 * holds it, or a GitHub repository. A worktree session keeps its project's
 * `localProjectId`, so it groups with the project.
 */
export function lanAlertProjectId(session: {
  machineId: string;
  project?: ProjectRef;
  repoFullName?: string;
}): string | null {
  if (session.project?.kind === 'local') {
    return `local:${session.machineId}:${session.project.localProjectId}`;
  }
  const repo = (resolveProjectGitHubRepo(session.project) ?? session.repoFullName)?.trim();
  return repo ? `github:${repo.toLowerCase()}` : null;
}

export type LanPushEvent =
  | (LanAlertEventBase & {
      type: 'session-completed';
      sessionId: string;
      occurrenceId: string;
      sessionTitle?: string | null;
    })
  | (LanAlertEventBase & {
      type: 'session-failed';
      sessionId: string;
      sessionTitle?: string | null;
      reason: string;
      message?: string | null;
    })
  | (LanAlertEventBase & {
      /** A message the agent sent the user through `lody_notify_user`. */
      type: 'agent-message';
      sessionId: string;
      noticeId: string;
      sessionTitle?: string | null;
      title?: string | null;
      body: string;
    })
  | (LanAlertEventBase & {
      type: 'permission-requested';
      sessionId: string;
      sessionTitle?: string | null;
      requestId: string;
      toolTitle?: string | null;
      requestKind?: 'permission' | 'ask_user_question';
    })
  | (LanAlertEventBase & {
      /**
       * The request was answered, here or on another device. The phone's alert
       * for it, if one went out, is replaced by a quiet one saying so.
       */
      type: 'permission-resolved';
      sessionId: string;
      requestId: string;
      sessionTitle?: string | null;
    })
  | (LanAlertEventBase & {
      type: 'schedule';
      phase: 'dispatched' | 'blocked' | 'skipped';
      scheduleId: string;
      runKey: string;
      title: string;
      sessionId?: string | null;
      code?: string | null;
    })
  | (LanPushEventBase & {
      type: 'session-detail';
      sessionId: string;
      activity?: string | null;
      thought?: string | null;
      /** `null` once answered; absent when unchanged. */
      permission?: {
        requestId: string;
        command?: string | null;
        options: readonly LanPermissionOption[];
      } | null;
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
