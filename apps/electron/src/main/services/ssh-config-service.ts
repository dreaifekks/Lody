import { spawn } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { readFile, readdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { LanSshDestination, SshDestination } from '@lody/shared/lan-ssh'
import { probeSshServer } from '@lody/shared/node/ssh-probe'
import { getUserShellEnvCached } from './shell-env'
import {
  findSshConfigDestination,
  parseSshEvaluation,
  readSshConfig,
  type SshConfigEntry,
  type SshConfigFiles,
  type SshReach
} from './ssh-config-core'

const FILE_MAX_BYTES = 256 * 1024
const EVALUATE_TIMEOUT_MS = 2_500
const EVALUATE_OUTPUT_MAX = 64 * 1024
const RESOLVE_TIMEOUT_MS = 1_500
const PROBE_TIMEOUT_MS = 1_500
// The header asks when it is drawn and again when the editor is started.
const RECENT_MS = 5_000

const files: SshConfigFiles = {
  read: async (file) => {
    try {
      const info = await stat(file)
      if (!info.isFile() || info.size > FILE_MAX_BYTES) return null
      return await readFile(file, 'utf8')
    } catch {
      return null
    }
  },
  list: async (directory) => {
    try {
      return await readdir(directory)
    } catch {
      return []
    }
  }
}

/**
 * Asks `ssh` what it connects to for a host of the configuration. It connects
 * to nothing for that; it reads the configuration as it does before it would.
 */
async function evaluate(host: string): Promise<SshConfigEntry | null> {
  const shellEnv = await getUserShellEnvCached()
  const env = shellEnv ? { ...process.env, ...shellEnv } : process.env
  return await new Promise<SshConfigEntry | null>((done) => {
    let settled = false
    let output = ''
    const finish = (entry: SshConfigEntry | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done(entry)
    }
    const child = spawn('ssh', ['-G', host], {
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    })
    const timer = setTimeout(() => {
      child.kill()
      finish(null)
    }, EVALUATE_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      if (output.length < EVALUATE_OUTPUT_MAX) output += chunk.toString('utf8')
    })
    child.once('error', () => finish(null))
    child.once('close', (code) => finish(code === 0 ? parseSshEvaluation(output) : null))
  })
}

async function resolve(hostName: string): Promise<string[]> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<string[]>((done) => {
    timer = setTimeout(() => done([]), RESOLVE_TIMEOUT_MS)
  })
  const found = lookup(hostName, { all: true }).then(
    (addresses) => addresses.map(({ address }) => address),
    () => []
  )
  try {
    return await Promise.race([found, late])
  } finally {
    clearTimeout(timer)
  }
}

const reach: SshReach = {
  evaluate,
  resolve,
  probe: async (address, port) => await probeSshServer(address, port, PROBE_TIMEOUT_MS)
}

function readLocalUser(): string | null {
  try {
    return os.userInfo().username || null
  } catch {
    return null
  }
}

async function find(machine: LanSshDestination, urlHost: boolean): Promise<SshDestination | null> {
  const home = os.homedir()
  const text = await readSshConfig(path.join(home, '.ssh', 'config'), home, files)
  return await findSshConfigDestination(text, machine, readLocalUser(), reach, { urlHost })
}

let recent: { asked: string; at: number; found: Promise<SshDestination | null> } | null = null

/**
 * The entry of the user's SSH configuration that reaches a machine of a LAN
 * from where this machine is now, as an editor is handed it; `null` when
 * there is none. With `urlHost`, an entry an address cannot name is none.
 */
export function findSshDestination(
  machine: LanSshDestination,
  urlHost: boolean
): Promise<SshDestination | null> {
  const asked = JSON.stringify([machine, urlHost])
  if (recent && recent.asked === asked && Date.now() - recent.at < RECENT_MS) return recent.found
  const found = find(machine, urlHost).catch(() => null)
  recent = { asked, at: Date.now(), found }
  return found
}
