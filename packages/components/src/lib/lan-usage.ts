// The usage page of an installation without the hosted service: every machine
// of the LAN reports what its own agents used, and the page puts the reports
// together. The hosted page splits usage by member; every member of a LAN is
// one user, so here it is split by machine.
import type { LanUsageRow } from '@lody/shared';
import type {
  SettingsUsageCalendarData,
  SettingsUsageDayData,
  SettingsUsageRange,
  SettingsUsageTimelineData,
} from '@/components/settings/settings-data-cache';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const CALENDAR_DAYS = 371;

export type LanUsageMachineReport = {
  machineId: string;
  name: string;
  rows: readonly LanUsageRow[];
};

const tokensOf = (row: LanUsageRow) =>
  row.inputTokens +
  row.outputTokens +
  row.cacheReadInputTokens +
  row.cacheCreationInputTokens +
  row.reasoningOutputTokens;

const floorTo = (ms: number, size: number) => Math.floor(ms / size) * size;
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function usersOf(reports: readonly LanUsageMachineReport[]) {
  return Object.fromEntries(reports.map((report) => [report.machineId, { name: report.name }]));
}

type Sum = { tokens: number; costUSD: number };

function addTo(map: Map<string, Sum>, key: string, tokens: number, costUSD: number) {
  const sum = map.get(key) ?? { tokens: 0, costUSD: 0 };
  sum.tokens += tokens;
  sum.costUSD += costUSD;
  map.set(key, sum);
}

const listOf = <K extends string>(map: Map<string, Sum>, key: K) =>
  [...map]
    .filter(([, sum]) => sum.tokens > 0 || sum.costUSD > 0)
    .sort((left, right) => right[1].tokens - left[1].tokens)
    .map(([id, sum]) => ({ [key]: id, ...sum }) as { [P in K]: string } & Sum);

/**
 * The window and buckets of a range, in UTC like the hosted page: the last 24
 * hours or 7 days by the hour, the last 30 days by the day, and every day
 * since the first one counted.
 */
function windowOf(
  range: SettingsUsageRange,
  reports: readonly LanUsageMachineReport[],
  now: number
) {
  const hourEnd = floorTo(now, HOUR_MS) + HOUR_MS;
  const dayEnd = floorTo(now, DAY_MS) + DAY_MS;
  if (range === 'day') return { startMs: hourEnd - 24 * HOUR_MS, endMs: hourEnd, size: HOUR_MS };
  if (range === 'week') return { startMs: hourEnd - 168 * HOUR_MS, endMs: hourEnd, size: HOUR_MS };
  if (range === 'month') return { startMs: dayEnd - 30 * DAY_MS, endMs: dayEnd, size: DAY_MS };
  let first = dayEnd - DAY_MS;
  for (const report of reports) {
    for (const row of report.rows) first = Math.min(first, floorTo(row.startMs, DAY_MS));
  }
  return { startMs: first, endMs: dayEnd, size: DAY_MS };
}

