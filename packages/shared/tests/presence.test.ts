import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  LODY_PRESENCE_BACKGROUND_TASK_COUNT_MAX,
  LODY_PRESENCE_TTL_MS,
  SessionStatusFactory,
  collectOnlineMachineIdsFromPresence,
  collectViewedSessionIdsFromPresence,
  findFreshMachinePresenceState,
  findFreshSessionPresenceState,
  getLodyMachinePresenceKey,
  getLodySessionPresenceKey,
  getLodySessionViewingPresenceKey,
  parseLodyPresenceStates,
  type LodyPresenceInstanceId,
  type LodyPresenceStateMap,
  type LodySessionViewingPresenceState,
  type MachineId,
  type SessionId,
} from '../src';

const machineId = '01020304-1111-4222-8333-010203040501' as MachineId;
const sessionId = '01020304-1111-4222-8333-010203040502' as SessionId;
const instanceId = '01020304-1111-4222-8333-010203040503' as LodyPresenceInstanceId;

describe('presence helpers', () => {
  it.each(['sessionId', 'machineId', 'instanceId', 'userId'] as const)(
    'rejects free text and oversized %s only in minimal mode',
    (field) => {
      const entry =
        field === 'machineId'
          ? {
              kind: 'machine',
              machineId: '01020304-1111-4222-8333-010203040506',
              instanceId: '01020304-1111-4222-8333-010203040507',
              updatedAt: 100,
            }
          : {
              kind: 'session-viewing',
              sessionId: '01020304-1111-4222-8333-010203040508',
              instanceId: '01020304-1111-4222-8333-010203040507',
              userId: 'Abcdef0123456789Abcdef0123456789',
              since: 100,
              updatedAt: 100,
            };
      for (const invalid of [
        'Private roadmap: /Users/example/project',
        'TitleWithoutSpaces',
        '/tmp/private-path',
        'relative/path',
        '%2Fprivate',
        '秘密标题',
        'a'.repeat(1024),
        '01020304-1111-4222-8333-010203040508\n',
      ]) {
        const input = { entry: { ...entry, [field]: invalid } };
        expect(parseLodyPresenceStates(input, { minimal: true }), `${field}: ${invalid}`).toEqual(
          {}
        );
        expect(parseLodyPresenceStates(input).entry).toHaveProperty(field, invalid);
      }
    }
  );

  it('rejects unverified fallback session IDs on receive while preserving other presence', () => {
    for (const fallbackSessionId of ['1790000000000-privateroadmap', '1790000000000-k5zmz7k']) {
      const machine = { kind: 'machine', machineId, instanceId, updatedAt: 100 };
      const session = {
        kind: 'session',
        sessionId: fallbackSessionId,
        machineId,
        instanceId,
        status: { type: 'running' },
        updatedAt: 100,
      };
      const viewing = {
        kind: 'session-viewing',
        sessionId: fallbackSessionId,
        instanceId,
        userId: 'Abcdef0123456789Abcdef0123456789',
        since: 50,
        updatedAt: 100,
      };
      expect(parseLodyPresenceStates({ machine, session, viewing }, { minimal: true })).toEqual({
        machine,
      });
      expect(parseLodyPresenceStates({ machine, session, viewing })).toEqual({
        machine,
        session,
        viewing,
      });
    }
  });

  it('accepts supported generated ID formats without widening ordinary parsers', () => {
    for (const ids of [
      {
        sessionId: '01020304-1111-4222-8333-010203040508',
        machineId: '01020304-1111-4222-8333-010203040509',
        instanceId: '01020304-1111-4222-8333-010203040507',
        userId: 'Abcdef0123456789Abcdef0123456789',
      },
      {
        sessionId: '019a0d00-0000-8000-8000-000000000001',
        machineId: 'ab'.repeat(32),
        instanceId: '1790000000000-k5zmz7k',
        userId: 'local:' + 'cd'.repeat(16),
      },
      {
        sessionId: '019a0d00-0000-7000-8000-000000000002',
        machineId: '01020304-1111-4222-8333-010203040509',
        instanceId: '01020304-1111-4222-8333-010203040507',
        userId: '019a0d00-0000-7000-8000-000000000001',
      },
    ]) {
      const states = {
        machine: {
          kind: 'machine',
          machineId: ids.machineId,
          instanceId: ids.instanceId,
          updatedAt: 100,
        },
        session: {
          kind: 'session',
          sessionId: ids.sessionId,
          machineId: ids.machineId,
          instanceId: ids.instanceId,
          status: { type: 'running' },
          updatedAt: 100,
        },
        viewing: {
          kind: 'session-viewing',
          sessionId: ids.sessionId,
          userId: ids.userId,
          instanceId: ids.instanceId,
          since: 50,
          updatedAt: 100,
        },
      };
      expect(parseLodyPresenceStates(states, { minimal: true })).toEqual(states);
    }
    for (const userId of ['a'.repeat(31), 'a'.repeat(33), 'local:' + 'ab'.repeat(17)]) {
      expect(
        parseLodyPresenceStates(
          {
            viewing: {
              kind: 'session-viewing',
              sessionId,
              instanceId,
              userId,
              since: 50,
              updatedAt: 100,
            },
          },
          { minimal: true }
        )
      ).toEqual({});
    }
    expect(
      parseLodyPresenceStates(
        {
          viewing: {
            kind: 'session-viewing',
            sessionId: '1790000000000-fallback\n',
            instanceId,
            userId: 'Abcdef0123456789Abcdef0123456789',
            since: 50,
            updatedAt: 100,
          },
        },
        { minimal: true }
      )
    ).toEqual({});
  });

  it('uses a separate minimal allowlist and ignores arbitrary details before validation', () => {
    const input = {
      entry: {
        kind: 'session',
        sessionId,
        machineId,
        instanceId,
        updatedAt: 120,
        extra: 'secret',
        status: {
          type: 'initializing',
          stage: 'acp',
          detail: 'x'.repeat(1000),
          futureText: 'secret',
        },
      },
    };
    expect(parseLodyPresenceStates(input, { minimal: true })).toEqual({
      entry: {
        kind: 'session',
        sessionId,
        machineId,
        instanceId,
        updatedAt: 120,
        status: { type: 'initializing', stage: 'acp' },
      },
    });
    expect(parseLodyPresenceStates(input)).toEqual({});
    input.entry.status.detail = 'ordinary detail';
    expect(parseLodyPresenceStates(input).entry).toHaveProperty('status.detail', 'ordinary detail');
  });

  it('keeps only identifiers, enums and timestamps across all minimal entry kinds', () => {
    const common = {
      instanceId,
      updatedAt: 100,
      detail: 'private detail',
      futureText: 'private text',
    };
    const states = {
      machine: { ...common, kind: 'machine', machineId },
      viewing: {
        ...common,
        kind: 'session-viewing',
        userId: 'Abcdef0123456789Abcdef0123456789',
        sessionId,
        since: 50,
      },
      running: {
        ...common,
        kind: 'session',
        machineId,
        sessionId,
        status: {
          type: 'running',
          activity: 'image_generation',
          phase: 'finalizing',
          detail: 'private text',
        },
      },
      permission: {
        ...common,
        kind: 'session',
        machineId,
        sessionId,
        status: { type: 'requestPermission', detail: 'private text' },
      },
      invalid: {
        ...common,
        kind: 'session',
        machineId,
        sessionId,
        status: { type: 'running', activity: 'arbitrary free text' },
      },
    };
    expect(parseLodyPresenceStates(states, { minimal: true })).toEqual({
      machine: { kind: 'machine', machineId, instanceId, updatedAt: 100 },
      viewing: {
        kind: 'session-viewing',
        userId: 'Abcdef0123456789Abcdef0123456789',
        sessionId,
        instanceId,
        since: 50,
        updatedAt: 100,
      },
      running: {
        kind: 'session',
        machineId,
        sessionId,
        instanceId,
        updatedAt: 100,
        status: { type: 'running', activity: 'image_generation', phase: 'finalizing' },
      },
      permission: {
        kind: 'session',
        machineId,
        sessionId,
        instanceId,
        updatedAt: 100,
        status: { type: 'requestPermission' },
      },
    });
  });

  it('accepts status fields nulled by the Loro value roundtrip', () => {
    // Loro values cannot represent `undefined`; optional status fields written
    // as undefined come back as null after the wasm roundtrip. These entries
    // must still parse or the Working indicator silently drops them.
    const sessionKey = getLodySessionPresenceKey(sessionId, instanceId);
    const parsed = parseLodyPresenceStates({
      [sessionKey]: {
        kind: 'session',
        sessionId,
        machineId,
        instanceId,
        status: { type: 'initializing', stage: null, detail: null },
        updatedAt: 120,
      },
    });

    expect(parsed[sessionKey]).toMatchObject({
      kind: 'session',
      sessionId,
      status: { type: 'initializing' },
    });
  });

  it('accepts bounded running backgroundTaskState and count across full/minimal modes while keeping baseline LAN schemas compatible', () => {
    const bgKey = getLodySessionPresenceKey(sessionId, instanceId);
    const wakeupSessionId = '01020304-1111-4222-8333-010203040599' as SessionId;
    const wakeupKey = getLodySessionPresenceKey(wakeupSessionId, instanceId);
    const states = {
      [bgKey]: {
        kind: 'session',
        sessionId,
        machineId,
        instanceId,
        status: SessionStatusFactory.running({
          backgroundTaskState: 'background',
          backgroundTaskCount: 3,
        }),
        updatedAt: 120,
      },
      [wakeupKey]: {
        kind: 'session',
        sessionId: wakeupSessionId,
        machineId,
        instanceId,
        status: SessionStatusFactory.running({
          backgroundTaskState: 'running',
          backgroundTaskCount: 2,
        }),
        updatedAt: 120,
      },
    };

    for (const minimal of [false, true]) {
      const parsed = parseLodyPresenceStates(states, { minimal });
      expect(parsed[bgKey]).toMatchObject({
        status: { type: 'running', backgroundTaskState: 'background', backgroundTaskCount: 3 },
      });
      expect(parsed[wakeupKey]).toMatchObject({
        status: { type: 'running', backgroundTaskState: 'running', backgroundTaskCount: 2 },
      });
    }

    // Loro null roundtrip on optional running fields degrades cleanly to `{ type: 'running' }`.
    const nulled = parseLodyPresenceStates(
      {
        [bgKey]: {
          kind: 'session',
          sessionId,
          machineId,
          instanceId,
          status: {
            type: 'running',
            phase: null,
            backgroundTaskState: null,
            backgroundTaskCount: null,
          },
          updatedAt: 120,
        },
      },
      { minimal: true }
    );
    expect(nulled[bgKey]).toMatchObject({ status: { type: 'running' } });

    // Baseline (`origin/lan-hub`) full & minimal schemas where `phase` is strictly
    // `z.literal('finalizing').optional()`: unknown `backgroundTaskState` /
    // `backgroundTaskCount` fields are stripped and the session stays `{ type: 'running' }`
    // instead of dropping the whole entry to idle.
    const omitNullValuesBaseline = (value: unknown): unknown => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        if (entry === null || entry === undefined) continue;
        out[key] = entry;
      }
      return out;
    };
    const baselineFullStatusSchema = z.preprocess(
      omitNullValuesBaseline,
      z.discriminatedUnion('type', [
        z.object({
          type: z.literal('running'),
          activity: z.enum(['image_generation']).optional(),
          phase: z.literal('finalizing').optional(),
        }),
        z.object({ type: z.literal('requestPermission') }),
        z.object({
          type: z.literal('initializing'),
          stage: z.enum(['git-clone', 'managed-runtime', 'acp', 'resuming']).optional(),
          detail: z.string().max(280).optional(),
        }),
      ])
    );
    const baselineMinimalStatusSchema = z.preprocess(
      omitNullValuesBaseline,
      z.discriminatedUnion('type', [
        z.object({
          type: z.literal('running'),
          activity: z.enum(['image_generation']).optional(),
          phase: z.literal('finalizing').optional(),
        }),
        z.object({ type: z.literal('requestPermission') }),
        z.object({
          type: z.literal('initializing'),
          stage: z.enum(['git-clone', 'managed-runtime', 'acp', 'resuming']).optional(),
        }),
      ])
    );
    const baselineFullSessionSchema = z.object({
      kind: z.literal('session'),
      sessionId: z.string().min(1),
      machineId: z.string().min(1),
      instanceId: z.string().min(1),
      status: baselineFullStatusSchema,
      updatedAt: z.number().finite(),
    });
    const baselineMinimalSessionSchema = z.object({
      kind: z.literal('session'),
      sessionId: z.string().length(36).uuid(),
      machineId: z.string().length(36).uuid(),
      instanceId: z.string().length(36).uuid(),
      status: baselineMinimalStatusSchema,
      updatedAt: z.number().finite(),
    });

    for (const entry of [states[bgKey], states[wakeupKey]]) {
      const fullResult = baselineFullSessionSchema.safeParse(entry);
      expect(fullResult.success).toBe(true);
      if (fullResult.success) {
        expect(fullResult.data.status).toEqual({ type: 'running' });
      }
      const minimalResult = baselineMinimalSessionSchema.safeParse(entry);
      expect(minimalResult.success).toBe(true);
      if (minimalResult.success) {
        expect(minimalResult.data.status).toEqual({ type: 'running' });
      }
    }

    // Out-of-range or non-integer backgroundTaskCount, unknown backgroundTaskState,
    // and non-finalizing phases are rejected.
    for (const badStatus of [
      { type: 'running', backgroundTaskState: 'background', backgroundTaskCount: 0 },
      { type: 'running', backgroundTaskState: 'background', backgroundTaskCount: -1 },
      {
        type: 'running',
        backgroundTaskState: 'background',
        backgroundTaskCount: LODY_PRESENCE_BACKGROUND_TASK_COUNT_MAX + 1,
      },
      { type: 'running', backgroundTaskState: 'background', backgroundTaskCount: 1.5 },
      { type: 'running', backgroundTaskState: 'background', backgroundTaskCount: '2' },
      { type: 'running', backgroundTaskState: 'arbitrary free text' },
      { type: 'running', phase: 'background' },
      { type: 'running', phase: 'arbitrary free text' },
    ]) {
      const input = {
        [bgKey]: {
          kind: 'session',
          sessionId,
          machineId,
          instanceId,
          status: badStatus,
          updatedAt: 120,
        },
      };
      expect(parseLodyPresenceStates(input)).toEqual({});
      expect(parseLodyPresenceStates(input, { minimal: true })).toEqual({});
    }

    // SessionStatusFactory clamps positive counts and omits non-positive/non-finite counts.
    expect(SessionStatusFactory.running()).toEqual({ type: 'running' });
    expect(SessionStatusFactory.running('image_generation')).toEqual({
      type: 'running',
      activity: 'image_generation',
    });
    expect(
      SessionStatusFactory.running({ backgroundTaskState: 'background', backgroundTaskCount: 0 })
    ).toEqual({
      type: 'running',
      backgroundTaskState: 'background',
    });
    expect(
      SessionStatusFactory.running({
        backgroundTaskState: 'background',
        backgroundTaskCount: LODY_PRESENCE_BACKGROUND_TASK_COUNT_MAX + 50,
      })
    ).toEqual({
      type: 'running',
      backgroundTaskState: 'background',
      backgroundTaskCount: LODY_PRESENCE_BACKGROUND_TASK_COUNT_MAX,
    });
  });

  it('returns only fresh latest presence for a machine/session', () => {
    const freshInstance = 'instance-fresh' as LodyPresenceInstanceId;
    const staleInstance = 'instance-stale' as LodyPresenceInstanceId;
    const states: LodyPresenceStateMap = {
      [getLodyMachinePresenceKey(machineId, staleInstance)]: {
        kind: 'machine',
        machineId,
        instanceId: staleInstance,
        updatedAt: 1,
      },
      [getLodyMachinePresenceKey(machineId, freshInstance)]: {
        kind: 'machine',
        machineId,
        instanceId: freshInstance,
        updatedAt: 95,
      },
      [getLodySessionPresenceKey(sessionId, freshInstance)]: {
        kind: 'session',
        sessionId,
        machineId,
        instanceId: freshInstance,
        status: { type: 'running', activity: 'image_generation' },
        updatedAt: 90,
      },
    };

    expect(findFreshMachinePresenceState(states, machineId, 100, 20)?.instanceId).toBe(
      freshInstance
    );
    expect(findFreshSessionPresenceState(states, sessionId, 100, 20)?.status).toEqual({
      type: 'running',
      activity: 'image_generation',
    });
    expect(findFreshMachinePresenceState(states, machineId, LODY_PRESENCE_TTL_MS + 200)).toBe(
      undefined
    );
  });

  it('collects online machine ids from fresh machine presence only', () => {
    const now = 1_000;
    const staleMachineId = 'machine-stale' as MachineId;
    const states: LodyPresenceStateMap = {
      [getLodyMachinePresenceKey(machineId, instanceId)]: {
        kind: 'machine',
        machineId,
        instanceId,
        updatedAt: now,
      },
      [getLodyMachinePresenceKey(staleMachineId, instanceId)]: {
        kind: 'machine',
        machineId: staleMachineId,
        instanceId,
        updatedAt: now - LODY_PRESENCE_TTL_MS - 1,
      },
      [getLodySessionPresenceKey(sessionId, instanceId)]: {
        kind: 'session',
        sessionId,
        machineId: 'machine-session-only' as MachineId,
        instanceId,
        status: { type: 'running' },
        updatedAt: now,
      },
    };

    const online = collectOnlineMachineIdsFromPresence(states, now);
    expect(online.has(machineId)).toBe(true);
    expect(online.has(staleMachineId)).toBe(false);
    // Session presence alone must not mark a machine online; machine liveness
    // is only asserted by machine heartbeats.
    expect(online.size).toBe(1);
  });

  it('collectViewedSessionIdsFromPresence returns only fresh viewing entries', () => {
    const viewerUserId = 'user-1';
    const viewingState = (overrides: Partial<LodySessionViewingPresenceState> = {}) =>
      ({
        kind: 'session-viewing',
        userId: viewerUserId,
        instanceId,
        sessionId,
        since: 1_000,
        updatedAt: 2_000,
        ...overrides,
      }) satisfies LodySessionViewingPresenceState;

    const nowMs = 100_000;
    const states = parseLodyPresenceStates({
      [getLodySessionViewingPresenceKey(viewerUserId, instanceId)]: viewingState({
        updatedAt: nowMs - 1_000,
      }),
      'viewing:user-2:instance-9': viewingState({
        userId: 'user-2',
        sessionId: 'session-2' as SessionId,
        updatedAt: nowMs - LODY_PRESENCE_TTL_MS - 1,
      }),
      'session:session-3:instance-1': {
        kind: 'session',
        sessionId: 'session-3',
        machineId: 'machine-1',
        instanceId,
        status: { type: 'running' },
        updatedAt: nowMs - 1_000,
      },
    });

    const viewed = collectViewedSessionIdsFromPresence(states, nowMs);
    expect([...viewed]).toEqual([sessionId]);
  });
});
