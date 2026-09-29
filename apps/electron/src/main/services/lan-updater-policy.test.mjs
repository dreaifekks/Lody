import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveLanInstallTarget } from './lan-updater-policy.ts'

const mac = {
  platform: 'darwin',
  arch: 'arm64',
  runningUnderArm64Translation: false,
  isPackaged: true,
  execPath: '/Applications/Lody OSS.app/Contents/MacOS/Lody OSS',
  appImagePath: undefined,
  downloadsDir: '/Users/u/Library/Application Support/Lody OSS/lan-updates'
}

void test('a bundle is replaced by one staged beside it', () => {
  assert.deepEqual(resolveLanInstallTarget(mac), {
    enabled: true,
    target: {
      kind: 'mac-bundle',
      asset: 'LodyOSS-lan-mac-arm64.zip',
      bundlePath: '/Applications/Lody OSS.app',
      download:
        '/Users/u/Library/Application Support/Lody OSS/lan-updates/LodyOSS-lan-mac-arm64.zip',
      staging: '/Applications/.Lody OSS.app.update',
      backup: '/Applications/.Lody OSS.app.previous',
      report: '/Users/u/Library/Application Support/Lody OSS/lan-updates/last-failure.txt'
    }
  })
})

void test('a bundle keeps the name and the place its user gave it', () => {
  const decision = resolveLanInstallTarget({
    ...mac,
    arch: 'x64',
    execPath: '/Users/u/Applications/Lody (fork).app/Contents/MacOS/Lody OSS'
  })
  assert.equal(decision.enabled, true)
  assert.equal(decision.target.asset, 'LodyOSS-lan-mac-x64.zip')
  assert.equal(decision.target.bundlePath, '/Users/u/Applications/Lody (fork).app')
  assert.equal(decision.target.staging, '/Users/u/Applications/.Lody (fork).app.update')
})

void test('a build for Intel that runs translated moves to the build for the machine', () => {
  const decision = resolveLanInstallTarget({
    ...mac,
    arch: 'x64',
    runningUnderArm64Translation: true
  })
  assert.equal(decision.target.asset, 'LodyOSS-lan-mac-arm64.zip')
})

void test('an application that runs from where it cannot be replaced follows nothing', () => {
  for (const execPath of [
    '/private/var/folders/ab/T/AppTranslocation/1234/d/Lody OSS.app/Contents/MacOS/Lody OSS',
    '/Volumes/Lody OSS 0.100.0-lan.3/Lody OSS.app/Contents/MacOS/Lody OSS'
  ]) {
    assert.deepEqual(resolveLanInstallTarget({ ...mac, execPath }), {
      enabled: false,
      reason: 'not_installed'
    })
  }
  assert.deepEqual(resolveLanInstallTarget({ ...mac, execPath: '/usr/local/bin/electron' }), {
    enabled: false,
    reason: 'unsupported_platform'
  })
})

void test('an installer is kept outside the directory it replaces', () => {
  assert.deepEqual(
    resolveLanInstallTarget({
      platform: 'win32',
      arch: 'x64',
      runningUnderArm64Translation: false,
      isPackaged: true,
      execPath: 'C:\\Users\\u\\AppData\\Local\\Programs\\lody\\lody-oss.exe',
      appImagePath: undefined,
      downloadsDir: 'C:\\Users\\u\\AppData\\Roaming\\Lody OSS\\lan-updates'
    }),
    {
      enabled: true,
      target: {
        kind: 'nsis',
        asset: 'LodyOSS-lan-win-x64-setup.exe',
        download:
          'C:\\Users\\u\\AppData\\Roaming\\Lody OSS\\lan-updates\\LodyOSS-lan-win-x64-setup.exe'
      }
    }
  )
})

void test('an AppImage is replaced by a file downloaded beside it', () => {
  const linux = {
    platform: 'linux',
    arch: 'x64',
    runningUnderArm64Translation: false,
    isPackaged: true,
    execPath: '/tmp/.mount_LodyOSabc/lodyOssDesktop',
    appImagePath: '/home/u/Applications/LodyOSS.AppImage',
    downloadsDir: '/home/u/.config/Lody OSS/lan-updates'
  }
  assert.deepEqual(resolveLanInstallTarget(linux), {
    enabled: true,
    target: {
      kind: 'appimage',
      asset: 'LodyOSS-lan-linux-x64.AppImage',
      target: '/home/u/Applications/LodyOSS.AppImage',
      download: '/home/u/Applications/.LodyOSS.AppImage.update',
      report: '/home/u/.config/Lody OSS/lan-updates/last-failure.txt'
    }
  })

  // A package or an unpacked directory is replaced by whatever installed it.
  for (const appImagePath of [undefined, '', 'LodyOSS.AppImage']) {
    assert.deepEqual(resolveLanInstallTarget({ ...linux, appImagePath }), {
      enabled: false,
      reason: 'unsupported_platform'
    })
  }
  assert.deepEqual(resolveLanInstallTarget({ ...linux, arch: 'arm64' }), {
    enabled: false,
    reason: 'unsupported_platform'
  })
})

void test('a build that runs from a checkout follows nothing', () => {
  assert.deepEqual(resolveLanInstallTarget({ ...mac, isPackaged: false }), {
    enabled: false,
    reason: 'not_packaged'
  })
  assert.deepEqual(resolveLanInstallTarget({ ...mac, platform: 'freebsd' }), {
    enabled: false,
    reason: 'unsupported_platform'
  })
})
