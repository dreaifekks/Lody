import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ElectronLanFailure,
  ElectronLanReachability,
  ElectronLanState,
} from '@lody/shared/electron-ipc';
import { isElectronRenderer } from '@/lib/electron';
import { getIpcServices } from '@/lib/electron-ipc-client';
import { refreshLocalPlatformSnapshot } from '../providers/local-platform-provider';

export type LanSettingsResult = { ok: true } | ElectronLanFailure;

export type LanSettings = {
  /** `null` until the first answer, and wherever LANs do not exist. */
  state: ElectronLanState | null;
  loading: boolean;
  /** Whether each LAN answers right now; a LAN that was not asked yet is absent. */
  reachability: Readonly<Record<string, ElectronLanReachability>>;
  join: (input: { invite: string; name?: string | null }) => Promise<LanSettingsResult>;
  add: (input: { url: string; token: string; name?: string | null }) => Promise<LanSettingsResult>;
  update: (input: {
    id: string;
    name?: string | null;
    url?: string | null;
  }) => Promise<LanSettingsResult>;
  remove: (input: { id: string }) => Promise<LanSettingsResult>;
  setMachineName: (input: { name: string | null }) => Promise<LanSettingsResult>;
  /** The link another device joins a LAN with. It carries the credential. */
  getInvite: (input: { id: string }) => Promise<string | null>;
};

const UNAVAILABLE: ElectronLanFailure = {
  ok: false,
  code: 'unavailable',
  message: 'LANs are not available in this application',
};

type LanIpc = NonNullable<ReturnType<typeof getIpcServices>>['lan'];

function getLanIpc(): LanIpc | null {
  return isElectronRenderer() ? (getIpcServices()?.lan ?? null) : null;
}

/**
 * The LANs of this installation, as the desktop shell holds them. Every edit
 * is applied by the shell; the agent service follows the settings on its own,
 * so the workspaces of a LAN appear a moment after the LAN does.
 */
export function useLanSettings(): LanSettings {
  const [state, setState] = useState<ElectronLanState | null>(null);
  const [loading, setLoading] = useState(true);
  const [reachability, setReachability] = useState<Record<string, ElectronLanReachability>>({});
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const adopt = useCallback((next: ElectronLanState | null) => {
    if (!mounted.current) return;
    setState(next);
    setLoading(false);
    // The shell applied the edit; the workspaces follow once the agent
    // service did, which the snapshot shows.
    void refreshLocalPlatformSnapshot();
  }, []);

  useEffect(() => {
    const lan = getLanIpc();
    if (!lan) {
      setLoading(false);
      return;
    }
    void lan
      .getState()
      .then(adopt)
      .catch(() => adopt(null));
  }, [adopt]);

  // Asked again whenever a LAN appears or moves; a LAN that left is forgotten.
  const probed = (state?.lans ?? []).map((lan) => `${lan.id} ${lan.url}`).join('\n');
  useEffect(() => {
    const lan = getLanIpc();
    const ids = (state?.lans ?? []).map((entry) => entry.id);
    setReachability((current) =>
      Object.fromEntries(Object.entries(current).filter(([id]) => ids.includes(id)))
    );
    if (!lan) return;
    for (const id of ids) {
      void lan
        .probe({ id })
        .then((result) => {
          if (mounted.current) setReachability((current) => ({ ...current, [id]: result }));
        })
        .catch(() => undefined);
    }
    // `probed` names every LAN and its address; the list itself changes identity
    // with every answer of the shell.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [probed]);

  const edit = useCallback(
    async (
      run: (lan: LanIpc) => Promise<{ ok: true; state: ElectronLanState } | ElectronLanFailure>
    ): Promise<LanSettingsResult> => {
      const lan = getLanIpc();
      if (!lan) return UNAVAILABLE;
      try {
        const result = await run(lan);
        if (!result.ok) return result;
        adopt(result.state);
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          code: 'write_failed',
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
    [adopt]
  );

  return {
    state,
    loading,
    reachability,
    join: useCallback((input) => edit((lan) => lan.join(input)), [edit]),
    add: useCallback((input) => edit((lan) => lan.add(input)), [edit]),
    update: useCallback((input) => edit((lan) => lan.update(input)), [edit]),
    remove: useCallback((input) => edit((lan) => lan.remove(input)), [edit]),
    setMachineName: useCallback((input) => edit((lan) => lan.setMachineName(input)), [edit]),
    getInvite: useCallback(async (input) => {
      const result = await getLanIpc()
        ?.getInvite(input)
        .catch(() => null);
      return result?.ok ? result.invite : null;
    }, []),
  };
}
