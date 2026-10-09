import { useEffect, useMemo, useState } from 'react';
import { atom, useAtomValue } from 'jotai';
import { atomFamily } from 'jotai/utils';
import type { LanGitHubState, MachineId, WorkspaceId } from '@lody/shared';
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

/**
 * The login per workspace, asked of this machine alone once something shows
 * it; Settings > GitHub writes what it reads later.
 */
export const gitHubIdentityLoginAtomFamily = atomFamily((workspaceId: string) => {
  const login = atom<string | null>(null);
  login.onMount = (set) => {
    const control = isElectronRenderer() ? getIpcServices()?.localProjects : null;
    void control
      ?.control({
        type: 'lan/github',
        machineId: '' as MachineId,
        workspaceId: workspaceId as WorkspaceId,
      })
      .then((response) => {
        if (response.ok && response.type === 'lan/github') {
          set(resolveGitHubIdentityLogin(response.result));
        }
      })
      .catch(() => {});
  };
  return login;
});

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
