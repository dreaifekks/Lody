import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  buildLanInstallCommand,
  readBundleVersion,
  readLanInstallFailure
} from './lan-updater-install.ts'

const posix = process.platform !== 'win32'

/** A directory for one test, removed when the test is over. */
function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lody lan update '))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

/**
 * Runs a command the way the application does, with programs of the test in
 * front of the ones of the system.
 */
function runCommand(command, programs) {
  return spawnSync(command.command, command.args, {
    env: {
      ...process.env,
      ...command.env,
      PATH: `${programs}${path.delimiter}${process.env.PATH}`
    },
    encoding: 'utf8',
    timeout: 20_000
  })
}

/** A program that writes what it was called with into a file. */
function fakeProgram(directory, name, record) {
  const file = path.join(directory, name)
  fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> "${record}"\n`, { mode: 0o755 })
}

function macTarget(root) {
  const bundlePath = path.join(root, "Lody OSS's $HOME.app")
  return {
    kind: 'mac-bundle',
    asset: 'LodyOSS-lan-mac-arm64.zip',
    bundlePath,
    download: path.join(root, 'download.zip'),
    staging: path.join(root, '.staging'),
    backup: path.join(root, '.previous'),
    report: path.join(root, 'last-failure.txt')
  }
}

function layOutBundle(directory, version) {
  fs.mkdirSync(path.join(directory, 'Contents'), { recursive: true })
  fs.writeFileSync(path.join(directory, 'Contents', 'version'), version)
}

void test(
  'a bundle is replaced and started once the application is gone',
  { skip: !posix },
  (t) => {
    const root = scratch(t)
    const target = macTarget(root)
    const staged = path.join(target.staging, 'Lody OSS.app')
    const record = path.join(root, 'record')
    const programs = path.join(root, 'bin')
    fs.mkdirSync(programs)
    fakeProgram(programs, 'open', record)
    fakeProgram(programs, 'xattr', record)
    layOutBundle(target.bundlePath, 'old')
    layOutBundle(staged, 'new')
    layOutBundle(target.backup, 'older')

    // The application is gone: no process has this id.
    const gone = spawnSync(process.execPath, ['-e', '']).pid
    const result = runCommand(
      buildLanInstallCommand({ target, pid: gone, staged, relaunchArgs: [] }),
      programs
    )

    assert.equal(result.status, 0, result.stderr)
    assert.equal(
      fs.readFileSync(path.join(target.bundlePath, 'Contents', 'version'), 'utf8'),
      'new'
    )
    assert.equal(fs.existsSync(target.backup), false)
    assert.equal(fs.existsSync(target.staging), false)
    assert.equal(fs.existsSync(target.report), false)
    assert.deepEqual(fs.readFileSync(record, 'utf8').trim().split('\n'), [
      `xattr -dr com.apple.quarantine ${target.bundlePath}`,
      `open ${target.bundlePath}`
    ])
  }
)

void test(
  'the application that was there is started when the new one cannot take its place',
  { skip: !posix },
  (t) => {
    const root = scratch(t)
    const target = macTarget(root)
    const record = path.join(root, 'record')
    const programs = path.join(root, 'bin')
    fs.mkdirSync(programs)
    fakeProgram(programs, 'open', record)
    fakeProgram(programs, 'xattr', record)
    layOutBundle(target.bundlePath, 'old')

    const gone = spawnSync(process.execPath, ['-e', '']).pid
    const result = runCommand(
      buildLanInstallCommand({
        target,
        pid: gone,
        staged: path.join(target.staging, 'missing.app'),
        relaunchArgs: []
      }),
      programs
    )

    assert.equal(result.status, 0, result.stderr)
    assert.equal(
      fs.readFileSync(path.join(target.bundlePath, 'Contents', 'version'), 'utf8'),
      'old'
    )
    assert.equal(fs.existsSync(target.backup), false)
    assert.deepEqual(fs.readFileSync(record, 'utf8').trim().split('\n'), [
      `open ${target.bundlePath}`
    ])
    // The application that starts next is told why it is still the old one.
    assert.match(readLanInstallFailure(fs.readFileSync(target.report, 'utf8')), /missing\.app/u)
  }
)

void test('nothing is replaced while the application is there', { skip: !posix }, async (t) => {
  const root = scratch(t)
  const target = macTarget(root)
  const staged = path.join(target.staging, 'Lody OSS.app')
  const record = path.join(root, 'record')
  const programs = path.join(root, 'bin')
  const gate = path.join(root, 'gate')
  fs.mkdirSync(programs)
  fakeProgram(programs, 'open', record)
  fakeProgram(programs, 'xattr', record)
  // The script waits by sleeping. Here it waits at a gate instead, so the
  // test knows when it waits and decides when it goes on.
  assert.equal(spawnSync('mkfifo', [gate]).status, 0)
  fs.writeFileSync(path.join(programs, 'sleep'), `#!/bin/sh\nread -r _ < "${gate}"\n`, {
    mode: 0o755
  })
  layOutBundle(target.bundlePath, 'old')
  layOutBundle(staged, 'new')
  const installed = () =>
    fs.readFileSync(path.join(target.bundlePath, 'Contents', 'version'), 'utf8')

  // Stands in for the application: it is there until it is told to go.
  const application = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
    stdio: ['pipe', 'ignore', 'ignore']
  })
  t.after(() => application.kill())
  const command = buildLanInstallCommand({
    target,
    pid: application.pid,
    staged,
    relaunchArgs: []
  })
  const replacement = spawn(command.command, command.args, {
    env: { ...process.env, PATH: `${programs}${path.delimiter}${process.env.PATH}` },
    stdio: 'ignore'
  })
  t.after(() => replacement.kill())
  const replaced = new Promise((resolve) => replacement.once('exit', resolve))

  // Opening the gate returns once the script stands at it: it found the
  // application and waits.
  await fs.promises.writeFile(gate, 'go\n')
  assert.equal(installed(), 'old')

  application.stdin.end()
  await new Promise((resolve) => application.once('exit', resolve))
  // The script may have looked once more before the application was gone.
  const open = fs.openSync(gate, fs.constants.O_RDWR | fs.constants.O_NONBLOCK)
  t.after(() => fs.closeSync(open))
  fs.writeSync(open, 'go\n'.repeat(64))

  assert.equal(await replaced, 0)
  assert.equal(installed(), 'new')
  assert.equal(fs.existsSync(target.staging), false)
})

