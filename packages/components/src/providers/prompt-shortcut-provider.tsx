import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useAtomValue } from 'jotai';
import { LoroRepo } from 'loro-repo';
import { IndexedDBStorageAdaptor } from 'loro-repo/storage/indexeddb';
import {
  createSingleUserShortcutPublication,
  getSingleUserShortcutGrant,
  LocalShortcutStore,
  PromptShortcutRuntime,
  PromptShortcutSync,
  shortcutByteLength,
  SingleUserShortcutDirectory,
  type ShortcutRuntimeSnapshot,
} from '@lody/shared/prompt-shortcuts';
import { resolvePlatformSync } from '@lody/platform';
import {
  useCloudAction,
  useCloudMutation,
  useCloudQuery,
  usePlatform,
  usePlatformSession,
} from '@lody/platform/react';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { cloudOperations as api } from '@/lib/cloud-api-operations';
import { scheduleIdleTask } from '@/lib/idle-task';
import { promptShortcutDatabaseName } from '@/lib/prompt-shortcut-storage';
import { useResolvedWorkspaceScope } from '@/hooks/use-resolved-workspace-scope';

const Context = createContext<{
  runtime: PromptShortcutRuntime | null;
  error?: unknown;
  retry?: () => void;
}>({ runtime: null });
const EMPTY: ShortcutRuntimeSnapshot = { entries: [], pendingIds: [], errors: {}, loading: true };
const noopSubscribe = () => () => {};
const emptySnapshot = () => EMPTY;
// StrictMode and a quick workspace return must finish the previous writer's
// durable writes before reopening the same IndexedDB as a new replica.
const closingDatabases = new Map<string, Promise<void>>();

export function usePromptShortcuts() {
  const { runtime, error, retry } = useContext(Context);
  const snapshot = useSyncExternalStore(
    runtime?.subscribe ?? noopSubscribe,
    runtime?.getSnapshot ?? emptySnapshot,
    emptySnapshot
  );
  return {
    runtime,
    ...snapshot,
    ...(error ? { loading: false, errors: { initialization: error } } : {}),
    retry: () => {
      if (runtime) void runtime.retry();
      else retry?.();
    },
  };
}

function PromptShortcutBodyPrefetcher() {
  const { runtime, entries, loading } = usePromptShortcuts();
  useEffect(() => {
    if (!runtime || loading || entries.length === 0) return undefined;
    const controller = new AbortController();
    const cancelIdle = scheduleIdleTask(() => {
      void runtime.prefetch(entries, { signal: controller.signal });
    });
    return () => {
      controller.abort();
      cancelIdle();
    };
  }, [entries, loading, runtime]);
  return null;
}

