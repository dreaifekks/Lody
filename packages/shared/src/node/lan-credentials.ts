// What every member of a LAN keeps of the credentials its hub holds: the GitHub
// token, the APNs key and the phones registered for push. A member copies them
// from the hub, so it still has them while the hub is away, and a machine that
// takes the hub over finds them in place. The copy sits in the member's data
// directory in the hub's own file layout and never leaves the machine.
import fs from 'node:fs';
import path from 'node:path';
import { getLodyDataDir } from './installation-profile';
import type { LanGitHubCredential } from './lan-github';

/** The hub's credentials as one document: `GET`; one part: `PUT` or `DELETE`. */
export const LAN_HUB_CREDENTIALS_PATH = '/lan/credentials';
export const LAN_HUB_CREDENTIALS_GITHUB_PATH = '/lan/credentials/github';
export const LAN_HUB_CREDENTIALS_APNS_PATH = '/lan/credentials/apns';

const DIRECTORY_NAME = 'lan-credentials';
const GITHUB_FILE_NAME = 'github.json';
/** Names the copy held, so an unchanged one is not written again. */
export const LAN_CREDENTIALS_REVISION_FILE_NAME = 'revision';
const HUB_ID_PATTERN = /^[a-f0-9]{32}$/;

export function getLanCredentialsRoot(dataDir: string = getLodyDataDir('local')): string {
  return path.join(dataDir, DIRECTORY_NAME);
}

/** Where this machine keeps the copy for the LAN with id `hubId`. */
export function getLanCredentialsDirectory(hubId: string, dataDir?: string): string {
  if (!HUB_ID_PATTERN.test(hubId)) throw new Error('Not a LAN id');
  return path.join(getLanCredentialsRoot(dataDir), hubId);
}

export function isLanCredentialsDirectoryName(name: string): boolean {
  return HUB_ID_PATTERN.test(name);
}

/** The GitHub token in this machine's copy for a LAN; `null` when it holds none. */
export function readLanCredentialsGitHub(
  hubId: string,
  dataDir?: string
): LanGitHubCredential | null {
  let raw: string;
  try {
    raw = fs.readFileSync(
      path.join(getLanCredentialsDirectory(hubId, dataDir), GITHUB_FILE_NAME),
      'utf8'
    );
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LanGitHubCredential>;
    if (typeof parsed.token !== 'string' || !parsed.token) return null;
    return {
      token: parsed.token,
      login: typeof parsed.login === 'string' ? parsed.login : null,
      userId: typeof parsed.userId === 'string' ? parsed.userId : null,
    };
  } catch {
    return null;
  }
}
