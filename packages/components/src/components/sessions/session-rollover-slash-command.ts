import type { AcpCommandSummary } from '@lody/shared';

export const ROLLOVER_SLASH_COMMAND_NAME = 'rollover';

export const ROLLOVER_SLASH_COMMAND: AcpCommandSummary = {
  name: ROLLOVER_SLASH_COMMAND_NAME,
  description:
    'Seal the current context and switch to a fresh underlying node on the next message, keeping the handoff card and locked invariants',
};

/**
 * Merges the local `/rollover` command into the ACP `availableCommands` catalog
 * for non-coordinator sessions (keeping native `/compact` untouched).
 */
export function mergeRolloverAvailableCommands(
  commands: readonly AcpCommandSummary[] | undefined,
  options?: { readonly isBoardCoordinator?: boolean; readonly description?: string }
): AcpCommandSummary[] {
  const existing = commands ?? [];
  if (options?.isBoardCoordinator) {
    return [...existing];
  }
  const result: AcpCommandSummary[] = [];
  let hasRollover = false;
  for (const command of existing) {
    if (command.name.trim().toLowerCase() === ROLLOVER_SLASH_COMMAND_NAME) {
      if (hasRollover) continue;
      hasRollover = true;
    }
    result.push(command);
  }
  if (!hasRollover) {
    result.push(
      options?.description
        ? { name: ROLLOVER_SLASH_COMMAND_NAME, description: options.description }
        : ROLLOVER_SLASH_COMMAND
    );
  }
  return result;
}
