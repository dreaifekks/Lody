import { execFile } from 'node:child_process'
import { fetchLanHubGitHubCredential } from '@lody/shared/node/lan-github'
import type { LanHub } from '@lody/shared/node/lan-hub'
import { getUserShellEnvCached } from './shell-env'

/**
 * The github.com token of this machine's own `gh` login. The local desktop has
 * no hosted token broker, so pull request details and actions in the renderer
 * use the login the user already has on the machine showing them.
 */
export type GitHubCliTokenResult =
  | { ok: true; token: string }
  | { ok: false; code: 'gh-missing' | 'not-authed'; message: string }

const GH_TIMEOUT_MS = 5_000

export type RunGhAuthToken = (
  env: NodeJS.ProcessEnv
) => Promise<{ exitCode: number | 'missing'; stdout: string }>

const runGhAuthToken: RunGhAuthToken = async (env) =>
  await new Promise((resolve) => {
    execFile(
      'gh',
      ['auth', 'token', '--hostname', 'github.com'],
      { env, timeout: GH_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (!error) {
          resolve({ exitCode: 0, stdout: String(stdout) })
          return
        }
        const code = (error as NodeJS.ErrnoException).code
        resolve({
          exitCode: code === 'ENOENT' ? 'missing' : typeof code === 'number' ? code : 1,
          stdout: ''
        })
      }
    )
  })

export async function readGitHubCliToken(
  run: RunGhAuthToken = runGhAuthToken
): Promise<GitHubCliTokenResult> {
  const shellEnv = await getUserShellEnvCached()
  const env = shellEnv ? { ...process.env, ...shellEnv } : process.env
  const { exitCode, stdout } = await run(env)
  if (exitCode === 'missing') {
    return {
      ok: false,
      code: 'gh-missing',
      message:
        'GitHub CLI (gh) is not installed on this machine. Install it and run `gh auth login`.'
    }
  }
  const token = stdout.trim()
  if (exitCode !== 0 || !token) {
    return {
      ok: false,
      code: 'not-authed',
      message:
        'GitHub CLI (gh) is not logged in to github.com on this machine. Run `gh auth login`.'
    }
  }
  return { ok: true, token }
}

const LAN_HUB_TIMEOUT_MS = 3_000

/**
 * The token the host of one of this installation's LANs keeps, so a machine
 * without a `gh` login shows pull requests too; the machine's own login when
 * no host keeps one or none answers.
 */
export async function readGitHubToken(
  hubs: readonly Pick<LanHub, 'url' | 'token'>[],
  options: { fetch?: typeof fetch; run?: RunGhAuthToken } = {}
): Promise<GitHubCliTokenResult> {
  for (const hub of hubs) {
    const credential = await fetchLanHubGitHubCredential(hub, {
      fetch: options.fetch,
      timeoutMs: LAN_HUB_TIMEOUT_MS
    }).catch(() => null)
    if (credential) return { ok: true, token: credential.token }
  }
  return await readGitHubCliToken(options.run)
}
