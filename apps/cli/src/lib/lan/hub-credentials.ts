// The credentials a LAN hub holds, handed to its members as one document and
// set from any of them. Members keep a copy (see `lan-credential-sync.ts`), so
// the GitHub token and push keep working while the hub is away and wherever
// the hub moves. Nothing here reaches a log.
import crypto from 'node:crypto';
import type http from 'node:http';
import {
  LAN_HUB_CREDENTIALS_APNS_PATH,
  LAN_HUB_CREDENTIALS_GITHUB_PATH,
  LAN_HUB_CREDENTIALS_PATH,
} from '@lody/shared/node/lan-credentials';
import { z } from 'zod';
import { readApnsConfig, removeApnsConfig, validateApnsConfig, writeApnsConfig } from './apns';
import {
  readLanHubGitHubConfig,
  removeLanHubGitHubConfig,
  writeLanHubGitHubConfig,
} from './hub-github';
import type { LanPushDevice } from './lan-push-protocol';

const MAX_BODY_BYTES = 64 * 1024;

export const LanHubCredentialsSchema = z.object({
  revision: z.string().min(1),
  github: z
    .object({
      token: z.string().min(1),
      login: z.string().nullable(),
      userId: z.string().nullable(),
      savedAt: z.string(),
    })
    .nullable(),
  apns: z
    .object({ keyId: z.string().min(1), teamId: z.string().min(1), privateKey: z.string().min(1) })
    .nullable(),
  /** Read back by `createLanHubPush`, which drops a record it cannot read. */
  devices: z.array(z.unknown()),
});
export type LanHubCredentials = z.infer<typeof LanHubCredentialsSchema>;

const GitHubBodySchema = z
  .object({ token: z.string().min(1), login: z.string().nullable(), userId: z.string().nullable() })
  .strict();
const ApnsBodySchema = z
  .object({ keyId: z.string(), teamId: z.string(), privateKey: z.string() })
  .strict();

export function readLanHubCredentials(
  dataDir: string,
  devices: readonly LanPushDevice[]
): LanHubCredentials {
  const content = {
    github: readLanHubGitHubConfig(dataDir),
    apns: readApnsConfig(dataDir),
    devices: [...devices],
  };
  const revision = crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex');
  return { revision, ...content };
}

export type LanHubCredentialRoutes = {
  handles(url: string | undefined): boolean;
  handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void>;
};

class BadRequest extends Error {}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BadRequest('body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new BadRequest('body is not JSON');
  }
}

/**
 * Answers members behind the gate: the whole document, or setting and
 * removing the GitHub token or the APNs key. Who sets a credential checked it
 * first (`lody lan github setup` asks GitHub who the token is); the hub only
 * refuses an APNs key that is not one.
 */
export function createLanHubCredentialRoutes(options: {
  dataDir: string;
  devices: () => readonly LanPushDevice[];
  log?: (line: string) => void;
}): LanHubCredentialRoutes {
  const answer = (response: http.ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(body));
  };
  const routes = new Set([
    LAN_HUB_CREDENTIALS_PATH,
    LAN_HUB_CREDENTIALS_GITHUB_PATH,
    LAN_HUB_CREDENTIALS_APNS_PATH,
  ]);
  return {
    handles: (url) => routes.has(url?.split('?')[0] ?? ''),
    handle: async (request, response) => {
      const route = request.url?.split('?')[0];
      try {
        if (route === LAN_HUB_CREDENTIALS_PATH && request.method === 'GET') {
          answer(response, 200, readLanHubCredentials(options.dataDir, options.devices()));
        } else if (route === LAN_HUB_CREDENTIALS_GITHUB_PATH && request.method === 'PUT') {
          const parsed = GitHubBodySchema.safeParse(await readJson(request));
          if (!parsed.success) throw new BadRequest('token, login and userId required');
          writeLanHubGitHubConfig(options.dataDir, {
            ...parsed.data,
            savedAt: new Date().toISOString(),
          });
          options.log?.(`[credentials] GitHub token of ${parsed.data.login ?? 'unknown'} saved`);
          answer(response, 200, { ok: true });
        } else if (route === LAN_HUB_CREDENTIALS_GITHUB_PATH && request.method === 'DELETE') {
          answer(response, 200, { removed: removeLanHubGitHubConfig(options.dataDir) });
        } else if (route === LAN_HUB_CREDENTIALS_APNS_PATH && request.method === 'PUT') {
          const parsed = ApnsBodySchema.safeParse(await readJson(request));
          if (!parsed.success) throw new BadRequest('keyId, teamId and privateKey required');
          try {
            validateApnsConfig(parsed.data);
          } catch (error) {
            throw new BadRequest(error instanceof Error ? error.message : 'not an APNs key');
          }
          writeApnsConfig(options.dataDir, parsed.data);
          options.log?.(`[credentials] APNs key ${parsed.data.keyId} saved`);
          answer(response, 200, { ok: true });
        } else if (route === LAN_HUB_CREDENTIALS_APNS_PATH && request.method === 'DELETE') {
          answer(response, 200, { removed: removeApnsConfig(options.dataDir) });
        } else {
          answer(response, 405, { error: 'method_not_allowed' });
        }
      } catch (error) {
        if (error instanceof BadRequest) {
          answer(response, 400, { error: error.message });
          return;
        }
        options.log?.(
          `[credentials] ${route ?? '?'} failed: ${error instanceof Error ? error.name : 'error'}`
        );
        if (!response.headersSent) answer(response, 500, { error: 'credentials_failed' });
      }
    },
  };
}