export function buildLanUsageTimeline(
  workspaceId: string,
  range: SettingsUsageRange,
  reports: readonly LanUsageMachineReport[],
  now: number
): SettingsUsageTimelineData {
  const { startMs, endMs, size } = windowOf(range, reports, now);
  const count = Math.max(1, Math.round((endMs - startMs) / size));
  const buckets = Array.from({ length: count }, (_, index) => ({
    startMs: startMs + index * size,
    byModel: new Map<string, Sum>(),
    byMachine: new Map<string, Sum>(),
  }));
  const breakdown = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
  };
  let tokens = 0;
  let costUSD = 0;
  for (const report of reports) {
    for (const row of report.rows) {
      // A day the machine keeps whole goes into the bucket it starts in.
      if (row.startMs < startMs || row.startMs >= endMs) continue;
      const bucket = buckets[Math.floor((row.startMs - startMs) / size)];
      if (!bucket) continue;
      const rowTokens = tokensOf(row);
      addTo(bucket.byModel, row.modelId, rowTokens, row.costUSD);
      addTo(bucket.byMachine, report.machineId, rowTokens, row.costUSD);
      tokens += rowTokens;
      costUSD += row.costUSD;
      for (const key of Object.keys(breakdown) as Array<keyof typeof breakdown>) {
        breakdown[key] += row[key];
      }
    }
  }
  return {
    workspaceId,
    range,
    startMs,
    endMs,
    bucketSizeMs: size,
    totals: { tokens, costUSD, breakdown },
    users: usersOf(reports),
    buckets: buckets.map((bucket) => {
      const models = listOf(bucket.byModel, 'modelId');
      const machines = listOf(bucket.byMachine, 'userId');
      return {
        bucketStartMs: bucket.startMs,
        bucketLabel: isoDate(bucket.startMs),
        tokens: models.reduce((sum, item) => sum + item.tokens, 0),
        costUSD: models.reduce((sum, item) => sum + item.costUSD, 0),
        byModel: models,
        byUser: machines,
      };
    }),
  };
}

/** A year of days by week columns, Sunday first, ending with this week. */
export function buildLanUsageCalendar(
  workspaceId: string,
  reports: readonly LanUsageMachineReport[],
  now: number
): SettingsUsageCalendarData {
  const today = floorTo(now, DAY_MS);
  const weekday = new Date(today).getUTCDay();
  const startMs = today - weekday * DAY_MS - (CALENDAR_DAYS - 7) * DAY_MS;
  const sums = new Map<number, Sum>();
  for (const report of reports) {
    for (const row of report.rows) {
      const day = floorTo(row.startMs, DAY_MS);
      const sum = sums.get(day) ?? { tokens: 0, costUSD: 0 };
      sum.tokens += tokensOf(row);
      sum.costUSD += row.costUSD;
      sums.set(day, sum);
    }
  }
  return {
    workspaceId,
    timezone: 'UTC',
    startMs,
    endMs: startMs + (CALENDAR_DAYS - 1) * DAY_MS,
    days: Array.from({ length: CALENDAR_DAYS }, (_, index) => {
      const dayStartMs = startMs + index * DAY_MS;
      const sum = sums.get(dayStartMs);
      return {
        dayStartMs,
        date: isoDate(dayStartMs),
        tokens: sum?.tokens ?? 0,
        costUSD: sum?.costUSD ?? 0,
        isFuture: dayStartMs > today,
      };
    }),
  };
}

export function buildLanUsageDay(
  workspaceId: string,
  dayStartMs: number,
  reports: readonly LanUsageMachineReport[]
): SettingsUsageDayData {
  const byModel = new Map<string, Sum>();
  const byMachine = new Map<string, Sum>();
  const totals = {
    tokens: 0,
    costUSD: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    webSearchRequests: 0,
  };
  for (const report of reports) {
    for (const row of report.rows) {
      if (floorTo(row.startMs, DAY_MS) !== dayStartMs) continue;
      const rowTokens = tokensOf(row);
      addTo(byModel, row.modelId, rowTokens, row.costUSD);
      addTo(byMachine, report.machineId, rowTokens, row.costUSD);
      totals.tokens += rowTokens;
      totals.costUSD += row.costUSD;
      totals.inputTokens += row.inputTokens;
      totals.outputTokens += row.outputTokens;
      totals.cacheReadInputTokens += row.cacheReadInputTokens;
      totals.cacheCreationInputTokens += row.cacheCreationInputTokens;
      totals.reasoningOutputTokens += row.reasoningOutputTokens;
    }
  }
  return {
    workspaceId,
    dayStartMs,
    date: isoDate(dayStartMs),
    totals,
    byModel: listOf(byModel, 'modelId'),
    byUser: listOf(byMachine, 'userId'),
    users: usersOf(reports),
  };
}
