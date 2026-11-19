import {
  getSessionRoomId,
  ScheduleRepository,
  sessionDocSchema,
  type ScheduleDefinition,
  type ScheduleRepositoryPort,
  type SessionHistoryInput,
} from '@lody/shared';
import { LoroDoc } from 'loro-crdt';
import { Mirror } from 'loro-mirror';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v5 as uuidv5 } from 'uuid';
import { withHistoryPort } from '../../../tests/history-port-fixture';
import {
  commitPreparedSessionDispatch,
  isPreparedSessionDispatched,
  materializePreparedSessionInput,
  type PreparedSessionInput,
} from '../prepared-session-input';
import {
  buildScheduleRunTarget,
  buildScheduleSessionCreateOptions,
  resolveScheduleMcpSelection,
  scheduleRequiredLocalProjectId,
} from './schedule-run-preparation';
import { type ScheduleRun } from './schedule-store';
import { isScheduledMessageFile } from './scheduled-message-files';

import { findNextDispatchableUserTurn } from '@/session/session-dispatch-logic';
import {
  buildScheduleRegistryRow,
  ScheduleDefinitionSchema,
  scheduleOwnSessionId,
  zonedLocalInputToInstant,
  type ScheduleDocument,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoroDocumentManager } from '../loro/doc';
import {
  ScheduleConfigurationError,
  ScheduleEngine,
  type ScheduleEnginePorts,
} from './schedule-engine';
import {
  resolveScheduleDestinationSession,
  type DestinationSessionState,
} from './schedule-run-preparation';
import { ScheduleStore } from './schedule-store';
import { isScheduleRunFinished } from './schedule-workspace';

const document = (): ScheduleDocument => ({
  definition: ScheduleDefinitionSchema.parse({
    scheduleId: 'schedule',
    title: 'Nightly',
    ownerId: 'owner',
    machineId: 'machine',
    enabled: true,
    activationId: 'activation',
    activeFrom: 0,
    trigger: { kind: 'interval', everyMs: 60_000, anchorAt: '1970-01-01T00:00:00Z' },
    misfirePolicy: { kind: 'run_once' },
    overlapPolicy: 'queue_one',
    agent: { agentConfigId: 'agent', modeId: 'safe' },
    project: { kind: 'github', repoFullName: 'loro-dev/lody', branch: 'main' },
    retryPolicy: { dispatchMaxAttempts: 5, dispatchMaxAgeMs: 86_400_000 },
    createdAt: 0,
    updatedAt: 0,
    createdBy: 'owner',
  }),
  prompt: 'original',
  timeline: [],
});
const stores: ScheduleStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function harness(d = document()) {
  const store = new ScheduleStore<{ prompt: string }>(':memory:');
  stores.push(store);
  let row = buildScheduleRegistryRow(d);
  let now = 60_000;
  let ready = true;
  let disabled = false;
  let accepted = false;
  let finished = false;
  const ports: ScheduleEnginePorts<{ prompt: string }> = {
    workspaceId: 'workspace',
    machineId: 'machine',
    userId: 'owner',
    store,
    now: () => now,
    ready: () => ready,
    disabled: () => disabled,
    list: async () => [row],
    read: async () => d,
    validateTarget: async () => {},
    prepare: vi.fn(async (run) => ({ prompt: run.prompt, sessionId: run.sessionId })),
    materialize: vi.fn(async () => {}),
    isDispatched: async () => accepted,
    dispatch: vi.fn(async () => {
      accepted = true;
    }),
    isFinished: async () => finished,
    publish: vi.fn(async () => {}),
    onError: vi.fn(),
  };
  const engine = new ScheduleEngine(ports);
  return {
    store,
    d,
    ports,
    engine,
    time: (n: number) => {
      now = n;
    },
    ready: (v: boolean) => {
      ready = v;
    },
    disabled: (v: boolean) => {
      disabled = v;
    },
    finished: () => {
      finished = true;
    },
    accepted: () => {
      accepted = true;
    },
    pause: () => {
      d.definition.enabled = false;
      d.definition.activationId = `${d.definition.activationId}-paused`;
      row = buildScheduleRegistryRow(d);
    },
  };
}

