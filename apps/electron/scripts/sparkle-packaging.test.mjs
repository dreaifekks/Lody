import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import path from 'node:path'
import {
  DEFAULT_SPARKLE_APPCAST_URL,
  hasCodeSigningCredentials,
  isMacPackaging,
  resolvePackagedSparkleFeedUrl,
  resolveSparkleRebuildArch,
  shouldAdHocSignSparkleApp,
  shouldInjectSparklePublicKey,
  sparkleInfoPlistPath,
  withoutLibraryValidation
} from './sparkle-packaging.mjs'

void test('treats explicit --mac and host-default darwin packaging as Sparkle package runs', () => {
  assert.equal(isMacPackaging(['--mac', '--arm64', '--x64'], 'linux'), true)
  assert.equal(isMacPackaging(['--dir'], 'darwin'), true)
  assert.equal(isMacPackaging(['--win'], 'darwin'), false)
  assert.equal(isMacPackaging(['--linux', 'AppImage', 'deb'], 'darwin'), false)
  assert.equal(isMacPackaging(['--dir'], 'linux'), false)
})

void test('rebuilds a universal Sparkle addon when packaging both mac slices', () => {
  assert.equal(resolveSparkleRebuildArch(['--mac', '--arm64', '--x64'], 'arm64'), 'universal')
  assert.equal(resolveSparkleRebuildArch(['--mac', '--arm64'], 'arm64'), 'arm64')
  assert.equal(resolveSparkleRebuildArch(['--mac', '--x64'], 'arm64'), 'x64')
  assert.equal(resolveSparkleRebuildArch(['--mac'], 'arm64'), 'arm64')
  assert.equal(resolveSparkleRebuildArch(['--mac'], 'x64'), 'x64')
})

void test('ad-hoc signs Sparkle mac builds only when no Developer ID credentials are present', () => {
  assert.equal(hasCodeSigningCredentials({ CSC_LINK: 'abc', CSC_NAME: '' }), true)
  assert.equal(hasCodeSigningCredentials({ CSC_NAME: 'Developer ID' }), true)
  assert.equal(hasCodeSigningCredentials({ CSC_LINK: '  ', CSC_NAME: '' }), false)
  assert.equal(
    shouldAdHocSignSparkleApp({ platform: 'darwin', hasCodeSigningCredentials: false }),
    true
  )
  assert.equal(
    shouldAdHocSignSparkleApp({ platform: 'darwin', hasCodeSigningCredentials: true }),
    false
  )
  assert.equal(
    shouldAdHocSignSparkleApp({ platform: 'win32', hasCodeSigningCredentials: false }),
    false
  )
})

function readEntitlements(document) {
  const body = /<dict>([\s\S]*)<\/dict>/u.exec(document.replace(/<!--[\s\S]*?-->/gu, ''))
  assert.ok(body, 'the document holds a dictionary')
  return Object.fromEntries(
    [...body[1].matchAll(/<key>([^<]+)<\/key>\s*<(true|false)\/>/gu)].map(([, key, value]) => [
      key,
      value === 'true'
    ])
  )
}

void test('a self-signed application keeps its entitlements and may load what carries no Team ID', () => {
  const read = (name) => fs.readFileSync(new URL(`../build/${name}`, import.meta.url), 'utf8')
  const application = read('entitlements.mac.plist')
  const exception = 'com.apple.security.cs.disable-library-validation'

  // The checked-in entitlements stay strict: a build signed with a Team ID uses them as they are.
  assert.equal(exception in readEntitlements(application), false)
  assert.deepEqual(readEntitlements(withoutLibraryValidation(application)), {
    ...readEntitlements(application),
    [exception]: true
  })

  const nested = read('entitlements.mac.inherit.plist')
  assert.equal(withoutLibraryValidation(nested), nested)
  assert.throws(() => withoutLibraryValidation('<plist version="1.0"></plist>'), /no dictionary/u)
})

void test('packages a local Sparkle feed URL when one is configured', () => {
  assert.equal(resolvePackagedSparkleFeedUrl({}), DEFAULT_SPARKLE_APPCAST_URL)
  assert.equal(
    resolvePackagedSparkleFeedUrl({ configuredAppcastUrl: ' http://127.0.0.1:4371/appcast.xml ' }),
    'http://127.0.0.1:4371/appcast.xml'
  )
})

void test('injects the Sparkle public key only into packaged macOS Info.plist files', () => {
  assert.equal(shouldInjectSparklePublicKey({ platform: 'darwin', publicEdKey: 'ed-key' }), true)
  assert.equal(shouldInjectSparklePublicKey({ platform: 'mas', publicEdKey: 'ed-key' }), true)
  assert.equal(shouldInjectSparklePublicKey({ platform: 'darwin', publicEdKey: '  ' }), false)
  assert.equal(shouldInjectSparklePublicKey({ platform: 'win32', publicEdKey: 'ed-key' }), false)
  assert.equal(
    sparkleInfoPlistPath({
      appOutDir: '/dist/mac-arm64',
      productFilename: 'Lody OSS'
    }),
    path.join('/dist/mac-arm64', 'Lody OSS.app', 'Contents', 'Info.plist')
  )
})
