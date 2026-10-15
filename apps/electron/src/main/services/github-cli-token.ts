import { runCommandTextLegacy } from '@lody/shared/node/process'
import { getUserShellEnvCachedLegacy } from './shell-env'

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

const runGhAuthToken: RunGhAuthToken = async (env) => {
  try {
    const result = await runCommandTextLegacy({
      command: 'gh',
      args: ['auth', 'token', '--hostname', 'github.com'],
      env,
      timeout: GH_TIMEOUT_MS,
      check: 'none'
    })
    return { exitCode: result.code ?? 1, stdout: result.stdout }
  } catch (error) {
    return {
      exitCode: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 1,
      stdout: ''
    }
  }
}

export async function readGitHubCliToken(
  run: RunGhAuthToken = runGhAuthToken
): Promise<GitHubCliTokenResult> {
  const shellEnv = await getUserShellEnvCachedLegacy()
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
