import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  machineSupportsLanFiles,
  type LocalSessionControlResponse,
  type MachineId,
  type MachineMeta,
  type SessionFilePayload,
  type SessionFileReadLocalRequest,
  type SessionFileReadLocalResponse,
  type SessionFileSendLocalRequest,
  type SessionFileSendLocalResponse,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import { getLanHubWorkspaceId } from '@lody/shared/lan-hub';
import { parseLanTerminalEndpoint } from '@lody/shared/lan-terminal';
import type { LanHub } from '@lody/shared/node/lan-hub';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import { getSessionFileBlobPath } from '@/lib/session-file-blob-store';
import {
  fetchFileFromLanMember,
  sendFilesToLanMember,
  type LanFileToRead,
  type ReceivedLanFile,
} from './lan-files';
import { deriveLanTerminalKey } from './lan-terminal';
import type { LanFileReceiver } from './lan-terminal-host';

/** What the handoff needs of the workspace one LAN carries on this machine. */
export type LanFileWorkspace = {
  /** `missing` for a session this machine has not heard of. */
  lookupSession: (
    sessionId: SessionId
  ) => Promise<{ type: 'found'; meta: SessionMeta } | { type: 'deleted' } | { type: 'missing' }>;
  readMachine: (machineId: MachineId) => Promise<MachineMeta | undefined>;
  /** Takes files into a session of this machine, as its desktop hands them over. */
  storeLocally: (request: SessionFileSendLocalRequest) => Promise<LocalSessionControlResponse[]>;
};

type SendFiles = typeof sendFilesToLanMember;
type FetchFile = typeof fetchFileFromLanMember;
type SessionLookup = LanFileWorkspace['lookupSession'];

/**
 * The files of a message between the members of a LAN. A desktop hands them
 * to the agent service of its own machine, which holds the credential of the
 * LAN: `send` takes them to the member that runs the session, and
 * `receiverFor` is what that member does with them.
 */
export class LanFileHandoff {
  constructor(
    private readonly options: {
      machineId: MachineId;
      logger: Logger;
      hubs: () => readonly LanHub[];
      /** `null` while this machine does not run the workspace. */
      workspace: (workspaceId: string) => LanFileWorkspace | null;
      /**
       * The sessions of any workspace this machine runs, LAN or not: a desktop
       * reads the files of its own machine's sessions whatever carries them.
       */
      localSessions: (workspaceId: string) => SessionLookup | null;
      sendFiles?: SendFiles;
      fetchFile?: FetchFile;
      /** Where this machine keeps the file of a block; the blob store by default. */
      keptPath?: typeof getSessionFileBlobPath;
    }
  ) {}

  receiverFor(workspaceId: string): LanFileReceiver | null {
    if (!this.options.workspace(workspaceId)) return null;
    return {
      admit: async ({ sessionId }) => {
        await this.admit(workspaceId, sessionId as SessionId);
      },
      store: async (file) => await this.store(workspaceId, file),
      read: async ({ sessionId, fileId }) => await this.kept(workspaceId, sessionId, fileId),
    };
  }