describe('Schedule worker handoff', () => {
  it('dispatches a machine-clock Once slot at its saved instant, retaining the ledger on restart', async () => {
    const instant = zonedLocalInputToInstant('2026-10-01T02:21', 'America/Los_Angeles');
    expect(instant).toBe(Date.parse('2026-10-01T09:21:00Z'));
    const d = document();
    d.definition.trigger = { kind: 'once', at: '2026-10-01T09:21:00.000Z' };
    d.definition.activeFrom = Date.parse('2026-10-01T00:00:00Z');
    const h = harness(d);
    h.time(Date.parse('2026-10-01T09:20:59Z'));
    await h.engine.evaluate();
    expect(h.store.history('workspace', 'schedule')).toEqual([]);
    h.time(Date.parse('2026-10-01T09:21:00Z'));
    await h.engine.evaluate();
    expect(h.store.history('workspace', 'schedule')).toMatchObject([
      { scheduledFor: instant, state: 'dispatched' },
    ]);
    h.time(Date.parse('2026-10-01T09:22:00Z'));
    const restarted = new ScheduleEngine(h.ports);
    await restarted.evaluate();
    expect(h.store.history('workspace', 'schedule')).toHaveLength(1);
    expect(h.store.history('workspace', 'schedule')[0]?.scheduledFor).toBe(instant);
  });
  it('never materializes before initial/reconnect sync and never dispatches twice', async () => {
    const h = harness();
    h.ready(false);
    await h.engine.evaluate();
    expect(h.ports.prepare).not.toHaveBeenCalled();
    h.ready(true);
    await h.engine.evaluate();
    await h.engine.evaluate();
    expect(h.ports.dispatch).toHaveBeenCalledTimes(1);
    expect(h.store.unfinished('workspace')[0]?.state).toBe('dispatched');
    h.pause();
    h.disabled(true);
    h.finished();
    await h.engine.evaluate();
    expect(h.store.unfinished('workspace')).toEqual([]);
  });
  it('keeps prepared history inert if paused before the pointer handoff', async () => {
    const h = harness();
    h.ports.materialize = vi.fn(async () => {
      h.pause();
    });
    await h.engine.evaluate();
    expect(h.ports.dispatch).not.toHaveBeenCalled();
    expect(h.store.history('workspace', 'schedule')[0]?.state).toBe('skipped');
    const turn = {
      id: 'turn',
      role: 'user' as const,
      status: 'prepared' as const,
      read: true,
      timestamp: '',
      fileDiff: [],
    };
    expect(findNextDispatchableUserTurn([turn], {} as never)).toBeNull();
    expect(findNextDispatchableUserTurn([turn], { latestUserMsgId: 'turn' } as never)?.id).toBe(
      'turn'
    );
  });
  it('revokes a queued manual run when paused before handoff', async () => {
    const h = harness();
    h.d.definition.trigger = { kind: 'manual' };
    const row = buildScheduleRegistryRow(h.d);
    h.store.planManual('workspace', h.d, row.definitionFingerprint, 'manual', 1);
    h.pause();
    await h.engine.evaluate();
    expect(h.store.history('workspace', 'schedule')).toMatchObject([
      { manual: true, state: 'skipped', errorCode: 'ACTIVATION_REVOKED' },
    ]);
    expect(h.store.unfinished('workspace')).toEqual([]);
  });
  it('dispatches a new manual run while automatic scheduling stays paused', async () => {
    const h = harness();
    h.pause();
    await h.engine.evaluate();
    expect(h.store.history('workspace', 'schedule')).toEqual([]);
    const row = buildScheduleRegistryRow(h.d);
    h.store.planManual('workspace', h.d, row.definitionFingerprint, 'after-pause', 1);
    await h.engine.evaluate();
    await h.engine.evaluate();
    expect(h.store.history('workspace', 'schedule')).toMatchObject([
      { manual: true, activationId: h.d.definition.activationId, state: 'dispatched' },
    ]);
    expect(h.d.definition.enabled).toBe(false);
  });
  it('retains prepared input when scheduling is disabled', async () => {
    const h = harness();
    h.ports.materialize = async () => {
      h.ready(false);
    };
    await h.engine.evaluate();
    h.ready(true);
    h.disabled(true);
    await h.engine.evaluate();
    expect(h.store.unfinished('workspace')[0]).toMatchObject({
      state: 'session_prepared',
      prepared: { prompt: 'original' },
    });
    expect(h.ports.dispatch).not.toHaveBeenCalled();
    expect(h.ports.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ blockedCode: 'SCHEDULES_DISABLED' })
    );
  });

  it('caches future definitions and dispatches each interval slot once while earlier runs are unfinished', async () => {
    const h = harness();
    // Carry the real ledger identity through the handoff, so a second dispatch
    // of the same slot cannot hide behind an unchanged ledger or prompt.
    const sent: string[] = [];
    h.ports.prepare = async (run) => ({ prompt: run.runKey, sessionId: run.sessionId });
    h.ports.dispatch = async ({ prompt }) => {
      sent.push(prompt);
    };
    h.ports.isDispatched = async ({ prompt }) => sent.includes(prompt);
    h.time(1);
    h.ports.read = vi.fn(async () => h.d);
    await h.engine.evaluate();
    // activeFrom and the interval anchor are both zero: this catches up slot 0.
    const first = h.store.history('workspace', 'schedule')[0]!;
    expect(first).toMatchObject({ scheduledFor: 0, state: 'dispatched', attempts: 1 });
    expect(sent).toEqual([first.runKey]);
    h.ports.read = vi.fn(async () => h.d);
    h.time(15_000);
    await h.engine.evaluate();
    expect(h.ports.read).not.toHaveBeenCalled();
    expect(sent).toEqual([first.runKey]);
    h.time(60_000);
    await h.engine.evaluate();
    const second = h.store.history('workspace', 'schedule')[0]!;
    expect(second).toMatchObject({ scheduledFor: 60_000, state: 'dispatched', attempts: 1 });
    expect(second.runKey).not.toBe(first.runKey);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.userTurnId).not.toBe(first.userTurnId);
    expect(h.store.unfinished('workspace')).toHaveLength(2);
    expect(sent).toEqual([first.runKey, second.runKey]);

    await Promise.all([h.engine.evaluate(), h.engine.evaluate()]);
    await h.engine.stop();
    const restarted = new ScheduleEngine(h.ports);
    await restarted.evaluate();
    await restarted.evaluate();
    expect(sent).toEqual([first.runKey, second.runKey]);
    expect(h.store.history('workspace', 'schedule')).toEqual([second, first]);
    await restarted.stop();
  });
  it('waits for target permission recovery without spending attempts or losing the slot', async () => {
    const h = harness();
    h.ports.validateTarget = async () => {
      throw new ScheduleConfigurationError('PROJECT_UNAVAILABLE');
    };
    await h.engine.evaluate();
    await h.engine.evaluate();
    expect(h.ports.dispatch).not.toHaveBeenCalled();
    expect(h.store.unfinished('workspace')[0]).toMatchObject({
      state: 'retry_wait',
      attempts: 0,
      errorCode: 'PROJECT_UNAVAILABLE',
    });
    expect(h.ports.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ queueState: 'blocked', blockedCode: 'PROJECT_UNAVAILABLE' })
    );
    h.ports.validateTarget = async () => {};
    h.time(90_000);
    await h.engine.evaluate();
    expect(h.ports.dispatch).toHaveBeenCalledTimes(1);
    expect(h.store.unfinished('workspace')[0]?.scheduledFor).toBe(60_000);
  });
  it('blocks a run whose Role cannot be resolved, freezing nothing, then prepares it afresh', async () => {
    const h = harness();
    h.ports.prepare = vi
      .fn()
      .mockRejectedValueOnce(new ScheduleConfigurationError('ROLE_NOT_FOUND'))
      .mockImplementation(async (run) => ({
        prompt: 'as the Role says now',
        sessionId: run.sessionId,
      }));
    await h.engine.evaluate();
    const blocked = h.store.unfinished('workspace')[0]!;
    expect(blocked).toMatchObject({
      state: 'retry_wait',
      attempts: 0,
      errorCode: 'ROLE_NOT_FOUND',
    });
    // Nothing was frozen from the Agent saved beside the reference, and no Session exists.
    expect(blocked.prepared).toBeUndefined();
    expect(h.ports.materialize).not.toHaveBeenCalled();
    expect(h.ports.dispatch).not.toHaveBeenCalled();
    expect(h.ports.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ queueState: 'blocked', blockedCode: 'ROLE_NOT_FOUND' })
    );
    h.time(90_000);
    await h.engine.evaluate();
    expect(h.store.get(blocked.runKey)).toMatchObject({
      state: 'dispatched',
      prepared: { prompt: 'as the Role says now', sessionId: blocked.sessionId },
    });
  });
  it('defers one run until the agent quota resets and skips the rest of the outage', async () => {
    const h = harness();
    let resetAt: number | undefined = 200_000;
    h.ports.capacityRetryAt = async () => resetAt;
    await h.engine.evaluate();
    expect(h.ports.dispatch).not.toHaveBeenCalled();
    const deferred = h.store.unfinished('workspace')[0]!;
    expect(deferred).toMatchObject({
      state: 'retry_wait',
      retryAt: 200_000,
      errorCode: 'CAPACITY_EXHAUSTED',
    });
    expect(h.ports.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ queueState: 'blocked', blockedCode: 'CAPACITY_EXHAUSTED' })
    );

    // A later slot during the same exhaustion is skipped rather than queued behind it.
    h.time(120_000);
    await h.engine.evaluate();
    expect(h.ports.dispatch).not.toHaveBeenCalled();
    expect(
      h.store
        .history('workspace', 'schedule')
        .filter((run) => run.state === 'skipped')
        .map((run) => run.errorCode)
    ).toEqual(['CAPACITY_EXHAUSTED']);

    // After the reset the deferred run dispatches once; capacity is no longer reported exhausted.
    resetAt = undefined;
    h.time(200_000);
    await h.engine.evaluate();
    expect(
      h.store.history('workspace', 'schedule').find((run) => run.runKey === deferred.runKey)
    ).toMatchObject({ state: 'dispatched' });
  });
  it('dispatches as usual when capacity is unknown or cannot be read', async () => {
    const h = harness();
    h.ports.capacityRetryAt = async () => {
      throw new Error('Synthetic capacity ledger failure');
    };
    await h.engine.evaluate();
    expect(h.ports.dispatch).toHaveBeenCalledTimes(1);
  });
  it('skips a run whose quota resets only after its dispatch window', async () => {
    const h = harness();
    h.ports.capacityRetryAt = async () => 60_000 + 86_400_000;
    await h.engine.evaluate();
    expect(h.ports.dispatch).not.toHaveBeenCalled();
    expect(h.store.history('workspace', 'schedule')[0]).toMatchObject({
      state: 'skipped',
      errorCode: 'CAPACITY_EXHAUSTED',
    });
  });
  it('does not hand off a preparation that outlives its dispatch deadline', async () => {
    const h = harness();
    h.ports.materialize = vi.fn(async () => {
      h.time(86_460_000);
    });
    await h.engine.evaluate();
    expect(h.ports.dispatch).not.toHaveBeenCalled();
    expect(h.store.history('workspace', 'schedule')[0]?.errorCode).toBe('DISPATCH_EXPIRED');
  });
});

