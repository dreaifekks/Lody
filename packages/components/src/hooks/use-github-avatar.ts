import { useEffect, useMemo, useState } from 'react';
import { atom, useAtomValue, type useStore } from 'jotai';
import { atomEffect } from 'jotai-effect';
import { atomFamily } from 'jotai/utils';
import type { LanGitHubState, MachineId, WorkspaceId } from '@lody/shared';
import { localCliStartingAtom } from '@/atoms/local-probe';
import { useAppCapability } from '@/lib/app-platform';
import { isElectronRenderer } from '@/lib/electron';
import { getIpcServices } from '@/lib/electron-ipc-client';

/**
 * Whose GitHub face the local desktop draws for its user: the account of the
 * token the LAN's hub keeps, else this machine's own `gh` login.
 */
export function resolveGitHubIdentityLogin(state: LanGitHubState): string | null {
  return state.lan?.login ?? state.own?.login ?? null;
}

export function gitHubAvatarUrl(login: string): string {
  return `https://avatars.githubusercontent.com/${encodeURIComponent(login)}`;
}

/** How often each workspace's login was written, so an answer asked before a write is dropped. */
const loginWrites = new Map<string, number>();

/**
 * The login per workspace, asked of this machine alone once something shows
 * it and the local agent can answer, and again each time the agent comes back;
 * Settings > GitHub writes what it reads later.
 */
export const gitHubIdentityLoginAtomFamily = atomFamily((workspaceId: string) => {
  const login = atom<string | null>(null);
  const ask = atomEffect((get, set) => {
    // An agent still starting refuses the question, and nothing would ask again.
    if (get(localCliStartingAtom)) return undefined;
    const asked = loginWrites.get(workspaceId) ?? 0;
    let mounted = true;
    const control = isElectronRenderer() ? getIpcServices()?.localProjects : null;
    void control
      ?.control({
        type: 'lan/github',
        machineId: '' as MachineId,
        workspaceId: workspaceId as WorkspaceId,
      })
      .then((response) => {
        if (!mounted || (loginWrites.get(workspaceId) ?? 0) !== asked) return;
        if (response.ok && response.type === 'lan/github') {
          set(login, resolveGitHubIdentityLogin(response.result));
        }
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  });
  return atom(
    (get) => {
      get(ask);
      return get(login);
    },
    (_get, set, value: string | null) => set(login, value)
  );
});

/** Writes what Settings > GitHub read, ahead of any answer still on its way. */
export function writeGitHubIdentityLogin(
  store: ReturnType<typeof useStore>,
  workspaceId: string,
  login: string | null
): void {
  loginWrites.set(workspaceId, (loginWrites.get(workspaceId) ?? 0) + 1);
  store.set(gitHubIdentityLoginAtomFamily(workspaceId), login);
}

const noLoginAtom = atom<string | null>(null);

/**
 * The GitHub avatar of the user of the local desktop, or `null` where the
 * platform has no machine-held GitHub credential or nobody is signed in.
 */
export function useGitHubAvatarUrl(workspaceId: string | null | undefined): string | null {
  // Where the hosted service brings GitHub, its account draws the user instead.
  const hosted = useAppCapability('githubIntegration');
  const enabled = useAppCapability('localGitHubCredential') && !hosted;
  const login = useAtomValue(
    enabled && workspaceId ? gitHubIdentityLoginAtomFamily(workspaceId) : noLoginAtom
  );
  return login ? gitHubAvatarUrl(login) : null;
}

/**
 * The sender a user message of the local desktop shows: a face without a name,
 * since a name would turn the avatar into a profile and add one beside it.
 */
export function useGitHubAvatarUser(
  workspaceId: string | null | undefined
): { image: string } | null {
  const image = useGitHubAvatarUrl(workspaceId);
  return useMemo(() => (image ? { image } : null), [image]);
}

/** `src` once it has loaded, so a picture that fails leaves what stood before. */
export function useLoadedImageSrc(src: string | null): string | null {
  const [loaded, setLoaded] = useState<string | null>(null);
  useEffect(() => {
    if (!src) return undefined;
    const image = new Image();
    image.onload = () => setLoaded(src);
    image.src = src;
    return () => {
      image.onload = null;
    };
  }, [src]);
  return src && loaded === src ? src : null;
}
