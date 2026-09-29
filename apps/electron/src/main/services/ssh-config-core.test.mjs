import assert from 'node:assert/strict'
import test from 'node:test'
import {
  evaluateSshConfig,
  findSshConfigDestination,
  listSshConfigHosts,
  parseSshConfig,
  readSshConfig
} from './ssh-config-core.ts'

const machine = {
  version: 1,
  user: 'me',
  host: '100.64.0.7',
  port: 22,
  names: ['server', '192.168.1.5']
}

const find = (text, options = {}) =>
  findSshConfigDestination(
    text,
    { ...machine, ...options.machine },
    options.localUser === undefined ? 'someone' : options.localUser
  )

void test('an entry that names the address of the machine is what an editor is handed', () => {
  const text = `
    Host *
      AddKeysToAgent yes

    Host nuc
      HostName 100.64.0.7
      User me
      IdentityFile ~/.ssh/nuc
  `
  assert.equal(find(text), 'nuc')
})

void test('each machine is reached by its own entry, whoever the user of this machine is', () => {
  const text = `
    Host *
      AddKeysToAgent yes
      IdentityFile ~/.ssh/id_ed25519

    Host nuc
      HostName 100.64.0.7
      User me
      IdentityFile ~/.ssh/nuc

    Host mini
      HostName 100.64.0.9
      User admin
      IdentityFile ~/.ssh/mini
  `
  const mini = { version: 1, user: 'admin', host: '100.64.0.9', port: 22, names: ['mini-pc'] }

  for (const localUser of ['someone', 'me', 'admin', null]) {
    assert.equal(findSshConfigDestination(text, machine, localUser), 'nuc')
    assert.equal(findSshConfigDestination(text, mini, localUser), 'mini')
  }
})

void test('an entry reaches the machine by anything the machine is called', () => {
  assert.equal(find('Host nuc\n  HostName 192.168.1.5\n  User me'), 'nuc')
  assert.equal(find('Host nuc\n  HostName server\n  User me'), 'nuc')
  assert.equal(find('Host nuc\n  HostName SERVER.tail1234.ts.net.\n  User me'), 'nuc')
  // The name of the entry is the name of the machine when it names no other.
  assert.equal(find('Host server\n  User me'), 'server')
  assert.equal(find('Host 100.64.0.7\n  User me\n  IdentityFile ~/.ssh/nuc'), '100.64.0.7')
  assert.equal(
    find('Host nuc\n  HostName server.lan\n  User me', {
      machine: { host: 'server.home', names: undefined }
    }),
    'nuc'
  )
})

void test('an entry for another machine, port or user is not taken', () => {
  assert.equal(find('Host other\n  HostName 100.64.0.8\n  User me'), null)
  assert.equal(find('Host other\n  HostName servers\n  User me'), null)
  assert.equal(find('Host other\n  HostName 192.168.1.50\n  User me'), null)
  assert.equal(find('Host git\n  HostName 100.64.0.7\n  User me\n  Port 2222'), null)
  assert.equal(find('Host root\n  HostName 100.64.0.7\n  User root'), null)
  assert.equal(find(''), null)

  assert.equal(
    find('Host git\n  HostName 100.64.0.7\n  User me\n  Port 2222', { machine: { port: 2222 } }),
    'git'
  )
})

void test('an entry that leaves the user open is told who owns the folder', () => {
  const text = 'Host nuc\n  HostName 100.64.0.7\n  IdentityFile ~/.ssh/nuc'
  assert.equal(find(text, { localUser: 'someone' }), 'me@nuc')
  assert.equal(find(text, { localUser: null }), 'me@nuc')
  // `ssh nuc` of this machine would connect as that user anyway.
  assert.equal(find(text, { localUser: 'me' }), 'nuc')
  assert.equal(find(`Host *\n  User me\n${text}`, { localUser: 'someone' }), 'nuc')
  assert.equal(find(`${text}\nMatch all\n  User me`, { localUser: 'someone' }), 'nuc')
})

