import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, loadConfigFromFile } from 'vite';

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), '..');
const loaded = await loadConfigFromFile(
  { command: 'build', mode: 'production' },
  path.join(root, 'vite.config.ts')
);
const config = loaded.config;
const inputs = Object.entries(config.build.rollupOptions.input);
const group = process.argv[2];

if (group) {
  config.build.rollupOptions.input = Object.fromEntries(
    inputs.filter(([name]) => (group === 'runtime' ? !name.endsWith('-acp') : name === group))
  );
  config.build.emptyOutDir = group === 'runtime';
  await build({ ...config, root, configFile: false });
} else {
  // Each adapter's SDK and sourcemaps get a fresh heap. Keep the same entries,
  // chunks and complete maps without raising the CLI's 2 GiB build limit.
  for (const part of [
    'runtime',
    ...inputs.map(([name]) => name).filter((name) => name.endsWith('-acp')),
  ]) {
    const result = spawnSync(process.execPath, [script, part], { cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
