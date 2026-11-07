import { describe, expect, it } from 'vitest';

import {
  CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
  MACHINE_PROTOCOL_CAPABILITIES,
  machineSupportsAcpAuthenticationInteractionsProtocol,
  machineSupportsAcpCapabilityRefreshCacheProtocol,
  machineSupportsLocalFileResourcesProtocol,
  machineSupportsProtocolCapability,
  machineSupportsRealtimeVoice,
  machineSupportsRealtimeVoiceContext,
  machineSupportsRealtimeVoiceSelection,
  machineSupportsGeminiVoice,
  machineSupportsSubagentEvents,
  machineSupportsIosSimulatorControls,
  negotiatedAcpCapabilitiesRefreshForce,
  REALTIME_VOICE_PROTOCOL_VERSION,
  resolveNewSessionHistoryBackend,
} from '../src/machine-protocol-capabilities';
import { MachineVoiceRequestSchema, MachineVoiceResponseSchema } from '../src/machine-voice';
import {
  MachineAcpCapabilitiesRefreshRequestSchema,
  safeParseLocalSessionControlRequest,
} from '../src/message-schemas';

it('negotiates a new backend preference without changing explicit persisted choices', () => {
  expect(resolveNewSessionHistoryBackend(undefined, { preferred: 'roost' })).toBe('loro');
  expect(
    resolveNewSessionHistoryBackend(
      { protocolCapabilities: { sessionHistory: 1 } },
      { preferred: 'roost' }
    )
  ).toBe('loro');
  expect(
    resolveNewSessionHistoryBackend(
      { protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES },
      { preferred: 'roost' }
    )
  ).toBe('roost');
  expect(() => resolveNewSessionHistoryBackend(undefined, { requested: 'roost' })).toThrow(
    'Update the machine'
  );
  expect(
    resolveNewSessionHistoryBackend(undefined, { requested: 'loro', preferred: 'roost' })
  ).toBe('loro');
});

describe('ACP capability refresh cache protocol capability', () => {
  // The refresh request as a daemon without this capability parses it: the same
  // strict schema minus the field that build never declared. Derived from the
  // current schema so it cannot drift away from what actually shipped.
  const previousGenerationRequestSchema = MachineAcpCapabilitiesRefreshRequestSchema.omit({
    force: true,
  });
  const buildRequest = (
    machine: { protocolCapabilities?: Record<string, number> } | undefined
  ) => ({
    type: 'machine/acp-capabilities-refresh' as const,
    machineId: 'machine-1',
    workspaceId: 'workspace-1',
    configId: 'config-1',
    ...negotiatedAcpCapabilitiesRefreshForce(machine, true),
  });

  it.each([
    { name: 'no advertised capabilities', machine: undefined },
    {
      name: 'an unrelated capability set',
      machine: { protocolCapabilities: { providerSetup: 1 } },
    },
    {
      name: 'a zero version',
      machine: { protocolCapabilities: { acpCapabilityRefreshCache: 0 } },
    },
  ])('sends a request a previous-generation daemon still accepts given $name', ({ machine }) => {
    const request = buildRequest(machine);

    // Not just "force is falsy": a strict schema rejects the key even when its
    // value is undefined, so the key must be absent from the payload entirely.
    expect(Object.keys(request)).not.toContain('force');
    expect(previousGenerationRequestSchema.safeParse(request).success).toBe(true);
    expect(safeParseLocalSessionControlRequest(JSON.stringify(request)).success).toBe(true);
  });

  it('sends force only to a daemon that advertised the capability', () => {
    const request = buildRequest({ protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES });

    expect(request.force).toBe(true);
    expect(safeParseLocalSessionControlRequest(JSON.stringify(request)).success).toBe(true);
    // The regression this negotiation prevents: a previous-generation daemon
    // rejects the whole request rather than ignoring an unknown field.
    expect(previousGenerationRequestSchema.safeParse(request).success).toBe(false);
  });
});

