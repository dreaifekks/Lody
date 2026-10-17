// What `lody lan env` does: gives the host of a LAN one environment variable
// for the MCP servers of its workspace, takes one back, or lists the names the
// host keeps. A value comes in through a stream, never an argument, and the
// list never carries one; with `--data-dir` the host's files are written on
// this machine instead of asking the hub.
import type { LanHub } from '@lody/shared/node/lan-hub';
import { LAN_HUB_CREDENTIALS_ENV_PATH } from '@lody/shared/node/lan-credentials';
import { isLanEnvName, readLanHubEnv, setLanHubEnv, unsetLanHubEnv } from './hub-env';
import { callLanHubCredentials } from './lan-github-credential';

export type LanEnvTarget = { hub: Pick<LanHub, 'name' | 'url' | 'token'> } | { dataDir: string };

export async function readLanEnvValue(stream: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  // A value pasted or piped in ends with the newline of the shell, not of the value.
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}

export async function setLanEnv(
  target: LanEnvTarget,
  name: string,
  value: string,
  request?: typeof fetch
): Promise<void> {
  if (!isLanEnvName(name)) throw new Error(`${name} is not an environment variable name`);
  if (!value) throw new Error('No value was given');
  if ('dataDir' in target) {
    setLanHubEnv(target.dataDir, name, value);
    return;
  }
  await callLanHubCredentials(
    target.hub,
    'PUT',
    LAN_HUB_CREDENTIALS_ENV_PATH,
    { name, value },
    request
  );
}

/** `false` when the host kept no such variable. */
export async function unsetLanEnv(
  target: LanEnvTarget,
  name: string,
  request?: typeof fetch
): Promise<boolean> {
  if ('dataDir' in target) return unsetLanHubEnv(target.dataDir, name);
  const answer = await callLanHubCredentials(
    target.hub,
    'DELETE',
    LAN_HUB_CREDENTIALS_ENV_PATH,
    { name },
    request
  );
  return answer.removed === true;
}

/** The names the host keeps, sorted; values stay on the host. */
export async function listLanEnvNames(
  target: LanEnvTarget,
  request: typeof fetch = fetch
): Promise<string[]> {
  if ('dataDir' in target) return Object.keys(readLanHubEnv(target.dataDir)).sort();
  const response = await request(`${target.hub.url}${LAN_HUB_CREDENTIALS_ENV_PATH}`, {
    headers: { Authorization: `Bearer ${target.hub.token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 404) {
    throw new Error(`${target.hub.name} runs a host without an environment table; update it`);
  }
  if (!response.ok) throw new Error(`${target.hub.name} refused: ${response.status}`);
  const body = (await response.json().catch(() => ({}))) as { names?: unknown };
  return Array.isArray(body.names)
    ? body.names.filter((name): name is string => typeof name === 'string')
    : [];
}
