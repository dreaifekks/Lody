import { readFile, readdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { LanSshDestination } from '@lody/shared/lan-ssh'
import { findSshConfigDestination, readSshConfig, type SshConfigFiles } from './ssh-config-core'

const FILE_MAX_BYTES = 256 * 1024

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

function readLocalUser(): string | null {
  try {
    return os.userInfo().username || null
  } catch {
    return null
  }
}

/**
 * The entry of the user's SSH configuration that reaches a machine of a LAN,
 * as an editor is handed it; `null` when there is none. The configuration is
 * read each time: it is small, and its owner changes it to change this.
 */
export async function findSshDestination(machine: LanSshDestination): Promise<string | null> {
  const home = os.homedir()
  const text = await readSshConfig(path.join(home, '.ssh', 'config'), home, files)
  return findSshConfigDestination(text, machine, readLocalUser())
}
