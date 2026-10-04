import { describe, expect, it } from 'vitest';
import type { LanUsageRow } from '@lody/shared';
import {
  buildLanUsageCalendar,
  buildLanUsageDay,
  buildLanUsageTimeline,
  type LanUsageMachineReport,
} from '../src/lib/lan-usage';

const HOUR = 3_600_000;
const DAY = 86_400_000;
// Sunday 2026-10-04 10:30 UTC.
const NOW = Date.UTC(2026, 9, 4, 10, 30);
const THIS_HOUR = Date.UTC(2026, 9, 4, 10);
const TODAY = Date.UTC(2026, 9, 4);

function row(
  startMs: number,
  modelId: string,
  tokens: number,
  costUSD = 0,
  spanMs: LanUsageRow['spanMs'] = HOUR
): LanUsageRow {
  return {
    startMs,
    spanMs,
    modelId,
    inputTokens: tokens,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    costUSD,
  };
}

const reports: LanUsageMachineReport[] = [
  {
    machineId: 'devnuc',
    name: 'devnuc',
    rows: [
      row(THIS_HOUR, 'claude-opus', 100, 1),
      row(THIS_HOUR - 2 * HOUR, 'gpt-5.5', 40),
      // Ten days ago, kept as a day.
      row(TODAY - 10 * DAY, 'claude-opus', 1_000, 5, DAY),
    ],
  },
  { machineId: 'mac', name: 'MacBook', rows: [row(THIS_HOUR, 'claude-opus', 60, 0.5)] },
];

describe('LAN usage views', () => {
  it('puts the last 24 hours by the hour, split by model and by machine', () => {
    const timeline = buildLanUsageTimeline('lw_home', 'day', reports, NOW);

    expect(timeline.bucketSizeMs).toBe(HOUR);
    expect(timeline.buckets).toHaveLength(24);
    expect(timeline.endMs).toBe(THIS_HOUR + HOUR);
    expect(timeline.totals).toMatchObject({ tokens: 200, costUSD: 1.5 });
    const last = timeline.buckets.at(-1);
    expect(last?.byModel).toEqual([{ modelId: 'claude-opus', tokens: 160, costUSD: 1.5 }]);
    expect(last?.byUser).toEqual([
      { userId: 'devnuc', tokens: 100, costUSD: 1 },
      { userId: 'mac', tokens: 60, costUSD: 0.5 },
    ]);
    expect(timeline.users).toEqual({ devnuc: { name: 'devnuc' }, mac: { name: 'MacBook' } });
  });

  it('counts a day kept whole in the day ranges and leaves it out of the hourly ones', () => {
    expect(buildLanUsageTimeline('lw_home', 'week', reports, NOW).totals.tokens).toBe(200);
    const month = buildLanUsageTimeline('lw_home', 'month', reports, NOW);
    expect(month.bucketSizeMs).toBe(DAY);
    expect(month.buckets).toHaveLength(30);
    expect(month.totals.tokens).toBe(1_200);

    const total = buildLanUsageTimeline('lw_home', 'total', reports, NOW);
    expect(total.startMs).toBe(TODAY - 10 * DAY);
    expect(total.buckets).toHaveLength(11);
  });

  it('lays out a year by weeks with today in the last one and the rest of it ahead', () => {
    const calendar = buildLanUsageCalendar('lw_home', reports, NOW);

    expect(calendar.days).toHaveLength(371);
    expect(new Date(calendar.startMs).getUTCDay()).toBe(0);
    const today = calendar.days.find((day) => day.dayStartMs === TODAY);
    expect(today).toMatchObject({ tokens: 200, isFuture: false });
    expect(calendar.days.filter((day) => day.isFuture)).toHaveLength(6);
  });

  it('breaks one day down by model and machine', () => {
    const day = buildLanUsageDay('lw_home', TODAY, reports);

    expect(day.totals).toMatchObject({ tokens: 200, inputTokens: 200, costUSD: 1.5 });
    expect(day.byModel.map((item) => item.modelId)).toEqual(['claude-opus', 'gpt-5.5']);
    expect(day.byUser.map((item) => item.userId)).toEqual(['devnuc', 'mac']);
  });
});
