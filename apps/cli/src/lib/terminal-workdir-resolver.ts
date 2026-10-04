import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type LocalProjectId,
  type MachineId,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import {
  deriveRepoIdFromGitHubRepo,
  deriveRepoIdFromLocalProjectPath,
  getWorktreeHostPathFromDotlodyPath,
} from '@lody/shared/node/worktree-paths';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';

export type TerminalSessionMetaLookup =
  | { type: 'found'; meta: SessionMeta }
  | { type: 'deleted' }
  | { type: 'missing' };

export type TerminalWorkdirResolverOptions = {
  sessionId: SessionId;
  machineId: MachineId;
  lookupSessionMeta: (sessionId: SessionId) => Promise<TerminalSessionMetaLookup>;
  resolveLocalProjectRootPath: (localProjectId: LocalProjectId) => Promise<string | null>;
  isDirectory?: (path: string) => boolean;
  homeDir?: string;
};

function defaultIsDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function requireExistingDirectory(
  filePath: string,
  isDirectory: (path: string) => boolean
): string {
  if (!isDirectory(filePath)) {
    throw new Error(`workdir_unavailable:path_not_found:${filePath}`);
  }
  return filePath;
}

function resolveDefaultChatWorkdir(
  sessionId: SessionId,
  homeDir: string,
  isDirectory: (path: string) => boolean
): string {
  const workdir = path.join(getLodyDataDir(undefined, homeDir), 'chats', sessionId);
  fs.mkdirSync(workdir, { recursive: true });
  return requireExistingDirectory(workdir, isDirectory);
}

async function resolveTerminalWorkdirForSession(
  sessionId: SessionId,
  options: TerminalWorkdirResolverOptions,
  seen: Set<SessionId>
): Promise<string> {
  if (seen.has(sessionId)) {
    throw new Error(`session_parent_cycle:${sessionId}`);
  }
  seen.add(sessionId);

  const lookup = await options.lookupSessionMeta(sessionId);
  if (lookup.type === 'missing') {
    throw new Error(`session_not_found:${sessionId}`);
  }
  if (lookup.type === 'deleted') {
    throw new Error(`session_deleted:${sessionId}`);
  }

  const meta = lookup.meta;
  if (meta.isArchived) {
    throw new Error(`session_archived:${sessionId}`);
  }
  if (meta.machineId !== options.machineId) {
    throw new Error(`session_machine_mismatch:${sessionId}:${meta.machineId}`);
  }
  if (meta.parentSessionId) {
    return await resolveTerminalWorkdirForSession(meta.parentSessionId, options, seen);
  }

  const isDirectory = options.isDirectory ?? defaultIsDirectory;
  const homeDir = options.homeDir ?? os.homedir();
  const project = meta.project;

  if (project?.kind === 'local') {
    const rootPath = await options.resolveLocalProjectRootPath(project.localProjectId);
    if (!rootPath) {
      throw new Error(`workdir_unavailable:local_project_not_found:${project.localProjectId}`);
    }
    if (meta.isWorktree || project.useWorktree === true) {
      const repoId = deriveRepoIdFromLocalProjectPath(rootPath);
      return requireExistingDirectory(
        getWorktreeHostPathFromDotlodyPath(repoId, sessionId, getLodyDataDir(undefined, homeDir)),
        isDirectory
      );
    }
    return requireExistingDirectory(rootPath, isDirectory);
  }

  if (meta.repoFullName) {
    const repoId = deriveRepoIdFromGitHubRepo(meta.repoFullName);
    return requireExistingDirectory(
      getWorktreeHostPathFromDotlodyPath(repoId, sessionId, getLodyDataDir(undefined, homeDir)),
      isDirectory
    );
  }

  return resolveDefaultChatWorkdir(sessionId, homeDir, isDirectory);
}

export async function resolveTerminalWorkdirFromMetadata(
  options: TerminalWorkdirResolverOptions
): Promise<string> {
  return await resolveTerminalWorkdirForSession(options.sessionId, options, new Set());
}

/**
 * Where a shell of this machine starts: the home directory, or the directory
 * asked for, which may begin with `~`. A relative path or one that is no
 * directory is refused rather than replaced by another place.
 */
export function resolveMachineShellWorkdir(
  requested: string | undefined,
  options: { homeDir?: string; isDirectory?: (path: string) => boolean } = {}
): string {
  const home = options.homeDir ?? os.homedir();
  const isDirectory =
    options.isDirectory ??
    ((candidate: string) => {
      try {
        return fs.statSync(candidate).isDirectory();
      } catch {
        return false;
      }
    });
  const wanted = requested?.trim();
  let workdir = home;
  if (wanted) {
    if (wanted === '~') workdir = home;
    else if (wanted.startsWith('~/') || wanted.startsWith('~\\')) {
      workdir = path.join(home, wanted.slice(2));
    } else if (path.isAbsolute(wanted)) workdir = path.resolve(wanted);
    else throw new Error(`workdir_unavailable:${wanted} is not an absolute path`);
  }
  if (!isDirectory(workdir)) throw new Error(`workdir_unavailable:${workdir} is no directory`);
  return workdir;
}