void test('the entry for the address the machine answers on comes before one for another name', () => {
  const home = 'Host home\n  HostName 192.168.1.5\n  User me'
  const away = 'Host away\n  HostName 100.64.0.7\n  User me'
  assert.equal(find(`${home}\n${away}`), 'away')
  assert.equal(find(`${away}\n${home}`), 'away')

  // Between two that are as good, the one that says who connects, then the first.
  const open = 'Host open\n  HostName 100.64.0.7'
  assert.equal(find(`${open}\n${away}`, { localUser: 'me' }), 'away')
  assert.equal(find(`${away}\nHost again\n  HostName 100.64.0.7\n  User me`), 'away')
})

void test('an entry is read as ssh reads it', () => {
  const sections = parseSshConfig(`
    # what stands before the first section is for every host
    Port 2200

    Host "quoted name" nuc nuc-* !nuc-old   # the machines of the house
      HostName=%h.lan
      User = me
      HostName ignored.lan
    Match host nuc exec "true"
      User nobody
    Host *
      User someone
      Port 22
  `)

  assert.deepEqual(evaluateSshConfig(sections, 'NUC'), {
    hostName: 'NUC.lan',
    user: 'me',
    port: 2200
  })
  assert.deepEqual(evaluateSshConfig(sections, 'nuc-2'), {
    hostName: 'nuc-2.lan',
    user: 'me',
    port: 2200
  })
  assert.deepEqual(evaluateSshConfig(sections, 'nuc-old'), {
    hostName: 'nuc-old',
    user: 'someone',
    port: 2200
  })
  assert.deepEqual(listSshConfigHosts(sections), ['nuc'])
})

void test('no entry is taken whose name an editor could read as something else', () => {
  const text = `
    Host -oProxyCommand=id me@nuc nuc:22 nuc/1
      HostName 100.64.0.7
      User me
  `
  assert.deepEqual(listSshConfigHosts(parseSshConfig(text)), [])
  assert.equal(find(text), null)
})

void test('what a configuration includes is read in its place', async () => {
  const stored = new Map([
    ['/home/u/.ssh/config', 'Include hosts.d/*.conf ~/elsewhere/config /etc/ssh/more\nHost last\n'],
    ['/home/u/.ssh/hosts.d/b.conf', 'Host b\n  Include nested\n'],
    ['/home/u/.ssh/hosts.d/a.conf', 'Host a\n'],
    ['/home/u/.ssh/hosts.d/skipped.txt', 'Host skipped\n'],
    ['/home/u/.ssh/nested', 'HostName 100.64.0.7\n  User me\n'],
    ['/home/u/elsewhere/config', 'Host elsewhere\n'],
    ['/etc/ssh/more', 'Host more\nInclude /etc/ssh/more\n']
  ])
  const read = []
  const text = await readSshConfig('/home/u/.ssh/config', '/home/u', {
    read: async (file) => {
      read.push(file)
      return stored.get(file) ?? null
    },
    list: async (directory) =>
      [...stored.keys()]
        .filter((file) => file.startsWith(`${directory}/`))
        .map((file) => file.slice(directory.length + 1))
  })

  assert.deepEqual(listSshConfigHosts(parseSshConfig(text)), [
    'a',
    'b',
    'elsewhere',
    'more',
    'last'
  ])
  assert.equal(findSshConfigDestination(text, machine, 'someone'), 'b')
  // A configuration that includes itself is read a few times, not forever.
  assert.equal(read.filter((file) => file === '/etc/ssh/more').length, 4)
})

void test('a configuration that cannot be read names no entry', async () => {
  const text = await readSshConfig('/home/u/.ssh/config', '/home/u', {
    read: async () => null,
    list: async () => []
  })
  assert.equal(text, '')
  assert.equal(findSshConfigDestination(text, machine, 'me'), null)
})
