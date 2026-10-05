import { useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import type { AcpSessionMonitorSnapshot, MachineId, SessionId } from '@lody/shared';
import type { LanMachine } from '@lody/shared/lan-control';
import { getAllAgentConfigAtom } from '@/atoms/agents';
import { sessionMetaCacheAtom } from '@/atoms/doc-meta';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useMachineMonitor } from '@/hooks/use-machine-monitor';
import { Dialog } from '@/ui/dialog';
import { DeviceResourceMonitor } from './device-resource-monitor';
import { useSettingsPane } from './settings-page-header';
import { SETTINGS_EDITOR_DIALOG_LAYOUT, SETTINGS_EDITOR_DIALOG_WIDTH } from './surface';

/**
 * The agent processes a machine of the LAN this window shows runs, as the
 * hosted product's machine monitor shows them, and ends one on request.
 */
export function LanMachineProcesses({
  machine,
  onClose,
}: {
  machine: LanMachine | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const settingsPane = useSettingsPane();
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const sessionMetaCache = useAtomValue(sessionMetaCacheAtom);
  const agentConfigs = useAtomValue(getAllAgentConfigAtom);
  const sessionMetas = useMemo(() => Object.values(sessionMetaCache), [sessionMetaCache]);
  const [shown, setShown] = useState<LanMachine | null>(machine);
  // A dialog that closes keeps what it showed until it is gone.
  if (machine && machine !== shown) setShown(machine);
  const machineId = (machine?.machineId ?? null) as MachineId | null;
  const monitor = useMachineMonitor({
    machineId,
    enabled: machine !== null,
    online: machine?.online !== false,
  });

  const terminate = async (session: AcpSessionMonitorSnapshot) => {
    if (!runtime || !machineId) {
      throw new Error(
        t('settings.devices.sessions.terminateUnavailable', 'Machine is unavailable')
      );
    }
    const response = await runtime.requestSessionTerminate(
      machineId,
      session.sessionId as SessionId,
      { timeoutMs: 30_000 }
    );
    if (!response?.success) {
      throw new Error(
        response?.error ??
          t('settings.devices.sessions.terminateFailed', 'Failed to terminate ACP process')
      );
    }
    monitor.refresh();
  };

  return (
    <Dialog.Root
      open={machine !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Content
        width={SETTINGS_EDITOR_DIALOG_WIDTH}
        centerOn={settingsPane}
        className={SETTINGS_EDITOR_DIALOG_LAYOUT}
      >
        <Dialog.Header>
          <Dialog.Title>
            {t('settings.lan.machines.processes.title', {
              name: shown?.alias ?? shown?.name ?? '',
            })}
          </Dialog.Title>
        </Dialog.Header>
        <DeviceResourceMonitor
          snapshot={monitor.snapshot}
          state={monitor.state}
          os={shown?.os ?? null}
          cliVersion={shown?.version ?? null}
          sessionMetas={sessionMetas}
          agentConfigs={agentConfigs}
          onTerminateSession={terminate}
          flush
        />
      </Dialog.Content>
    </Dialog.Root>
  );
}
