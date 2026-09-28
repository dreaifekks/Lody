import { contextBridge } from 'electron'
import { ipcBridge } from './ipc-bridge'
import { electronAPI } from '@electron-toolkit/preload'
import { setupRenderer } from '@better-auth/electron/preload'
import os from 'node:os'
import { readPreferredSystemLanguagesArgument } from '../system-language-argument'
import { createBootProfiler, type BootProfilerBridge } from './boot-profiler'
import { resolvePlatformKind } from '@lody/shared/platform-kind'
import { readLanHubConfig } from '@lody/shared/node/lan-hub'

setupRenderer()

// Only presence is exposed: the shell forwards hub traffic, so the address and
// credential never enter the renderer. A malformed config reads as absent here
// because the main process already reported it.
function isLanHubConfigured(): boolean {
  if (resolvePlatformKind(import.meta.env.VITE_LODY_PLATFORM) !== 'local') return false
  try {
    return readLanHubConfig() !== null
  } catch {
    return false
  }
}

const platformInfo = {
  os: process.platform,
  homeDir: os.homedir(),
  machineName: os.hostname(),
  preferredSystemLanguages: readPreferredSystemLanguagesArgument(process.argv),
  lanHub: isLanHubConfigured()
}

const bootProfiler = process.env['LODY_E2E_BOOT_PROFILE'] === '1' ? createBootProfiler() : null

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('__LODY_ELECTRON__', true)
    contextBridge.exposeInMainWorld('__LODY_PLATFORM__', platformInfo)
    if (bootProfiler) contextBridge.exposeInMainWorld('__LODY_E2E_BOOT__', bootProfiler)
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('ipc', ipcBridge)
  } catch (error) {
    console.error(error)
  }
} else {
  const legacyWindow = window as typeof window & { __LODY_E2E_BOOT__?: BootProfilerBridge }
  // @ts-ignore (define in dts)
  window.__LODY_ELECTRON__ = true
  // @ts-ignore (define in dts)
  window.__LODY_PLATFORM__ = platformInfo
  if (bootProfiler) legacyWindow.__LODY_E2E_BOOT__ = bootProfiler
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.ipc = ipcBridge
}
