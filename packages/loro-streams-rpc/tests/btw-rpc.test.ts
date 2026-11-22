import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MachineId, SessionBtwProgress, SessionBtwRequest, WorkspaceId } from '@lody/shared';
import {
  isDirectRpcMethod,
  LoroStreamsMachineRpcClient,
  LoroStreamsMachineRpcServer,
  type LoroJsonLiveBatchHandler,
  type LoroJsonStreamBatch,
  type LoroStreamsJsonStreamClient,
} from '../src/index';

const createSilentLogger = () => ({
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
});

/** In-memory Loro Streams pub/sub connecting one client and one server cleanly. */
const createInMemoryStreams = () => {
  const subscribers = new Map<
    string,
    Array<{
      queue: LoroJsonStreamBatch[];
      waiter?: (batch: LoroJsonStreamBatch) => void;
    }>
  >();
  let seq = 0;

  const publish = (streamId: string, value: unknown) => {
    seq += 1;
    const batch: LoroJsonStreamBatch = {
      messages: [value],
      nextOffset: String(seq),
      upToDate: true,
    };
    const list = subscribers.get(streamId) ?? [];
    for (const sub of list) {
      if (sub.waiter) {
        const wake = sub.waiter;
        sub.waiter = undefined;
        wake(batch);
      } else {
        sub.queue.push(batch);
      }
    }
  };

  const appended: Array<{ streamId: string; value: unknown }> = [];
  const streamClient: LoroStreamsJsonStreamClient = {
    ensureJsonStream: vi.fn(async () => {}),
    appendJson: vi.fn(async (streamId: string, value: unknown) => {
      appended.push({ streamId, value });
      publish(streamId, value);
      return String(seq);
    }),
    readJsonLive: vi.fn(
      async (
        streamId: string,
        _state,
        onBatch: LoroJsonLiveBatchHandler,
        options?: { signal?: AbortSignal }
      ) => {
        const entry: {
          queue: LoroJsonStreamBatch[];
          waiter?: (batch: LoroJsonStreamBatch) => void;
        } = { queue: [] };
        const list = subscribers.get(streamId) ?? [];
        list.push(entry);
        subscribers.set(streamId, list);
        try {
          while (!options?.signal?.aborted) {
            const next =
              entry.queue.shift() ??
              (await new Promise<LoroJsonStreamBatch>((resolve, reject) => {
                const onAbort = () => {
                  entry.waiter = undefined;
                  reject(new Error('aborted'));
                };
                options?.signal?.addEventListener('abort', onAbort, { once: true });
                entry.waiter = (batch) => {
                  options?.signal?.removeEventListener('abort', onAbort);
                  resolve(batch);
                };
              }));
            await onBatch(next);
          }
        } finally {
          const current = subscribers.get(streamId);
          if (current) {
            const idx = current.indexOf(entry);
            if (idx !== -1) current.splice(idx, 1);
          }
        }
      }
    ),
  };

  return { streamClient, appended };
};