  /** A file this machine keeps for a session, as a block of its history names it. */
  private async kept(
    workspaceId: string,
    sessionId: string,
    fileId: string
  ): Promise<LanFileToRead> {
    const lookup = this.options.localSessions(workspaceId);
    if (!lookup) throw new Error('remote_unreachable:this machine does not run that workspace');
    const session = await lookup(sessionId as SessionId);
    if (session.type === 'deleted') throw new Error(`session_deleted:${sessionId}`);
    if (session.type === 'missing') throw new Error(`session_not_found:${sessionId}`);
    let filePath: string;
    try {
      filePath = (this.options.keptPath ?? getSessionFileBlobPath)({
        workspaceId,
        sessionId,
        fileId,
      });
    } catch {
      throw new Error('invalid_request:that is not the name of a file');
    }
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat?.isFile()) throw new Error(`file_not_found:this machine does not keep ${fileId}`);
    return { path: filePath, sizeBytes: stat.size };
  }

  /**
   * Writes the bytes of a file block to where the desktop asked: from this
   * machine's own store, or from the member of a LAN that keeps the file.
   */
  async read(message: SessionFileReadLocalRequest): Promise<SessionFileReadLocalResponse> {
    const answer = (
      response: Omit<SessionFileReadLocalResponse, 'type' | 'sessionId' | 'workspaceId'>
    ): SessionFileReadLocalResponse => ({
      type: 'session/file-read-local_response',
      sessionId: message.sessionId,
      workspaceId: message.workspaceId,
      ...response,
    });
    const refused = (error: unknown, prefix = '') => {
      const reason = formatErrorMessage(error);
      return answer({
        success: false,
        error: /^([a-z][a-z0-9_]*):/.exec(reason)?.[1] ?? 'file_read_failed',
        message: `${prefix}${reason}`,
      });
    };
    const { workspaceId, targetMachineId } = message;
    if (!targetMachineId || targetMachineId === this.options.machineId) {
      try {
        const file = await this.kept(workspaceId, message.sessionId, message.fileId);
        await copyChecked(file, message);
        return answer({ success: true });
      } catch (error) {
        return refused(error);
      }
    }

    const hub = this.options
      .hubs()
      .find((candidate) => getLanHubWorkspaceId(candidate.id) === workspaceId);
    const workspace = this.options.workspace(workspaceId);
    if (!hub || !workspace) {
      return answer({
        success: false,
        error: 'remote_unreachable',
        message: 'Another machine keeps the file, and no LAN of this machine reaches it',
      });
    }
    const machine = await workspace.readMachine(targetMachineId);
    const name = machine?.name?.trim() || targetMachineId;
    const endpoint = parseLanTerminalEndpoint(machine?.lanTerminal);
    if (!endpoint || !machineSupportsLanFiles(machine)) {
      return answer({
        success: false,
        error: 'remote_unreachable',
        message: `${name} gives no files to the other machines of ${hub.name}. Update it, and check that its terminals are open to them.`,
      });
    }
    try {
      await (this.options.fetchFile ?? fetchFileFromLanMember)({
        endpoint,
        lanId: hub.id,
        key: deriveLanTerminalKey(hub.token),
        machineId: targetMachineId,
        sessionId: message.sessionId,
        fileId: message.fileId,
        sizeBytes: message.sizeBytes,
        sha256: message.sha256,
        destinationPath: message.destinationPath,
      });
      return answer({ success: true });
    } catch (error) {
      this.options.logger.debug(
        `[lan-files] ${name} did not give ${message.fileId}: ${formatErrorMessage(error)}`
      );
      return refused(error, `${name}: `);
    }
  }

  /**
   * Whether this machine takes a file for a session. The files of the first
   * message of a conversation arrive before the conversation does, so a
   * session nobody has heard of is taken for one about to be created here.
   */
  private async admit(workspaceId: string, sessionId: SessionId): Promise<LanFileWorkspace> {
    const workspace = this.options.workspace(workspaceId);
    if (!workspace) throw new Error('remote_unreachable:this machine does not run that LAN yet');
    const lookup = await workspace.lookupSession(sessionId);
    if (lookup.type === 'deleted') throw new Error(`session_deleted:${sessionId}`);
    if (lookup.type === 'found') {
      if (lookup.meta.isArchived) throw new Error(`session_archived:${sessionId}`);
      const owner: unknown = lookup.meta.machineId;
      if (typeof owner === 'string' && owner !== '' && owner !== this.options.machineId) {
        throw new Error(`session_machine_mismatch:${sessionId}:${owner}`);
      }
    }
    return workspace;
  }

  private async store(workspaceId: string, file: ReceivedLanFile): Promise<SessionFilePayload> {
    const sessionId = file.sessionId as SessionId;
    // Asked again: the session may have been archived while the file travelled.
    const workspace = await this.admit(workspaceId, sessionId);
    const responses = await workspace.storeLocally({
      type: 'session/file-send-local',
      machineId: this.options.machineId,
      sessionId,
      workspaceId: workspaceId as WorkspaceId,
      paths: [file.path],
    });
    const response = responses.find(
      (candidate): candidate is SessionFileSendLocalResponse =>
        candidate.type === 'session/file-send-local_response'
    );
    const stored = response?.success ? response.files?.[0] : undefined;
    if (!stored) {
      const code = response?.error ?? 'local_handoff_failed';
      throw new Error(`${code}:${response?.message ?? 'the file was not stored'}`);
    }
    return stored;
  }

  /** Takes the files of a message to the member that runs its session. */
  async send(
    message: SessionFileSendLocalRequest & { targetMachineId: MachineId }
  ): Promise<SessionFileSendLocalResponse> {
    const answer = (
      response: Omit<SessionFileSendLocalResponse, 'type' | 'sessionId' | 'workspaceId'>
    ): SessionFileSendLocalResponse => ({
      type: 'session/file-send-local_response',
      sessionId: message.sessionId,
      ...(message.workspaceId ? { workspaceId: message.workspaceId } : {}),
      ...response,
    });
    const { workspaceId } = message;
    const hub = workspaceId
      ? this.options.hubs().find((candidate) => getLanHubWorkspaceId(candidate.id) === workspaceId)
      : undefined;
    const workspace = workspaceId ? this.options.workspace(workspaceId) : null;
    if (!hub || !workspace) {
      return answer({
        success: false,
        error: 'remote_unreachable',
        message: 'The session runs on another machine, and no LAN of this machine reaches it',
      });
    }
    const machine = await workspace.readMachine(message.targetMachineId);
    const name = machine?.name?.trim() || message.targetMachineId;
    const endpoint = parseLanTerminalEndpoint(machine?.lanTerminal);
    if (!endpoint || !machineSupportsLanFiles(machine)) {
      return answer({
        success: false,
        error: 'remote_unreachable',
        message: `${name} takes no files from the other machines of ${hub.name}. Update it, and check that its terminals are open to them.`,
      });
    }
    try {
      const files = await (this.options.sendFiles ?? sendFilesToLanMember)({
        endpoint,
        lanId: hub.id,
        key: deriveLanTerminalKey(hub.token),
        machineId: message.targetMachineId,
        sessionId: message.sessionId,
        files: message.paths.map((filePath) => ({
          path: filePath,
          fileName: path.basename(filePath),
        })),
      });
      return answer({ success: true, files });
    } catch (error) {
      const reason = formatErrorMessage(error);
      this.options.logger.debug(`[lan-files] ${name} did not take the files: ${reason}`);
      return answer({
        success: false,
        error: /^([a-z][a-z0-9_]*):/.exec(reason)?.[1] ?? 'local_handoff_failed',
        message: `${name} did not take the files: ${reason}`,
      });
    }
  }
}

/** Copies a kept file where it was asked for, if it is the one the block names. */
async function copyChecked(
  file: LanFileToRead,
  wanted: { sizeBytes: number; sha256: string; destinationPath: string }
): Promise<void> {
  if (file.sizeBytes !== wanted.sizeBytes) {
    throw new Error('invalid_file:this machine keeps another file under that name');
  }
  const handle = await fs.promises.open(wanted.destinationPath, 'wx', 0o600);
  let complete = false;
  try {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file.path, { end: file.sizeBytes - 1 })) {
      hash.update(chunk as Buffer);
      await handle.write(chunk as Buffer);
    }
    if (hash.digest('hex') !== wanted.sha256.toLowerCase()) {
      throw new Error('invalid_file:this machine keeps another file under that name');
    }
    complete = true;
  } finally {
    await handle.close();
    if (!complete) await fs.promises.rm(wanted.destinationPath, { force: true });
  }
}
