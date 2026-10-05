import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, net, powerMonitor } from 'electron'
import type {
  CheckForElectronUpdateResult,
  ElectronUpdaterState,
  QuitAndInstallElectronUpdateResult
} from '@lody/shared/electron-ipc'
import { IPC_PUSH_CHANNELS } from '@lody/shared/electron-ipc'
import {
  findLanReleaseAsset,
  getLanReleasePageUrl,
  resolveLanUpdateAvailability,
  type LanReleaseManifest,
  type LanReleaseSource
} from '@lody/shared/lan-release'
import {
  downloadNewestLanReleaseAsset,
  fetchLanReleaseManifest,
  type LanReleaseFetch
} from '@lody/shared/node/lan-release'
import { AUTO_LAUNCH_ARG } from '../auto-launch-policy'
import { formatUnknownError } from '../utils'
import { setAppQuitting } from '../window-state'
import type { AppUpdater } from './app-updater'
import {
  buildLanInstallCommand,
  readBundleVersion,
  readLanInstallFailure
} from './lan-updater-install'
import { composeLanReleaseNotes, getLanCompareUrl, readLanChanges } from './lan-updater-notes'
import {
  resolveLanInstallTarget,
  type LanInstallTarget,
  type LanUpdaterDecision
} from './lan-updater-policy'

const FIRST_CHECK_DELAY_MS = 20_000
// A fork publishes a build for every push; a quarter of an hour notices one
// soon without asking GitHub more than a few times an hour.
const CHECK_INTERVAL_MS = 15 * 60_000
const NOTES_TIMEOUT_MS = 15_000
const PROGRESS_INTERVAL_MS = 250
const EXTRACT_TIMEOUT_MS = 5 * 60_000
// Quitting asks the windows and stops the agent service first. When the
// application is still there after this long, somebody said no.
const QUIT_TIMEOUT_MS = 45_000

const netFetch: LanReleaseFetch = (url, init) => net.fetch(url, init)

function run(command: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-2000)
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `${path.basename(command)} exited with ${code}`))
    })
  })
}

/**
 * Keeps a build of a fork current with the releases of the repository that
 * built it. It asks before it downloads: a fork publishes a build for every
 * push, and most of them are not worth the download to whoever runs one.
 */
export class LanUpdaterService implements AppUpdater {
  private state: ElectronUpdaterState
  private decision: LanUpdaterDecision = { enabled: false, reason: 'not_packaged' }
  /** The release a later version was read from. */
  private manifest: LanReleaseManifest | null = null
  /** What is ready to take the place of the application, and its version. */
  private staged: { path: string; version: string } | null = null
  /** Why the last update did not take the place of this application. */
  private failure: string | null = null
  private started = false
  private checkInFlight = false
  private updateInFlight = false
  private firstCheck: NodeJS.Timeout | null = null
  private interval: NodeJS.Timeout | null = null

  constructor(private readonly options: { source: LanReleaseSource }) {
    this.state = {
      phase: 'idle',
      currentVersion: app.getVersion(),
      followed: this.describeSource()
    }
  }

  getState(): ElectronUpdaterState {
    return this.state
  }

  start(): void {
    if (this.started) return
    this.started = true

    this.decision = resolveLanInstallTarget({
      platform: process.platform,
      arch: process.arch,
      runningUnderArm64Translation: app.runningUnderARM64Translation,
      isPackaged: app.isPackaged || process.env.LODY_ELECTRON_ENABLE_DEV_UPDATER === '1',
      execPath: process.execPath,
      appImagePath: process.env.APPIMAGE,
      downloadsDir: path.join(app.getPath('userData'), 'lan-updates')
    })
    if (!this.decision.enabled) {
      this.setState({ phase: 'disabled', disabledReason: this.decision.reason })
      return
    }

    this.failure = this.takeFailure(this.decision.target)
    this.discardLeftovers(this.decision.target)
    this.firstCheck = setTimeout(() => void this.checkForUpdates(), FIRST_CHECK_DELAY_MS)
    this.interval = setInterval(() => void this.checkForUpdates(), CHECK_INTERVAL_MS)
    // Timers stand still while a laptop sleeps; waking up is when a check is due.
    powerMonitor.on('resume', this.checkOnResume)
  }

  private readonly checkOnResume = (): void => {
    void this.checkForUpdates()
  }

  stop(): void {
    if (this.firstCheck) clearTimeout(this.firstCheck)
    if (this.interval) clearInterval(this.interval)
    this.firstCheck = null
    this.interval = null
    powerMonitor.off('resume', this.checkOnResume)
  }

