/** Command composition remains Legacy while LoroDocumentManager owns Promise cleanup. */
export interface WorkspaceCommandScope {
  readonly userId: string;
  readonly token: string;
  readonly machineId: string;
  readonly authBaseUrl: string;
  readonly authSiteUrl?: string;
}

interface CommandManager {
  cleanUp(options: { fast: boolean; preserveSessionStatus: boolean }): Promise<void>;
  isPresenceReleased(): boolean;
}

/** Overlapping commands borrow one manager; completed cleanup removes the entry. */
export function makeWorkspaceCommandManagers<Manager extends CommandManager>() {
  const entries = new Map<
    string,
    {
      scope: WorkspaceCommandScope;
      ready: Promise<Manager>;
      users: number;
      closing?: Promise<void>;
    }
  >();
  return async function withManager<Result>(
    workspaceId: string,
    scope: WorkspaceCommandScope,
    create: () => Promise<Manager>,
    fn: (manager: Manager) => Promise<Result>,
    onCleanupFailure: (error: unknown) => void
  ): Promise<Result> {
    let entry = entries.get(workspaceId);
    // Never admit a new owner while the previous manager is still closing.
    // Only unreleased presence keeps a failed receipt and its original owner.
    while (entry?.closing) {
      await entry.closing;
      entry = entries.get(workspaceId);
    }
    if (
      entry &&
      (entry.scope.userId !== scope.userId ||
        entry.scope.token !== scope.token ||
        entry.scope.machineId !== scope.machineId ||
        entry.scope.authBaseUrl !== scope.authBaseUrl ||
        entry.scope.authSiteUrl !== scope.authSiteUrl)
    )
      throw new Error('Concurrent workspace commands require the same authorization scope');
    if (!entry) {
      entry = { scope: { ...scope }, ready: Promise.resolve().then(create), users: 0 };
      entries.set(workspaceId, entry);
    }
    const borrowed = entry;
    borrowed.users++;
    let manager: Manager;
    try {
      manager = await borrowed.ready;
    } catch (error) {
      if (--borrowed.users === 0) entries.delete(workspaceId);
      throw error;
    }
    try {
      return await fn(manager);
    } finally {
      if (--borrowed.users === 0) {
        borrowed.closing = Promise.resolve()
          .then(() => manager.cleanUp({ fast: true, preserveSessionStatus: true }))
          .then(() => {
            entries.delete(workspaceId);
          })
          .catch((error: unknown) => {
            if (!manager.isPresenceReleased()) throw error;
            // Cleanup settled and presence is released: a transport/repo error
            // must not poison later callers, including those already waiting.
            entries.delete(workspaceId);
            onCleanupFailure(error);
          });
        try {
          await borrowed.closing;
        } catch (error) {
          // Preserve an accepted command's result, matching the existing cleanup policy.
          onCleanupFailure(error);
        }
      }
    }
  };
}