describe('One-time complete messages', () => {
  function message() {
    const d = document();
    d.definition = {
      ...d.definition,
      messageVersion: 1,
      project: undefined,
      destination: { kind: 'existing_session', sessionId: 'chat' },
      trigger: { kind: 'once', at: '1970-01-01T00:01:00Z' },
      misfirePolicy: { kind: 'run_once' },
    };
    d.prompt = 'Frozen message';
    d.message = { inputBlocks: [{ type: 'text', text: 'Frozen message' }], mcpServerIds: [] };
    return d;
  }
  function continuationMessage() {
    const d = message();
    const reset = 59_000;
    d.definition.scheduleId = uuidv5(
      JSON.stringify(['continuation', 'workspace', 'chat', reset]),
      uuidv5.URL
    );
    d.definition.activationId = uuidv5('activation', d.definition.scheduleId);
    d.definition.activeFrom = 60_000;
    d.prompt = 'continue';
    d.message = { inputBlocks: [{ type: 'text', text: 'continue' }] };
    return d;
  }
  it('dispatches an already prepared continuation input', async () => {
    const d = continuationMessage();
    const h = harness(d);
    h.store.plan('workspace', d, buildScheduleRegistryRow(d).definitionFingerprint, 60_000);
    const run = h.store.unfinished('workspace')[0];
    if (!run) throw new Error('missing scheduled run');
    h.store.transition(run.runKey, ['pending'], {
      state: 'claimed',
      prepared: { prompt: 'continue' },
    });
    expect(h.store.unfinishedForSession('workspace', 'chat')).toHaveLength(1);
    expect(h.store.unfinishedForSession('workspace', 'other-chat')).toEqual([]);
    await h.engine.evaluate();
    expect(h.store.history('workspace', d.definition.scheduleId)[0]?.state).toBe('dispatched');
    expect(h.ports.dispatch).toHaveBeenCalledOnce();
  });
  it('reconciles an already delivered continuation input without dispatching again', async () => {
    const d = continuationMessage();
    const h = harness(d);
    h.store.plan('workspace', d, buildScheduleRegistryRow(d).definitionFingerprint, 60_000);
    const run = h.store.unfinished('workspace')[0];
    if (!run) throw new Error('missing scheduled run');
    h.store.transition(run.runKey, ['pending'], {
      state: 'claimed',
      prepared: { prompt: 'continue' },
    });
    h.accepted();
    await h.engine.evaluate();
    expect(h.store.history('workspace', d.definition.scheduleId)[0]?.state).toBe('dispatched');
    expect(h.ports.dispatch).not.toHaveBeenCalled();
  });
  it('keeps ordinary and edited scheduled messages', async () => {
    const d = continuationMessage();
    d.prompt = 'different message';
    d.message = { inputBlocks: [{ type: 'text', text: 'different message' }] };
    const h = harness(d);
    await h.engine.evaluate();
    expect(h.store.history('workspace', d.definition.scheduleId)[0]?.state).toBe('dispatched');
    expect(h.ports.dispatch).toHaveBeenCalledOnce();
  });
  it('records a discarded quota handoff without retrying after restart', async () => {
    const h = harness(message());
    h.ports.dispatch = async () => 'discarded';
    await h.engine.evaluate();
    expect(h.store.history('workspace', 'schedule')).toMatchObject([
      { state: 'skipped', errorCode: 'QUOTA_RECOVERY_ALREADY_ACCEPTED' },
    ]);
    await new ScheduleEngine(h.ports).evaluate();
    expect(h.store.history('workspace', 'schedule')).toHaveLength(1);
    expect(h.ports.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messageState: 'failed',
        blockedCode: 'QUOTA_RECOVERY_ALREADY_ACCEPTED',
      })
    );
  });
  it.each([
    ['message', 'message'],
    ['task', 'message'],
    ['message', 'task'],
  ] as const)(
    'does not couple a running %s to an unrelated %s on the same agent',
    async (firstKind, nextKind) => {
      const first = firstKind === 'message' ? message() : document();
      const next = nextKind === 'message' ? message() : document();
      next.definition.scheduleId = 'other-schedule';
      next.definition.destination = { kind: 'existing_session', sessionId: 'other-chat' };
      const documents = [first];
      const h = harness(first);
      h.ports.list = async () => documents.map(buildScheduleRegistryRow);
      h.ports.read = async (id) =>
        documents.find((entry) => entry.definition.scheduleId === id) ?? null;
      h.ports.prepare = async (run) => ({ prompt: run.scheduleId, sessionId: run.sessionId });
      const sent: string[] = [];
      h.ports.dispatch = async (prepared) => {
        sent.push(prepared.prompt);
      };
      h.ports.isDispatched = async (prepared) => sent.includes(prepared.prompt);
      await h.engine.evaluate();
      expect(sent).toEqual(['schedule']);
      expect(h.store.history('workspace', 'schedule')[0]?.state).toBe('dispatched');
      // Restart while the first conversation is still running. Its delivery must
      // neither repeat nor block another conversation's admission.
      const restarted = new ScheduleEngine(h.ports);
      documents.push(next);
      h.time(60_001);
      await restarted.evaluate();
      expect(sent).toEqual(['schedule', 'other-schedule']);
      expect(h.store.history('workspace', 'other-schedule')[0]?.state).toBe('dispatched');
      expect(h.store.history('workspace', 'schedule')[0]?.state).toBe('dispatched');
      await restarted.evaluate();
      expect(sent).toEqual(['schedule', 'other-schedule']);
    }
  );

  it('waits for its own busy chat and sends once after it becomes idle', async () => {
    const h = harness(message());
    let busy = true;
    const sent: string[] = [];
    h.ports.validateTarget = async () => {
      if (busy) throw new ScheduleConfigurationError('SESSION_BUSY');
    };
    h.ports.dispatch = async (prepared) => {
      sent.push(prepared.prompt);
      h.accepted();
    };
    await h.engine.evaluate();
    expect(sent).toEqual([]);
    expect(h.store.history('workspace', 'schedule')[0]).toMatchObject({
      state: 'retry_wait',
      errorCode: 'SESSION_BUSY',
      attempts: 0,
    });
    busy = false;
    h.time(90_000);
    await h.engine.evaluate();
    await h.engine.evaluate();
    expect(sent).toEqual(['Frozen message']);
    expect(h.store.history('workspace', 'schedule')[0]?.state).toBe('dispatched');
  });

  it('retains frozen blocks in the ledger and restores sent status without sending again', async () => {
    const h = harness(message());
    h.time(600_000); // Offline at the due time: one catch-up.
    await h.engine.evaluate();
    const [run] = h.store.history('workspace', 'schedule');
    expect(run?.message).toEqual(h.d.message);
    expect(run?.sessionId).toBe('chat');
    expect(run?.state).toBe('dispatched');
    const restarted = new ScheduleEngine(h.ports);
    await restarted.evaluate();
    expect(h.store.history('workspace', 'schedule')).toHaveLength(1);
    expect(h.store.history('workspace', 'schedule')[0]?.state).toBe('dispatched');
    expect(h.ports.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messageState: 'sent',
        lastDispatch: expect.objectContaining({ sessionId: 'chat' }),
      })
    );
  });
  it('never sends a consumed message again after a stale edit, even after restart', async () => {
    const h = harness(message());
    const delivered: string[] = [];
    h.ports.dispatch = async (prepared) => {
      delivered.push(prepared.prompt);
      h.accepted();
    };
    await h.engine.evaluate();
    h.finished();
    await h.engine.evaluate();
    h.d.prompt = 'edited after delivery';
    h.d.message = { inputBlocks: [{ type: 'text', text: h.d.prompt }] };
    h.d.definition.activationId = 'stale-client-edit';
    h.d.definition.trigger = { kind: 'once', at: new Date(120_000).toISOString() };
    h.ports.list = async () => [buildScheduleRegistryRow(h.d)];
    h.time(120_000);
    const restarted = new ScheduleEngine(h.ports);
    await restarted.evaluate();
    expect(delivered).toEqual(['Frozen message']);
    expect(h.store.history('workspace', 'schedule')).toHaveLength(1);
    expect(h.ports.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        activationId: 'stale-client-edit',
        messageState: 'sent',
        lastDispatch: expect.objectContaining({ sessionId: 'chat' }),
      })
    );
  });

  it('acknowledges cancellation before a future message has a run', async () => {
    const h = harness(message());
    h.time(1);
    h.pause();
    await h.engine.evaluate();
    expect(h.store.history('workspace', 'schedule')).toEqual([]);
    expect(h.ports.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageState: 'cancelled' })
    );
  });
  it('reports sent if a cancellation races a committed dispatch receipt', async () => {
    const h = harness(message());
    h.ports.dispatch = async () => {
      h.accepted();
      h.pause();
      throw new Error('lost receipt');
    };
    await h.engine.evaluate();
    expect(h.store.history('workspace', 'schedule')[0]?.state).toBe('dispatched');
    expect(h.ports.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageState: 'sent' })
    );
  });
});

