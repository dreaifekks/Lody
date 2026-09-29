import assert from 'node:assert/strict'
import test from 'node:test'
import {
  evaluateSshConfig,
  findSshConfigDestination,
  listPossibleHostNames,
  listSshConfigHosts,
  parseSshConfig,
  parseSshEvaluation,
  readSshConfig
} from './ssh-config-core.ts'

const machine = {
  version: 1,
  user: 'me',
  host: '100.64.0.7',
  port: 22,
  names: ['server', '192.168.1.5']
}

/**
 * This machine as a test says it is: what `ssh` answers for a host, what
 * names stand for, and where an SSH server answers. Left alone, `ssh` cannot
 * be asked, no name stands for anything and a server answers everywhere.
 */
function createReach({ ssh, names = {}, answering } = {}) {
  const asked = []
  const reach = {
    evaluate: async (host) => {
      asked.push(`ssh ${host}`)
      return ssh?.[host] ?? null
    },
    resolve: async (hostName) => {
      asked.push(`name ${hostName}`)
      return names[hostName] ?? []
    },
    probe: async (address, port) => {
      asked.push(`server ${address}:${port}`)
      return answering ? answering.includes(address) : true
    }
  }
  return { reach, asked }
}

/** What an editor is handed, written out as someone reads it; `null` for no entry. */
const written = (destination) =>
  destination === null
    ? null
    : `${destination.user === undefined ? '' : `${destination.user}@`}${destination.host}`

const find = async (text, options = {}) =>
  written(
    await findSshConfigDestination(
      text,
      { ...machine, ...options.machine },
      options.localUser === undefined ? 'someone' : options.localUser,
      createReach(options).reach,
      { urlHost: options.urlHost }
    )
  )

void test('an entry that names the address of the machine is what an editor is handed', async () => {
  const text = `
    Host *
      AddKeysToAgent yes

    Host nuc
      HostName 100.64.0.7
      User me
      IdentityFile ~/.ssh/nuc
  `
  assert.equal(await find(text), 'nuc')
})

void test('each machine is reached by its own entry, whoever the user of this machine is', async () => {
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
    const { reach } = createReach()
    assert.deepEqual(await findSshConfigDestination(text, machine, localUser, reach), {
      host: 'nuc'
    })
    assert.deepEqual(await findSshConfigDestination(text, mini, localUser, reach), {
      host: 'mini'
    })
  }
})

void test('an entry is handed over as the configuration writes it', async () => {
  // `ssh home-nuc` would find no entry: `Host` tells the letters of one case from the other.
  const text = 'Host Home-Nuc\n  HostName 192.168.1.5\n  User me'
  assert.equal(await find(text), 'Home-Nuc')

  const sections = parseSshConfig(text)
  assert.deepEqual(listSshConfigHosts(sections), ['Home-Nuc'])
  assert.equal(evaluateSshConfig(sections, 'Home-Nuc').hostName, '192.168.1.5')
  assert.equal(evaluateSshConfig(sections, 'home-nuc').hostName, 'home-nuc')
})

void test('an entry with a colon in its name is taken, where an editor can be handed one', async () => {
  const text = `
    Host home-devNuc
        HostName 192.168.1.5
        User me
        IdentityFile /Users/someone/.ssh/nuc_rsa

    Host ts:home-devNuc
        Hostname server.tail1234.ts.net
        User me
        IdentityFile /Users/someone/.ssh/nuc_rsa
  `
  const names = { 'server.tail1234.ts.net': ['100.64.0.7'] }
  const away = { names, answering: ['100.64.0.7'] }
  const home = { names, answering: ['192.168.1.5'] }

  assert.equal(await find(text, away), 'ts:home-devNuc')
  assert.equal(await find(text, home), 'home-devNuc')
  // An address has no place for a colon in the name of a host.
  assert.equal(await find(text, { ...away, urlHost: true }), null)
  assert.equal(await find(text, { ...home, urlHost: true }), 'home-devNuc')

  // The same entry under a second name, which an address can carry.
  const renamed = text.replace('Host ts:home-devNuc', 'Host ts:home-devNuc ts-home-devNuc')
  assert.equal(await find(renamed, away), 'ts:home-devNuc')
  assert.equal(await find(renamed, { ...away, urlHost: true }), 'ts-home-devNuc')

  // Both names lead to one server, which is asked once.
  const { reach, asked } = createReach(away)
  await findSshConfigDestination(renamed, machine, 'someone', reach)
  assert.deepEqual(asked.filter((question) => question.startsWith('server')).sort(), [
    'server 100.64.0.7:22',
    'server 192.168.1.5:22'
  ])
})

