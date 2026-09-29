// Finds the entry of the user's SSH configuration that reaches a machine of a
// LAN. An editor that is handed the name of that entry connects the way `ssh`
// of this machine does: with the key, the user and the settings the entry
// names. Handed the bare address, it would find none of them.
//
// A configuration may hold several entries for one machine, such as one for
// the network at home and one for an overlay network, and which of them leads
// anywhere depends on where this machine is. What an entry connects to is
// therefore asked of `ssh` itself, and whether a server answers there is tried.
import path from 'node:path'
import {
  LAN_SSH_DEFAULT_PORT,
  isSshConfiguredHost,
  parseSshDestinationText,
  type LanSshDestination
} from '@lody/shared/lan-ssh'

/** A section of an SSH configuration, in the order of the file. */
export type SshConfigSection = {
  /** The hosts the section is for; `null` for every host. */
  patterns: string[] | null
  /** Whether it is for them only while something holds that is not asked here. */
  conditional: boolean
  hostName?: string
  user?: string
  port?: number
  proxied?: boolean
}

/** What `ssh <host>` connects to. */
export type SshConfigEntry = {
  hostName: string
  /** `null` when the configuration names none, which leaves it to who connects. */
  user: string | null
  port: number
  /** Whether it connects through another host or a command, where nothing here follows it. */
  proxied: boolean
}

export type SshConfigFiles = {
  /** The text of a file; `null` for one that cannot be read. */
  read: (file: string) => Promise<string | null>
  /** The names of what a directory holds; none for one that cannot be read. */
  list: (directory: string) => Promise<string[]>
}

/** What is asked of this machine as it is now. */
export type SshReach = {
  /** What `ssh <host>` connects to as `ssh` says it; `null` when it cannot be asked. */
  evaluate: (host: string) => Promise<SshConfigEntry | null>
  /** The addresses a host name stands for; none when it stands for none. */
  resolve: (hostName: string) => Promise<string[]>
  /** Whether an SSH server answers at an address. */
  probe: (address: string, port: number) => Promise<boolean>
}

const INCLUDE_DEPTH_MAX = 4
const FILES_MAX = 64
const HOSTS_MAX = 256
const ADDRESSES_MAX = 4
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

function toPattern(glob: string, flags = 'u'): RegExp {
  const source = glob.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '.*')
  return new RegExp(`^${source.replace(/\?/gu, '.')}$`, flags)
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

/**
 * The hosts a `Match` is for. It asks nothing when it says `all`, and names
 * hosts as `Host` does when it says `originalhost`; whatever else it asks is
 * not answered here, so the section may or may not be for a host.
 */
function readMatch(values: readonly string[]): Pick<SshConfigSection, 'patterns' | 'conditional'> {
  if (values.length === 1 && values[0]?.toLowerCase() === 'all') {
    return { patterns: null, conditional: false }
  }
  const named = values.findIndex((value) => value.toLowerCase() === 'originalhost')
  const list = named === -1 ? undefined : values[named + 1]
  return { patterns: list ? list.split(',').filter(Boolean) : null, conditional: true }
}

export function parseSshConfig(text: string): SshConfigSection[] {
  let section: SshConfigSection = { patterns: null, conditional: false }
  const sections = [section]
  for (const line of text.split(/\r?\n/u)) {
    const read = readLine(line)
    if (!read) continue
    const { keyword, values } = read
    if (keyword === 'host') {
      section = { patterns: [...values], conditional: false }
      sections.push(section)
    } else if (keyword === 'match') {
      section = readMatch(values)
      sections.push(section)
    } else if (keyword === 'hostname') {
      section.hostName ??= values[0]
    } else if (keyword === 'user') {
      section.user ??= values[0]
    } else if (keyword === 'port') {
      const port = Number(values[0])
      if (Number.isInteger(port) && port >= 1 && port <= 65_535) section.port ??= port
    } else if (keyword === 'proxyjump' || keyword === 'proxycommand') {
      section.proxied ??= values[0] !== undefined && values[0].toLowerCase() !== 'none'
    }
  }
  return sections
}

function isFor(section: SshConfigSection, host: string): boolean {
  if (section.patterns === null) return true
  // `Host` tells letters of one case from the other; a `Match` does not.
  const flags = section.conditional ? 'iu' : 'u'
  let named = false
  for (const pattern of section.patterns) {
    if (pattern.startsWith('!')) {
      if (toPattern(pattern.slice(1), flags).test(host)) return false
    } else if (toPattern(pattern, flags).test(host)) {
      named = true
    }
  }
  return named
}

const expandHostName = (hostName: string, host: string): string =>
  hostName.replace(/%([h%])/gu, (_, token: string) => (token === 'h' ? host : '%'))

/**
 * What the configuration says `ssh <host>` connects to: the first value each
 * section for the host gives, a section that may not be for it left out.
 */
export function evaluateSshConfig(
  sections: readonly SshConfigSection[],
  host: string
): SshConfigEntry {
  let hostName: string | undefined
  let user: string | undefined
  let port: number | undefined
  let proxied: boolean | undefined
  for (const section of sections) {
    if (section.conditional || !isFor(section, host)) continue
    hostName ??= section.hostName
    user ??= section.user
    port ??= section.port
    proxied ??= section.proxied
  }
  return {
    hostName: expandHostName(hostName ?? host, host),
    user: user ?? null,
    port: port ?? LAN_SSH_DEFAULT_PORT,
    proxied: proxied ?? false
  }
}

/**
 * Every host name the configuration may hand `ssh <host>`: what it says
 * without asking anything first, then what it says while something holds.
 */
