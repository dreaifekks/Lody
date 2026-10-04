// Where the desktop takes a GitHub token from. This file stays free of the
// `electron` runtime and of shell probing so it runs under `node --test`.
import { fetchLanHubGitHubCredential, type LanGitHubCredential } from '@lody/shared/node/lan-github'
import type { LanHub } from '@lody/shared/node/lan-hub'
import type { GitHubCliTokenResult } from './github-cli-token'

const LAN_HUB_TIMEOUT_MS = 3_000

/**
 * The token the host of one of this installation's LANs keeps, so a machine
 * without a `gh` login shows pull requests too. While no host answers, the
 * copy of that token this machine's agent service keeps stands in; the
 * machine's own login comes last.
 */
export async function readGitHubToken(
  hubs: readonly Pick<LanHub, 'id' | 'url' | 'token'>[],
  options: {
    /** The machine's own `gh` login, asked last. */
    readGhLogin: () => Promise<GitHubCliTokenResult>
    fetch?: typeof fetch
    /** This machine's copy of what a host holds; `lan-credentials` in `@lody/shared`. */
    readCopy?: (hubId: string) => LanGitHubCredential | null
  }
): Promise<GitHubCliTokenResult> {
  const away: string[] = []
  for (const hub of hubs) {
    const credential = await fetchLanHubGitHubCredential(hub, {
      fetch: options.fetch,
      timeoutMs: LAN_HUB_TIMEOUT_MS
    }).catch(() => {
      away.push(hub.id)
      return null
    })
    if (credential) return { ok: true, token: credential.token }
  }
  // A host that answered it keeps no token has none to stand in for.
  for (const hubId of away) {
    const copy = options.readCopy?.(hubId)
    if (copy) return { ok: true, token: copy.token }
  }
  return await options.readGhLogin()
}
