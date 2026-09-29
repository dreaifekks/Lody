#!/usr/bin/env node
// Applies this fork's changes to submodules it cannot push to. Each file in
// patches/submodules/<submodule>/ is applied, in name order, to
// packages/<submodule>. The rest of patches/ belongs to pnpm.
// Running it again changes nothing; a patch that neither applies nor is
// already applied fails the build, which is what an upstream update that
// conflicts with it should do.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const patchesDir = path.join(root, 'patches', 'submodules');

function git(cwd, args) {
  try {
    execFileSync('git', args, { cwd, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

if (fs.existsSync(patchesDir)) {
  for (const submodule of fs.readdirSync(patchesDir).sort()) {
    const target = path.join(root, 'packages', submodule);
    if (!fs.existsSync(path.join(target, '.git'))) {
      throw new Error(`patches/submodules/${submodule} has no checked-out submodule at packages/${submodule}`);
    }
    const patches = fs
      .readdirSync(path.join(patchesDir, submodule))
      .filter((name) => name.endsWith('.patch'))
      .sort();
    for (const name of patches) {
      const patch = path.join(patchesDir, submodule, name);
      if (git(target, ['apply', '--reverse', '--check', patch])) continue;
      if (!git(target, ['apply', '--check', patch])) {
        throw new Error(
          `patches/submodules/${submodule}/${name} no longer applies to packages/${submodule}; update or drop it`
        );
      }
      execFileSync('git', ['apply', patch], { cwd: target, stdio: 'inherit' });
      console.log(`Applied patches/submodules/${submodule}/${name}`);
    }
  }
}
