import { runCommandTextLegacy } from '@lody/shared/node/process';
import { resolveSessionAcpTargetId, type AgentConfigMeta, type SessionMeta } from '@lody/shared';
import { toShared } from '@/platform/process-options';
import { codexProfileEnvironment } from './codex-profile-runtime';
import { getCodexProfileStore } from './codex-profile-store';
import { getLoginShellEnvLegacy } from './login-shell-env';
import { mergeLoginShellEnv, resolveBuiltinCodexExecutable } from './setting';

const CODEX_ARCHIVE_TIMEOUT_MS = 60_000;

/** The Codex thread a builtin Codex Session continues; other agents have none. */
export function getSessionCodexThreadId(meta: SessionMeta): string | undefined {
  if (meta.cliType !== 'builtin' || meta.agentType !== 'codex') return undefined;
  return resolveSessionAcpTargetId(meta);
}

/**
 * Mirrors a Lody archive or restore onto the thread in Codex's own store with
 * the official `codex archive|unarchive <id>` commands, run with the binary and
 * Codex home of the Session's Provider (`null` for a Session without one).
 * Codex refuses to resume an archived thread, so a restored Session needs its
 * thread unarchived before the next turn.
 */
export async function setCodexThreadArchived(input: {
  workspaceId: string;
  provider: AgentConfigMeta | null;
  threadId: string;
  archived: boolean;
}): Promise<void> {
  const { provider } = input;
  const command = await resolveBuiltinCodexExecutable({
    runtimeOverrides: provider?.runtimeOverrides,
  });
  const env = mergeLoginShellEnv(
    { ...process.env, ...provider?.env },
    await getLoginShellEnvLegacy()
  );
  const profile = provider?.codexAuth
    ? await getCodexProfileStore().resolve(input.workspaceId, provider)
    : undefined;
  await runCommandTextLegacy(
    {
      command,
      args: [input.archived ? 'archive' : 'unarchive', input.threadId],
      env: profile ? codexProfileEnvironment(profile, env) : env,
      timeout: CODEX_ARCHIVE_TIMEOUT_MS,
      check: 'exit-0',
    },
    toShared()
  );
}