void test('an entry reaches the machine by anything the machine is called', async () => {
  const names = {
    server: ['192.168.1.5'],
    'server.tail1234.ts.net': ['100.64.0.7'],
    'server.lan': ['192.168.1.5']
  }
  assert.equal(await find('Host nuc\n  HostName 192.168.1.5\n  User me'), 'nuc')
  assert.equal(await find('Host nuc\n  HostName server\n  User me', { names }), 'nuc')
  assert.equal(
    await find('Host nuc\n  HostName SERVER.tail1234.ts.net.\n  User me', { names }),
    'nuc'
  )
  // The name of the entry is the name of the machine when it names no other.
  assert.equal(await find('Host server\n  User me', { names }), 'server')
  assert.equal(await find('Host 100.64.0.7\n  User me\n  IdentityFile ~/.ssh/nuc'), '100.64.0.7')
  assert.equal(
    await find('Host nuc\n  HostName server.lan\n  User me', {
      names,
      machine: { host: 'server.home', names: undefined }
    }),
    'nuc'
  )
})

void test('a name that stands for an address of the machine is the machine', async () => {
  // The overlay network calls the machine something the machine does not call itself.
  const text = 'Host ts-nuc\n  HostName devbox.tail1234.ts.net\n  User me'
  assert.equal(
    await find(text, { names: { 'devbox.tail1234.ts.net': ['fd7a::7', '100.64.0.7'] } }),
    'ts-nuc'
  )
  assert.equal(await find(text, { names: { 'devbox.tail1234.ts.net': ['192.168.1.5'] } }), 'ts-nuc')
  assert.equal(await find(text, { names: { 'devbox.tail1234.ts.net': ['100.64.0.8'] } }), null)
  assert.equal(await find(text), null)
})

void test('an entry for another machine, port or user is not taken', async () => {
  assert.equal(await find('Host other\n  HostName 100.64.0.8\n  User me'), null)
  assert.equal(await find('Host other\n  HostName servers\n  User me'), null)
  assert.equal(await find('Host other\n  HostName 192.168.1.50\n  User me'), null)
  assert.equal(await find('Host git\n  HostName 100.64.0.7\n  User me\n  Port 2222'), null)
  assert.equal(await find('Host root\n  HostName 100.64.0.7\n  User root'), null)
  assert.equal(await find(''), null)

  assert.equal(
    await find('Host git\n  HostName 100.64.0.7\n  User me\n  Port 2222', {
      machine: { port: 2222 }
    }),
    'git'
  )
})

void test('an entry that leaves the user open is told who owns the folder', async () => {
  const text = 'Host nuc\n  HostName 100.64.0.7\n  IdentityFile ~/.ssh/nuc'
  assert.equal(await find(text, { localUser: 'someone' }), 'me@nuc')
  assert.equal(await find(text, { localUser: null }), 'me@nuc')
  // `ssh nuc` of this machine would connect as that user anyway.
  assert.equal(await find(text, { localUser: 'me' }), 'nuc')
  assert.equal(await find(`Host *\n  User me\n${text}`, { localUser: 'someone' }), 'nuc')
  assert.equal(await find(`${text}\nMatch all\n  User me`, { localUser: 'someone' }), 'nuc')

  // `ssh` says who it would connect as, named by the configuration or not.
  const asked = (user) => ({ nuc: { hostName: '100.64.0.7', user, port: 22, proxied: false } })
  assert.equal(await find(text, { ssh: asked('someone') }), 'me@nuc')
  assert.equal(await find(text, { ssh: asked('me') }), 'nuc')
  assert.equal(await find(`${text}\n  User root`, { ssh: asked('root') }), null)
})

