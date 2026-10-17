// The usage of the agents of this machine, kept on its own disk where no
// hosted service counts it. A LAN's members ask each other for it.
import fs from 'node:fs';
import path from 'node:path';
import type { CloudUsagePort, CloudUsageUpdateInput } from '@lody/platform';
import {
  isBuiltinAgentType,
  LAN_USAGE_DAY_MS,
  LAN_USAGE_HOUR_MS,
  LanUsageAgentRowSchema,
  LanUsageRowSchema,
  type LanUsageAgentRow,
  type LanUsageRow,
} from '@lody/shared';
import type { SessionUsageUpdate } from 'acp-extension-core';
import { z } from 'zod';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import { cloneUsageUpdate, priceSessionUsageUpdate } from './price';

/** Hours older than this are kept as days. */
const HOURLY_FOR_MS = 8 * LAN_USAGE_DAY_MS;
/**
 * An accounting scope not heard of for this long reports nothing new: most
 * scopes last one turn, and an agent process idle this long has been stopped.
 */
const SCOPE_KEPT_MS = 7 * LAN_USAGE_DAY_MS;
const SAVE_DELAY_MS = 5_000;

const CountSchema = z.number().nonnegative().finite();
const CountersSchema = z.object({
  inputTokens: CountSchema,
  outputTokens: CountSchema,
  cacheReadInputTokens: CountSchema,
  cacheCreationInputTokens: CountSchema.optional(),
  reasoningOutputTokens: CountSchema.optional(),
  costUSD: CountSchema.optional(),
});
type Counters = z.infer<typeof CountersSchema>;

const UsageUpdateSchema = z.object({
  modelUsage: z.record(z.string().min(1), CountersSchema.passthrough()).optional(),
});

/** The highest cumulative counters each accounting scope reported, per model. */
const ScopesSchema = z.record(
  z.string(),
  z.object({ seenAt: z.number(), models: z.record(z.string(), CountersSchema) })
);
/**
 * Version 1 filed rows by hour and model; version 2 adds the agent that used
 * the model, which rows from before it do not have.
 */
const LedgerFileSchema = z.discriminatedUnion('version', [
  z.object({
    version: z.literal(1),
    scopes: ScopesSchema,
    workspaces: z.record(z.string(), z.array(z.unknown())),
  }),
  z.object({
    version: z.literal(2),
    scopes: ScopesSchema,
    workspaces: z.record(z.string(), z.array(z.unknown())),
  }),
]);
type LedgerFile = z.infer<typeof LedgerFileSchema>;

const COUNTER_KEYS = [
  'inputTokens',
  'outputTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
  'reasoningOutputTokens',
] as const;

const rowKey = (row: Pick<LanUsageAgentRow, 'startMs' | 'modelId' | 'agent'>) =>
  `${row.startMs}|${row.modelId}|${row.agent ?? ''}`;

function emptyRow(
  startMs: number,
  spanMs: LanUsageRow['spanMs'],
  modelId: string,
  agent: string | null
): LanUsageAgentRow {
  return {
    startMs,
    spanMs,
    modelId,
    agent,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    costUSD: 0,
  };
}

function addRow(target: LanUsageRow, source: LanUsageRow): void {
  for (const key of COUNTER_KEYS) target[key] += source[key];
  target.costUSD += source.costUSD;
}

/** The row as builds before the agent was kept read it. */
function withoutAgent({ agent: _agent, ...row }: LanUsageAgentRow): LanUsageRow {
  return row;
}

/**
 * Counts what each accounting scope reported since it last did. Scopes report
 * cumulative counters; a smaller reading, such as an agent that started its
 * count again, adds nothing until it passes the highest one, which is how the
 * hosted service counts too.
 */
export class LocalUsageLedger implements CloudUsagePort {
  private readonly scopes = new Map<string, { seenAt: number; models: Record<string, Counters> }>();
  private readonly workspaces = new Map<string, Map<string, LanUsageAgentRow>>();
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  private closed = false;

  constructor(
    private readonly options: {
      file: string;
      logger: Logger;
      now?: () => number;
    }
  ) {
    this.load();
  }

  recordSessionUsageUpdate(input: CloudUsageUpdateInput): void {
    const parsed = UsageUpdateSchema.safeParse(input.update);
    if (!parsed.success || !parsed.data.modelUsage) return;
    if (!isBuiltinAgentType(input.cliType)) return;
    const priced = priceSessionUsageUpdate(
      cloneUsageUpdate(input.update as SessionUsageUpdate),
      input.cliType
    );
    const now = this.now();
    const key = `${input.workspaceId}:${input.sessionId}:${input.acpSessionId}:${input.userId}`;
    const scope = this.scopes.get(key) ?? { seenAt: now, models: {} };
    const startMs = Math.floor(now / LAN_USAGE_HOUR_MS) * LAN_USAGE_HOUR_MS;
    const rows = this.rowsOf(input.workspaceId);

    for (const [modelId, reported] of Object.entries(priced.modelUsage ?? {})) {
      const current = CountersSchema.safeParse(reported);
      if (!current.success) continue;
      const before = scope.models[modelId];
      const added = emptyRow(startMs, LAN_USAGE_HOUR_MS, modelId, input.cliType);
      const highest: Counters = { ...current.data };
      let grew = false;
      for (const counter of COUNTER_KEYS) {
        const was = before?.[counter] ?? 0;
        const is = current.data[counter] ?? 0;
        if (is > was) {
          added[counter] = is - was;
          grew = true;
        }
        highest[counter] = Math.max(was, is);
      }
      const costWas = before?.costUSD ?? 0;
      const costIs = current.data.costUSD;
      if (costIs !== undefined && costIs > costWas) {
        added.costUSD = costIs - costWas;
        grew = true;
      }
      highest.costUSD =
        costIs === undefined && before?.costUSD === undefined
          ? undefined
          : Math.max(costWas, costIs ?? 0);
      scope.models[modelId] = highest;
      if (!grew) continue;
      const existing = rows.get(rowKey(added));
      if (existing) addRow(existing, added);
      else rows.set(rowKey(added), added);
    }
    scope.seenAt = now;
    this.scopes.set(key, scope);
    this.scheduleSave();
  }

