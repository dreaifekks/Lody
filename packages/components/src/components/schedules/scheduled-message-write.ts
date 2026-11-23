import { requireWorkspaceFeature } from '@/lib/workspace-feature';
import {
  ScheduleRepository,
  ScheduledMessageSchema,
  getServerNow,
  type ScheduleDraft,
  type ScheduledMessage,
  type SessionId,
  type MachineId,
  type SessionInputBlock,
} from '@lody/shared';
import type { WorkspaceRuntime } from '@/atoms/runtime';
import type { SessionAttachmentDraft } from '@/lib/session-attachment-draft';
import { prepareDraftAttachments } from '@/lib/session-attachment-preparation';
import { ScheduleEditConflictError } from '../../providers/schedule-write-sync';

/** One-time message reservations share delivery policy across the composer and quota continue. */
export const SCHEDULED_MESSAGE_POLICY = {
  misfirePolicy: { kind: 'run_once' },
  overlapPolicy: 'queue_one',
  retryPolicy: { dispatchMaxAttempts: 5, dispatchMaxAgeMs: 86_400_000 },
} as const satisfies Pick<ScheduleDraft, 'misfirePolicy' | 'overlapPolicy' | 'retryPolicy'>;

/** Mean transfer progress, or null when there is nothing to transfer. */
export function scheduledAttachmentProgress(attachments: SessionAttachmentDraft[]): number | null {
  return attachments.length
    ? Math.round(
        attachments.reduce((sum, item) => sum + (item.progress ?? 0), 0) / attachments.length
      )
    : null;
}

/** Use the same owned attachment transfers as Send, without publishing a user turn. */
export async function prepareScheduledMessage(args: {
  runtime: WorkspaceRuntime;
  scheduleId: string;
  sessionId: SessionId;
  machineId: MachineId;
  actorId: string;
  inputBlocks: SessionInputBlock[];
  attachments: SessionAttachmentDraft[];
  message?: Omit<ScheduledMessage, 'inputBlocks'>;
  token: string | null;
  localMachineId: MachineId | null;
  signal: AbortSignal;
  onAttachments: (attachments: SessionAttachmentDraft[]) => void;
}): Promise<ScheduledMessage> {
  const content = {
    mode: args.runtime.contentMode === 'e2ee' ? 'protected' : 'plaintext',
  } as const;
  if (
    args.attachments.length ||
    args.inputBlocks.some((block) => block.type === 'file' || block.type === 'image')
  )
    requireWorkspaceFeature(content, 'attachments');
  const prepared = await prepareDraftAttachments({
    content,
    resources: args.runtime.sendResources,
    signal: args.signal,
    token: () => args.token,
    localMachineId: () => args.localMachineId,
    record: {
      workspaceId: args.runtime.workspaceId,
      sessionId: args.sessionId,
      targetMachineId: args.machineId,
      attachments: args.attachments,
      entry: {
        id: 'schedule:' + args.scheduleId,
        role: 'user',
        userId: args.actorId,
        timestamp: new Date(getServerNow()).toISOString(),
        items: [],
        finished: true,
        fileDiff: [],
        inputConfig: { inputBlocks: args.inputBlocks },
      },
    },
    update: args.onAttachments,
  });

  return ScheduledMessageSchema.parse({
    ...args.message,
    inputBlocks: prepared.entry.inputConfig?.inputBlocks,
  });
}

/** Stable identity is supplied by the draft, including after an uncertain save. */
export async function saveScheduledMessage(args: {
  runtime: WorkspaceRuntime;
  actorId: string;
  scheduleId: string;
  activationId: string;
  activityId: string;
  draft: ScheduleDraft;
  create: boolean;
  baseActivationId?: string;
  expectedActivationId?: string;
  expectedUpdatedAt?: number;
  now?: number;
}) {
  const now = args.now ?? getServerNow();
  if (args.draft.trigger.kind !== 'once' || Date.parse(args.draft.trigger.at) <= now)
    throw new Error('SCHEDULE_TIME_PASSED');

  return args.runtime.withScheduleStore(
    args.scheduleId,
    (store) => {
      if (!args.create && args.baseActivationId) {
        const latest = store?.getState();
        const isRetryOfThisSave = latest?.timeline.some((entry) => entry.id === args.activityId);
        if (
          latest &&
          latest.definition.activationId !== args.baseActivationId &&
          !isRetryOfThisSave
        ) {
          throw new ScheduleEditConflictError();
        }
      }
      return new ScheduleRepository(args.runtime.repo, args.runtime.workspaceId, {
        protectedContent: args.runtime.contentMode === 'e2ee',
        signDeclaration: args.runtime.signScheduleDeclaration,
      }).save({ ...args, now });
    },
    {
      create: args.create,
      expectedActivationId: args.expectedActivationId,
      expectedUpdatedAt: args.expectedUpdatedAt,
    }
  );
}

/**
 * Re-schedule only the send instant of a pending scheduled message.
 * Reads the synced document inside `withScheduleStore` so concurrent edits
 * to the body, attachments or target are preserved instead of rolled back.
 */
export async function rescheduleScheduledMessageTime(args: {
  runtime: WorkspaceRuntime;
  actorId: string;
  scheduleId: string;
  activationId: string;
  activityId: string;
  at: string;
  expectedActivationId?: string;
  expectedUpdatedAt?: number;
  now?: number;
}) {
  const now = args.now ?? getServerNow();
  if (Date.parse(args.at) <= now) throw new Error('SCHEDULE_TIME_PASSED');

  return args.runtime.withScheduleStore(
    args.scheduleId,
    async (store) => {
      const repository = new ScheduleRepository(args.runtime.repo, args.runtime.workspaceId, {
        protectedContent: args.runtime.contentMode === 'e2ee',
        signDeclaration: args.runtime.signScheduleDeclaration,
      });
      const current = store?.getState() ?? (await repository.read(args.scheduleId));
      if (!current?.message || !current.definition.enabled) {
        throw new Error('Scheduled message unavailable');
      }
      const {
        title,
        machineId,
        agent,
        agentRole,
        mcpServerIds,
        boardId,
        project,
        destination,
        misfirePolicy,
        overlapPolicy,
        retryPolicy,
      } = current.definition;
      return repository.save({
        scheduleId: args.scheduleId,
        activationId: args.activationId,
        activityId: args.activityId,
        actorId: args.actorId,
        create: false,
        now,
        draft: {
          title,
          machineId,
          agent,
          ...(agentRole ? { agentRole } : {}),
          ...(mcpServerIds !== undefined ? { mcpServerIds } : {}),
          ...(boardId ? { boardId } : {}),
          ...(project ? { project } : {}),
          destination,
          misfirePolicy,
          overlapPolicy,
          retryPolicy,
          prompt: current.prompt,
          message: current.message,
          trigger: { kind: 'once', at: args.at },
        },
      });
    },
    {
      create: false,
      expectedActivationId: args.expectedActivationId,
      expectedUpdatedAt: args.expectedUpdatedAt,
    }
  );
}