/** Servers that answer when a test lets them, in the order it lets them. */
function createServers() {
  const waiting = new Map()
  const tried = []
  return {
    tried,
    probe: (address) =>
      new Promise((answer) => {
        tried.push(address)
        waiting.set(address, answer)
      }),
    /** Lets the server at an address answer, or stay silent for good. */
    settle: async (address, answers) => {
      waiting.get(address)(answers)
      // What follows an answer runs before the next server is let to answer.
      await new Promise((next) => setImmediate(next))
    }
  }
}

void test('the entry at which a server answers first is taken', async () => {
  const text = `
    Host home-nuc
      HostName 192.168.1.5
      User me
    Host ts-nuc
      HostName 100.64.0.7
      User me
  `
  const race = async (order) => {
    const servers = createServers()
    const found = findSshConfigDestination(text, machine, 'someone', {
      evaluate: async () => null,
      resolve: async () => [],
      probe: servers.probe
    })
    await new Promise((next) => setImmediate(next))
    // Every server is tried before any has answered.
    assert.deepEqual(servers.tried.sort(), ['100.64.0.7', '192.168.1.5'])
    for (const [address, answers] of order) await servers.settle(address, answers)
    return written(await found)
  }

  // At home the network of the house is the shorter way.
  assert.equal(
    await race([
      ['192.168.1.5', true],
      ['100.64.0.7', true]
    ]),
    'home-nuc'
  )
  assert.equal(
    await race([
      ['100.64.0.7', true],
      ['192.168.1.5', true]
    ]),
    'ts-nuc'
  )
  // One that says it leads nowhere does not end the wait for the other.
  assert.equal(
    await race([
      ['100.64.0.7', false],
      ['192.168.1.5', true]
    ]),
    'home-nuc'
  )
  assert.equal(
    await race([
      ['192.168.1.5', false],
      ['100.64.0.7', false]
    ]),
    null
  )
})

void test('the entry at which a server answers is taken, from where this machine is', async () => {
  const home = 'Host home-nuc\n  HostName 192.168.1.5\n  User me'
  const away = 'Host ts-nuc\n  HostName 100.64.0.7\n  User me'
  const lan = ['192.168.1.5']
  const overlay = ['100.64.0.7']

  for (const text of [`${home}\n${away}`, `${away}\n${home}`]) {
    // Away from home the network of the house leads nowhere.
    assert.equal(await find(text, { answering: overlay }), 'ts-nuc')
    // At home without the overlay network.
    assert.equal(await find(text, { answering: lan }), 'home-nuc')
    // Where both answer at once, the address the machine answers members on comes first.
    assert.equal(await find(text, { answering: [...lan, ...overlay] }), 'ts-nuc')
    assert.equal(await find(text, { answering: [] }), null)
  }
  assert.equal(await find(home, { answering: overlay }), null)

  // Between two that are as good, the one that says who connects, then the first.
  const open = 'Host open\n  HostName 100.64.0.7'
  assert.equal(await find(`${open}\n${away}`, { localUser: 'me' }), 'ts-nuc')
  assert.equal(await find(`${away}\nHost again\n  HostName 100.64.0.7\n  User me`), 'ts-nuc')
})

void test('an entry is taken as soon as a server answers, whatever stays silent after it', async () => {
  const text = `
    Host home-nuc
      HostName 192.168.1.5
      User me
    Host ts-nuc
      HostName 100.64.0.7
      User me
  `
  // The network of the house never answers from elsewhere; it only stops being waited for.
  const silent = new Promise(() => {})
  const found = await findSshConfigDestination(text, machine, 'someone', {
    evaluate: async () => null,
    resolve: async () => [],
    probe: (address) => (address === '100.64.0.7' ? Promise.resolve(true) : silent)
  })
  assert.deepEqual(found, { host: 'ts-nuc' })
})