void test(
  'an AppImage is replaced and started with what the application was started with',
  { skip: !posix },
  (t) => {
    const root = scratch(t)
    const record = path.join(root, 'record')
    const target = {
      kind: 'appimage',
      asset: 'LodyOSS-lan-linux-x64.AppImage',
      target: path.join(root, 'Lody OSS.AppImage'),
      download: path.join(root, '.Lody OSS.AppImage.update'),
      report: path.join(root, 'last-failure.txt')
    }
    fs.writeFileSync(target.target, '#!/bin/sh\nexit 9\n', { mode: 0o755 })
    fs.writeFileSync(
      target.download,
      `#!/bin/sh\nprintf '%s\\n' "$APPIMAGE_SILENT_INSTALL" "$@" > "${record}"\n`,
      { mode: 0o755 }
    )

    const gone = spawnSync(process.execPath, ['-e', '']).pid
    const result = runCommand(
      buildLanInstallCommand({
        target,
        pid: gone,
        staged: target.download,
        relaunchArgs: ['--no-sandbox', '--password-store=gnome libsecret']
      }),
      root
    )

    assert.equal(result.status, 0, result.stderr)
    assert.equal(fs.existsSync(target.download), false)
    assert.equal(fs.existsSync(target.report), false)
    assert.deepEqual(fs.readFileSync(record, 'utf8').trim().split('\n'), [
      'true',
      '--no-sandbox',
      '--password-store=gnome libsecret'
    ])
  }
)

void test(
  'the AppImage that was there is started when the new one cannot take its place',
  { skip: !posix },
  (t) => {
    const root = scratch(t)
    const record = path.join(root, 'record')
    const target = {
      kind: 'appimage',
      asset: 'LodyOSS-lan-linux-x64.AppImage',
      target: path.join(root, 'Lody OSS.AppImage'),
      download: path.join(root, 'missing.update'),
      report: path.join(root, 'last-failure.txt')
    }
    fs.writeFileSync(target.target, `#!/bin/sh\nprintf '%s\\n' "old $*" > "${record}"\n`, {
      mode: 0o755
    })

    const gone = spawnSync(process.execPath, ['-e', '']).pid
    const result = runCommand(
      buildLanInstallCommand({
        target,
        pid: gone,
        staged: target.download,
        relaunchArgs: ['--no-sandbox']
      }),
      root
    )

    assert.equal(result.status, 0, result.stderr)
    assert.equal(fs.readFileSync(record, 'utf8'), 'old --no-sandbox\n')
    assert.match(readLanInstallFailure(fs.readFileSync(target.report, 'utf8')), /missing\.update/u)
  }
)

void test('an installer replaces what it installed without asking and starts it', () => {
  const download = 'C:\\Users\\u\\AppData\\Roaming\\Lody OSS\\lan-updates\\setup.exe'
  assert.deepEqual(
    buildLanInstallCommand({
      target: { kind: 'nsis', asset: 'setup.exe', download },
      pid: 4321,
      staged: download,
      relaunchArgs: ['--ignored']
    }),
    { command: download, args: ['/S', '--updated', '--force-run'] }
  )
})

void test('what a failed replacement left is one line short enough to show', () => {
  assert.equal(
    readLanInstallFailure('\n  mv: rename a to b: Operation not permitted \nmore\n'),
    'mv: rename a to b: Operation not permitted'
  )
  assert.equal(readLanInstallFailure(`${'x'.repeat(400)}\n`)?.length, 300)
  assert.equal(readLanInstallFailure(' \n\n'), null)
})

void test('the version of a staged application is read from its property list', () => {
  const list = (version) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>dev.loro.lody.oss</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key><string>1</string>
</dict></plist>`

  assert.equal(readBundleVersion(list('0.100.0-lan.5')), '0.100.0-lan.5')
  assert.equal(readBundleVersion(list('')), null)
  assert.equal(readBundleVersion('bplist00'), null)
})
