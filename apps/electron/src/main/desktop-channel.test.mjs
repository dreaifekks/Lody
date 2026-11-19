import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AUTO_LAUNCH_ARG,
  getAutoLaunchQueryOptions,
  getAutoLaunchRegistrationSettings,
  resolveAutoLaunchEnabled,
  shouldHideMainWindowOnAutoLaunch
} from './auto-launch-policy.ts'
import { getDesktopCallbackProtocol, resolveDesktopProfile } from './desktop-channel.ts'
import { parseLocalPlatformSnapshot } from './local-platform-snapshot.ts'

const cloud = {
  platform: 'cloud',
  namespace: 'lody',
  dataDirectoryName: '.lody',
  desktopProtocol: 'lody',
  desktopProductName: 'Lody',
  desktopAppId: 'ai.lody.desktop',
  localCliHostPort: 17788
}

void test('Nightly separates desktop identity while retaining the shared CLI owner', () => {
  const nightly = resolveDesktopProfile(cloud, 'nightly')
  assert.equal(nightly.desktopProtocol, 'ai.lody.nightly')
  assert.equal(getDesktopCallbackProtocol(nightly), 'ai.lody.nightly')
  assert.equal(nightly.desktopUserDataName, 'Lody Nightly')
  assert.equal(nightly.desktopAppId, 'ai.lody.desktop.nightly')
  assert.equal(nightly.desktopIpcNamespace, 'lody-nightly')
  assert.equal(nightly.namespace, cloud.namespace)
  assert.equal(nightly.localCliHostPort, cloud.localCliHostPort)
  assert.equal(nightly.dataDirectoryName, cloud.dataDirectoryName)
  assert.equal(cloud.desktopProductName, 'Lody')
})

void test('Stable preserves existing desktop paths and local builds reject cloud channels', () => {
  const stable = resolveDesktopProfile(cloud)
  assert.equal(stable.desktopUserDataName, null)
  assert.equal(stable.desktopProtocol, 'lody')
  assert.equal(getDesktopCallbackProtocol(stable), 'ai.lody.stable')
  assert.equal(stable.desktopIpcNamespace, 'lody')
  assert.throws(() => resolveDesktopProfile(cloud, 'unknown'))
  assert.throws(() => resolveDesktopProfile(cloud, 'local'))
  const local = {
    ...cloud,
    platform: 'local',
    namespace: 'lody-oss',
    desktopProtocol: 'lody-oss',
    desktopProductName: 'Lody OSS'
  }
  assert.equal(resolveDesktopProfile(local).releaseChannel, 'local')
  assert.equal(getDesktopCallbackProtocol(local), 'lody-oss')
  assert.throws(() => resolveDesktopProfile(local, 'nightly'))
})

void test('the local desktop shares no desktop state with the hosted one', () => {
  const local = {
    ...cloud,
    platform: 'local',
    namespace: 'lody-oss',
    desktopProtocol: 'lody-oss',
    desktopProductName: 'Lody OSS'
  }
  const hosted = resolveDesktopProfile(cloud)
  const oss = resolveDesktopProfile(local)
  assert.equal(oss.desktopUserDataName, 'Lody OSS')
  assert.notEqual(oss.desktopStoreName, hosted.desktopStoreName)
  assert.equal(hosted.desktopStoreName, 'lody-desktop')
})

void test('uses one stable identity to register and query each login item', () => {
  assert.deepEqual(getAutoLaunchQueryOptions('darwin'), { type: 'mainAppService' })
  assert.deepEqual(getAutoLaunchRegistrationSettings('darwin', true), {
    openAtLogin: true,
    type: 'mainAppService'
  })

  const windowsQuery = { args: [AUTO_LAUNCH_ARG] }
  assert.deepEqual(getAutoLaunchQueryOptions('win32'), windowsQuery)
  assert.deepEqual(getAutoLaunchRegistrationSettings('win32', true), {
    openAtLogin: true,
    ...windowsQuery
  })
  assert.deepEqual(getAutoLaunchRegistrationSettings('win32', false), {
    openAtLogin: false,
    ...windowsQuery
  })
})

void test('recognizes both current and legacy Windows login entries', () => {
  assert.equal(
    resolveAutoLaunchEnabled('win32', {
      openAtLogin: true,
      executableWillLaunchAtLogin: true
    }),
    true
  )
  assert.equal(
    resolveAutoLaunchEnabled('win32', {
      openAtLogin: false,
      executableWillLaunchAtLogin: true
    }),
    true
  )
  assert.equal(
    resolveAutoLaunchEnabled('win32', {
      openAtLogin: false,
      executableWillLaunchAtLogin: false
    }),
    false
  )
})

const baseVisibilityInput = {
  preferenceEnabled: true,
  launchedAtLogin: true,
  initialPath: '/',
  hasInitialDeepLink: false
}

void test('hides only ordinary login launches with an explicit preference', () => {
  assert.equal(shouldHideMainWindowOnAutoLaunch(baseVisibilityInput), true)
  assert.equal(
    shouldHideMainWindowOnAutoLaunch({
      ...baseVisibilityInput,
      preferenceEnabled: false
    }),
    false
  )
  assert.equal(
    shouldHideMainWindowOnAutoLaunch({
      ...baseVisibilityInput,
      launchedAtLogin: false
    }),
    false
  )
})

void test('always shows onboarding and deep-link launches', () => {
  assert.equal(
    shouldHideMainWindowOnAutoLaunch({
      ...baseVisibilityInput,
      initialPath: '/onboarding'
    }),
    false
  )
  assert.equal(
    shouldHideMainWindowOnAutoLaunch({
      ...baseVisibilityInput,
      hasInitialDeepLink: true
    }),
    false
  )
})

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
