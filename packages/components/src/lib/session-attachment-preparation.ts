import {
  inputBlocksToHistoryItems,
  normalizeSessionInputBlocks,
  SESSION_FILE_MAX_COUNT,
  type MachineId,
  type SessionId,
  type WorkspaceId,
  type SessionInputBlock,
} from '@lody/shared';
import { prepareSessionFile } from './session-file-preparation';
import { uploadSessionImage } from './session-image-upload';
import { isUploadAbortedError } from './session-file-upload';
import {
  canUseElectronLocalFileSend,
  sendSessionFileToLocalRuntime,
} from './electron-session-file-sender';
import { throwIfSendAborted, type SessionSendResources } from './session-send-resources';
import { preparedDraftInput } from './session-attachment-draft';
import type { PendingSessionSend } from './session-pending-sends';

type DraftAttachmentSend = Pick<
  PendingSessionSend,
  'workspaceId' | 'sessionId' | 'entry' | 'queue' | 'attachments' | 'targetMachineId'
>;
type PreparedSend = Pick<PendingSessionSend, 'entry' | 'queue' | 'attachments'>;

/** Replace draft attachments with their ready references in the turn and queue row. */
export function finalizePreparedSend(record: DraftAttachmentSend): PreparedSend {
  const inputBlocks = preparedDraftInput(record.entry.inputConfig, record.attachments);
  const inputConfig = { ...record.entry.inputConfig, inputBlocks };
  return {
    attachments: record.attachments.map((item) => ({ ...item, source: undefined })),
    entry: { ...record.entry, items: inputBlocksToHistoryItems(inputBlocks), inputConfig },
    ...(record.queue
      ? {
          queue: {
            ...record.queue,
            acpSessionConfig: { ...(record.queue.acpSessionConfig as object), inputBlocks },
          },
        }
      : {}),
  };
}

/**
 * Prepare every unready attachment, one at a time, publishing each result
 * through `update`. Rejects with the first failure after trying the rest, so a
 * retry only transfers what failed.
 */
export async function prepareDraftAttachments(args: {
  record: DraftAttachmentSend;
  resources: SessionSendResources;
  signal: AbortSignal;
  token(): string | null;
  localMachineId(): MachineId | null;
  /**
   * Whether the agent service of this machine hands files over to the other
   * machines of the workspace, as the members of a LAN do.
   */
  handsOffToMembers?(): boolean;
  update(attachments: DraftAttachmentSend['attachments']): void;
  report(id: string, progress: number): void;
}): Promise<PreparedSend> {
  let attachments = args.record.attachments;
  let failure: unknown;
  // The agent service of this machine takes the files of its own sessions,
  // and where it reaches the other machines, of theirs.
  const canHandOffTo = (machineId: MachineId | null | undefined): machineId is MachineId =>
    !!machineId &&
    canUseElectronLocalFileSend() &&
    (machineId === args.localMachineId() || args.handsOffToMembers?.() === true);
  // One transfer at a time per message bounds hashing memory and preserves
  // successful results; different conversations retain independent lifetimes.
  for (const attachment of attachments) {
    if (attachment.ready) continue;
    throwIfSendAborted(args.signal);
    try {
      if (!attachment.source) throw new Error('Attachment source is unavailable');
      const file = new File([attachment.source], attachment.name, {
        type: attachment.mimeType,
        lastModified: attachment.lastModified,
      });
      let ready: SessionInputBlock | undefined;
      if (attachment.kind === 'image') {
        const token = args.token();
        try {
          // Without an account there is no image store to upload to; an image
          // for this machine still reaches its session through the local handoff.
          if (!token) throw new Error('Image upload requires authentication');
          const image = await args.resources.run(
            (signal) =>
              uploadSessionImage({
                workspaceId: args.record.workspaceId as WorkspaceId,
                sessionId: args.record.sessionId,
                token,
                file,
                signal,
                onProgress: (progress) => args.report(attachment.id, progress),
              }),
            args.signal
          );
          ready = { type: 'image', ...image };
        } catch (error) {
          throwIfSendAborted(args.signal);
          const machineId = args.record.targetMachineId;
          const fileCount =
            normalizeSessionInputBlocks(args.record.entry.inputConfig?.inputBlocks, '').filter(
              (block) => block.type === 'file'
            ).length +
            attachments.filter((item) => item.kind === 'file' || item.ready?.type === 'file')
              .length;
          // Keep the existing image fallback. Cancellation, a machine the agent
          // service does not reach and a full file allowance never authorize a
          // handoff.
          if (
            isUploadAbortedError(error) ||
            !canHandOffTo(machineId) ||
            fileCount >= SESSION_FILE_MAX_COUNT
          )
            throw error;
          let refusal: string | undefined;
          try {
            const outcome = await args.resources.run(
              (signal) =>
                sendSessionFileToLocalRuntime({
                  workspaceId: args.record.workspaceId,
                  sessionId: args.record.sessionId,
                  machineId,
                  file,
                  signal,
                }),
              args.signal
            );
            if (outcome?.ok && outcome.files[0]) ready = outcome.files[0];
            else if (outcome && !outcome.ok) refusal = outcome.error;
          } catch {
            throwIfSendAborted(args.signal);
          }
          if (!ready) {
            // The upload failure remains the reason if the handoff is also
            // unavailable, and no second cloud file upload is introduced.
            // Where nothing could be uploaded the handoff was the only way,
            // and what it said is why the image was not sent.
            throw !token && refusal ? new Error(refusal) : error;
          }
        }
      } else {
        const machineId = args.record.targetMachineId ?? null;
        const fileResult = await prepareSessionFile(args.resources, {
          workspaceId: args.record.workspaceId as WorkspaceId,
          sessionId: args.record.sessionId as SessionId,
          token: args.token(),
          machineId,
          canSendLocally: canHandOffTo(machineId),
          file,
          signal: args.signal,
          onProgress: (progress) => args.report(attachment.id, progress.percent),
        });
        ready = fileResult;
      }
      throwIfSendAborted(args.signal);
      attachments = attachments.map((item) =>
        item.id === attachment.id ? { ...item, ready, error: undefined, progress: 100 } : item
      );
      args.update(attachments);
    } catch (error) {
      throwIfSendAborted(args.signal);
      failure = error;
      attachments = attachments.map((item) =>
        item.id === attachment.id
          ? {
              ...item,
              error: error instanceof Error ? error.message : 'Attachment preparation failed',
              progress: 0,
            }
          : item
      );
      args.update(attachments);
    }
  }
  if (failure) throw failure;
  return finalizePreparedSend({ ...args.record, attachments });
}
