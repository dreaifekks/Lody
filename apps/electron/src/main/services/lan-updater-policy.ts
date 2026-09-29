import path from 'node:path'
import { resolveLanDesktopAssetName } from '@lody/shared/lan-release'

/**
 * Where a build of a fork installs a later build of itself. The builds are not
 * signed, so neither the updater of the platform nor the one of the framework
 * accepts them; the application replaces its own files instead, after it quit.
 */
export type LanUpdaterHost = {
  platform: string
  arch: string
  /** An x64 build under Rosetta reports x64 although the machine is arm64. */
  runningUnderArm64Translation: boolean
  isPackaged: boolean
  execPath: string
  /** The AppImage this process was started from, as its runtime names it. */
  appImagePath: string | undefined
  /** Where the application keeps what it downloads. */
  downloadsDir: string
}

/**
 * - `not_packaged`: a build that runs from a checkout.
 * - `unsupported_platform`: the fork builds nothing for this platform.
 * - `not_installed`: the application runs from where it cannot be replaced: a
 *   disk image, or the read-only copy the system makes of a quarantined
 *   application. Moving it to Applications ends both.
 */
export type LanUpdaterDisabledReason = 'not_packaged' | 'unsupported_platform' | 'not_installed'

export type LanInstallTarget =
  | {
      kind: 'mac-bundle'
      asset: string
      /** The running application, which the staged one replaces. */
      bundlePath: string
      download: string
      /** Beside the application, so that replacing it is a rename. */
      staging: string
      backup: string
      /** Where what replaces the application says why it could not. */
      report: string
    }
  | { kind: 'nsis'; asset: string; download: string }
  | {
      kind: 'appimage'
      asset: string
      /** The running file, which the downloaded one replaces. */
      target: string
      /** Beside the running file, so that replacing it is a rename. */
      download: string
      /** Where what replaces the application says why it could not. */
      report: string
    }

export type LanUpdaterDecision =
  | { enabled: true; target: LanInstallTarget }
  | { enabled: false; reason: LanUpdaterDisabledReason }

const REPORT_NAME = 'last-failure.txt'

const disabled = (reason: LanUpdaterDisabledReason): LanUpdaterDecision => ({
  enabled: false,
  reason
})

function resolveMacBundle(execPath: string): string | null {
  // <bundle>.app/Contents/MacOS/<executable>
  const macOsDir = path.posix.dirname(execPath)
  const contentsDir = path.posix.dirname(macOsDir)
  const bundlePath = path.posix.dirname(contentsDir)
  if (
    path.posix.basename(macOsDir) !== 'MacOS' ||
    path.posix.basename(contentsDir) !== 'Contents' ||
    !bundlePath.endsWith('.app')
  ) {
    return null
  }
  return bundlePath
}

export function resolveLanInstallTarget(host: LanUpdaterHost): LanUpdaterDecision {
  if (!host.isPackaged) return disabled('not_packaged')

  if (host.platform === 'darwin') {
    const asset = resolveLanDesktopAssetName(
      host.platform,
      host.runningUnderArm64Translation ? 'arm64' : host.arch
    )
    const bundlePath = resolveMacBundle(host.execPath)
    if (!asset || !bundlePath) return disabled('unsupported_platform')
    if (bundlePath.includes('/AppTranslocation/') || bundlePath.startsWith('/Volumes/')) {
      return disabled('not_installed')
    }
    const parent = path.posix.dirname(bundlePath)
    const name = path.posix.basename(bundlePath)
    return {
      enabled: true,
      target: {
        kind: 'mac-bundle',
        asset,
        bundlePath,
        download: path.posix.join(host.downloadsDir, asset),
        staging: path.posix.join(parent, `.${name}.update`),
        backup: path.posix.join(parent, `.${name}.previous`),
        report: path.posix.join(host.downloadsDir, REPORT_NAME)
      }
    }
  }

  if (host.platform === 'win32') {
    const asset = resolveLanDesktopAssetName(host.platform, host.arch)
    if (!asset) return disabled('unsupported_platform')
    // Outside the directory of the application: the installer empties that one.
    return {
      enabled: true,
      target: { kind: 'nsis', asset, download: path.win32.join(host.downloadsDir, asset) }
    }
  }

  if (host.platform === 'linux') {
    const asset = resolveLanDesktopAssetName(host.platform, host.arch)
    const target = host.appImagePath?.trim()
    // A package or an unpacked directory is replaced by whatever installed it.
    if (!asset || !target || !path.posix.isAbsolute(target)) {
      return disabled('unsupported_platform')
    }
    return {
      enabled: true,
      target: {
        kind: 'appimage',
        asset,
        target,
        download: path.posix.join(
          path.posix.dirname(target),
          `.${path.posix.basename(target)}.update`
        ),
        report: path.posix.join(host.downloadsDir, REPORT_NAME)
      }
    }
  }

  return disabled('unsupported_platform')
}
