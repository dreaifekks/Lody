import assert from 'node:assert/strict'
import test from 'node:test'
import { getDesktopCallbackProtocol, resolveDesktopProfile } from './desktop-channel.ts'

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

void test('the Mac test build isolates desktop stores, locks and protocol registration', () => {
  const local = {
    ...cloud,
    platform: 'local',
    namespace: 'lody-oss',
    desktopProtocol: 'lody-oss',
    desktopProductName: 'Lody OSS',
    desktopAppId: 'dev.loro.lody.oss'
  }
  const installed = resolveDesktopProfile(local)
  const testing = resolveDesktopProfile(local, undefined, true)
  for (const field of [
    'desktopProtocol',
    'desktopAppId',
    'desktopUserDataName',
    'desktopStoreName',
    'desktopIpcNamespace'
  ]) {
    assert.notEqual(testing[field], installed[field], field)
  }
  assert.equal(testing.desktopProductName, 'Lody Test')
  assert.equal(getDesktopCallbackProtocol(testing), 'lody-test')
  assert.equal(testing.releaseChannel, 'local')
  assert.equal(resolveDesktopProfile(local).desktopUserDataName, 'Lody OSS')
})
