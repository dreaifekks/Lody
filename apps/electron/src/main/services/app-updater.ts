import type { LanReleaseChannel } from '@lody/shared/lan-release'
import type {
  CheckForElectronUpdateResult,
  ElectronUpdaterState,
  QuitAndInstallElectronUpdateResult
} from '@lody/shared/electron-ipc'

/**
 * What the shell, the menu and the windows ask of whatever keeps this
 * application current. The hosted desktop follows its publisher's feed; a
 * build of a fork follows the releases of the repository that built it.
 */
export interface AppUpdater {
  getState(): ElectronUpdaterState
  start(): void
  stop(): void
  checkForUpdates(): Promise<CheckForElectronUpdateResult>
  quitAndInstall(): Promise<QuitAndInstallElectronUpdateResult>
  /** Switches between the releases of a fork; absent where a publisher's feed is followed. */
  follow?(channel: LanReleaseChannel): Promise<CheckForElectronUpdateResult>
}