it('retains scheduled local bytes without history and releases the reservation after deletion', async () => {
  const docs = new Map<string, LoroDoc>();
  const rows = new Map<string, unknown>();
  const port: ScheduleRepositoryPort = {
    openPersistedDoc: async (id) => {
      if (!docs.has(id)) docs.set(id, new LoroDoc());
      return { doc: docs.get(id)! };
    },
    openFlockDoc: async () => ({
      flock: {
        scan: () => [...rows].map(([key, value]) => ({ key: JSON.parse(key), value })),
        get: (key) => rows.get(JSON.stringify(key)),
        set: (key, value) => rows.set(JSON.stringify(key), value),
      },
    }),
    flush: async () => {},
  };
  const repository = new ScheduleRepository(port, 'workspace' as never);
  const d = document().definition;
  await repository.save({
    scheduleId: 'message-file',
    actorId: 'owner',
    now: 1,
    activationId: 'a',
    activityId: 'create',
    create: true,
    draft: {
      title: d.title,
      machineId: d.machineId,
      agent: d.agent,
      retryPolicy: d.retryPolicy,
      misfirePolicy: d.misfirePolicy,
      overlapPolicy: d.overlapPolicy,
      prompt: '',
      destination: { kind: 'existing_session', sessionId: 'chat' },
      trigger: { kind: 'once', at: '2099-01-01T00:00:00Z' },
      message: {
        inputBlocks: [
          {
            type: 'file',
            fileId: 'blob',
            fileName: 'notes.txt',
            mimeType: 'text/plain',
            sizeBytes: 5,
            sha256: 'a'.repeat(64),
            textPreview: true,
            uploadedAt: 1,
            transport: 'local',
            machineId: 'machine',
          },
        ],
      },
    },
  });
  const args = {
    repo: port,
    workspaceId: 'workspace' as never,
    sessionId: 'chat' as never,
    fileId: 'blob',
  };
  expect(await isScheduledMessageFile(args)).toBe(true);
  expect(await isScheduledMessageFile({ ...args, sessionId: 'other' as never })).toBe(false);
  await repository.delete('message-file', 'owner', 2);
  expect(await isScheduledMessageFile(args)).toBe(false);
});

