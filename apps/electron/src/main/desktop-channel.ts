import type { InstallationProfile } from '@lody/shared/node/installation-profile'

export type DesktopProfile = Omit<
  InstallationProfile,
  'desktopProtocol' | 'desktopProductName' | 'desktopAppId'
> & {
  desktopProtocol: string
  desktopProductName: string
  desktopAppId: string
  desktopUserDataName: string | null
  /** Names the stores kept beside `userData`, which products would otherwise share. */
  desktopStoreName: string
  desktopIpcNamespace: string
  releaseChannel: 'local' | 'stable' | 'staging' | 'nightly'
}

/** Desktop identity is separate from the CLI's shared installation namespace. */
export function resolveDesktopProfile(
  installation: InstallationProfile,
  configuredChannel?: string
): DesktopProfile {
  if (installation.platform === 'local' && configuredChannel) {
    throw new Error('Local desktop cannot select a cloud release channel')
  }
  const channel = installation.platform === 'local' ? 'local' : (configuredChannel ?? 'stable')
  if (
    !['local', 'stable', 'staging', 'nightly'].includes(channel) ||
    (installation.platform === 'cloud' && channel === 'local')
  ) {
    throw new Error('Invalid desktop release channel')
  }
  const nightly = channel === 'nightly'
  return {
    ...installation,
    ...(nightly
      ? {
          desktopProtocol: 'ai.lody.nightly',
          desktopProductName: 'Lody Nightly',
          desktopAppId: 'ai.lody.desktop.nightly'
        }
      : {}),
    // Stable keeps the path Electron derives for it. The local desktop names
    // its own: the single-instance lock lives in `userData`, so a path shared
    // with the hosted desktop lets only one of the two run.
    desktopUserDataName: nightly
      ? 'Lody Nightly'
      : installation.platform === 'local'
        ? installation.desktopProductName
        : null,
    desktopStoreName: installation.platform === 'local' ? 'lody-oss-desktop' : 'lody-desktop',
    desktopIpcNamespace: nightly ? 'lody-nightly' : installation.namespace,
    releaseChannel: channel as DesktopProfile['releaseChannel']
  }
}