void test('what ssh says an entry connects to counts, not what the file seems to say', async () => {
  const text = `
    Match originalhost nuc exec "at-home"
      HostName 192.168.1.5
    Host nuc
      HostName 100.64.0.7
      User me
  `
  const says = (hostName) => ({ nuc: { hostName, user: 'me', port: 22, proxied: false } })
  const answering = ['100.64.0.7']

  assert.equal(await find(text, { ssh: says('100.64.0.7'), answering }), 'nuc')
  // At home `ssh` takes the entry to the network of the house, which answers there.
  assert.equal(await find(text, { ssh: says('192.168.1.5'), answering: ['192.168.1.5'] }), 'nuc')
  assert.equal(await find(text, { ssh: says('192.168.1.5'), answering }), null)
  // An entry the configuration holds only while something holds that does not now.
  assert.equal(await find(text, { ssh: says('nuc'), answering }), null)
  assert.equal(await find(text, { ssh: says('100.64.0.8') }), null)
  assert.equal(
    await find(text, { ssh: { nuc: { ...says('100.64.0.7').nuc, port: 2222 } }, answering }),
    null
  )
})

void test('an entry that goes through another host comes after one a server answers at', async () => {
  const jump = 'Host jump-nuc\n  HostName 192.168.1.5\n  User me\n  ProxyJump bastion'
  const away = 'Host ts-nuc\n  HostName 100.64.0.7\n  User me'
  const { reach, asked } = createReach({ answering: [] })

  assert.deepEqual(await findSshConfigDestination(jump, machine, 'me', reach), {
    host: 'jump-nuc'
  })
  // Whether it leads anywhere is for the host it goes through to find out.
  assert.deepEqual(
    asked.filter((question) => question.startsWith('server')),
    []
  )
  assert.equal(await find(`${jump}\n${away}`, { answering: ['100.64.0.7'] }), 'ts-nuc')
  assert.equal(await find(`${jump}\n${away}`, { answering: [] }), 'jump-nuc')
  assert.equal(
    await find('Host direct\n  HostName 192.168.1.5\n  User me\n  ProxyJump none', {
      answering: []
    }),
    null
  )
})

void test('ssh is asked about the entries that may lead to the machine, and no other', async () => {
  const text = `
    Host github.com
      User git
    Host work
      HostName work.example.com
    Host nuc
      HostName 100.64.0.7
      User me
    Match originalhost maybe exec "at-home"
      HostName 192.168.1.5
    Host maybe
      User me
  `
  const { reach, asked } = createReach()

  assert.deepEqual(await findSshConfigDestination(text, machine, 'someone', reach), {
    host: 'nuc'
  })
  assert.deepEqual(asked.filter((question) => question.startsWith('ssh')).sort(), [
    'ssh maybe',
    'ssh nuc'
  ])
  // Nor is a name asked about that no entry for this user and port connects to.
  assert.deepEqual(asked.filter((question) => question.startsWith('name')).sort(), [
    'name maybe',
    'name work.example.com'
  ])
})

void test('a name is asked about once, however many entries connect to it', async () => {
  const text = `
    Host one
      HostName devbox.example.com
    Host two
      HostName DEVBOX.example.com.
      User me
  `
  const { reach, asked } = createReach({ names: { 'devbox.example.com': ['100.64.0.7'] } })

  assert.deepEqual(await findSshConfigDestination(text, machine, 'someone', reach), {
    host: 'two'
  })
  assert.deepEqual(
    asked.filter((question) => question.startsWith('name')),
    ['name devbox.example.com']
  )
})

