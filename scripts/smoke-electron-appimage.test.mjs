import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { smokeAppImage } from './smoke-electron-appimage.mjs';

// A stand-in AppImage: `--appimage-extract` unpacks an AppRun that runs `script`
// and leaves what it was started with, and the helper it started, in `report`.
function fakeAppImage(t, script) {
  const root = mkdtempSync(path.join(tmpdir(), 'appimage-smoke-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const report = path.join(root, 'report');
  const appRun = [
    '#!/bin/sh',
    `echo "args=$*" > "${report}"`,
    `echo "home=$HOME data=$LODY_DATA_DIR secret=$SMOKE_TEST_SECRET" >> "${report}"`,
    'sleep 1000 &',
    `echo "helper=$!" >> "${report}"`,
    script,
  ].join('\n');
  const appImage = path.join(root, 'fake.AppImage');
  writeFileSync(
    appImage,
    `#!/bin/sh\nmkdir squashfs-root\ncat > squashfs-root/AppRun <<'APPRUN'\n${appRun}\nAPPRUN\nchmod +x squashfs-root/AppRun\n`
  );
  chmodSync(appImage, 0o755);
  return { appImage, report: () => readFileSync(report, 'utf8') };
}

const quiet = { error() {} };
// Shuts its children down on SIGTERM, as the application does.
const staysUp = "trap 'trap - TERM; kill 0; exit 0' TERM\nsleep 1000 & wait";

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('passes on the loaded line and stops everything it started', async (t) => {
  const { appImage, report } = fakeAppImage(
    t,
    `echo '[electron-auth-debug] main window finished load without a pending deep link'\n${staysUp}`
  );
  process.env.SMOKE_TEST_SECRET = 'inherited';
  t.after(() => delete process.env.SMOKE_TEST_SECRET);

  assert.equal(await smokeAppImage(appImage, { log: quiet }), undefined);

  const started = report();
  assert.match(
    started,
    /args=--no-sandbox --ozone-platform=headless --disable-gpu --enable-logging=stderr/u
  );
  assert.match(started, /home=\S*lody-smoke-\S*\/home data=\S*lody-smoke-\S*\/data secret=\n/u);
  assert.equal(isRunning(Number(/helper=(\d+)/u.exec(started)[1])), false);
});

test('fails on the startup failure line and prints the log tail', async (t) => {
  const { appImage } = fakeAppImage(
    t,
    `echo '[Electron] Desktop startup failed Error: boom' >&2\n${staysUp}`
  );
  const printed = [];
  const failure = await smokeAppImage(appImage, { log: { error: (text) => printed.push(text) } });
  assert.match(failure, /Desktop startup failed/u);
  assert.match(printed.join('\n'), /Error: boom/u);
});

test('fails when a startup failure is logged beside the loaded line', async (t) => {
  const { appImage } = fakeAppImage(
    t,
    `echo 'Desktop startup failed' >&2\necho 'main window finished load'\n${staysUp}`
  );
  assert.match(await smokeAppImage(appImage, { log: quiet }), /Desktop startup failed/u);
});

test('fails when the application exits without loading, even with status 0', async (t) => {
  const { appImage, report } = fakeAppImage(t, 'exit 0');
  assert.match(await smokeAppImage(appImage, { log: quiet }), /exited \(0\) before the window/u);
  assert.equal(isRunning(Number(/helper=(\d+)/u.exec(report())[1])), false);
});

test('kills an application that ignores SIGTERM', async (t) => {
  const { appImage, report } = fakeAppImage(
    t,
    "trap '' TERM\necho 'main window finished load'\nsleep 1000 & wait"
  );
  assert.equal(await smokeAppImage(appImage, { stopTimeoutMs: 50, log: quiet }), undefined);
  assert.equal(isRunning(Number(/helper=(\d+)/u.exec(report())[1])), false);
});

test('fails when the loaded line never appears', async (t) => {
  const { appImage } = fakeAppImage(t, staysUp);
  assert.match(
    await smokeAppImage(appImage, { timeoutMs: 50, log: quiet }),
    /did not appear within 0\.05 s/u
  );
});

test('fails on a file that cannot be extracted', async (t) => {
  const { appImage } = fakeAppImage(t, staysUp);
  writeFileSync(appImage, '#!/bin/sh\necho corrupt >&2\nexit 3\n');
  await assert.rejects(smokeAppImage(appImage, { log: quiet }), /Could not extract .*corrupt/su);
});
