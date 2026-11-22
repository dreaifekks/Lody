// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CodeNavDiffOutlineOk,
  CodeNavQueryRequest,
  CodeNavQueryResponse,
  MachineId,
  SessionId,
  WorkspaceId,
} from '@lody/shared';
import { runtimeAtom, type WorkspaceRuntime } from '../src/atoms/runtime';
import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom } from '../src/atoms/workspace-context';
import { createWorkspaceMachineRpcFacade } from '../src/providers/workspace-machine-rpc-facade';

const mockResolvedMachine = vi.hoisted(() => ({
  machine: null as { protocolCapabilities?: Record<string, number> } | null,
}));

vi.mock('../src/hooks/use-resolved-machine-meta', () => ({
  useResolvedMachineMeta: () => ({
    machine: mockResolvedMachine.machine,
    machineFlockRows: new Map(),
  }),
}));

import { useCodeNav, type UseCodeNavResult } from '../src/components/code-review/use-code-nav';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION_ID = 'sess-review-1' as SessionId;
const MACHINE_ID = 'machine-review-1' as MachineId;
const WORKSPACE_ID = 'ws-review-1' as WorkspaceId;

const SAMPLE_OUTLINE: CodeNavDiffOutlineOk = {
  type: 'code-nav/query',
  status: 'ok',
  action: 'diff-outline',
  headSha: 'abc1234',
  files: [
    {
      path: 'apps/cli/src/agent/session-mcp-resolver.ts',
      symbols: [
        {
          name: 'loadSessionMcpCatalog',
          kind: 'function',
          startLine: 88,
          endLine: 105,
          hunkCount: 1,
        },
      ],
      hunks: [],
    },
  ],
  truncated: false,
  provider: 'ast-grep',
};

