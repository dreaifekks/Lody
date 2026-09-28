import {
  getSessionRoomId,
  type ElectronCliState,
  type MachineId,
  type SessionId,
} from '@lody/shared';
import { parseLanTerminalEndpoint } from '@lody/shared/lan-terminal';
import { useAtomValue } from 'jotai';
import { useParams } from '@tanstack/react-router';
import { useMemo } from 'react';
import { localMachineIdAtom } from '@/atoms/local-probe';
import { sessionMetaAtomFamily } from '@/atoms/doc-meta';
import { machineOnlineStatusAtomFamily, sessionLiveStatusAtomFamily } from '@/atoms/presence';
import { getMachineMetaByIdAtomFamily } from '@/atoms/machines';
import { useElectronCliDaemon } from '@/hooks/use-electron-cli-daemon';
import { TerminalDock } from './terminal/terminal-dock';
import { createElectronTerminalChannel } from './terminal/electron-terminal-channel';

// The terminal can only attach once the daemon is actually up (running/degraded).
function canUseTerminalCliPhase(phase: ElectronCliState['phase']): boolean {
  return phase === 'running' || phase === 'degraded';
}

/**
 * Whether this desktop can reach the terminals of a session: its own
 * machine's always, another LAN member's while that member is online and
 * accepts terminals. The agent service of this machine connects to it.
 */
export function canReachSessionTerminal(input: {
  sessionMachineId: MachineId | undefined;
  localMachineId: MachineId | null | undefined;
  sessionMachine: { lanTerminal?: unknown } | null | undefined;
  sessionMachineOnline: boolean;
}): boolean {
  if (!input.sessionMachineId || !input.localMachineId) return false;
  if (input.sessionMachineId === input.localMachineId) return true;
  return (
    input.sessionMachineOnline && parseLanTerminalEndpoint(input.sessionMachine?.lanTerminal) !== null
  );
}

/**
 * Mounts the bottom terminal dock for the active route session. Electron-only,
 * and only wires a real `sessionId` when this desktop can reach the session's
 * machine (`canReachSessionTerminal`) — that gate is also what makes the
 * session header's dock icon and the ⌃`/⌘J command appear (via the dock
 * controller). The daemon status + restart/terminate controls now live in
 * Settings → General → Startup.
 */
export function TerminalDockHost() {
  const params = useParams({ strict: false });
  const isElectron = typeof window !== 'undefined' && window.__LODY_ELECTRON__ === true;
  const localMachineId = useAtomValue(localMachineIdAtom);
  const routeSessionId =
    typeof params.sessionId === 'string' && params.sessionId.trim()
      ? (params.sessionId as SessionId)
      : null;
  const routeSessionRoomId = getSessionRoomId((routeSessionId ?? '__no_session__') as SessionId);
  const routeSession = useAtomValue(sessionMetaAtomFamily(routeSessionRoomId));
  const routeSessionLiveStatus = useAtomValue(
    sessionLiveStatusAtomFamily((routeSessionId ?? '__no_session__') as SessionId)
  );
  const routeMachineId = routeSession?.machineId as MachineId | undefined;
  const routeMachine = useAtomValue(getMachineMetaByIdAtomFamily(routeMachineId));
  const routeMachineStatus = useAtomValue(machineOnlineStatusAtomFamily(routeMachineId));
  const { phase: cliPhase } = useElectronCliDaemon();

  const terminalChannel = useMemo(
    () => (isElectron ? createElectronTerminalChannel() : null),
    [isElectron]
  );

  const isRouteSessionReachable =
    Boolean(terminalChannel && routeSessionId) &&
    canReachSessionTerminal({
      sessionMachineId: routeMachineId,
      localMachineId,
      sessionMachine: routeMachine,
      sessionMachineOnline: routeMachineStatus === 'online',
    });
  const isRouteSessionReadyForTerminal =
    Boolean(routeSession?.acpSessionId) || routeSessionLiveStatus != null;
  const canCreateTerminal =
    isRouteSessionReachable && canUseTerminalCliPhase(cliPhase) && isRouteSessionReadyForTerminal;
  const terminalSessionId =
    terminalChannel && isRouteSessionReachable && routeSessionId ? routeSessionId : undefined;

  if (!isElectron || !terminalChannel) return null;

  return (
    <TerminalDock
      channel={terminalChannel}
      sessionId={terminalSessionId}
      canCreateTerminal={canCreateTerminal}
    />
  );
}