describe('session/btw Streams RPC', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const stop of cleanups.splice(0)) {
      stop();
    }
  });

  it('keeps session/btw off DIRECT_RPC_METHODS so streaming always uses Streams RPC', () => {
    expect(isDirectRpcMethod('session/btw')).toBe(false);
  });

  it('streams status and delta progress frames in order before resolving final response', async () => {
    const { streamClient } = createInMemoryStreams();
    const workspaceId = 'ws-btw' as WorkspaceId;
    const machineId = 'machine-btw' as MachineId;

    const receivedRequests: SessionBtwRequest[] = [];
    const server = new LoroStreamsMachineRpcServer({
      workspaceId,
      machineId,
      logger: createSilentLogger(),
      streamClient,
      getMachineStatus: vi.fn(),
      refreshMachineAcpCapabilities: vi.fn(),
      handleSessionBtw: async (request, { onProgress }) => {
        receivedRequests.push(request);
        if (request.action === 'ask') {
          onProgress?.({ btwId: request.btwId, kind: 'status', status: 'starting' });
          onProgress?.({
            btwId: request.btwId,
            kind: 'status',
            status: 'streaming',
            modelId: 'gemini-4-hydrogen',
            modelLabel: 'Hydrogen · Low',
          });
          onProgress?.({
            btwId: request.btwId,
            kind: 'delta',
            delta: 'First ',
            modelId: 'gemini-4-hydrogen',
            modelLabel: 'Hydrogen · Low',
          });
          onProgress?.({
            btwId: request.btwId,
            kind: 'delta',
            delta: 'second',
            modelId: 'gemini-4-hydrogen',
            modelLabel: 'Hydrogen · Low',
          });
          return {
            btwId: request.btwId,
            text: 'First second',
            modelId: 'gemini-4-hydrogen',
            modelLabel: 'Hydrogen · Low',
            readOnlyTools: false,
          };
        }
        return { btwId: request.btwId, text: '', cancelled: request.action === 'cancel' };
      },
    });
    const client = new LoroStreamsMachineRpcClient({
      workspaceId,
      machineId,
      streamClient,
    });
    cleanups.push(() => {
      client.stop();
      server.stop();
    });

    await server.start();
    await client.start();

    const progressFrames: SessionBtwProgress[] = [];
    const response = await client.requestSessionBtw({
      request: {
        action: 'ask',
        sessionId: 'sess-1',
        btwId: 'btw-rpc-1',
        question: 'Hello over Streams?',
        readOnlyTools: false,
      },
      onProgress: (frame) => progressFrames.push(frame),
    });

    expect(progressFrames).toEqual([
      { btwId: 'btw-rpc-1', kind: 'status', status: 'starting' },
      {
        btwId: 'btw-rpc-1',
        kind: 'status',
        status: 'streaming',
        modelId: 'gemini-4-hydrogen',
        modelLabel: 'Hydrogen · Low',
      },
      {
        btwId: 'btw-rpc-1',
        kind: 'delta',
        delta: 'First ',
        modelId: 'gemini-4-hydrogen',
        modelLabel: 'Hydrogen · Low',
      },
      {
        btwId: 'btw-rpc-1',
        kind: 'delta',
        delta: 'second',
        modelId: 'gemini-4-hydrogen',
        modelLabel: 'Hydrogen · Low',
      },
    ]);
    expect(response).toEqual({
      btwId: 'btw-rpc-1',
      text: 'First second',
      modelId: 'gemini-4-hydrogen',
      modelLabel: 'Hydrogen · Low',
      readOnlyTools: false,
    });

    const closed = await client.requestSessionBtw({
      request: { action: 'close', sessionId: 'sess-1', btwId: 'btw-rpc-1' },
    });
    expect(closed).toEqual({ btwId: 'btw-rpc-1', text: '', cancelled: false });
    expect(receivedRequests.map((r) => r.action)).toEqual(['ask', 'close']);
  });

  it('forwards remote cancel when the ask AbortSignal aborts', async () => {
    const { streamClient } = createInMemoryStreams();
    const workspaceId = 'ws-btw' as WorkspaceId;
    const machineId = 'machine-btw' as MachineId;

    let releaseAsk!: () => void;
    let askStarted!: () => void;
    const askStartedPromise = new Promise<void>((resolve) => {
      askStarted = resolve;
    });
    let cancelReceived!: () => void;
    const cancelReceivedPromise = new Promise<void>((resolve) => {
      cancelReceived = resolve;
    });

    const server = new LoroStreamsMachineRpcServer({
      workspaceId,
      machineId,
      logger: createSilentLogger(),
      streamClient,
      getMachineStatus: vi.fn(),
      refreshMachineAcpCapabilities: vi.fn(),
      handleSessionBtw: async (request) => {
        if (request.action === 'ask') {
          askStarted();
          await new Promise<void>((resolve) => {
            releaseAsk = resolve;
          });
          return { btwId: request.btwId, text: '', cancelled: true };
        }
        if (request.action === 'cancel') {
          cancelReceived();
          releaseAsk?.();
          return { btwId: request.btwId, text: '', cancelled: true };
        }
        return { btwId: request.btwId, text: '' };
      },
    });
    const client = new LoroStreamsMachineRpcClient({
      workspaceId,
      machineId,
      streamClient,
    });
    cleanups.push(() => {
      client.stop();
      server.stop();
    });

    await server.start();
    await client.start();

    const abortController = new AbortController();
    const askPromise = client.requestSessionBtw({
      request: {
        action: 'ask',
        sessionId: 'sess-1',
        btwId: 'btw-abort-1',
        question: 'Slow question',
      },
      signal: abortController.signal,
    });

    await askStartedPromise;
    abortController.abort();

    expect(await askPromise).toBeNull();
    await cancelReceivedPromise;
  });

  it('returns an error response when the machine does not register handleSessionBtw', async () => {
    const { streamClient } = createInMemoryStreams();
    const workspaceId = 'ws-btw' as WorkspaceId;
    const machineId = 'machine-btw' as MachineId;

    const server = new LoroStreamsMachineRpcServer({
      workspaceId,
      machineId,
      logger: createSilentLogger(),
      streamClient,
      getMachineStatus: vi.fn(),
      refreshMachineAcpCapabilities: vi.fn(),
    });
    const client = new LoroStreamsMachineRpcClient({
      workspaceId,
      machineId,
      streamClient,
    });
    cleanups.push(() => {
      client.stop();
      server.stop();
    });

    await server.start();
    await client.start();

    const response = await client.requestSessionBtw({
      request: {
        action: 'ask',
        sessionId: 'sess-1',
        btwId: 'btw-unavail',
        question: 'hi',
      },
    });
    expect(response).toMatchObject({
      btwId: 'btw-unavail',
      text: '',
      error: expect.stringContaining('not available'),
    });
  });
});