  async checkForUpdates(): Promise<CheckForElectronUpdateResult> {
    if (!this.decision.enabled) return { started: false, error: 'updater_disabled' }
    if (this.checkInFlight || this.updateInFlight) {
      return { started: false, error: 'check_in_progress' }
    }

    this.checkInFlight = true
    // A check in the background leaves an offered update on screen instead of
    // hiding it until the answer arrives.
    if (this.state.phase !== 'available' && this.state.phase !== 'downloaded') {
      this.setState({ phase: 'checking', error: undefined })
    }
    try {
      const manifest = await fetchLanReleaseManifest(this.options.source, { fetch: netFetch })
      // Why the last update failed is said with the update it can be tried
      // with again, and to nobody once there is none.
      const failure = this.failure
      this.failure = null
      if (resolveLanUpdateAvailability(app.getVersion(), manifest.version) !== 'available') {
        this.manifest = null
        this.setState({
          phase: 'up_to_date',
          availableVersion: undefined,
          checkedAtMs: Date.now()
        })
        return { started: true }
      }

      const known = this.manifest?.version === manifest.version
      this.manifest = manifest
      if (this.staged && this.staged.version !== manifest.version) this.discardStaged()
      this.setState({
        phase: this.staged ? 'downloaded' : 'available',
        availableVersion: manifest.version,
        downloadedVersion: this.staged?.version,
        releaseName: `Lody OSS LAN ${manifest.version}`,
        releaseDate: manifest.builtAt,
        ...(known ? {} : this.describeNotes(manifest, [])),
        ...(failure ? { error: failure } : {}),
        checkedAtMs: Date.now()
      })
      if (!known) void this.readChanges(manifest)
      return { started: true }
    } catch (error) {
      const message = formatUnknownError(error)
      this.recordError(message)
      return { started: false, error: message }
    } finally {
      this.checkInFlight = false
    }
  }

  /**
   * Updates the application: downloads what is not there yet, then quits and
   * lets the new build take the place of this one. It answers once it started.
   */
  async quitAndInstall(): Promise<QuitAndInstallElectronUpdateResult> {
    if (!this.decision.enabled) return { ok: false, error: 'updater_disabled' }
    if (this.updateInFlight) return { ok: false, error: 'update_install_in_progress' }
    const { target } = this.decision

    if (this.staged) return this.install(target, this.staged.path)
    const manifest = this.manifest
    if (!manifest || this.state.phase !== 'available') {
      return { ok: false, error: 'update_not_downloaded' }
    }
    const asset = findLanReleaseAsset(manifest, target.asset)
    if (!asset) {
      const message = `The release carries no ${target.asset}`
      this.recordError(message)
      return { ok: false, error: message }
    }

    this.updateInFlight = true
    void (async () => {
      try {
        let reportedAt = 0
        this.setState({
          phase: 'downloading',
          percent: 0,
          transferred: 0,
          total: asset.size,
          error: undefined
        })
        fs.mkdirSync(path.dirname(target.download), { recursive: true })
        const downloaded = await downloadNewestLanReleaseAsset({
          source: this.options.source,
          manifest,
          assetName: asset.name,
          destination: target.download,
          fetch: netFetch,
          // A build published while this one was being offered is the one installed.
          onManifest: (newer) => {
            this.manifest = newer
            this.setState({ availableVersion: newer.version, releaseDate: newer.builtAt })
          },
          onProgress: (received, total) => {
            const now = Date.now()
            if (received < total && now - reportedAt < PROGRESS_INTERVAL_MS) return
            reportedAt = now
            this.setState({
              phase: 'downloading',
              percent: (received / total) * 100,
              transferred: received,
              total
            })
          }
        })
        this.staged = { path: await this.stage(target, downloaded), version: downloaded.version }
        this.setState({
          phase: 'downloaded',
          downloadedVersion: downloaded.version,
          percent: undefined,
          bytesPerSecond: undefined,
          transferred: undefined,
          total: undefined
        })
        this.install(target, this.staged.path)
      } catch (error) {
        this.recordError(formatUnknownError(error))
      } finally {
        this.updateInFlight = false
      }
    })()
    return { ok: true }
  }

  /** Makes of the download what takes the place of the application. */
  private async stage(target: LanInstallTarget, manifest: LanReleaseManifest): Promise<string> {
    if (target.kind === 'nsis') return target.download
    if (target.kind === 'appimage') {
      fs.chmodSync(target.download, 0o755)
      return target.download
    }

    fs.rmSync(target.staging, { recursive: true, force: true })
    fs.mkdirSync(target.staging)
    // The archiver of the system keeps the links and the modes the signature
    // of a bundle covers; an unzip written in JavaScript may not.
    await run('/usr/bin/ditto', ['-x', '-k', target.download, target.staging], EXTRACT_TIMEOUT_MS)
    const name = fs.readdirSync(target.staging).find((entry) => entry.endsWith('.app'))
    if (!name) throw new Error(`${target.asset} contains no application`)

    const staged = path.join(target.staging, name)
    let claimed: string | null = null
    try {
      claimed = readBundleVersion(
        fs.readFileSync(path.join(staged, 'Contents', 'Info.plist'), 'utf8')
      )
    } catch {
      // A list this cannot read says nothing, which is not a contradiction.
    }
    if (claimed && claimed !== manifest.version) {
      throw new Error(`${target.asset} is ${claimed}, not ${manifest.version}`)
    }
    fs.rmSync(target.download, { force: true })
    return staged
  }

