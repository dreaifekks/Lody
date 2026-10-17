import { describe, expect, it } from 'vitest';
import i18next from 'i18next';
import { initI18n } from '../src/i18n';
import { usageAgentBuckets, usageAgentLabel } from '../src/components/settings/usage-agent-label';
import type {
  LanMemberControlRequest,
  LanMemberControlResponse,
  LanUsageAgentRow,
  MachineId,
  WorkspaceId,
} from '@lody/shared';
import {
  askLanMachineUsage,
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
  spanMs: LanUsageAgentRow['spanMs'] = HOUR,
  agent: string | null = 'claude'
): LanUsageAgentRow {
  return {
    startMs,
    spanMs,
    modelId,
    agent,
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
      row(THIS_HOUR - 2 * HOUR, 'gpt-5.5', 40, 0, HOUR, 'codex'),
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
    expect(day.byAgent).toEqual([
      { agentId: 'claude', tokens: 160, costUSD: 1.5 },
      { agentId: 'codex', tokens: 40, costUSD: 0 },
    ]);
  });

  it('splits by agent, with the review Codex reports as a model and rows counted before the agent was kept', () => {
    const mixed: LanUsageMachineReport[] = [
      {
        machineId: 'devnuc',
        name: 'devnuc',
        rows: [
          row(THIS_HOUR, 'gpt-5.5', 50, 0, HOUR, 'codex'),
          row(THIS_HOUR, 'codex-auto-review', 20, 0, HOUR, 'codex'),
          row(THIS_HOUR, 'codex-auto-review', 5, 0, HOUR, null),
          row(THIS_HOUR, 'claude-opus', 30, 0, HOUR, null),
        ],
      },
    ];

    const timeline = buildLanUsageTimeline('lw_home', 'day', mixed, NOW);
    expect(timeline.buckets.at(-1)?.byAgent).toEqual([
      { agentId: 'codex', tokens: 50, costUSD: 0 },
      { agentId: 'unknown', tokens: 30, costUSD: 0 },
      { agentId: 'codex-auto-review', tokens: 25, costUSD: 0 },
    ]);
    // The model split lists the review as Codex reports it.
    expect(timeline.buckets.at(-1)?.byModel.map((item) => item.modelId)).toEqual([
      'gpt-5.5',
      'claude-opus',
      'codex-auto-review',
    ]);
    expect(buildLanUsageDay('lw_home', TODAY, mixed).byAgent?.map((item) => item.agentId)).toEqual([
      'codex',
      'unknown',
      'codex-auto-review',
    ]);
  });
});

describe('naming the agents of the split', () => {
  it('names them in the product language on the chart legend as on the rest of the page', async () => {
    const timeline = buildLanUsageTimeline(
      'lw_home',
      'day',
      [
        {
          machineId: 'devnuc',
          name: 'devnuc',
          rows: [
            row(THIS_HOUR, 'claude-opus', 100, 0, HOUR, 'claude'),
            row(THIS_HOUR, 'codex-auto-review', 20, 0, HOUR, 'codex'),
            row(THIS_HOUR, 'gpt-5.5', 5, 0, HOUR, null),
          ],
        },
      ],
      NOW
    );
    const legend = () =>
      usageAgentBuckets(timeline, (bucket) => bucket.bucketLabel, i18next.t)
        .at(-1)
        ?.values.map((value) => value.label);

    await initI18n('zh_CN');
    expect(legend()).toEqual(['Claude Code', 'Codex 自动评审', '未知']);
    expect(usageAgentLabel('codex-auto-review', i18next.t)).toBe('Codex 自动评审');

    await i18next.changeLanguage('en');
    expect(legend()).toEqual(['Claude Code', 'Codex auto review', 'Unknown']);
  });
});

describe('asking a machine what it counted', () => {
  const target = { machineId: 'mac' as MachineId, workspaceId: 'lw_home' as WorkspaceId };
  const withAgent = row(THIS_HOUR, 'claude-opus', 100, 1);
  const { agent: _agent, ...withoutAgent } = withAgent;

  function member(answers: {
    byAgent?: LanMemberControlResponse | null;
    byModel?: LanMemberControlResponse | null;
  }) {
    const asked: LanMemberControlRequest['type'][] = [];
    const send = async (request: LanMemberControlRequest) => {
      asked.push(request.type);
      if (request.type === 'lan/usage-by-agent') return answers.byAgent ?? null;
      if (request.type === 'lan/usage') return answers.byModel ?? null;
      throw new Error(`unexpected ${request.type}`);
    };
    return { asked, send };
  }

  it('takes the rows with their agents from a machine that keeps them', async () => {
    const { asked, send } = member({
      byAgent: { ok: true, type: 'lan/usage-by-agent', result: { rows: [withAgent] } },
    });
    expect(await askLanMachineUsage(send, target)).toEqual([withAgent]);
    expect(asked).toEqual(['lan/usage-by-agent']);
  });

  it('asks a machine that refuses the request the way its build knows, with the agent unknown', async () => {
    const { asked, send } = member({
      byAgent: {
        ok: false,
        type: 'lan/usage-by-agent',
        error: 'execution_failed',
        message: 'mac could not be reached: The request cannot be read',
      },
      byModel: { ok: true, type: 'lan/usage', result: { rows: [withoutAgent] } },
    });
    expect(await askLanMachineUsage(send, target)).toEqual([{ ...withoutAgent, agent: null }]);
    expect(asked).toEqual(['lan/usage-by-agent', 'lan/usage']);
  });

  it('asks nothing more of a machine that did not answer', async () => {
    const silent = member({});
    expect(await askLanMachineUsage(silent.send, target)).toBeNull();
    expect(silent.asked).toEqual(['lan/usage-by-agent']);

    const refusing = member({
      byAgent: { ok: false, type: 'lan/usage-by-agent', error: 'execution_failed', message: 'no' },
      byModel: { ok: false, type: 'lan/usage', error: 'execution_failed', message: 'no' },
    });
    expect(await askLanMachineUsage(refusing.send, target)).toBeNull();
  });
});
