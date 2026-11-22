import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import type { SessionMeta } from '@lody/shared';
import {
  formatSshDestination,
  parseLanSshDestination,
  type LanSshDestination,
} from '@lody/shared/lan-ssh';
import { userAtom } from '@/atoms';
import { localHomeDirAtom, localMachineIdAtom } from '@/atoms/local-probe';
import { useResolvedMachineMeta } from '@/hooks/use-resolved-machine-meta';
import { getIpcServices } from '@/lib/electron-ipc-client';
import {
  parseMachineSshEntry,
  readMachineSshEntry,
  useMachineSshEntries,
} from '@/lib/machine-ssh-entry';
import {
  resolveSessionLocalProjectRootPath,
  resolveSessionRepoFullName,
} from '@/lib/session-local-file-source';
import {
  resolveSessionOpenInIdeHost,
  resolveSessionOpenInIdePathTarget,
} from '@/lib/session-open-in-ide-path';
import {
  buildPathLauncherProbes,
  canLaunchRemotePath,
  executePathLauncher,
  getAvailablePathLauncherOptions,
  getPathLauncherId,
  PATH_LAUNCHER_PREFERENCE_CHANGED_EVENT,
  PATH_LAUNCHER_PREFERENCE_STORAGE_KEY,
  readStoredPathLauncherPreference,
  remotePathLauncherTakesUrlHost,
  resolveRemotePathDestination,
  resolveRemotePathEntry,
  resolveSelectedPathLauncher,
  type PathLauncherFileTarget,
  type PathLauncherOption,
} from '@/lib/session-path-launchers';
import {
  resolveMachineDotlodyPath,
  resolveSessionWorkspacePath,
} from '@/lib/session-workspace-path';
import { toast } from '@/lib/toast';

export interface UseSessionOpenInIdeResult {
  readonly canOpen: boolean;
  readonly launcher: PathLauncherOption;
  readonly launcherLabel: string;
  readonly sshDestinationLabel: string | null;
  readonly openWorktreeInIde: (fileTarget?: PathLauncherFileTarget) => Promise<boolean>;
}

/**
 * Reusable local + Remote-SSH worktree IDE launcher hook supporting exact
 * `file:line:column` targets inside a session's worktree or local project.
 */