describe('useCodeNav capability gating & caching', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mockResolvedMachine.machine = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  function mountHook(
    store: ReturnType<typeof createStore>,
    initialProps?: Partial<Parameters<typeof useCodeNav>[0]>
  ) {
    let latest!: UseCodeNavResult;
    function Probe({ props }: { props: Parameters<typeof useCodeNav>[0] }) {
      latest = useCodeNav(props);
      return null;
    }
    const baseProps: Parameters<typeof useCodeNav>[0] = {
      sessionId: SESSION_ID,
      machineId: MACHINE_ID,
      ...initialProps,
    };
    const render = async (override?: Partial<Parameters<typeof useCodeNav>[0]>) => {
      await act(async () => {
        root.render(
          createElement(
            Provider,
            { store },
            createElement(Probe, { props: { ...baseProps, ...override } })
          )
        );
      });
    };
    return { render, get: () => latest };
  }

  function createRuntimeStore(
    queryCodeNav: (
      machineId: MachineId,
      request: CodeNavQueryRequest,
      options?: { readonly ownerSessionId?: SessionId }
    ) => Promise<CodeNavQueryResponse>
  ) {
    const store = createStore();
    store.set(currentWorkspaceIdAtom, WORKSPACE_ID);
    store.set(currentWorkspaceSlugAtom, 'review-ws');
    store.set(runtimeAtom, {
      workspaceId: WORKSPACE_ID,
      workspaceSlug: 'review-ws',
      queryCodeNav,
    } as unknown as WorkspaceRuntime);
    return store;
  }

  it('silently degrades without firing RPC when the target machine lacks codeNav >= 1', async () => {
    const queryCodeNav =
      vi.fn<
        (machineId: MachineId, request: CodeNavQueryRequest) => Promise<CodeNavQueryResponse>
      >();
    const store = createRuntimeStore(queryCodeNav);
    mockResolvedMachine.machine = { protocolCapabilities: { codeCollabDiffBlobs: 1 } };

    const harness = mountHook(store);
    await harness.render();

    expect(harness.get().supported).toBe(false);
    expect(await harness.get().queryDiffOutline('branch')).toBeNull();
    expect(
      await harness.get().queryDefinition({ path: 'a.ts', line: 10, character: 2 })
    ).toBeNull();
    expect(queryCodeNav).not.toHaveBeenCalled();
  });

  it('caches identical ok responses, dedupes concurrent requests, and allows transient retries', async () => {
    let resolveDeferred!: (value: CodeNavQueryResponse) => void;
    const queryCodeNav = vi
      .fn<(machineId: MachineId, request: CodeNavQueryRequest) => Promise<CodeNavQueryResponse>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveDeferred = resolve;
          })
      )
      .mockResolvedValueOnce({
        type: 'code-nav/query',
        status: 'error',
        code: 'timeout',
        retryable: true,
      })
      .mockResolvedValueOnce({
        type: 'code-nav/query',
        status: 'ok',
        action: 'definition',
        symbol: 'resolveSessionMcpServers',
        items: [],
        confidence: 'exact',
        truncated: false,
        provider: 'ast-grep',
      });

    const store = createRuntimeStore(queryCodeNav);
    mockResolvedMachine.machine = { protocolCapabilities: { codeNav: 1 } };

    const harness = mountHook(store);
    await harness.render();
    expect(harness.get().supported).toBe(true);

    // Two concurrent identical requests collapse to one RPC call.
    const p1 = harness.get().queryDiffOutline('branch');
    const p2 = harness.get().queryDiffOutline('branch');
    expect(queryCodeNav).toHaveBeenCalledTimes(1);
    resolveDeferred(SAMPLE_OUTLINE);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(SAMPLE_OUTLINE);
    expect(r2).toEqual(SAMPLE_OUTLINE);

    // Subsequent identical request hits the in-memory cache.
    expect(await harness.get().queryDiffOutline('branch')).toEqual(SAMPLE_OUTLINE);
    expect(queryCodeNav).toHaveBeenCalledTimes(1);

    // Transient retryable error returns null without poisoning the cache.
    expect(
      await harness.get().queryDefinition({
        path: 'apps/cli/src/agent/session-mcp-resolver.ts',
        line: 94,
        character: 20,
        symbolHint: 'resolveSessionMcpServers',
      })
    ).toBeNull();
    expect(queryCodeNav).toHaveBeenCalledTimes(2);

    // Retry succeeds and is returned cleanly.
    const def = await harness.get().queryDefinition({
      path: 'apps/cli/src/agent/session-mcp-resolver.ts',
      line: 94,
      character: 20,
      symbolHint: 'resolveSessionMcpServers',
    });
    expect(def?.action).toBe('definition');
    expect(queryCodeNav).toHaveBeenCalledTimes(3);
  });

  it('passes parent ownerSessionId for child sessions while preserving child sessionId in the request payload', async () => {
    const queryCodeNav = vi.fn(async () => SAMPLE_OUTLINE);
    const store = createRuntimeStore(queryCodeNav);
    mockResolvedMachine.machine = { protocolCapabilities: { codeNav: 1 } };

    const childSessionId = 'sess-child-1' as SessionId;
    const parentSessionId = 'sess-parent-1' as SessionId;
    const harness = mountHook(store, {
      sessionId: childSessionId,
      ownerSessionId: parentSessionId,
    });
    await harness.render();

    await harness.get().queryDiffOutline('branch');
    expect(queryCodeNav).toHaveBeenCalledWith(
      MACHINE_ID,
      expect.objectContaining({
        action: 'diff-outline',
        sessionId: childSessionId,
        scope: 'branch',
      }),
      { ownerSessionId: parentSessionId }
    );
  });

  it('maps Project Group member paths to rootId and remaps returned locations back to display paths', async () => {
    const queryCodeNav = vi.fn(
      async (
        _machineId: MachineId,
        request: CodeNavQueryRequest
      ): Promise<CodeNavQueryResponse> => {
        if (request.action === 'diff-outline') {
          if (request.rootId === 'member:sdk') {
            return {
              type: 'code-nav/query',
              status: 'ok',
              action: 'diff-outline',
              files: [
                {
                  path: 'src/api.ts',
                  symbols: [
                    { name: 'fetchUser', kind: 'function', startLine: 1, endLine: 5, hunkCount: 1 },
                  ],
                  hunks: [],
                },
              ],
              truncated: false,
              provider: 'ast-grep',
            };
          }
          return SAMPLE_OUTLINE;
        }
        if (request.action === 'definition') {
          return {
            type: 'code-nav/query',
            status: 'ok',
            action: 'definition',
            symbol: 'fetchUser',
            items: [
              {
                path: 'src/client.ts',
                line: 12,
                character: 16,
                name: 'fetchUser',
                kind: 'function',
                previewLine: 'export function fetchUser() {',
              },
            ],
            confidence: 'exact',
            totalCandidates: 1,
            truncated: false,
            provider: 'ast-grep',
          };
        }
        if (request.action === 'callers') {
          return {
            type: 'code-nav/query',
            status: 'ok',
            action: 'callers',
            symbol: 'fetchUser',
            items: [
              {
                path: 'src/api.ts',
                line: 4,
                character: 10,
                previewLine: 'return fetchUser();',
                depth: 1,
              },
            ],
            totalCandidates: 1,
            truncated: false,
            provider: 'ast-grep',
          };
        }
        return {
          type: 'code-nav/query',
          status: 'ok',
          action: 'enclosing',
          path: request.path,
          chain: [{ name: 'fetchUser', kind: 'function', startLine: 1, endLine: 5 }],
          provider: 'ast-grep',
        };
      }
    );
    const store = createRuntimeStore(queryCodeNav);
    mockResolvedMachine.machine = { protocolCapabilities: { codeNav: 1 } };

    const projectRun = {
      members: {
        sdk: {
          access: 'additional',
          path: 'sdk',
          placement: { kind: 'root', dir: 'sdk' },
        },
      },
    } as unknown as NonNullable<Parameters<typeof useCodeNav>[0]['projectRun']>;

    const harness = mountHook(store, { projectRun });
    await harness.render();

    const outline = await harness.get().queryDiffOutline('branch', 'origin/main');
    expect(outline?.files.map((f) => f.path)).toEqual([
      'apps/cli/src/agent/session-mcp-resolver.ts',
      'sdk/src/api.ts',
    ]);
    // Member outline call must receive rootId and NOT inherit main repo's baseRef.
    expect(queryCodeNav).toHaveBeenCalledWith(
      MACHINE_ID,
      {
        action: 'diff-outline',
        sessionId: SESSION_ID,
        scope: 'branch',
        rootId: 'member:sdk',
      },
      { ownerSessionId: SESSION_ID }
    );

    const def = await harness.get().queryDefinition({
      path: 'sdk/src/api.ts',
      line: 4,
      character: 10,
      symbolHint: 'fetchUser',
    });
    expect(queryCodeNav).toHaveBeenCalledWith(
      MACHINE_ID,
      expect.objectContaining({
        action: 'definition',
        path: 'src/api.ts',
        rootId: 'member:sdk',
      }),
      { ownerSessionId: SESSION_ID }
    );
    expect(def?.items[0]?.path).toBe('sdk/src/client.ts');

    const callers = await harness.get().queryCallers({
      path: 'sdk/src/client.ts',
      line: 12,
      character: 16,
      symbolHint: 'fetchUser',
    });
    expect(callers?.items[0]?.path).toBe('sdk/src/api.ts');

    const enc = await harness.get().queryEnclosing('sdk/src/api.ts', 2, 3);
    expect(enc?.path).toBe('sdk/src/api.ts');
  });

  it('invalidates cache and discards stale in-flight replies when revision changes', async () => {
    let resolveFirst!: (value: CodeNavQueryResponse) => void;
    const queryCodeNav = vi
      .fn<
        (
          machineId: MachineId,
          request: CodeNavQueryRequest,
          options?: { readonly ownerSessionId?: SessionId }
        ) => Promise<CodeNavQueryResponse>
      >()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValueOnce({
        ...SAMPLE_OUTLINE,
        headSha: 'rev-2-sha',
      });

    const store = createRuntimeStore(queryCodeNav);
    mockResolvedMachine.machine = { protocolCapabilities: { codeNav: 1 } };

    const harness = mountHook(store, { revision: 'rev-1' });
    await harness.render();

    const firstPromise = harness.get().queryDiffOutline('branch');
    expect(queryCodeNav).toHaveBeenCalledTimes(1);

    // Diff refreshes to rev-2 while rev-1 outline is still in-flight.
    await harness.render({ revision: 'rev-2' });
    const secondResult = await harness.get().queryDiffOutline('branch');
    expect(secondResult?.headSha).toBe('rev-2-sha');
    expect(queryCodeNav).toHaveBeenCalledTimes(2);

    // Late rev-1 reply must be discarded as null rather than overwriting rev-2 cache.
    resolveFirst(SAMPLE_OUTLINE);
    expect(await firstPromise).toBeNull();
    expect((await harness.get().queryDiffOutline('branch'))?.headSha).toBe('rev-2-sha');
    expect(queryCodeNav).toHaveBeenCalledTimes(2);
  });
});

