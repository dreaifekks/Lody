import assert from 'node:assert/strict'
import test from 'node:test'
import { parseLocalPlatformSnapshot } from './local-platform-snapshot.ts'

const workspace = (workspaceId, name, slug, state = 'active') => ({
  workspaceId,
  name,
  slug,
  role: 'owner',
  state
})

const validCatalog = {
  identity: { userId: 'local:user-1' },
  workspaces: [workspace('lw_workspace-1', 'Lody', 'local')]
}

const lans = [
  {
    id: 'a'.repeat(32),
    url: 'http://100.64.0.1:8788',
    workspaceId: 'lw_home',
    userId: 'local:home-user'
  },
  {
    id: 'b'.repeat(32),
    url: 'https://hub.example.com',
    workspaceId: 'lw_office',
    userId: 'local:office-user'
  }
]

void test('keeps CLI identity and workspace in one local platform snapshot', () => {
  const expected = {
    workspaceId: 'lw_workspace-1',
    name: 'Lody',
    slug: 'local',
    role: 'owner'
  }
  assert.deepEqual(parseLocalPlatformSnapshot(validCatalog), {
    userId: 'local:user-1',
    workspace: expected,
    workspaces: [{ ...expected, lan: null, userId: 'local:user-1' }]
  })
})

void test('lists one workspace per LAN and names the LAN each one syncs through', () => {
  const snapshot = parseLocalPlatformSnapshot(
    {
      identity: { userId: 'local:home-user' },
      workspaces: [
        workspace('lw_home', 'Home', 'lan-home'),
        workspace('lw_office', 'Office', 'office'),
        workspace('lw_workspace-1', 'Lody', 'local', 'remote_missing')
      ]
    },
    lans
  )
  assert.deepEqual(snapshot, {
    userId: 'local:home-user',
    workspace: { workspaceId: 'lw_home', name: 'Home', slug: 'lan-home', role: 'owner' },
    workspaces: [
      {
        workspaceId: 'lw_home',
        name: 'Home',
        slug: 'lan-home',
        role: 'owner',
        lan: { id: 'a'.repeat(32), url: 'http://100.64.0.1:8788' },
        userId: 'local:home-user'
      },
      {
        workspaceId: 'lw_office',
        name: 'Office',
        slug: 'office',
        role: 'owner',
        lan: { id: 'b'.repeat(32), url: 'https://hub.example.com' },
        userId: 'local:office-user'
      }
    ]
  })
  assert.ok(!JSON.stringify(snapshot).includes('token'))
})

void test('keeps a workspace local while the settings do not name its LAN', () => {
  // The settings already lost the LAN; the CLI has not left it yet.
  const snapshot = parseLocalPlatformSnapshot(
    {
      identity: { userId: 'local:lan-owner' },
      workspaces: [workspace('lw_office', 'Office', 'office')]
    },
    [lans[0]]
  )
  assert.equal(snapshot?.workspaces[0]?.lan, null)
})

void test('waits while the CLI is between two sets of workspaces', () => {
  assert.equal(
    parseLocalPlatformSnapshot({
      identity: { userId: 'local:lan-owner' },
      workspaces: [workspace('lw_workspace-1', 'Lody', 'local', 'remote_missing')]
    }),
    null
  )
})

void test('reports the workspaces of LANs the settings no longer name', () => {
  // The last LAN was left a moment ago; the CLI still serves both workspaces.
  const snapshot = parseLocalPlatformSnapshot({
    identity: { userId: 'local:lan-owner' },
    workspaces: [
      workspace('lw_home', 'Home', 'lan-home'),
      workspace('lw_office', 'Office', 'office')
    ]
  })
  assert.deepEqual(
    snapshot?.workspaces.map((entry) => [entry.workspaceId, entry.lan]),
    [
      ['lw_home', null],
      ['lw_office', null]
    ]
  )
})

void test('rejects identity drift and a workspace that is not a local one', () => {
  assert.throws(
    () => parseLocalPlatformSnapshot({ ...validCatalog, identity: { userId: 'cloud-user' } }),
    /invalid local user id/
  )
  assert.throws(
    () =>
      parseLocalPlatformSnapshot({
        ...validCatalog,
        workspaces: [workspace('cloud-workspace', 'Cloud', 'cloud')]
      }),
    /invalid active workspace/
  )
})