export function useSessionOpenInIde(
  session: SessionMeta | null | undefined
): UseSessionOpenInIdeResult {
  const { t } = useTranslation();
  const currentUser = useAtomValue(userAtom);
  const localMachineId = useAtomValue(localMachineIdAtom);
  const localHomeDir = useAtomValue(localHomeDirAtom);
  const { machine, machineFlockRows } = useResolvedMachineMeta(session?.machineId);
  const sshEntries = useMachineSshEntries();

  const sessionMachineSshText = JSON.stringify(parseLanSshDestination(machine?.lanSsh));
  const openInIdeHost = useMemo(
    () =>
      resolveSessionOpenInIdeHost({
        sessionMachineId: session?.machineId,
        localMachineId,
        currentUserId: currentUser?.id,
        machineOwnerUserId: machine?.ownerUserId,
        machineSsh: JSON.parse(sessionMachineSshText) as unknown,
      }),
    [
      currentUser?.id,
      localMachineId,
      machine?.ownerUserId,
      session?.machineId,
      sessionMachineSshText,
    ]
  );

  const canOpenSessionFolder = openInIdeHost.kind === 'local' || openInIdeHost.ssh !== null;
  const isLocalMachine = openInIdeHost.kind === 'local';
  const localProjectRootPath = useMemo(() => {
    if (!session || !canOpenSessionFolder) return null;
    return resolveSessionLocalProjectRootPath(session, machine?.localProjects ?? {});
  }, [canOpenSessionFolder, machine?.localProjects, session]);

  const repoFullName = useMemo(
    () => (session ? resolveSessionRepoFullName(session) : null),
    [session]
  );

  const machineDotlodyPath = useMemo(
    () => resolveMachineDotlodyPath(machineFlockRows, isLocalMachine ? localHomeDir : null),
    [isLocalMachine, localHomeDir, machineFlockRows]
  );

  const worktreePath = useMemo(() => {
    if (!session || !canOpenSessionFolder || !session.isWorktree) return null;
    return resolveSessionWorkspacePath({
      sessionId: session.id,
      ownerSessionId: session.parentSessionId,
      isWorktree: true,
      dotlodyPath: machineDotlodyPath,
      localProjectRootPath,
      repoFullName,
      legacyWorkspacePath: machine?.workspacePaths?.[session.id],
    });
  }, [
    canOpenSessionFolder,
    localProjectRootPath,
    machine?.workspacePaths,
    machineDotlodyPath,
    repoFullName,
    session,
  ]);

  const openInIdeTarget = useMemo(
    () =>
      resolveSessionOpenInIdePathTarget({
        worktreePath,
        localProjectRootPath,
        host: openInIdeHost,
      }),
    [localProjectRootPath, openInIdeHost, worktreePath]
  );

  const openInIdePath = openInIdeTarget?.path ?? null;
  const openInIdeSsh = openInIdeTarget?.ssh ?? null;

  const [preference, setPreference] = useState(readStoredPathLauncherPreference);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const refresh = () => setPreference(readStoredPathLauncherPreference());
    const handleStorage = (event: StorageEvent) => {
      if (event.key === PATH_LAUNCHER_PREFERENCE_STORAGE_KEY) refresh();
    };
    window.addEventListener(PATH_LAUNCHER_PREFERENCE_CHANGED_EVENT, refresh);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener(PATH_LAUNCHER_PREFERENCE_CHANGED_EVENT, refresh);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  const isElectron = typeof window !== 'undefined' && window.__LODY_ELECTRON__ === true;
  const platform = typeof window !== 'undefined' ? window.__LODY_PLATFORM__?.os : undefined;

  const launcherCandidates = useMemo(
    () =>
      getAvailablePathLauncherOptions({
        customLaunchers: preference.customLaunchers,
        isElectron,
        platform,
      }),
    [isElectron, platform, preference.customLaunchers]
  );

  const [availableLauncherIds, setAvailableLauncherIds] = useState(() => new Set<string>());
  useEffect(() => {
    if (!isElectron || !openInIdePath) {
      setAvailableLauncherIds(new Set());
      return undefined;
    }
    const services = getIpcServices();
    if (!services) return undefined;
    let cancelled = false;
    const launchers = buildPathLauncherProbes(
      launcherCandidates,
      openInIdePath,
      platform,
      openInIdeSsh
    );
    void services.app.probePathLaunchers({ launchers }).then(
      (result) => {
        if (!cancelled) setAvailableLauncherIds(new Set(result.availableIds));
      },
      () => {
        if (!cancelled) setAvailableLauncherIds(new Set());
      }
    );
    return () => {
      cancelled = true;
    };
  }, [isElectron, launcherCandidates, openInIdePath, openInIdeSsh, platform]);

  const pathLauncherOptions = useMemo(
    () =>
      launcherCandidates.filter(
        (launcher) =>
          (launcher.kind === 'custom' || availableLauncherIds.has(getPathLauncherId(launcher))) &&
          (!openInIdeSsh || canLaunchRemotePath(launcher))
      ),
    [availableLauncherIds, launcherCandidates, openInIdeSsh]
  );

  const selectedLauncher = useMemo(
    () => resolveSelectedPathLauncher(preference.selectedLauncherId, pathLauncherOptions),
    [pathLauncherOptions, preference.selectedLauncherId]
  );

  const selectedTakesUrlHost = remotePathLauncherTakesUrlHost(selectedLauncher);
  const namedSshEntry = session?.machineId ? (sshEntries[session.machineId] ?? null) : null;

  const [foundSshEntry, setFoundSshEntry] = useState<{
    readonly ssh: LanSshDestination;
    readonly urlHost: boolean;
    readonly entry: unknown;
  } | null>(null);
  const latestRequestRef = useRef(0);

  const findSshEntry = useCallback(
    async (ssh: LanSshDestination, urlHost: boolean): Promise<unknown> => {
      const request = ++latestRequestRef.current;
      const found = await (
        getIpcServices()?.app.resolveSshDestination({ machine: ssh, urlHost }) ??
        Promise.resolve(null)
      ).then(
        (result) => result?.destination ?? null,
        () => null
      );
      if (request === latestRequestRef.current) {
        setFoundSshEntry({ ssh, urlHost, entry: found });
      }
      return found;
    },
    []
  );

  const selectedTakesNamedEntry =
    resolveRemotePathEntry(
      selectedLauncher,
      namedSshEntry === null ? null : parseMachineSshEntry(namedSshEntry)
    ) !== null;

  useEffect(() => {
    if (!isElectron || !openInIdeSsh || selectedTakesNamedEntry) return;
    void findSshEntry(openInIdeSsh, selectedTakesUrlHost);
  }, [findSshEntry, isElectron, openInIdeSsh, selectedTakesNamedEntry, selectedTakesUrlHost]);

  const sshDestinationLabel = !openInIdeSsh
    ? null
    : selectedTakesNamedEntry ||
        (foundSshEntry?.ssh === openInIdeSsh && foundSshEntry.urlHost === selectedTakesUrlHost)
      ? formatSshDestination(
          resolveRemotePathDestination(selectedLauncher, openInIdeSsh, {
            named: namedSshEntry === null ? null : parseMachineSshEntry(namedSshEntry),
            found: foundSshEntry?.entry,
          })
        )
      : null;

  const canOpen =
    Boolean(openInIdePath) &&
    pathLauncherOptions.length > 0 &&
    (!openInIdeSsh || sshDestinationLabel !== null);

  const openWorktreeInIde = useCallback(
    async (fileTarget?: PathLauncherFileTarget): Promise<boolean> => {
      if (!openInIdePath || !session) return false;
      if (!getIpcServices()) {
        toast.error(
          t('sessions.pathLaunchUnsupported', 'This launcher is only available in the desktop app')
        );
        return false;
      }
      try {
        const sshDestination = openInIdeSsh
          ? (resolveRemotePathEntry(selectedLauncher, readMachineSshEntry(session.machineId)) ??
            resolveRemotePathDestination(selectedLauncher, openInIdeSsh, {
              found: await findSshEntry(
                openInIdeSsh,
                remotePathLauncherTakesUrlHost(selectedLauncher)
              ),
            }))
          : undefined;
        const result = await executePathLauncher(
          selectedLauncher,
          openInIdePath,
          'directory',
          sshDestination,
          fileTarget
        );
        if (!result.launched) {
          if (result.error !== 'launcher_not_approved') {
            toast.error(t('sessions.pathLaunchFailed', 'Failed to open path'));
          }
          return false;
        }
        return true;
      } catch {
        toast.error(t('sessions.pathLaunchFailed', 'Failed to open path'));
        return false;
      }
    },
    [findSshEntry, openInIdePath, openInIdeSsh, selectedLauncher, session, t]
  );

  return {
    canOpen,
    launcher: selectedLauncher,
    launcherLabel: selectedLauncher.label,
    sshDestinationLabel,
    openWorktreeInIde,
  };
}
