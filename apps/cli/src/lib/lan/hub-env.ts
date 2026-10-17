// The environment variables a LAN host keeps for the MCP servers of its
// workspace: one table of name to value, saved on the host with `lody lan env
// set` and handed to members through the credential gate, which copy it. A
// member's daemon fills `${VAR}` and `envPassthrough` of an MCP server from the
// copy where its own environment has no such variable. Values never reach a log.
import fs from 'node:fs';
import path from 'node:path';
import { ENV_VAR_NAME_PATTERN } from '@lody/shared';
import { LAN_ENV_FILE_NAME, parseLanEnv } from '@lody/shared/node/lan-credentials';

export function isLanEnvName(name: string): boolean {
  return ENV_VAR_NAME_PATTERN.test(name);
}

/** The table as the host keeps it; empty without a file. */
export function readLanHubEnv(dataDir: string): Record<string, string> {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dataDir, LAN_ENV_FILE_NAME), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  return parseLanEnv(JSON.parse(raw));
}

export function writeLanHubEnv(dataDir: string, env: Readonly<Record<string, string>>): void {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const target = path.join(dataDir, LAN_ENV_FILE_NAME);
  const temporary = `${target}.${process.pid}.tmp`;
  const sorted = Object.fromEntries(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(temporary, `${JSON.stringify(sorted, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

/** Sets one variable; the rest of the table stays. */
export function setLanHubEnv(dataDir: string, name: string, value: string): void {
  if (!isLanEnvName(name)) throw new Error(`${name} is not an environment variable name`);
  writeLanHubEnv(dataDir, { ...readLanHubEnv(dataDir), [name]: value });
}

/** `false` when the table had no such variable. */
export function unsetLanHubEnv(dataDir: string, name: string): boolean {
  const env = readLanHubEnv(dataDir);
  if (!(name in env)) return false;
  const { [name]: _removed, ...rest } = env;
  writeLanHubEnv(dataDir, rest);
  return true;
}
