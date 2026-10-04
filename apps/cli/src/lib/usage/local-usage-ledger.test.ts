import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CloudUsageUpdateInput } from '@lody/platform';
import { LAN_USAGE_DAY_MS, LAN_USAGE_HOUR_MS, type MachineId, type SessionId } from '@lody/shared';
import type { Logger } from '@/utils/logger';
import { LocalUsageLedger } from './local-usage-ledger';

const silentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  trace: () => {},
  setLevel: () => {},
  setDebug: () => {},
  child: () => silentLogger(),
  close: async () => {},
});

const WORKSPACE = 'lw_home';
const START = Date.UTC(2026, 9, 4, 10, 15);

function update(
  modelUsage: Record<string, Record<string, number>>,
  overrides: Partial<CloudUsageUpdateInput> = {}
): CloudUsageUpdateInput {
  return {
    workspaceId: WORKSPACE as CloudUsageUpdateInput['workspaceId'],
    sessionId: 'session-1' as SessionId,
    acpSessionId: 'native-1',
    userId: 'user-1',
    machineId: 'machine-1' as MachineId,
    cliType: 'claude',
    update: { sessionId: 'native-1', usage: {}, modelUsage },
    ...overrides,
  };
}

const counters = (input: number, output: number, costUSD?: number) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadInputTokens: 0,
  ...(costUSD === undefined ? {} : { costUSD }),
});

describe('LocalUsageLedger', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  function open(clock: { now: number }) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-usage-ledger-'));
    directories.push(directory);
    const file = path.join(directory, 'usage-ledger.json');
    const make = () => new LocalUsageLedger({ file, logger: silentLogger(), now: () => clock.now });
    return { file, make };
  }

  it('counts what each cumulative reading added, in the hour it arrived', () => {
    const clock = { now: START };
    const ledger = open(clock).make();

    ledger.recordSessionUsageUpdate(update({ 'claude-opus': counters(100, 10, 0.5) }));
    ledger.recordSessionUsageUpdate(update({ 'claude-opus': counters(150, 30, 0.75) }));
    // An agent that started counting again adds nothing until it passes the highest reading.
    ledger.recordSessionUsageUpdate(update({ 'claude-opus': counters(20, 5, 0.1) }));
    clock.now += LAN_USAGE_HOUR_MS;
    ledger.recordSessionUsageUpdate(update({ 'claude-opus': counters(170, 30, 0.8) }));

    const hour = Math.floor(START / LAN_USAGE_HOUR_MS) * LAN_USAGE_HOUR_MS;
    expect(ledger.report(WORKSPACE)).toEqual([
      expect.objectContaining({
        startMs: hour,
        spanMs: LAN_USAGE_HOUR_MS,
        modelId: 'claude-opus',
        inputTokens: 150,
        outputTokens: 30,
        costUSD: 0.75,
      }),
      expect.objectContaining({
        startMs: hour + LAN_USAGE_HOUR_MS,
        inputTokens: 20,
        outputTokens: 0,
      }),
    ]);
    expect(ledger.report(WORKSPACE, hour + LAN_USAGE_HOUR_MS)).toHaveLength(1);
    expect(ledger.report('lw_other')).toEqual([]);
  });

  it('keeps scopes apart and prices a model whose agent reports no cost', () => {
    const ledger = open({ now: START }).make();

    ledger.recordSessionUsageUpdate(
      update({ 'gpt-5.5': counters(1_000_000, 0) }, { cliType: 'codex', acpSessionId: 'turn-a' })
    );
    ledger.recordSessionUsageUpdate(
      update({ 'gpt-5.5': counters(1_000_000, 0) }, { cliType: 'codex', acpSessionId: 'turn-b' })
    );

    const [row] = ledger.report(WORKSPACE);
    expect(row?.inputTokens).toBe(2_000_000);
    expect(row?.costUSD).toBeGreaterThan(0);
  });

  it('counts nothing twice after it starts again, and keeps old hours as days', async () => {
    const clock = { now: START };
    const { make } = open(clock);
    const first = make();
    first.recordSessionUsageUpdate(update({ 'claude-opus': counters(100, 10) }));
    clock.now += LAN_USAGE_HOUR_MS;
    first.recordSessionUsageUpdate(update({ 'claude-opus': counters(300, 10) }));
    await first.flushSessionUsage();

    // The agent service starts again and the same scope reports again.
    const second = make();
    second.recordSessionUsageUpdate(update({ 'claude-opus': counters(300, 10) }));
    expect(second.report(WORKSPACE).reduce((sum, row) => sum + row.inputTokens, 0)).toBe(300);

    clock.now += 10 * LAN_USAGE_DAY_MS;
    await second.flushSessionUsage();
    const day = Math.floor(START / LAN_USAGE_DAY_MS) * LAN_USAGE_DAY_MS;
    expect(make().report(WORKSPACE)).toEqual([
      expect.objectContaining({
        startMs: day,
        spanMs: LAN_USAGE_DAY_MS,
        inputTokens: 300,
        outputTokens: 10,
      }),
    ]);
  });

  it('keeps an unreadable ledger aside instead of writing over it', async () => {
    const clock = { now: START };
    const { file, make } = open(clock);
    fs.writeFileSync(file, '{ not json');

    const ledger = make();
    ledger.recordSessionUsageUpdate(update({ 'claude-opus': counters(5, 5) }));
    await ledger.flushSessionUsage();

    expect(fs.readFileSync(`${file}.unreadable-${START}`, 'utf8')).toBe('{ not json');
    expect(make().report(WORKSPACE)).toHaveLength(1);
  });

  it('keeps imported days before its own counting, replaces them on a new import, and keeps them', async () => {
    const clock = { now: START };
    const { make } = open(clock);
    const ledger = make();
    // This machine started counting itself today.
    ledger.recordSessionUsageUpdate(update({ 'claude-opus': counters(100, 10) }));
    const today = Math.floor(START / LAN_USAGE_DAY_MS) * LAN_USAGE_DAY_MS;
    const day = (offset: number, inputTokens: number) => ({
      startMs: today + offset * LAN_USAGE_DAY_MS,
      spanMs: LAN_USAGE_DAY_MS,
      modelId: 'gpt-5.5',
      inputTokens,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
      costUSD: 1,
    });

    expect(
      ledger.importRows(WORKSPACE, 'vibe', [day(-2, 500), day(-1, 700), day(0, 900)], true)
    ).toEqual({ kept: 2, dropped: 1, cutoffMs: today });
    // A later part of the same import adds; a new import starts again.
    ledger.importRows(WORKSPACE, 'vibe', [day(-1, 1)], false);
    expect(ledger.report(WORKSPACE).map((row) => row.inputTokens)).toEqual([500, 701, 100]);
    ledger.importRows(WORKSPACE, 'vibe', [day(-3, 40)], true);
    await ledger.flushSessionUsage();

    expect(
      make()
        .report(WORKSPACE)
        .map((row) => row.inputTokens)
    ).toEqual([40, 100]);
    expect(make().report('lw_other')).toEqual([]);
  });
});
