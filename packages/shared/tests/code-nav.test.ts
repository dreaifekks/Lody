import { describe, expect, it } from 'vitest';
import {
  CODE_NAV_LIMITS,
  CODE_NAV_PROTOCOL_VERSION,
  CodeNavQueryRequestSchema,
  CodeNavQueryResponseSchema,
  CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
  MACHINE_PROTOCOL_CAPABILITIES,
  codeNavError,
  estimateCodeNavResponseBytes,
  isCodeNavError,
  machineSupportsCodeNav,
} from '../src/index';
import {
  LocalMachineRpcRequestSchema,
  LocalMachineRpcResponseSchema,
} from '../src/local-machine-rpc';
import {
  E2EE_READ_QUERY_METHODS,
  isE2eeFeatureMethod,
  isE2eeOwnerOnlyReadQuery,
  isE2eeReadQuery,
} from '../src/e2ee-rpc';

describe('code-nav shared protocol', () => {
  it('advertises and checks the codeNav v1 capability', () => {
    expect(MACHINE_PROTOCOL_CAPABILITIES.codeNav).toBe('codeNav');
    expect(CURRENT_MACHINE_PROTOCOL_CAPABILITIES.codeNav).toBe(CODE_NAV_PROTOCOL_VERSION);
    expect(machineSupportsCodeNav({ protocolCapabilities: { codeNav: 1 } })).toBe(true);
    expect(machineSupportsCodeNav({ protocolCapabilities: {} })).toBe(false);
    expect(machineSupportsCodeNav(null)).toBe(false);
  });

  it('validates all four discriminated action requests and rejects unknown fields', () => {
    const validRequests = [
      {
        action: 'diff-outline',
        sessionId: 'sess-1',
        scope: 'branch',
        baseRef: 'origin/main',
      },
      {
        action: 'enclosing',
        sessionId: 'sess-1',
        path: 'src/app.ts',
        startLine: 10,
        endLine: 25,
      },
      {
        action: 'definition',
        sessionId: 'sess-1',
        path: 'src/app.ts',
        line: 12,
        character: 8,
        symbolHint: 'resolveMcp',
      },
      {
        action: 'callers',
        sessionId: 'sess-1',
        path: 'src/app.ts',
        line: 12,
        character: 8,
        maxDepth: 2,
        limit: 40,
      },
    ] as const;

    for (const req of validRequests) {
      expect(CodeNavQueryRequestSchema.parse(req)).toEqual(req);
      expect(
        LocalMachineRpcRequestSchema.parse({
          machineId: 'm-1',
          workspaceId: 'w-1',
          method: 'code-nav/query',
          params: req,
        }).method
      ).toBe('code-nav/query');
    }

    expect(
      CodeNavQueryRequestSchema.safeParse({
        action: 'callers',
        sessionId: 'sess-1',
        path: 'src/app.ts',
        line: 12,
        character: 8,
        maxDepth: 3,
      }).success
    ).toBe(false);

    expect(
      CodeNavQueryRequestSchema.safeParse({
        action: 'definition',
        sessionId: 'sess-1',
        path: 'src/app.ts',
        line: 0,
        character: 0,
      }).success
    ).toBe(false);

    expect(
      CodeNavQueryRequestSchema.safeParse({
        action: 'enclosing',
        sessionId: 'sess-1',
        path: 'src/app.ts',
        startLine: 1,
        endLine: 2,
        extra: true,
      }).success
    ).toBe(false);
  });

  it('validates ok and error responses and enforces hard limit constants', () => {
    expect(CODE_NAV_LIMITS.maxResponseBytes).toBeLessThanOrEqual(256 * 1024);

    const diffOk = CodeNavQueryResponseSchema.parse({
      type: 'code-nav/query',
      status: 'ok',
      action: 'diff-outline',
      files: [
        {
          path: 'src/foo.ts',
          symbols: [
            {
              name: 'runTask',
              kind: 'function',
              startLine: 5,
              endLine: 20,
              hunkCount: 1,
            },
          ],
          hunks: [
            {
              startLine: 10,
              endLine: 12,
              enclosing: {
                name: 'runTask',
                kind: 'function',
                startLine: 5,
                endLine: 20,
              },
            },
          ],
        },
      ],
      truncated: false,
      provider: 'ast-grep',
    });
    expect(isCodeNavError(diffOk)).toBe(false);
    expect(estimateCodeNavResponseBytes(diffOk)).toBeGreaterThan(0);

    const defOk = CodeNavQueryResponseSchema.parse({
      type: 'code-nav/query',
      status: 'ok',
      action: 'definition',
      symbol: 'runTask',
      items: [
        {
          path: 'src/foo.ts',
          line: 5,
          character: 16,
          name: 'runTask',
          kind: 'function',
          previewLine: 'export function runTask() {',
        },
      ],
      confidence: 'exact',
      totalCandidates: 1,
      truncated: false,
      provider: 'ast-grep',
    });
    expect(LocalMachineRpcResponseSchema.parse({ ok: true, result: defOk })).toEqual({
      ok: true,
      result: defOk,
    });

    const err = codeNavError('unavailable', { message: 'missing binding' });
    expect(CodeNavQueryResponseSchema.parse(err)).toEqual(err);
    expect(isCodeNavError(err)).toBe(true);
    expect(LocalMachineRpcResponseSchema.parse({ ok: true, result: err })).toEqual({
      ok: true,
      result: err,
    });
  });

  it('registers code-nav/query on the E2EE read lane with owner-only authorization (never write journal or Guest)', () => {
    expect(isE2eeFeatureMethod('code-nav/query')).toBe(true);
    expect(E2EE_READ_QUERY_METHODS).toContain('code-nav/query');
    expect(isE2eeReadQuery('code-nav/query', {})).toBe(true);
    expect(isE2eeOwnerOnlyReadQuery('code-nav/query')).toBe(true);
    expect(isE2eeOwnerOnlyReadQuery('file/preview')).toBe(false);
  });
});