describe('WorkspaceMachineRpcFacade.queryCodeNav', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns typed unavailable error without network calls when machine lacks codeNav capability', async () => {
    const getMachineRpcClient = vi.fn();
    const facade = createWorkspaceMachineRpcFacade({
      workspaceId: WORKSPACE_ID,
      getMachineProtocolCapabilities: async () => ({ codeCollabDiffBlobs: 1 }),
      targetRouter: {
        getPlaneForMachine: () => 'cloud',
        resolvePlaneForMachine: async () => 'cloud',
      },
      getMachineRpcClient,
    });

    const response = await facade.queryCodeNav(MACHINE_ID, {
      action: 'diff-outline',
      sessionId: SESSION_ID,
      scope: 'branch',
    });
    expect(response).toMatchObject({
      type: 'code-nav/query',
      status: 'error',
      code: 'unavailable',
      retryable: false,
    });
    expect(getMachineRpcClient).not.toHaveBeenCalled();
  });

  it('dispatches remote code-nav/query over LoroStreamsMachineRpcClient when supported', async () => {
    const remoteQueryCodeNav = vi.fn(async () => SAMPLE_OUTLINE);
    const facade = createWorkspaceMachineRpcFacade({
      workspaceId: WORKSPACE_ID,
      getMachineProtocolCapabilities: async () => ({ codeNav: 1 }),
      targetRouter: {
        getPlaneForMachine: () => 'cloud',
        resolvePlaneForMachine: async () => 'cloud',
      },
      getMachineRpcClient: async () =>
        ({
          queryCodeNav: remoteQueryCodeNav,
        }) as never,
    });

    const response = await facade.queryCodeNav(MACHINE_ID, {
      action: 'diff-outline',
      sessionId: SESSION_ID,
      scope: 'branch',
    });
    expect(response).toEqual(SAMPLE_OUTLINE);
    expect(remoteQueryCodeNav).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'diff-outline',
        sessionId: SESSION_ID,
        ownerSessionId: SESSION_ID,
        scope: 'branch',
      })
    );
  });

  it('refuses E2EE Guest code-nav/query on protected workspaces without calling machine RPC', async () => {
    const getMachineRpcClient = vi.fn();
    const facade = createWorkspaceMachineRpcFacade({
      workspaceId: WORKSPACE_ID,
      protectedContent: true,
      protectedCodeCollabRole: () => 'read',
      getMachineProtocolCapabilities: async () => ({ codeNav: 1 }),
      targetRouter: {
        getPlaneForMachine: () => 'cloud',
        resolvePlaneForMachine: async () => 'cloud',
      },
      getMachineRpcClient,
    });

    const response = await facade.queryCodeNav(MACHINE_ID, {
      action: 'diff-outline',
      sessionId: SESSION_ID,
      scope: 'branch',
    });
    expect(response).toMatchObject({
      type: 'code-nav/query',
      status: 'error',
      code: 'permission_denied',
      retryable: false,
    });
    expect(getMachineRpcClient).not.toHaveBeenCalled();
  });
});
