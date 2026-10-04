// Usage that Vibe Usage (vibecafe.ai) counted before the machines of a LAN
// kept their own: read from the account the local vibe-usage tracker is linked
// to, and handed to each machine as rows of its ledger.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LAN_USAGE_DAY_MS, type LanMachine, type LanUsageRow } from '@lody/shared';
import { z } from 'zod';

export const VIBE_USAGE_SOURCE = 'vibe';

const VibeConfigSchema = z.object({
  apiKey: z.string().min(1),
  apiUrl: z.string().url().optional(),
  hostname: z.string().optional(),
});
export type VibeConfig = z.infer<typeof VibeConfigSchema>;

export function defaultVibeConfigPath(): string {
  return path.join(os.homedir(), '.vibe-usage', 'config.json');
}

/** The tracker's own configuration; its key is sent only to its own origin. */
export function readVibeConfig(file = defaultVibeConfigPath()): VibeConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new Error(
      `No Vibe Usage configuration at ${file}; run \`npx @vibe-cafe/vibe-usage init\``
    );
  }
  const parsed = VibeConfigSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`${file} names no Vibe Usage key`);
  return parsed.data;
}

const Count = z.number().nonnegative().finite().catch(0);

/**
 * One bucket the service answers with. Its counters do not overlap: input
 * leaves out cache reads, output leaves out reasoning, as Lody's do.
 */
const VibeBucketSchema = z.looseObject({
  model: z.string().min(1),
  hostname: z.string().min(1),
  bucketStart: z.string().min(1),
  inputTokens: Count,
  outputTokens: Count,
  cachedInputTokens: Count,
  reasoningOutputTokens: Count,
  cacheCreation5mTokens: Count,
  cacheCreation1hTokens: Count,
  estimatedCost: Count,
});
type VibeBucket = z.infer<typeof VibeBucketSchema>;

const VibeUsageSchema = z.looseObject({ buckets: z.array(z.unknown()) });

export async function fetchVibeBuckets(
  config: VibeConfig,
  days: number,
  fetchImpl: typeof fetch = fetch
): Promise<VibeBucket[]> {
  const url = new URL('/api/usage', config.apiUrl ?? 'https://vibecafe.ai');
  url.searchParams.set('days', String(days));
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${config.apiKey}` },
    signal: AbortSignal.timeout(120_000),
  });
  if (response.status === 401) throw new Error('Vibe Usage refused its key; link it again');
  if (!response.ok) throw new Error(`Vibe Usage answered ${response.status}`);
  const body = VibeUsageSchema.parse(await response.json());
  return body.buckets.flatMap((bucket) => {
    const parsed = VibeBucketSchema.safeParse(bucket);
    return parsed.success ? [parsed.data] : [];
  });
}

/** The service's buckets as day rows of the ledger, by the host that counted them. */
export function vibeBucketsToRows(buckets: readonly VibeBucket[]): Map<string, LanUsageRow[]> {
  const byHost = new Map<string, Map<string, LanUsageRow>>();
  for (const bucket of buckets) {
    const at = Date.parse(bucket.bucketStart);
    if (!Number.isFinite(at) || at < 0) continue;
    const startMs = Math.floor(at / LAN_USAGE_DAY_MS) * LAN_USAGE_DAY_MS;
    const rows = byHost.get(bucket.hostname) ?? new Map<string, LanUsageRow>();
    byHost.set(bucket.hostname, rows);
    const key = `${startMs}|${bucket.model}`;
    const row = rows.get(key) ?? {
      startMs,
      spanMs: LAN_USAGE_DAY_MS,
      modelId: bucket.model.slice(0, 256),
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
      costUSD: 0,
    };
    row.inputTokens += bucket.inputTokens;
    row.outputTokens += bucket.outputTokens;
    row.cacheReadInputTokens += bucket.cachedInputTokens;
    row.cacheCreationInputTokens += bucket.cacheCreation5mTokens + bucket.cacheCreation1hTokens;
    row.reasoningOutputTokens += bucket.reasoningOutputTokens;
    row.costUSD += bucket.estimatedCost;
    rows.set(key, row);
  }
  return new Map(
    [...byHost].map(([host, rows]) => [
      host,
      [...rows.values()].sort((left, right) => left.startMs - right.startMs),
    ])
  );
}

export const bareHost = (name: string) => name.trim().toLowerCase().split('.')[0] ?? '';

/**
 * The machine a host name of the service stands for: one named by `--map`,
 * else the one whose name or short name is the host name, with or without
 * the domain of a network and in any case. `null` when none or several are.
 */
export function matchVibeHost(
  hostname: string,
  machines: readonly LanMachine[],
  mapped: ReadonlyMap<string, string>
): LanMachine | null {
  // `--map` keys are host names as `bareHost` writes them.
  const wanted = mapped.get(bareHost(hostname));
  const target = bareHost(wanted ?? hostname);
  const matches = machines.filter(
    (machine) =>
      machine.machineId === wanted ||
      bareHost(machine.name) === target ||
      (machine.alias ? bareHost(machine.alias) === target : false)
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

export function chunkRows<T>(rows: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}
