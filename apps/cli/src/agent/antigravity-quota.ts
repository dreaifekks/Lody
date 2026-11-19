import type { LodyRateLimitsCapability, RateLimitsSnapshot } from 'acp-extension-core';
import { z } from 'zod';

export function isAntigravityRegistryAgent(agent: { cliType: string; agentType: string }): boolean {
  return agent.cliType === 'registry' && agent.agentType === 'antigravity-acp';
}

/** agy print mode handles this command without starting a model turn. */
export function parseAntigravityCliQuota(value: unknown): RateLimitsSnapshot {
  const bucket = z.object({
    id: z.string().min(1).max(160),
    window: z.enum(['weekly', '5h']),
    remaining_fraction: z.number().min(0).max(1),
    reset_time: z.iso.datetime({ offset: true }).optional(),
  });
  const result = z
    .object({
      status: z.literal('SUCCESS'),
      num_turns: z.literal(0),
      command: z.object({
        name: z.literal('usage'),
        data: z.object({
          groups: z
            .array(
              z.object({
                name: z.string().min(1).max(160),
                buckets: z.array(bucket).min(1).max(16),
              })
            )
            .min(1)
            .max(32),
        }),
      }),
    })
    .parse(value);
  const windows = result.command.data.groups.flatMap((group) =>
    group.buckets.map((b) => ({
      label: group.name,
      usedPercent: (1 - b.remaining_fraction) * 100,
      windowDurationSeconds: b.window === 'weekly' ? 604_800 : 18_000,
      resetsAtEpochSeconds: b.reset_time ? Date.parse(b.reset_time) / 1000 : null,
    }))
  );
  return {
    rateLimits: [{ limitId: 'antigravity', scope: { providerId: 'antigravity' }, windows }],
  };
}

export function isAntigravityBuiltinAgent(agent: { cliType: string; agentType: string }): boolean {
  return agent.cliType === 'builtin' && agent.agentType === 'antigravity';
}

/** Lody owns these query readers even when the official runtime advertises no Core extension. */
export function getAntigravityQuotaCapability(agent?: {
  cliType: string;
  agentType: string;
}): LodyRateLimitsCapability | undefined {
  return agent && (isAntigravityBuiltinAgent(agent) || isAntigravityRegistryAgent(agent))
    ? { version: 1, query: true }
    : undefined;
}
