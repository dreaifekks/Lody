// The usage of the agents of this machine, kept on its own disk where no
// hosted service counts it. A LAN's members ask each other for it.
import fs from 'node:fs';
import path from 'node:path';
import type { CloudUsagePort, CloudUsageUpdateInput } from '@lody/platform';
import {
  isBuiltinAgentType,
  LAN_USAGE_DAY_MS,
  LAN_USAGE_HOUR_MS,
  LanUsageRowSchema,
  type LanUsageImportResult,
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

const LedgerFileSchema = z.object({
  version: z.literal(1),
  /** The highest cumulative counters each accounting scope reported, per model. */
  scopes: z.record(
    z.string(),
    z.object({ seenAt: z.number(), models: z.record(z.string(), CountersSchema) })
  ),
  workspaces: z.record(z.string(), z.array(z.unknown())),
  /** Rows another tracker counted before this machine did, per workspace and source. */
  imported: z.record(z.string(), z.record(z.string(), z.array(z.unknown()))).optional(),
});
type LedgerFile = z.infer<typeof LedgerFileSchema>;

const COUNTER_KEYS = [
  'inputTokens',
  'outputTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
  'reasoningOutputTokens',
] as const;

const rowKey = (row: Pick<LanUsageRow, 'startMs' | 'modelId'>) => `${row.startMs}|${row.modelId}`;

function emptyRow(startMs: number, spanMs: LanUsageRow['spanMs'], modelId: string): LanUsageRow {
  return {
    startMs,
    spanMs,
    modelId,
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

/**
 * Counts what each accounting scope reported since it last did. Scopes report
 * cumulative counters; a smaller reading, such as an agent that started its
 * count again, adds nothing until it passes the highest one, which is how the
 * hosted service counts too.
 */
export class LocalUsageLedger implements CloudUsagePort {
  private readonly scopes = new Map<string, { seenAt: number; models: Record<string, Counters> }>();
  private readonly workspaces = new Map<string, Map<string, LanUsageRow>>();
  private readonly imported = new Map<string, Map<string, Map<string, LanUsageRow>>>();
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty = false;

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
      const added = emptyRow(startMs, LAN_USAGE_HOUR_MS, modelId);
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
   * What this machine counted for a workspace, and what it imported for the
   * days before, in buckets that end after `sinceMs`.
   */
  report(workspaceId: string, sinceMs = 0): LanUsageRow[] {
    const sources = [
      this.workspaces.get(workspaceId),
      ...(this.imported.get(workspaceId)?.values() ?? []),
    ];
    return sources
      .flatMap((rows) => (rows ? [...rows.values()] : []))
      .filter((row) => row.startMs + row.spanMs > sinceMs)
      .sort((left, right) => left.startMs - right.startMs)
      .map((row) => ({ ...row }));
  }

  /**
   * Keeps rows another tracker counted for this machine, for the whole days
   * before the first one this machine counted itself; later rows would be
   * counted twice. `replace` drops what the source gave before.
   */
  importRows(
    workspaceId: string,
    source: string,
    rows: readonly LanUsageRow[],
    replace: boolean
  ): LanUsageImportResult {
    const cutoffMs = this.ownCountingStart(workspaceId);
    let bySource = this.imported.get(workspaceId);
    if (!bySource) {
      bySource = new Map();
      this.imported.set(workspaceId, bySource);
    }
    const target = (replace ? undefined : bySource.get(source)) ?? new Map<string, LanUsageRow>();
    bySource.set(source, target);
    let kept = 0;
    let dropped = 0;
    for (const row of rows) {
      if (row.startMs + row.spanMs > cutoffMs) {
        dropped += 1;
        continue;
      }
      const existing = target.get(rowKey(row));
      if (existing) addRow(existing, row);
      else target.set(rowKey(row), { ...row });
      kept += 1;
    }
    this.scheduleSave();
    return { kept, dropped, cutoffMs };
  }

  close(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (this.dirty) this.save();
  }

  /** The start of the first day this machine counted usage itself, or of today. */
  private ownCountingStart(workspaceId: string): number {
    let start = Math.floor(this.now() / LAN_USAGE_DAY_MS) * LAN_USAGE_DAY_MS;
    for (const row of this.workspaces.get(workspaceId)?.values() ?? []) {
      start = Math.min(start, Math.floor(row.startMs / LAN_USAGE_DAY_MS) * LAN_USAGE_DAY_MS);
    }
    return start;
  }

  private rowsOf(workspaceId: string): Map<string, LanUsageRow> {
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
    const maps = [
      ...this.workspaces.values(),
      ...[...this.imported.values()].flatMap((bySource) => [...bySource.values()]),
    ];
    for (const rows of maps) {
      for (const [key, row] of [...rows]) {
        if (row.spanMs !== LAN_USAGE_HOUR_MS || row.startMs + row.spanMs > now - HOURLY_FOR_MS) {
          continue;
        }
        rows.delete(key);
        const day = emptyRow(
          Math.floor(row.startMs / LAN_USAGE_DAY_MS) * LAN_USAGE_DAY_MS,
          LAN_USAGE_DAY_MS,
          row.modelId
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
      version: 1,
      scopes: Object.fromEntries(this.scopes),
      workspaces: Object.fromEntries(
        [...this.workspaces].map(([workspaceId, rows]) => [workspaceId, [...rows.values()]])
      ),
      imported: Object.fromEntries(
        [...this.imported].map(([workspaceId, bySource]) => [
          workspaceId,
          Object.fromEntries([...bySource].map(([source, rows]) => [source, [...rows.values()]])),
        ])
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
    const fill = (map: Map<string, LanUsageRow>, rows: readonly unknown[]) => {
      for (const candidate of rows) {
        const row = LanUsageRowSchema.safeParse(candidate);
        if (row.success) map.set(rowKey(row.data), row.data);
      }
    };
    for (const [workspaceId, rows] of Object.entries(parsed.data.workspaces)) {
      fill(this.rowsOf(workspaceId), rows);
    }
    for (const [workspaceId, bySource] of Object.entries(parsed.data.imported ?? {})) {
      const sources = new Map<string, Map<string, LanUsageRow>>();
      for (const [source, rows] of Object.entries(bySource)) {
        const map = new Map<string, LanUsageRow>();
        fill(map, rows);
        sources.set(source, map);
      }
      this.imported.set(workspaceId, sources);
    }
  }
}
