// Agents on a LAN member use the machine's own GitHub login. A machine that has
// none gets the token the LAN host keeps: `gh` reads it from GH_TOKEN, and Git
// asks a credential helper placed after every helper the machine configured,
// so credentials Git already finds on the machine still win.
import { execFile } from 'node:child_process';
import { getLoginShellEnv } from '@/agent/login-shell-env';
import { getGhTokenFingerprint, LODY_MANAGED_GH_TOKEN_SHA256_ENV } from '@/lib/gh-token-env';

/** A login or logout on the machine is seen within this long. */
const GH_LOGIN_PROBE_TTL_MS = 60_000;
const GH_TIMEOUT_MS = 5_000;

/**
 * Answers only `get`; Git also sends `store` and `erase` to every helper, and
 * the token must never be written anywhere.
 */
export const LAN_GIT_CREDENTIAL_HELPER =
  '!f() { test "$1" = get || return 0; echo username=x-access-token; echo "password=$GH_TOKEN"; }; f';

export type GhLoginProbe = () => Promise<boolean>;

const runGhAuthToken = async (): Promise<boolean> => {
  const env = { ...process.env, ...(await getLoginShellEnv()) };
  return await new Promise((resolve) => {
    execFile(
      'gh',
      ['auth', 'token', '--hostname', 'github.com'],
      { env, timeout: GH_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => resolve(!error && String(stdout).trim().length > 0)
    );
  });
};

/** Whether `gh` on this machine is logged in to github.com, asked at most once a minute. */
export function createGhLoginProbe(
  run: () => Promise<boolean> = runGhAuthToken,
  now: () => number = Date.now
): GhLoginProbe {
  let cached: { loggedIn: boolean; until: number } | null = null;
  return async () => {
    if (cached && cached.until > now()) return cached.loggedIn;
    const loggedIn = await run();
    cached = { loggedIn, until: now() + GH_LOGIN_PROBE_TTL_MS };
    return loggedIn;
  };
}

/**
 * Adds the LAN token to the environment of a session. Git configuration given
 * through the environment is extended, never replaced; `baseEnv` is what the
 * session inherits beneath `env`.
 */
export function applyLanGitHubCredentialEnv(
  env: Record<string, string>,
  token: string,
  baseEnv: NodeJS.ProcessEnv = process.env
): void {
  env.GH_TOKEN = token;
  // Marks the token as Lody's, so terminals the user opens leave it out.
  env[LODY_MANAGED_GH_TOKEN_SHA256_ENV] = getGhTokenFingerprint(token);
  const inherited = env.GIT_CONFIG_COUNT ?? baseEnv.GIT_CONFIG_COUNT;
  let count = Number.parseInt(inherited ?? '0', 10);
  if (!Number.isFinite(count) || count < 0) count = 0;
  for (let index = 0; index < count; index += 1) {
    // Entries the session inherits stay; they only move into its own environment.
    for (const kind of ['KEY', 'VALUE'] as const) {
      const name = `GIT_CONFIG_${kind}_${index}`;
      const value = env[name] ?? baseEnv[name];
      if (value !== undefined) env[name] = value;
    }
  }
  for (const host of ['github.com', 'www.github.com']) {
    env[`GIT_CONFIG_KEY_${count}`] = `credential.https://${host}.helper`;
    env[`GIT_CONFIG_VALUE_${count}`] = LAN_GIT_CREDENTIAL_HELPER;
    count += 1;
  }
  env.GIT_CONFIG_COUNT = String(count);
}
