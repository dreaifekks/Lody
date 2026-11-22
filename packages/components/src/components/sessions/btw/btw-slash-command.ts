import type { AcpCommandSummary } from '@lody/shared';

export const BTW_SLASH_COMMAND_NAME = 'btw';

export const BTW_SLASH_COMMAND: AcpCommandSummary = {
  name: BTW_SLASH_COMMAND_NAME,
  description: 'Ask a lightweight side question without interrupting the main conversation',
};

const BTW_COMMAND_PATTERN = /^\/btw(?:\s+([\s\S]*))?$/i;

export type ParsedBtwSlashCommand =
  | { readonly matched: false }
  | { readonly matched: true; readonly question: string };

/**
 * Matches `/btw` or `/btw <question>` (case-insensitive). Does not match commands
 * that merely share the prefix (e.g. `/btwx`).
 */
export function parseBtwSlashCommand(text: string): ParsedBtwSlashCommand {
  const match = text.trim().match(BTW_COMMAND_PATTERN);
  if (!match) {
    return { matched: false };
  }
  return {
    matched: true,
    question: (match[1] ?? '').trim(),
  };
}

/**
 * Merges the client-side `/btw` command into the ACP `availableCommands` catalog
 * with case-insensitive deduplication so every provider offers `/btw` completion.
 */
export function mergeBtwAvailableCommands(
  commands: readonly AcpCommandSummary[] | undefined
): AcpCommandSummary[] {
  const existing = commands ?? [];
  const result: AcpCommandSummary[] = [];
  let hasBtw = false;
  for (const command of existing) {
    if (command.name.trim().toLowerCase() === BTW_SLASH_COMMAND_NAME) {
      if (hasBtw) continue;
      hasBtw = true;
    }
    result.push(command);
  }
  if (!hasBtw) {
    result.push(BTW_SLASH_COMMAND);
  }
  return result;
}
