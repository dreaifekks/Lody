// The GitHub credential a LAN host keeps for its members: one token, saved on
// the host with `lody lan github setup` and handed to members that ask through
// the credential gate. The token never reaches a log.
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { LAN_GITHUB_TOKEN_PATH, type LanGitHubCredential } from '@lody/shared/node/lan-github';

export const LAN_GITHUB_CONFIG_FILE_NAME = 'github.json';

export type LanHubGitHubConfig = LanGitHubCredential & { savedAt: string };

export function readLanHubGitHubConfig(dataDir: string): LanHubGitHubConfig | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dataDir, LAN_GITHUB_CONFIG_FILE_NAME), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const parsed = JSON.parse(raw) as Partial<LanHubGitHubConfig>;
  if (typeof parsed.token !== 'string' || !parsed.token) {
    throw new Error(`${LAN_GITHUB_CONFIG_FILE_NAME} holds no token`);
  }
  return {
    token: parsed.token,
    login: typeof parsed.login === 'string' ? parsed.login : null,
    userId: typeof parsed.userId === 'string' ? parsed.userId : null,
    savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : '',
  };
}

export function writeLanHubGitHubConfig(dataDir: string, config: LanHubGitHubConfig): void {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const target = path.join(dataDir, LAN_GITHUB_CONFIG_FILE_NAME);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

/** `false` when there was nothing to remove. */
export function removeLanHubGitHubConfig(dataDir: string): boolean {
  try {
    fs.unlinkSync(path.join(dataDir, LAN_GITHUB_CONFIG_FILE_NAME));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Who a token acts as, asked of GitHub before the token is saved. */
export async function describeGitHubToken(
  token: string,
  request: typeof fetch = fetch
): Promise<{ login: string; userId: string }> {
  const response = await request('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'lody-lan-hub',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401) throw new Error('GitHub does not accept this token');
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for this token`);
  const body = (await response.json()) as { login?: unknown; id?: unknown };
  if (typeof body.login !== 'string' || typeof body.id !== 'number') {
    throw new Error('GitHub did not say who this token acts as');
  }
  return { login: body.login, userId: String(body.id) };
}

export type LanHubGitHub = {
  handles(url: string | undefined): boolean;
  handle(request: http.IncomingMessage, response: http.ServerResponse): void;
};

/**
 * Answers members behind the gate. The file is read for every request, so a
 * credential saved or removed while the host runs takes effect at once.
 */
export function createLanHubGitHub(options: {
  dataDir: string;
  log?: (line: string) => void;
}): LanHubGitHub {
  const answer = (response: http.ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(body));
  };
  return {
    handles: (url) => url?.split('?')[0] === LAN_GITHUB_TOKEN_PATH,
    handle: (request, response) => {
      if (request.method !== 'GET') {
        answer(response, 405, { error: 'method_not_allowed' });
        return;
      }
      let config: LanHubGitHubConfig | null;
      try {
        config = readLanHubGitHubConfig(options.dataDir);
      } catch (error) {
        options.log?.(
          `[github] unreadable ${LAN_GITHUB_CONFIG_FILE_NAME}: ${error instanceof Error ? error.message : String(error)}`
        );
        config = null;
      }
      if (!config) {
        answer(response, 404, { error: 'not_configured' });
        return;
      }
      const credential: LanGitHubCredential = {
        token: config.token,
        login: config.login,
        userId: config.userId,
      };
      answer(response, 200, credential);
    },
  };
}
