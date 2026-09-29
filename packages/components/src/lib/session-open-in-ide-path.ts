import { parseLanSshDestination, type LanSshDestination } from '@lody/shared/lan-ssh';

export type SessionOpenInIdePathSource = 'worktree' | 'local_project';

/** The machine that has the folder of a session, seen from the one that opens it. */
export type SessionOpenInIdeHost =
  | { kind: 'local' }
  /** Another machine; `ssh` is where an editor reaches it, `null` when it does not. */
  | { kind: 'remote'; ssh: LanSshDestination | null };

export type SessionOpenInIdePathTarget = {
  path: string;
  source: SessionOpenInIdePathSource;
  /** How an editor on this machine reaches the path; absent when it is on this machine. */
  ssh?: LanSshDestination;
};

/**
 * Where the folder of a session is: on this machine, or on another one. An
 * editor follows a machine to the SSH server it names only when the machine is
 * the current user's, as every member of a LAN is: a server is a place the
 * editor trusts, and a machine of someone else could name any.
 */
export function resolveSessionOpenInIdeHost(input: {
  sessionMachineId: string | null | undefined;
  /** `null` until this machine knows which one it is. */
  localMachineId: string | null | undefined;
  currentUserId: string | null | undefined;
  machineOwnerUserId: string | null | undefined;
  /** What the machine of the session published as `lanSsh`. */
  machineSsh: unknown;
}): SessionOpenInIdeHost {
  if (!input.sessionMachineId || !input.localMachineId) return { kind: 'remote', ssh: null };
  if (input.sessionMachineId === input.localMachineId) return { kind: 'local' };
  const own = Boolean(input.currentUserId) && input.machineOwnerUserId === input.currentUserId;
  return { kind: 'remote', ssh: own ? parseLanSshDestination(input.machineSsh) : null };
}

function normalizePath(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function resolvePathTarget(
  worktreePath: string | null | undefined,
  localProjectRootPath: string | null | undefined
): SessionOpenInIdePathTarget | null {
  const normalizedWorktreePath = normalizePath(worktreePath);
  if (normalizedWorktreePath) {
    return { path: normalizedWorktreePath, source: 'worktree' };
  }

  const normalizedLocalProjectRootPath = normalizePath(localProjectRootPath);
  if (normalizedLocalProjectRootPath) {
    return { path: normalizedLocalProjectRootPath, source: 'local_project' };
  }

  return null;
}

export function resolveSessionOpenInIdePathTarget({
  worktreePath,
  localProjectRootPath,
  host,
}: {
  worktreePath: string | null | undefined;
  localProjectRootPath: string | null | undefined;
  /** The machine both paths are of. */
  host: SessionOpenInIdeHost;
}): SessionOpenInIdePathTarget | null {
  const target = resolvePathTarget(worktreePath, localProjectRootPath);
  if (!target || host.kind === 'local') return target;
  // An editor names a folder of another machine by address, which takes a POSIX path.
  if (!host.ssh || !target.path.startsWith('/')) return null;
  return { ...target, ssh: host.ssh };
}
