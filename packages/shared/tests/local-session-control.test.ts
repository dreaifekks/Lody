import { LanFileRangeRequestSchema, LocalFileRangeRequestSchema } from '../src/lan-file-range';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import {
  safeParseLocalSessionControlRequest,
  SessionFileUploadResponseSchema,
  SessionImageUploadResponseSchema,
} from '../src/message-schemas';
import {
  isLocalSessionControlRequest,
  isLocalSessionControlResponse,
} from '../src/node/local-session-control';

const require = createRequire(import.meta.url);
const {
  isLocalSessionControlRequest: isLocalSessionControlRequestCjs,
  isLocalSessionControlResponse: isLocalSessionControlResponseCjs,
} = require('../src/node/local-session-control.cjs') as {
  isLocalSessionControlRequest: (value: unknown) => boolean;
  isLocalSessionControlResponse: (value: unknown) => boolean;
};

describe('local session control node validators', () => {
  it('transports local DSH Provider discovery without workspace or launch inputs', () => {
    const request = { type: 'machine/dsh-providers', machineId: 'machine-1' };
    const response = {
      type: 'machine/dsh-providers_response',
      providers: [{ id: 'provider-1', name: 'DSH' }],
    };
    for (const validate of [isLocalSessionControlRequest, isLocalSessionControlRequestCjs]) {
      expect(validate(request)).toBe(true);
      expect(validate({ ...request, command: 'arbitrary' })).toBe(false);
    }
    for (const validate of [isLocalSessionControlResponse, isLocalSessionControlResponseCjs]) {
      expect(validate(response)).toBe(true);
      expect(validate({ ...response, providers: [{ id: 1 }] })).toBe(false);
    }
  });

  it('accepts builtin Sorbet sessions in TS and CJS validators', () => {
    const request = {
      type: 'session/create',
      sessionId: 'session-builtin',
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      acpSessionConfig: {
        cliType: 'builtin',
        agentType: 'sorbet',
        prompt: 'hello',
      },
      userId: 'user-1',
      userName: 'Test User',
      userEmail: 'test@example.com',
    };
    expect(isLocalSessionControlRequest(request)).toBe(true);
    expect(isLocalSessionControlRequestCjs(request)).toBe(true);
  });

  it('accepts up to 8 image upload paths and rejects 9', () => {
    const baseRequest = {
      type: 'session/image-upload',
      machineId: 'machine-1',
      sessionId: 'session-1',
    };

    expect(
      isLocalSessionControlRequest({
        ...baseRequest,
        paths: Array.from({ length: 8 }, (_, index) => `/tmp/screenshot-${index}.png`),
      })
    ).toBe(true);
    expect(
      isLocalSessionControlRequest({
        ...baseRequest,
        paths: Array.from({ length: 9 }, (_, index) => `/tmp/screenshot-${index}.png`),
      })
    ).toBe(false);
    expect(
      isLocalSessionControlRequestCjs({
        ...baseRequest,
        paths: Array.from({ length: 8 }, (_, index) => `/tmp/screenshot-${index}.png`),
      })
    ).toBe(true);
    expect(
      isLocalSessionControlRequestCjs({
        ...baseRequest,
        paths: Array.from({ length: 9 }, (_, index) => `/tmp/screenshot-${index}.png`),
      })
    ).toBe(false);
  });

  it('accepts up to 8 file upload paths and rejects 9 (ts + cjs)', () => {
    const base = {
      type: 'session/file-upload',
      machineId: 'machine-1',
      sessionId: 'session-1',
    };
    const eight = { ...base, paths: Array.from({ length: 8 }, (_, i) => `/tmp/f${i}.bin`) };
    const nine = { ...base, paths: Array.from({ length: 9 }, (_, i) => `/tmp/f${i}.bin`) };
    expect(isLocalSessionControlRequest(eight)).toBe(true);
    expect(isLocalSessionControlRequestCjs(eight)).toBe(true);
    expect(isLocalSessionControlRequest(nine)).toBe(false);
    expect(isLocalSessionControlRequestCjs(nine)).toBe(false);
  });

  it('accepts files kept by the machine where no relay store exists (ts + cjs + zod)', () => {
    const kept = {
      type: 'file',
      fileId: 'file-1',
      fileName: 'shot.png',
      mimeType: 'image/png',
      sizeBytes: 2048,
      sha256: 'a'.repeat(64),
      textPreview: false,
      transport: 'local',
      machineId: 'machine-1',
      uploadedAt: 1_700_000_000_000,
    };
    const fileResponse = {
      type: 'session/file-upload_response',
      sessionId: 'session-1',
      success: true,
      files: [kept],
    };
    const imageResponse = {
      type: 'session/image-upload_response',
      sessionId: 'session-1',
      success: true,
      files: [kept],
    };
    // A relay upload still has to say where it can be downloaded.
    const relayWithoutUrl = { ...fileResponse, files: [{ ...kept, transport: 'r2' }] };
    for (const validate of [isLocalSessionControlResponse, isLocalSessionControlResponseCjs]) {
      expect(validate(fileResponse)).toBe(true);
      expect(validate(imageResponse)).toBe(true);
      expect(validate(relayWithoutUrl)).toBe(false);
    }
    expect(SessionFileUploadResponseSchema.safeParse(fileResponse).success).toBe(true);
    expect(SessionImageUploadResponseSchema.safeParse(imageResponse).success).toBe(true);
    expect(SessionFileUploadResponseSchema.safeParse(relayWithoutUrl).success).toBe(false);
  });

  it('rejects file-send-local responses whose local block omits machineId (ts + cjs)', () => {
    const response = {
      type: 'session/file-send-local_response',
      sessionId: 'session-1',
      success: true,
      files: [
        {
          type: 'file',
          fileId: 'file-1',
          fileName: 'build.log',
          mimeType: 'text/plain',
          sizeBytes: 2048,
          sha256: 'a'.repeat(64),
          textPreview: false,
          transport: 'local',
          uploadedAt: 1_700_000_000_000,
        },
      ],
    };
    expect(isLocalSessionControlResponse(response)).toBe(false);
    expect(isLocalSessionControlResponseCjs(response)).toBe(false);
  });

  it('accepts config-bound capability refresh and rejects launch fields in ts and cjs', () => {
    const request = {
      type: 'machine/acp-capabilities-refresh' as const,
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      configId: 'config-1',
    };

    expect(isLocalSessionControlRequest(request)).toBe(true);
    expect(isLocalSessionControlRequestCjs(request)).toBe(true);
    expect(
      isLocalSessionControlRequest({
        ...request,
        customAcp: { command: '/tmp/untrusted-acp' },
        env: { ACP_PROVIDER_TOKEN: 'attacker-controlled' },
      })
    ).toBe(false);
    expect(
      isLocalSessionControlRequestCjs({
        ...request,
        customAcp: { command: '/tmp/untrusted-acp' },
        env: { ACP_PROVIDER_TOKEN: 'attacker-controlled' },
      })
    ).toBe(false);
  });
});