  /**
   * Quits, and replaces the application once it is gone. A window may refuse
   * to close and the agent service may refuse to stop; then nothing is
   * replaced, now or when the application quits for another reason.
   */
  private install(target: LanInstallTarget, staged: string): QuitAndInstallElectronUpdateResult {
    const command = buildLanInstallCommand({
      target,
      pid: process.pid,
      staged,
      relaunchArgs: process.argv.slice(1).filter((arg) => arg !== AUTO_LAUNCH_ARG)
    })
    const replace = (): void => {
      clearTimeout(refused)
      try {
        if (target.kind !== 'nsis') fs.mkdirSync(path.dirname(target.report), { recursive: true })
        spawn(command.command, command.args, {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, ...command.env }
        }).unref()
      } catch (error) {
        console.error('[lan-updater] Could not start the replacement', error)
      }
    }
    const refused = setTimeout(() => {
      app.removeListener('will-quit', replace)
      setAppQuitting(false)
      this.recordError('The application did not quit, so it was not updated')
    }, QUIT_TIMEOUT_MS)

    app.once('will-quit', replace)
    // Close handlers must not hide the windows and keep the application alive.
    setAppQuitting(true)
    app.quit()
    return { ok: true }
  }

  private async readChanges(manifest: LanReleaseManifest): Promise<void> {
    const from = this.options.source.commit
    if (!from || from === manifest.commit) return
    let changes: string[] = []
    try {
      const response = await net.fetch(
        getLanCompareUrl(this.options.source, from, manifest.commit),
        {
          headers: { accept: 'application/vnd.github+json' },
          signal: AbortSignal.timeout(NOTES_TIMEOUT_MS)
        }
      )
      if (response.ok) changes = readLanChanges(await response.json())
    } catch {
      // The notes then name the build and nothing else.
    }
    if (changes.length === 0 || this.manifest?.version !== manifest.version) return
    this.setState(this.describeNotes(manifest, changes))
  }

  private describeNotes(
    manifest: LanReleaseManifest,
    changes: readonly string[]
  ): Pick<ElectronUpdaterState, 'releaseNotes' | 'releaseNotesByLocale'> {
    const notes = composeLanReleaseNotes({
      source: this.options.source,
      version: manifest.version,
      commit: manifest.commit,
      changes
    })
    return { releaseNotes: notes.en, releaseNotesByLocale: notes }
  }

  private describeSource(): NonNullable<ElectronUpdaterState['followed']> {
    const { repository, tag } = this.options.source
    return { repository, tag, url: getLanReleasePageUrl(this.options.source) }
  }

  /** What the replacement of the last update said when it failed, read once. */
  private takeFailure(target: LanInstallTarget): string | null {
    if (target.kind === 'nsis') return null
    try {
      const failure = readLanInstallFailure(fs.readFileSync(target.report, 'utf8'))
      fs.rmSync(target.report, { force: true })
      return failure
    } catch {
      return null
    }
  }

  /**
   * What an update that did not finish left behind. A download that broke off
   * stays: the next one continues it if it is of the same file.
   */
  private discardLeftovers(target: LanInstallTarget): void {
    const leftovers =
      target.kind === 'mac-bundle'
        ? [target.download, target.staging, target.backup]
        : [target.download]
    for (const leftover of leftovers) {
      try {
        fs.rmSync(leftover, { recursive: true, force: true })
      } catch {
        // It stays where it is; the next update writes over it.
      }
    }
  }

  private discardStaged(): void {
    this.staged = null
    if (this.decision.enabled) this.discardLeftovers(this.decision.target)
  }

  /**
   * A failure does not take away what the user can still do: what is staged
   * can be installed, and what is known to be later can be asked for again.
   */
  private recordError(message: string): void {
    this.setState({
      phase: this.staged ? 'downloaded' : this.manifest ? 'available' : 'error',
      error: message,
      percent: undefined,
      bytesPerSecond: undefined,
      transferred: undefined,
      total: undefined,
      checkedAtMs: Date.now()
    })
  }

  private setState(next: Partial<ElectronUpdaterState>): void {
    this.state = {
      ...this.state,
      ...next,
      currentVersion: app.getVersion(),
      followed: this.describeSource()
    }
    for (const browserWindow of BrowserWindow.getAllWindows()) {
      if (browserWindow.isDestroyed()) continue
      const webContents = browserWindow.webContents
      if (!webContents || webContents.isDestroyed()) continue
      webContents.send(IPC_PUSH_CHANNELS.updaterState, this.state)
    }
  }
}