export function listPossibleHostNames(
  sections: readonly SshConfigSection[],
  host: string
): string[] {
  const names = [evaluateSshConfig(sections, host).hostName]
  for (const section of sections) {
    if (!section.conditional || section.hostName === undefined || !isFor(section, host)) continue
    const name = expandHostName(section.hostName, host)
    if (!names.includes(name)) names.push(name)
  }
  return names
}

/** The hosts a configuration names one by one, in its order and as it writes them. */
export function listSshConfigHosts(sections: readonly SshConfigSection[]): string[] {
  const hosts: string[] = []
  for (const section of sections) {
    if (section.conditional) continue
    for (const pattern of section.patterns ?? []) {
      if (isSshConfiguredHost(pattern) && !hosts.includes(pattern)) hosts.push(pattern)
    }
  }
  return hosts
}

/** What `ssh -G <host>` printed, which is what `ssh <host>` connects to. */
export function parseSshEvaluation(output: string): SshConfigEntry | null {
  const said = new Map<string, string>()
  for (const line of output.split(/\r?\n/u)) {
    const [, keyword, value] = /^(\S+)\s+(.*)$/u.exec(line.trim()) ?? []
    if (keyword && value !== undefined && !said.has(keyword.toLowerCase())) {
      said.set(keyword.toLowerCase(), value.trim())
    }
  }
  const hostName = said.get('hostname')
  const port = Number(said.get('port'))
  if (!hostName || !Number.isInteger(port) || port < 1 || port > 65_535) return null
  const through = (keyword: string) => (said.get(keyword) ?? 'none').toLowerCase() !== 'none'
  return {
    hostName,
    user: said.get('user') || null,
    port,
    proxied: through('proxyjump') || through('proxycommand')
  }
}

/**
 * What to hand an editor so that it reaches the machine through the user's
 * SSH configuration, or `null` when no entry of it does.
 *
 * An entry is for the machine when what it connects to is anything the
 * machine is called, or a name that stands for one of its addresses; a name
 * with the domain of a network and the same name without it are one. It has
 * to connect to the port the SSH server of the machine answers on, as the
 * user the agent service runs as; an entry that leaves the user open is told
 * which. Among the entries for the machine, the first at which a server
 * answers is taken: the one for the address the machine answers members on
 * before one for another of its names, then in the order of the file.
 */
export async function findSshConfigDestination(
  text: string,
  machine: LanSshDestination,
  localUser: string | null,
  reach: SshReach
): Promise<string | null> {
  const sections = parseSshConfig(text)
  const called = [machine.host, ...(machine.names ?? [])].map((name) => name.toLowerCase())
  const [answersOn = ''] = called
  const addresses = called.filter((name) => IPV4_PATTERN.test(name))
  const labels = called.filter((name) => !IPV4_PATTERN.test(name)).map((name) => name.split('.')[0])

  const resolved = new Map<string, Promise<string[]>>()
  const resolve = (hostName: string): Promise<string[]> => {
    const name = hostName.toLowerCase().replace(/\.$/u, '')
    if (IPV4_PATTERN.test(name)) return Promise.resolve([name])
    let found = resolved.get(name)
    if (!found) {
      found = reach.resolve(name).catch(() => [])
      resolved.set(name, found)
    }
    return found
  }
  // 2 for the address the machine answers members on, 1 for anything else it
  // is called, 0 for another machine.
  const rank = async (hostName: string): Promise<number> => {
    const name = hostName.toLowerCase().replace(/\.$/u, '')
    const found = await resolve(name)
    if (name === answersOn || found.includes(answersOn)) return 2
    if (called.includes(name) || found.some((address) => addresses.includes(address))) return 1
    return !IPV4_PATTERN.test(name) && labels.includes(name.split('.')[0]) ? 1 : 0
  }

  const hosts = listSshConfigHosts(sections).slice(0, HOSTS_MAX)
  const entries = await Promise.all(
    hosts.map(async (host, order) => {
      // Asking takes a process and the network, so nothing is asked about an
      // entry the configuration says is for another user, port or machine.
      const stated = evaluateSshConfig(sections, host)
      if (stated.user !== null && stated.user !== machine.user) return null
      if (stated.port !== machine.port) return null
      const possible = await Promise.all(listPossibleHostNames(sections, host).map(rank))
      if (!possible.some((reached) => reached > 0)) return null

      const entry = (await reach.evaluate(host).catch(() => null)) ?? stated
      if (entry.port !== machine.port) return null
      const reached = await rank(entry.hostName)
      if (reached === 0) return null

      // The account that owns the folder, whoever this machine would connect as.
      let destination: string | null
      if ((entry.user ?? localUser) === machine.user) destination = host
      else if (stated.user === null) destination = `${machine.user}@${host}`
      else return null
      destination = parseSshDestinationText(destination)
      if (!destination) return null

      // Every server is tried at once and none is waited for here: an address
      // that leads nowhere says so only by staying silent.
      const answers = entry.proxied
        ? Promise.resolve(false)
        : resolve(entry.hostName).then(async (found) =>
            (
              await Promise.all(
                found
                  .slice(0, ADDRESSES_MAX)
                  .map((address) => reach.probe(address, entry.port).catch(() => false))
              )
            ).some(Boolean)
          )
      return {
        destination,
        rank: reached * 2 + (stated.user === null ? 0 : 1),
        order,
        answers,
        proxied: entry.proxied
      }
    })
  )

  const found = entries
    .filter((entry) => entry !== null)
    .sort((left, right) => right.rank - left.rank || left.order - right.order)
  for (const entry of found) {
    // Only the entries that come before it are waited for.
    if (await entry.answers) return entry.destination
  }
  // Whether an entry that goes through another host leads anywhere is not
  // tried, so it comes after every entry at which a server answered.
  return found.find((entry) => entry.proxied)?.destination ?? null
}