it('negotiates private simulator controls independently of preview support', () => {
  expect(machineSupportsIosSimulatorControls(undefined)).toBe(false);
  expect(machineSupportsIosSimulatorControls({ protocolCapabilities: { iosSimulator: 1 } })).toBe(
    false
  );
  expect(
    machineSupportsIosSimulatorControls({
      protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
    })
  ).toBe(true);
});

describe('realtime voice protocol capability', () => {
  it('lets a v1 daemon keep hosting calls but only a v2 daemon receive their background', () => {
    const v1 = { protocolCapabilities: { realtimeVoice: 1 } };
    const current = { protocolCapabilities: { realtimeVoice: REALTIME_VOICE_PROTOCOL_VERSION } };
    expect(machineSupportsRealtimeVoice(v1)).toBe(true);
    expect(machineSupportsRealtimeVoiceContext(v1)).toBe(false);
    expect(machineSupportsRealtimeVoice(current)).toBe(true);
    expect(machineSupportsRealtimeVoiceContext(current)).toBe(true);
  });

  it('lets only a v3 daemon choose and list voices', () => {
    const v2 = { protocolCapabilities: { realtimeVoice: 2 } };
    const current = { protocolCapabilities: { realtimeVoice: REALTIME_VOICE_PROTOCOL_VERSION } };
    expect(machineSupportsRealtimeVoiceSelection(v2)).toBe(false);
    expect(machineSupportsRealtimeVoiceContext(v2)).toBe(true);
    expect(machineSupportsRealtimeVoiceSelection(current)).toBe(true);
  });

  it('lets only a v4 daemon sign Gemini tokens, with a strict request and answer', () => {
    expect(machineSupportsGeminiVoice({ protocolCapabilities: { realtimeVoice: 3 } })).toBe(false);
    expect(
      machineSupportsGeminiVoice({
        protocolCapabilities: { realtimeVoice: REALTIME_VOICE_PROTOCOL_VERSION },
      })
    ).toBe(true);
    const request = { action: 'geminiToken', mode: 'conversation' };
    expect(MachineVoiceRequestSchema.safeParse(request).success).toBe(true);
    expect(MachineVoiceRequestSchema.safeParse({ ...request, apiKey: 'x' }).success).toBe(false);
    const answer = {
      success: true,
      action: 'geminiToken',
      token: 'auth_tokens/abc',
      model: 'gemini-3.8-live',
      expireTime: '2026-11-07T12:30:00.000Z',
      newSessionExpireTime: '2026-11-07T12:01:00.000Z',
    };
    expect(MachineVoiceResponseSchema.safeParse(answer).success).toBe(true);
    expect(MachineVoiceResponseSchema.safeParse({ ...answer, token: '' }).success).toBe(false);
  });

  it('accepts a voice and a voice list request, which the v2 schema would reject', () => {
    const start = { action: 'start', configId: 'cfg', mode: 'conversation', sdp: 'offer' };
    expect(MachineVoiceRequestSchema.safeParse({ ...start, voice: 'cove' }).success).toBe(true);
    // The removed preview call of builds lan.25-26 is an invalid request now.
    expect(MachineVoiceRequestSchema.safeParse({ ...start, mode: 'preview' }).success).toBe(false);
    expect(MachineVoiceRequestSchema.safeParse({ action: 'voices', configId: 'cfg' }).success).toBe(
      true
    );
    expect(MachineVoiceRequestSchema.safeParse({ ...start, voice: 'Cove; rm' }).success).toBe(
      false
    );
  });

  it('accepts a start with background, which the v1 schema would reject', () => {
    const start = { action: 'start', configId: 'cfg', mode: 'conversation', sdp: 'offer' };
    expect(MachineVoiceRequestSchema.safeParse({ ...start, context: 'User: hi' }).success).toBe(
      true
    );
    expect(
      MachineVoiceRequestSchema.safeParse({ ...start, context: 'x'.repeat(16_001) }).success
    ).toBe(false);
  });
});