it('routes Provider quota refresh by persisted config only in both local validators', () => {
  const request = {
    type: 'machine/provider-rate-limits-refresh',
    machineId: 'm',
    workspaceId: 'w',
    configId: 'c',
  };
  for (const validate of [isLocalSessionControlRequest, isLocalSessionControlRequestCjs]) {
    expect(validate(request)).toBe(true);
    expect(validate({ ...request, configId: '' })).toBe(false);
    expect(validate({ ...request, env: { KEY: 'synthetic' } })).toBe(false);
    expect(validate({ ...request, customAcp: { command: 'example' } })).toBe(false);
  }
  for (const validate of [isLocalSessionControlResponse, isLocalSessionControlResponseCjs]) {
    expect(
      validate({
        type: 'machine/provider-rate-limits-refresh_response',
        machineId: 'm',
        configId: 'c',
        success: true,
      })
    ).toBe(true);
    expect(
      validate({
        type: 'machine/provider-rate-limits-refresh_response',
        machineId: 'm',
        configId: 'c',
        success: 'yes',
      })
    ).toBe(false);
  }
});

it('keeps the selected project-member root across local and LAN range requests', () => {
  const request = {
    type: 'range',
    sessionId: 'session-1',
    path: 'README.md',
    rootId: 'member:repo-2',
    offset: 0,
    length: 64,
  };
  expect(LanFileRangeRequestSchema.parse(request)).toEqual(request);
  const local = { ...request, workspaceId: 'workspace-1', machineId: 'machine-1' };
  expect(LocalFileRangeRequestSchema.parse(local)).toEqual(local);
  expect(LanFileRangeRequestSchema.safeParse({ ...request, rootId: '../outside' }).success).toBe(
    false
  );
  const { rootId: _root, ...legacy } = request;
  expect(LanFileRangeRequestSchema.parse(legacy)).toEqual(legacy);
});
