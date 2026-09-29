// Finds the entry of the user's SSH configuration that reaches a machine of a
// LAN. An editor that is handed the name of that entry connects the way `ssh`
// of this machine does: with the key, the user and the settings the entry
// names. Handed the bare address, it would find none of them.
import path from 'node:path'
import {
  LAN_SSH_DEFAULT_PORT,
  isSshConfiguredHost,
  parseSshDestinationText,
  type LanSshDestination
} from '@lody/shared/lan-ssh'

/** A section of an SSH configuration, in the order of the file. */
export type SshConfigSection = {
  /** The hosts the section is for; `null` for every host, none for a section nothing here reads. */
  patterns: string[] | null
  hostName?: string
  user?: string
  port?: number
}

export type SshConfigFiles = {
  /** The text of a file; `null` for one that cannot be read. */
  read: (file: string) => Promise<string | null>
  /** The names of what a directory holds; none for one that cannot be read. */
  list: (directory: string) => Promise<string[]>
}

const INCLUDE_DEPTH_MAX = 4
const FILES_MAX = 64
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/u

function readLine(line: string): { keyword: string; values: string[] } | null {
  const match = /^\s*([A-Za-z][A-Za-z0-9]*)(?:\s*=\s*|\s+)(.*)$/u.exec(line)
  if (!match) return null
  const values: string[] = []
  for (const [token, quoted] of (match[2] ?? '').matchAll(/"([^"]*)"|\S+/gu)) {
    if (quoted === undefined && token.startsWith('#')) break
    values.push(quoted ?? token)
  }
  return { keyword: (match[1] ?? '').toLowerCase(), values }
}

function toPattern(glob: string): RegExp {
  const source = glob.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '.*')
  return new RegExp(`^${source.replace(/\?/gu, '.')}$`, 'u')
}

/** Where an `Include` points: beside the configuration unless it says otherwise. */
async function listIncluded(
  pattern: string,
  home: string,
  files: SshConfigFiles
): Promise<string[]> {
  const target =
    pattern === '~' || pattern.startsWith('~/')
      ? path.join(home, pattern.slice(1))
      : path.isAbsolute(pattern)
        ? pattern
        : path.join(home, '.ssh', pattern)
  const directory = path.dirname(target)
  const name = path.basename(target)
  if (/[*?]/u.test(directory)) return []
  if (!/[*?]/u.test(name)) return [target]
  const wanted = toPattern(name)
  return (await files.list(directory))
    .filter((entry) => wanted.test(entry))
    .sort()
    .map((entry) => path.join(directory, entry))
}

/** The text of a configuration with what it includes in the place of each `Include`. */
export async function readSshConfig(
  file: string,
  home: string,
  files: SshConfigFiles
): Promise<string> {
  let left = FILES_MAX
  const load = async (target: string, depth: number): Promise<string> => {
    if (depth > INCLUDE_DEPTH_MAX || left <= 0) return ''
    left -= 1
    const text = await files.read(target)
    if (text === null) return ''
    const lines: string[] = []
    for (const line of text.split(/\r?\n/u)) {
      const read = readLine(line)
      if (read?.keyword !== 'include') {
        lines.push(line)
        continue
      }
      for (const pattern of read.values) {
        for (const included of await listIncluded(pattern, home, files)) {
          lines.push(await load(included, depth + 1))
        }
      }
    }
    return lines.join('\n')
  }
  return await load(file, 0)
}

