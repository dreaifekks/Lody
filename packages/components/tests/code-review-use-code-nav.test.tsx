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

  function mountHook(store: ReturnType<typeof createStore>, sessionId = SESSION_ID) {
    let latest!: UseCodeNavResult;
    function Probe({ id }: { id: SessionId }) {
      latest = useCodeNav({ sessionId: id, machineId: MACHINE_ID });
      return null;
    }
    const render = async (id = sessionId) => {
      await act(async () => {
        root.render(createElement(Provider, { store }, createElement(Probe, { id })));
      });
    };
    return { render, get: () => latest };
  }

  function createRuntimeStore(
    queryCodeNav: (
      machineId: MachineId,
      request: CodeNavQueryRequest
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
});