/** Mounted once by MainLayout, not once per settings panel/composer. */
export function PromptShortcutProvider({
  children,
  enabled,
}: {
  children: ReactNode;
  enabled: boolean;
}) {
  const platform = usePlatform();
  const session = usePlatformSession();
  const workspaceRuntime = useAtomValue(activeWorkspaceRuntimeAtom);
  const scope = useResolvedWorkspaceScope({ enabled });
  const userId = session.status === 'authenticated' ? session.user.id : null;
  const workspaceId =
    scope.enabled && scope.workspaceId === workspaceRuntime?.workspaceId ? scope.workspaceId : null;
  const cloud = platform.capabilities.has('cloudAccount');
  // A workspace shared through a fixed gateway (a LAN) is one user on every
  // machine: its shortcuts sync through that gateway without hosted grants.
  const gateway = cloud ? null : (resolvePlatformSync(platform.sync, workspaceId).streams ?? null);
  const stage = useCloudMutation(api.promptShortcuts.stageDocument);
  const activate = useCloudMutation(api.promptShortcuts.activateDocument);
  const revoke = useCloudMutation(api.promptShortcuts.revokeShortcut);
  const settle = useCloudMutation(api.promptShortcuts.settleDocument);
  const grant = useCloudAction(api.promptShortcuts.getStreamToken);
  const directory = useCloudQuery(
    api.promptShortcuts.listAccessibleDocuments,
    cloud && workspaceId && userId ? { workspaceId } : 'skip'
  );
  const current = useRef({ workspaceId, userId, stage, activate, revoke, grant, settle });
  current.current = { workspaceId, userId, stage, activate, revoke, grant, settle };
  const [generation, setGeneration] = useState(0);
  const [instance, setInstance] = useState<{
    runtime: PromptShortcutRuntime;
    generation: number;
    platform: typeof platform;
    cloud: boolean;
    gateway: typeof gateway;
    isActive: () => boolean;
  } | null>(null);
  const [failure, setFailure] = useState<{
    workspaceId: string;
    userId: string;
    generation: number;
    error: unknown;
  } | null>(null);
  // Render-time identity fencing: never show the old account/workspace for one effect tick.
  const runtime =
    instance?.runtime.workspaceId === workspaceId &&
    instance.runtime.userId === userId &&
    instance.generation === generation &&
    instance.platform === platform &&
    instance.cloud === cloud &&
    instance.gateway === gateway &&
    instance.isActive()
      ? instance.runtime
      : null;
  const initializationError =
    failure?.workspaceId === workspaceId &&
    failure.userId === userId &&
    failure.generation === generation
      ? failure.error
      : undefined;

  useEffect(() => {
    if (!workspaceId || !userId) return undefined;
    let disposed = false;
    let owned: PromptShortcutRuntime | undefined;
    let ownIndex: SingleUserShortcutDirectory | undefined;
    let repo: LoroRepo | undefined;
    const databaseName = promptShortcutDatabaseName(workspaceId, userId);
    const previousClose = closingDatabases.get(databaseName);
    const check = () => {
      const identity = platform.identity.session.get();
      if (
        disposed ||
        current.current.workspaceId !== workspaceId ||
        current.current.userId !== userId ||
        identity.status !== 'authenticated' ||
        identity.user.id !== userId
      )
        throw new Error('Shortcut identity changed');
    };
    const restartOwnIndex = () => void ownIndex?.start();
    const opening = (async () => {
      await previousClose;
      check();
      repo = await LoroRepo.create({
        storageAdapter: new IndexedDBStorageAdaptor({
          dbName: databaseName,
        }),
      });
      check();
      const store = await LocalShortcutStore.open({ repo, workspaceId, userId });
      const sync = cloud
        ? new PromptShortcutSync({
            repo,
            now: Date.now,
            grant: async (resource, write) => {
              check();
              const result = await current.current.grant({
                workspaceId,
                write,
                target:
                  resource.kind === 'body'
                    ? resource
                    : {
                        kind: 'index',
                        ownerUserId: resource.domain.ownerUserId,
                        visibility: resource.domain.visibility,
                      },
              });
              check();
              return result;
            },
          })
        : undefined;
      const lanSync = gateway
        ? new PromptShortcutSync({
            repo,
            now: Date.now,
            grant: async (resource) => {
              check();
              return getSingleUserShortcutGrant(gateway, resource);
            },
          })
        : undefined;
      const lanAcquire: PromptShortcutSync['acquire'] = (resource, write) => {
        check();
        return lanSync!.acquire(resource, write);
      };
      owned = new PromptShortcutRuntime(
        store,
        sync
          ? {
              acquire: (resource, write) => {
                check();
                return sync.acquire(resource, write);
              },
              stage: async ({ entry }) => {
                check();
                const result = await current.current.stage({
                  workspaceId,
                  ownerUserId: userId,
                  shortcutId: entry.id,
                  bodyDocId: entry.bodyDocId,
                  visibility: entry.visibility,
                });
                check();
                return result.status;
              },
              activate: async ({ entry, published }) => {
                check();
                await current.current.activate({
                  workspaceId,
                  bodyDocId: entry.bodyDocId,
                  previousBodyDocId: published?.bodyDocId ?? null,
                  previousRevision: published?.revision ?? null,
                  revision: entry.revision,
                  slug: entry.slug,
                  indexBytes: shortcutByteLength(JSON.stringify(entry)),
                });
                check();
              },
              revoke: async (entry) => {
                check();
                await current.current.revoke({
                  workspaceId,
                  shortcutId: entry.id,
                  bodyDocId: entry.bodyDocId,
                  visibility: entry.visibility,
                });
                check();
              },
              settle: async ({ entry }) => {
                check();
                const status = await current.current.settle({
                  workspaceId,
                  shortcutId: entry.id,
                  bodyDocId: entry.bodyDocId,
                  visibility: entry.visibility,
                });
                check();
                return status;
              },
              dispose: () => sync.dispose(),
            }
          : lanSync
            ? createSingleUserShortcutPublication({
                acquire: lanAcquire,
                dispose: () => lanSync.dispose(),
              })
            : undefined,
        cloud
      );
      check();
      setInstance({
        runtime: owned,
        generation,
        platform,
        cloud,
        gateway,
        isActive: () => !disposed,
      });
      void owned.flush();
      if (lanSync) {
        ownIndex = new SingleUserShortcutDirectory(owned, lanAcquire);
        void ownIndex.start();
        window.addEventListener('online', restartOwnIndex);
      }
    })().catch((error) => {
      if (!disposed) {
        console.error('Failed to open Prompt Shortcuts', error);
        setFailure({ workspaceId, userId, generation, error });
      }
    });
    return () => {
      disposed = true;
      window.removeEventListener('online', restartOwnIndex);
      // Identity can return before the replacement finishes opening. Retire this
      // effect's instance immediately, even while its durable close is pending.
      setInstance((value) => (value?.runtime === owned ? null : value));
      // Close a late initialization as well; no leaked IndexedDB/Streams leases.
      const closing = opening
        .then(async () => {
          await ownIndex?.dispose();
          await owned?.dispose();
          await repo?.destroy();
        })
        .catch((error) => console.error('Failed to close Prompt Shortcuts', error));
      closingDatabases.set(databaseName, closing);
      void closing.then(() => {
        if (closingDatabases.get(databaseName) === closing) closingDatabases.delete(databaseName);
      });
    };
  }, [workspaceId, userId, cloud, gateway, platform, generation]);

  useEffect(() => {
    if (runtime && directory) void runtime.setDirectory(directory);
  }, [runtime, directory]);
  useEffect(() => {
    if (!runtime) return undefined;
    const retry = () => {
      void runtime.flush();
      if (directory) void runtime.setDirectory(directory);
    };
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [runtime, directory]);
  return (
    <Context.Provider
      value={{
        runtime,
        error: initializationError,
        retry: () => setGeneration((value) => value + 1),
      }}
    >
      <PromptShortcutBodyPrefetcher />
      {children}
    </Context.Provider>
  );
}