export function parseSshConfig(text: string): SshConfigSection[] {
  let section: SshConfigSection = { patterns: null }
  const sections = [section]
  for (const line of text.split(/\r?\n/u)) {
    const read = readLine(line)
    if (!read) continue
    const { keyword, values } = read
    if (keyword === 'host') {
      section = { patterns: values.map((value) => value.toLowerCase()) }
      sections.push(section)
    } else if (keyword === 'match') {
      // What a `Match` asks cannot be answered here, except that `all` asks nothing.
      const all = values.length === 1 && values[0]?.toLowerCase() === 'all'
      section = { patterns: all ? null : [] }
      sections.push(section)
    } else if (keyword === 'hostname') {
      section.hostName ??= values[0]
    } else if (keyword === 'user') {
      section.user ??= values[0]
    } else if (keyword === 'port') {
      const port = Number(values[0])
      if (Number.isInteger(port) && port >= 1 && port <= 65_535) section.port ??= port
    }
  }
  return sections
}

function isFor(section: SshConfigSection, host: string): boolean {
  if (section.patterns === null) return true
  let named = false
  for (const pattern of section.patterns) {
    if (pattern.startsWith('!')) {
      if (toPattern(pattern.slice(1)).test(host)) return false
    } else if (toPattern(pattern).test(host)) {
      named = true
    }
  }
  return named
}

/** What `ssh <host>` would connect to: the first value each section for it gives. */
export function evaluateSshConfig(
  sections: readonly SshConfigSection[],
  host: string
): { hostName: string; user: string | null; port: number } {
  const name = host.toLowerCase()
  let hostName: string | undefined
  let user: string | undefined
  let port: number | undefined
  for (const section of sections) {
    if (!isFor(section, name)) continue
    hostName ??= section.hostName
    user ??= section.user
    port ??= section.port
  }
  return {
    hostName: (hostName ?? host).replace(/%([h%])/gu, (_, token: string) =>
      token === 'h' ? host : '%'
    ),
    user: user ?? null,
    port: port ?? LAN_SSH_DEFAULT_PORT
  }
}

/** The hosts a configuration names one by one, in its order. */
export function listSshConfigHosts(sections: readonly SshConfigSection[]): string[] {
  const hosts: string[] = []
  for (const section of sections) {
    for (const pattern of section.patterns ?? []) {
      if (isSshConfiguredHost(pattern) && !hosts.includes(pattern)) hosts.push(pattern)
    }
  }
  return hosts
}

/**
 * How well a host name names the machine: 2 for the address the machine
 * answers members on, 1 for anything else it is called, 0 for another machine.
 * A name with the domain of a network and the same name without it are one.
 */
function rankHostName(hostName: string, machine: LanSshDestination): number {
  const target = hostName.toLowerCase().replace(/\.$/u, '')
  const names = [machine.host, ...(machine.names ?? [])].map((name) => name.toLowerCase())
  if (target === names[0]) return 2
  if (names.includes(target)) return 1
  if (IPV4_PATTERN.test(target)) return 0
  const [label] = target.split('.')
  return names.some((name) => !IPV4_PATTERN.test(name) && name.split('.')[0] === label) ? 1 : 0
}

/**
 * What to hand an editor so that it reaches the machine through the user's
 * SSH configuration, or `null` when no entry of it does. An entry counts when
 * it names the machine, on the port its SSH server answers, as the user the
 * agent service runs as; one that leaves the user open is told which.
 */
export function findSshConfigDestination(
  text: string,
  machine: LanSshDestination,
  localUser: string | null
): string | null {
  const sections = parseSshConfig(text)
  let best: { destination: string; rank: number } | null = null
  for (const host of listSshConfigHosts(sections)) {
    const entry = evaluateSshConfig(sections, host)
    if (entry.port !== machine.port) continue
    if (entry.user !== null && entry.user !== machine.user) continue
    const reach = rankHostName(entry.hostName, machine)
    if (reach === 0) continue
    // The account that owns the folder, whoever this machine would connect as.
    const asUser = (entry.user ?? localUser) === machine.user
    const destination = parseSshDestinationText(asUser ? host : `${machine.user}@${host}`)
    if (!destination) continue
    const rank = reach * 2 + (entry.user === null ? 0 : 1)
    if (!best || rank > best.rank) best = { destination, rank }
  }
  return best?.destination ?? null
}