void test('a failure to ask leaves what the configuration says', async () => {
  const text = 'Host nuc\n  HostName server\n  User me'
  const failing = {
    evaluate: async () => {
      throw new Error('no ssh here')
    },
    resolve: async () => {
      throw new Error('no resolver here')
    },
    probe: async () => {
      throw new Error('no network here')
    }
  }
  // The name names the machine, but nothing says where a server would answer.
  assert.equal(await findSshConfigDestination(text, machine, 'me', failing), null)
  assert.deepEqual(
    await findSshConfigDestination('Host nuc\n  HostName 100.64.0.7', machine, 'me', {
      ...failing,
      probe: async () => true
    }),
    { host: 'nuc' }
  )
})

void test('an entry is read as ssh reads it', () => {
  const sections = parseSshConfig(`
    # what stands before the first section is for every host
    Port 2200

    Host "quoted name" nuc nuc-* !nuc-old   # the machines of the house
      HostName=%h.lan
      User = me
      HostName ignored.lan
      ProxyCommand none
    Match host nuc exec "true"
      User nobody
    Match originalhost NUC,other exec "at-home"
      HostName 192.168.1.5
    Host *
      User someone
      Port 22
      ProxyJump bastion
  `)

  assert.deepEqual(evaluateSshConfig(sections, 'nuc'), {
    hostName: 'nuc.lan',
    user: 'me',
    port: 2200,
    proxied: false
  })
  assert.deepEqual(evaluateSshConfig(sections, 'nuc-2'), {
    hostName: 'nuc-2.lan',
    user: 'me',
    port: 2200,
    proxied: false
  })
  for (const host of ['nuc-old', 'NUC']) {
    assert.deepEqual(evaluateSshConfig(sections, host), {
      hostName: host,
      user: 'someone',
      port: 2200,
      proxied: true
    })
  }
  assert.deepEqual(listSshConfigHosts(sections), ['nuc'])
  assert.deepEqual(listPossibleHostNames(sections, 'nuc'), ['nuc.lan', '192.168.1.5'])
  assert.deepEqual(listPossibleHostNames(sections, 'other'), ['other', '192.168.1.5'])
  assert.deepEqual(listPossibleHostNames(sections, 'another'), ['another'])
})

void test('what ssh prints for a host is what it connects to', () => {
  assert.deepEqual(
    parseSshEvaluation(
      'host nuc\nuser me\nhostname 100.64.0.7\nport 22\naddressfamily any\nidentityfile ~/.ssh/nuc\n'
    ),
    { hostName: '100.64.0.7', user: 'me', port: 22, proxied: false }
  )
  assert.deepEqual(
    parseSshEvaluation('USER me\r\nHostName server.lan\r\nport 2222\r\nproxyjump bastion\r\n'),
    { hostName: 'server.lan', user: 'me', port: 2222, proxied: true }
  )
  assert.equal(
    parseSshEvaluation('hostname nuc\nport 22\nproxycommand ssh -W %h:%p bastion\n').proxied,
    true
  )
  assert.deepEqual(parseSshEvaluation('hostname nuc\nport 22\nproxyjump none\n'), {
    hostName: 'nuc',
    user: null,
    port: 22,
    proxied: false
  })

  for (const output of ['', 'user me\nport 22\n', 'hostname nuc\n', 'hostname nuc\nport 0\n']) {
    assert.equal(parseSshEvaluation(output), null)
  }
})

void test('no entry is taken whose name an editor could read as something else', async () => {
  const text = `
    Host -oProxyCommand=id me@nuc :nuc nuc/1 "two words" nuc?x=1 nuc#1
      HostName 100.64.0.7
      User me
  `
  assert.deepEqual(listSshConfigHosts(parseSshConfig(text)), [])
  assert.equal(await find(text), null)
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
  assert.equal(await find(text), 'b')
  // A configuration that includes itself is read a few times, not forever.
  assert.equal(read.filter((file) => file === '/etc/ssh/more').length, 4)
})

void test('a configuration that cannot be read names no entry', async () => {
  const text = await readSshConfig('/home/u/.ssh/config', '/home/u', {
    read: async () => null,
    list: async () => []
  })
  assert.equal(text, '')
  assert.equal(await find(text), null)
})