  async flushSessionUsage(): Promise<void> {
    this.save();
  }

  /**
   * What this machine counted for a workspace, in buckets that end after
   * `sinceMs`, with the agent that used each model.
   */
  reportByAgent(workspaceId: string, sinceMs = 0): LanUsageAgentRow[] {
    const rows = this.workspaces.get(workspaceId);
    if (!rows) return [];
    return [...rows.values()]
      .filter((row) => row.startMs + row.spanMs > sinceMs)
      .sort((left, right) => left.startMs - right.startMs)
      .map((row) => ({ ...row }));
  }

  /**
   * The same by model alone, one row per bucket and model as builds before
   * the agent was kept expect it.
   */
  report(workspaceId: string, sinceMs = 0): LanUsageRow[] {
    const merged = new Map<string, LanUsageRow>();
    for (const row of this.reportByAgent(workspaceId, sinceMs)) {
      const key = `${row.startMs}|${row.modelId}`;
      const existing = merged.get(key);
      if (existing) addRow(existing, row);
      else merged.set(key, withoutAgent(row));
    }
    return [...merged.values()];
  }

  /**
   * Saves what is pending. What sessions still report while they shut down
   * is saved at once, as no timer is left to outlive the process.
   */
  close(): void {
    this.closed = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (this.dirty) this.save();
  }

  private rowsOf(workspaceId: string): Map<string, LanUsageAgentRow> {
    let rows = this.workspaces.get(workspaceId);
    if (!rows) {
      rows = new Map();
      this.workspaces.set(workspaceId, rows);
    }
    return rows;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.closed) {
      this.save();
      return;
    }
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, SAVE_DELAY_MS);
    this.saveTimer.unref?.();
  }

  /** Folds old hours into days and forgets scopes nobody reports any more. */
  private compact(): void {
    const now = this.now();
    for (const rows of this.workspaces.values()) {
      for (const [key, row] of [...rows]) {
        if (row.spanMs !== LAN_USAGE_HOUR_MS || row.startMs + row.spanMs > now - HOURLY_FOR_MS) {
          continue;
        }
        rows.delete(key);
        const day = emptyRow(
          Math.floor(row.startMs / LAN_USAGE_DAY_MS) * LAN_USAGE_DAY_MS,
          LAN_USAGE_DAY_MS,
          row.modelId,
          row.agent
        );
        const existing = rows.get(rowKey(day));
        if (existing) addRow(existing, row);
        else {
          addRow(day, row);
          rows.set(rowKey(day), day);
        }
      }
    }
    for (const [key, scope] of [...this.scopes]) {
      if (scope.seenAt < now - SCOPE_KEPT_MS) this.scopes.delete(key);
    }
  }

  private save(): void {
    this.compact();
    const file: LedgerFile = {
      version: 2,
      scopes: Object.fromEntries(this.scopes),
      workspaces: Object.fromEntries(
        [...this.workspaces].map(([workspaceId, rows]) => [workspaceId, [...rows.values()]])
      ),
    };
    try {
      fs.mkdirSync(path.dirname(this.options.file), { recursive: true });
      const temporary = `${this.options.file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(file), { mode: 0o600 });
      fs.renameSync(temporary, this.options.file);
      this.dirty = false;
    } catch (error) {
      this.options.logger.debug(
        `[usage] Could not save the usage ledger: ${formatErrorMessage(error)}`
      );
    }
  }

  private load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.options.file, 'utf8');
    } catch {
      return;
    }
    const parsed = (() => {
      try {
        return LedgerFileSchema.safeParse(JSON.parse(raw));
      } catch {
        return null;
      }
    })();
    if (!parsed?.success) {
      // Kept aside rather than overwritten: it is the only copy of what was counted.
      const aside = `${this.options.file}.unreadable-${this.now()}`;
      this.options.logger.warn(`[usage] The usage ledger cannot be read; kept it as ${aside}`);
      try {
        fs.renameSync(this.options.file, aside);
      } catch {
        // Nothing more to do: counting starts again.
      }
      return;
    }
    for (const [key, scope] of Object.entries(parsed.data.scopes)) this.scopes.set(key, scope);
    for (const [workspaceId, rows] of Object.entries(parsed.data.workspaces)) {
      const map = this.rowsOf(workspaceId);
      for (const candidate of rows) {
        // A version-1 row was counted before the agent was kept: it stays unknown.
        const row =
          parsed.data.version === 1
            ? LanUsageRowSchema.transform((legacy) => ({ ...legacy, agent: null })).safeParse(
                candidate
              )
            : LanUsageAgentRowSchema.safeParse(candidate);
        if (row.success) map.set(rowKey(row.data), row.data);
      }
    }
  }
}