describe('Frozen schedule destinations', () => {
  it('settles an archived dispatched session after live work drains despite pending activation and queue markers', async () => {
    const h = harness();
    const meta = {
      isArchived: false,
      latestUserMsgId: 'pending',
      messageQueueUpdatedAt: 20,
      messageQueueCheckedAt: 0,
    } as SessionMeta;
    let liveWork = false;
    const manager = {
      repo: { getDocMeta: async () => ({ meta }) },
    } as unknown as LoroDocumentManager;
    h.ports.isFinished = (run) => isScheduleRunFinished(manager, run, () => liveWork);
    await h.engine.evaluate();
    const run = h.store.unfinished('workspace')[0]!;
    await h.engine.evaluate();
    expect(h.store.get(run.runKey)?.state).toBe('dispatched');
    meta.isArchived = true;
    liveWork = true;
    await h.engine.evaluate();
    expect(h.store.get(run.runKey)?.state).toBe('dispatched');
    liveWork = false;
    await h.engine.evaluate();
    expect(h.store.get(run.runKey)?.state).toBe('finished');
  });

  it('persists the replacement session with preparation and keeps it on retry and restart', async () => {
    const d = document();
    d.definition.destination = { kind: 'own_session', epoch: 0 };
    d.definition.trigger = { kind: 'once', at: '1970-01-01T00:01:00Z' };
    const h = harness(d);
    const zero = scheduleOwnSessionId('schedule', 0);
    const next = scheduleOwnSessionId('schedule', 0, 1);
    const states = new Map<SessionId, DestinationSessionState>([
      [zero, { kind: 'present', meta: { isArchived: true } as SessionMeta }],
    ]);
    h.ports.prepare = async (run) => ({
      prompt: run.prompt,
      ...(await resolveScheduleDestinationSession({
        scheduleId: run.scheduleId,
        destination: run.definition.destination,
        plannedSessionId: run.sessionId as SessionId,
        readSession: async (id) => states.get(id) ?? { kind: 'absent' },
      })),
    });
    let unavailable = true;
    h.ports.materialize = async () => {
      if (unavailable) throw new Error('injected storage failure');
    };
    await h.engine.evaluate();
    expect(h.store.history('workspace', 'schedule')[0]).toMatchObject({
      sessionId: next,
      state: 'retry_wait',
      prepared: { sessionId: next },
    });
    states.clear(); // Sequence zero is usable again; a prepared retry must ignore it.
    unavailable = false;
    h.time(90_000);
    const restarted = new ScheduleEngine(h.ports);
    await restarted.evaluate();
    expect(h.store.history('workspace', 'schedule')[0]).toMatchObject({
      sessionId: next,
      state: 'dispatched',
      prepared: { sessionId: next },
    });
  });
  it('fails a prepared run if its destination becomes archived, without dispatching', async () => {
    const h = harness();
    let archived = false;
    h.ports.materialize = async () => {
      archived = true;
    };
    h.ports.validateTarget = async () => {
      if (archived) throw new ScheduleConfigurationError('SESSION_UNAVAILABLE');
    };
    await h.engine.evaluate();
    expect(h.store.history('workspace', 'schedule')[0]).toMatchObject({
      state: 'failed',
      errorCode: 'SESSION_UNAVAILABLE',
    });
    expect(h.store.unfinished('workspace')).toEqual([]);
  });
  it.each(['SESSION_UNAVAILABLE', 'BOARD_UNAVAILABLE'])(
    'blocks unprepared %s without an attempt ',
    async (code) => {
      const h = harness();
      h.ports.prepare = async () => {
        throw new ScheduleConfigurationError(code);
      };
      await h.engine.evaluate();
      expect(h.store.unfinished('workspace')[0]).toMatchObject({
        state: 'retry_wait',
        attempts: 0,
        errorCode: code,
      });
    }
  );
});

