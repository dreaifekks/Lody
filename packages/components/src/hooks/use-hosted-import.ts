import { useCallback, useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import type {
  HostedConfigCategory,
  HostedConfigImportResult,
  HostedConfigPreview,
  MachineId,
  WorkspaceId,
} from '@lody/shared';
import { currentWorkspaceIdAtom } from '@/atoms/workspace-context';
import { isElectronRenderer } from '@/lib/electron';
import { getIpcServices } from '@/lib/electron-ipc-client';

export type HostedImportOutcome =
  | { ok: true; result: HostedConfigImportResult }
  | { ok: false; message: string };

export type HostedImport = {
  /** `null` until the first answer, and when the agent service did not answer. */
  preview: HostedConfigPreview | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  run: (input: {
    sourceWorkspaceId: string;
    categories: HostedConfigCategory[];
  }) => Promise<HostedImportOutcome>;
};

const UNAVAILABLE = 'The agent service of this machine is not running';

// The shell fills in the machine it runs on.
const THIS_MACHINE = '' as MachineId;

/**
 * What the hosted installation of this machine configured, compared with the
 * workspace this window shows. The agent service reads and writes both; the
 * window only asks.
 */
export function useHostedImport(): HostedImport {
  const workspaceId = useAtomValue(currentWorkspaceIdAtom) as WorkspaceId | null;
  const [preview, setPreview] = useState<HostedConfigPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const ipc = isElectronRenderer() ? getIpcServices()?.localProjects : null;
    if (!ipc || !workspaceId) {
      setLoading(false);
      return;
    }
    const response = await ipc
      .control({ type: 'hosted-config/preview', machineId: THIS_MACHINE, workspaceId })
      .catch(() => null);
    if (!mounted.current) return;
    setLoading(false);
    if (response?.ok && response.type === 'hosted-config/preview') {
      setPreview(response.result);
      setError(null);
      return;
    }
    setPreview(null);
    setError(response && !response.ok ? response.message : UNAVAILABLE);
  }, [workspaceId]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  const run = useCallback<HostedImport['run']>(
    async (input) => {
      const ipc = isElectronRenderer() ? getIpcServices()?.localProjects : null;
      if (!ipc || !workspaceId) return { ok: false, message: UNAVAILABLE };
      const response = await ipc
        .control({
          type: 'hosted-config/import',
          machineId: THIS_MACHINE,
          workspaceId,
          ...input,
        })
        .catch(() => null);
      await refresh();
      if (response?.ok && response.type === 'hosted-config/import') {
        return { ok: true, result: response.result };
      }
      return { ok: false, message: response && !response.ok ? response.message : UNAVAILABLE };
    },
    [refresh, workspaceId]
  );

  return { preview, loading, error, refresh, run };
}
