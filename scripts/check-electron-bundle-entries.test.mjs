import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./check-electron-bundle-entries.mjs', import.meta.url));

function write(root, relativePath, content) {
  const file = path.join(root, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function fixture(t, bundles) {
  const root = mkdtempSync(path.join(tmpdir(), 'bundle-entries-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packages = {
    'ts-entry': { exports: { '.': { types: './src/index.ts', import: './src/index.ts' } } },
    'ts-subpath': { exports: { './telemetry': './src/telemetry.ts' } },
    'tsx-pattern': { exports: { './ui/*': './src/*.tsx' } },
    'js-entry': { exports: { '.': { types: './src/index.ts', default: './dist/index.js' } } },
    'js-main': { main: './dist/index.js' },
  };
  for (const [name, manifest] of Object.entries(packages)) {
    write(root, `node_modules/@lody/${name}/package.json`, JSON.stringify(manifest));
  }
  for (const [relativePath, content] of Object.entries({
    'out/main/index.js': 'console.log("main");',
    'out/preload/index.js': 'console.log("preload");',
    ...bundles,
  })) {
    write(root, relativePath, content);
  }
  return path.join(root, 'out');
}

function scan(outDir) {
  return spawnSync(process.execPath, [SCRIPT, outDir], { encoding: 'utf8' });
}

test('reports an external TypeScript entry with its file, package and configuration', (t) => {
  const result = scan(
    fixture(t, {
      'out/main/application-abc.js': 'const telemetry = require("@lody/ts-subpath/telemetry");',
      'out/main/nested/lazy-abc.js': 'const load = () => import("@lody/ts-entry");',
      'out/preload/index.js': 'const u = __require("@lody/tsx-pattern/ui/button");',
    })
  );
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /main\/application-abc\.js: @lody\/ts-subpath\/telemetry resolves to TypeScript \(\.\/src\/telemetry\.ts\)/u
  );
  assert.match(
    result.stderr,
    /main\/nested\/lazy-abc\.js: @lody\/ts-entry resolves to TypeScript/u
  );
  assert.match(result.stderr, /preload\/index\.js: @lody\/tsx-pattern\/ui\/button resolves/u);
  assert.match(
    result.stderr,
    /Add @lody\/ts-subpath, @lody\/ts-entry to main\.build\.externalizeDeps\.exclude in apps\/electron\/electron\.vite\.config\.ts/u
  );
  assert.match(
    result.stderr,
    /Add @lody\/tsx-pattern to preload\.build\.externalizeDeps\.exclude/u
  );
});

test('accepts external JavaScript entries, whose types may still be TypeScript', (t) => {
  const result = scan(
    fixture(t, {
      'out/main/index.js': 'require("@lody/js-entry"); import("@lody/js-main");',
    })
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /External @lody\/\* imports: @lody\/js-entry, @lody\/js-main\./u);
});

test('ignores package names in comments and plain strings', (t) => {
  const result = scan(
    fixture(t, {
      'out/main/index.js': [
        '// require("@lody/ts-entry")',
        '/* import("@lody/ts-entry"); */',
        'const message = "see require(\\"@lody/ts-entry\\") for details";',
        'const template = `import("@lody/ts-entry")`;',
        'console.log("@lody/ts-entry", message, template);',
      ].join('\n'),
    })
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /External @lody\/\* imports: none\./u);
});

test('fails on a package the bundle cannot load at all', (t) => {
  const result = scan(
    fixture(t, {
      'out/main/index.js': 'require("@lody/missing"); require("@lody/ts-subpath/other");',
    })
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /@lody\/missing is not installed/u);
  assert.match(result.stderr, /@lody\/ts-subpath\/other does not export \.\/other/u);
});

test('fails when there is nothing to scan', (t) => {
  const outDir = fixture(t, {});
  rmSync(path.join(outDir, 'preload'), { recursive: true });
  const result = scan(outDir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No bundles in .*preload/u);
});