describe('Schedule handoff integration', () => {
  /** Selectors that would put a scheduled run inside a working directory. */
  const WORKSPACE_SELECTORS = ['repo', 'branch', 'localProject', 'worktree'] as const;

  const definition = (project?: ScheduleDefinition['project']): ScheduleDefinition =>
    ScheduleDefinitionSchema.parse({
      scheduleId: 'chat',
      title: 'Morning check-in',
      ownerId: 'owner',
      machineId: 'machine',
      enabled: true,
      activationId: 'activation',
      activeFrom: 0,
      trigger: { kind: 'once', at: '1970-01-01T00:01:00Z' },
      misfirePolicy: { kind: 'run_once' },
      overlapPolicy: 'queue_one',
      agent: { agentConfigId: 'agent', modeId: 'safe' },
      ...(project ? { project } : {}),
      retryPolicy: { dispatchMaxAttempts: 5, dispatchMaxAgeMs: 86_400_000 },
      createdAt: 0,
      updatedAt: 0,
      createdBy: 'owner',
    });

  /**
   * A chat-only schedule, driven through the real engine, ledger and Loro history.
   *
   * The point of running the whole handoff rather than only the pure builders is
   * that "no project" has to survive the part that actually places a run: the
   * options handed to `prepareSessionInput`, the resolved target, and the durable
   * user turn that the ordinary dispatch watcher then owns.
   */
  describe('Chat-only schedule handoff', () => {
    const run = async (
      project: ScheduleDefinition['project'] | undefined,
      body: (context: {
        options: Record<string, unknown>[];
        targets: { project?: unknown }[];
        history: SessionHistoryInput[];
        meta: SessionMeta | undefined;
        sessionId: string;
        userTurnId: string;
        state: string | undefined;
      }) => void,
      selection: Pick<ScheduleDefinition, 'mcpServerIds' | 'destination'> = {
        destination: { kind: 'new_session' },
      }
    ) => {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'lody-schedule-chat-'));
      const store = new ScheduleStore<PreparedSessionInput>(path.join(directory, 'runs.sqlite'));
      const metas = new Map<string, SessionMeta>();
      const mirrors = new Map<string, Mirror<typeof sessionDocSchema>>();
      const manager = {
        isEncryptedWorkspace: () => false,
        repo: {
          getDocMeta: async (id: string) => (metas.has(id) ? { meta: metas.get(id) } : undefined),
          upsertDocMeta: async (id: string, patch: Partial<SessionMeta>) => {
            metas.set(id, { ...metas.get(id), ...patch } as SessionMeta);
          },
          flush: async () => {},
          openFlockDoc: async () => ({
            flock: {
              scan: () => [
                {
                  key: ['mcpServer', 'default'],
                  value: {
                    id: 'default',
                    name: 'Default',
                    transport: 'stdio',
                    enabledByDefault: true,
                    createdAt: 0,
                    updatedAt: 0,
                  },
                },
                {
                  key: ['mcpServer', 'opt-in'],
                  value: {
                    id: 'opt-in',
                    name: 'Optional',
                    transport: 'stdio',
                    enabledByDefault: false,
                    createdAt: 0,
                    updatedAt: 0,
                  },
                },
                {
                  key: ['mcpServer', 'unset'],
                  value: {
                    id: 'unset',
                    name: 'Unset',
                    transport: 'stdio',
                    createdAt: 0,
                    updatedAt: 0,
                  },
                },
              ],
            },
          }),
        },
        getOrCreateSessionDoc: async (id: string) => {
          if (!mirrors.has(id))
            mirrors.set(
              id,
              new Mirror({
                doc: new LoroDoc(),
                schema: sessionDocSchema,
                initialState: { history: [] },
              })
            );
          const mirror = mirrors.get(id)!;
          return withHistoryPort({
            getHistory: () => mirror.getState().history,
            updateHistory: async (update: (h: SessionHistoryInput[]) => SessionHistoryInput[]) => {
              mirror.setState({ ...mirror.getState(), history: update(mirror.getState().history) });
            },
          });
        },
      } as unknown as LoroDocumentManager;

      const document: ScheduleDocument = {
        definition: { ...definition(project), ...selection },
        prompt: 'Say good morning.',
        timeline: [],
      };
      const options: Record<string, unknown>[] = [];
      const targets: { project?: unknown }[] = [];
      let identity = { sessionId: '', userTurnId: '' };

      const ports: ScheduleEnginePorts<PreparedSessionInput> = {
        workspaceId: 'workspace',
        machineId: 'machine',
        userId: 'owner',
        store,
        now: () => 60_000,
        ready: () => true,
        disabled: () => false,
        list: async () => [buildScheduleRegistryRow(document)],
        read: async () => document,
        validateTarget: async () => {
          // Same guard the workspace runs: nothing to look up without a project.
          expect(scheduleRequiredLocalProjectId(document.definition.project)).toBe(
            project?.kind === 'local' ? project.localProjectId : undefined
          );
        },
        prepare: async (scheduled: ScheduleRun<PreparedSessionInput>) => {
          // The real builders, so this asserts what reaches session preparation.
          options.push(
            buildScheduleSessionCreateOptions({
              sessionId: scheduled.sessionId as PreparedSessionInput['sessionId'],
              userTurnId: scheduled.userTurnId,
              agentConfigId: scheduled.definition.agent.agentConfigId,
              title: scheduled.definition.title,
              project: scheduled.definition.project,
            })
          );
          targets.push(
            buildScheduleRunTarget({
              targetMachine: { id: 'machine' } as never,
              agentConfig: { id: 'agent' } as never,
              project: scheduled.definition.project,
            })
          );
          identity = { sessionId: scheduled.sessionId, userTurnId: scheduled.userTurnId };
          const prepared = {
            sessionId: scheduled.sessionId as PreparedSessionInput['sessionId'],
            meta: {
              id: scheduled.sessionId,
              machineId: 'machine',
              userId: 'owner',
              agentConfigId: 'agent',
              title: scheduled.definition.title,
              scheduleId: scheduled.scheduleId,
            } as SessionMeta,
            userTurn: {
              id: scheduled.userTurnId,
              role: 'user',
              status: 'prepared',
              read: true,
              timestamp: new Date(60_000).toISOString(),
              items: [{ type: 'text', text: scheduled.prompt }],
              inputConfig: {
                mcpServerIds: await resolveScheduleMcpSelection({
                  manager,
                  workspaceId: 'workspace' as never,
                  localOnly: true,
                  definition: scheduled.definition,
                  sessionId: scheduled.sessionId as PreparedSessionInput['sessionId'],
                }),
              },
              fileDiff: [],
            },
          } satisfies PreparedSessionInput;
          return prepared;
        },
        materialize: (prepared) => materializePreparedSessionInput(manager, prepared),
        isDispatched: (prepared) => isPreparedSessionDispatched(manager, prepared),
        dispatch: (prepared) => commitPreparedSessionDispatch(manager, prepared),
        isFinished: async () => false,
        publish: async () => {},
        onError: (error) => {
          throw error;
        },
      };

      const engine = new ScheduleEngine(ports);
      try {
        await engine.evaluate();
        const ledger = store.unfinished('workspace')[0];
        body({
          options,
          targets,
          history: mirrors.get(identity.sessionId)?.getState().history ?? [],
          meta: metas.get(getSessionRoomId(identity.sessionId as never)),
          sessionId: identity.sessionId,
          userTurnId: identity.userTurnId,
          state: ledger?.state,
        });
      } finally {
        await engine.stop();
        store.close();
        for (const mirror of mirrors.values()) mirror.dispose();
        rmSync(directory, { recursive: true, force: true });
      }
    };

    it.each(['new_session', 'own_session'] as const)(
      'freezes explicit, default and empty MCP selections for %s',
      async (kind) => {
        const destination = kind === 'own_session' ? { kind, epoch: 0 } : { kind };
        for (const [mcpServerIds, expected] of [
          [undefined, ['default']],
          [['opt-in'], ['opt-in']],
          [[], []],
        ] as const) {
          await run(
            undefined,
            (context) => {
              const turn = findNextDispatchableUserTurn(context.history, context.meta!);
              expect(turn?.inputConfig?.mcpServerIds).toEqual(expected);
              expect(context.state).toBe('dispatched');
            },
            {
              destination,
              ...(mcpServerIds !== undefined ? { mcpServerIds: [...mcpServerIds] } : {}),
            }
          );
        }
      }
    );
  });

  /**
   * An owned chat: every run of the schedule is a new turn in ONE Session. The
   * ids come from the same derivation the engine uses, through the real ledger
   * and Loro history, so this fails if a retry or a second run ever creates a
   * second chat.
   */
});
