import { codeNavError, type CodeNavQueryResponse } from '@lody/shared';
import { AstGrepCodeNavProvider } from './ast-grep-provider';
import type {
  CodeNavWorkerChildMessage,
  CodeNavWorkerParentMessage,
} from './code-nav-worker-protocol';

/**
 * Isolated recyclable worker process for AST code navigation.
 *
 * Keeping `@ast-grep/napi` in a dedicated child process ensures that shutting
 * the worker down after an idle period returns 100% of the Rust native heap
 * RSS back to the OS, and isolates native crashes/OOMs from the main daemon.
 */
const provider = new AstGrepCodeNavProvider();
const inFlightControllers = new Map<number, AbortController>();

function send(message: CodeNavWorkerChildMessage): void {
  if (process.connected && typeof process.send === 'function') {
    process.send(message);
  }
}

async function handleQuery(
  message: Extract<CodeNavWorkerParentMessage, { type: 'code-nav/query' }>
): Promise<void> {
  const controller = new AbortController();
  inFlightControllers.set(message.id, controller);
  let response: CodeNavQueryResponse;
  try {
    switch (message.action) {
      case 'diff-outline':
        response = await provider.diffOutline(message.input, controller.signal);
        break;
      case 'enclosing':
        response = await provider.enclosing(message.input, controller.signal);
        break;
      case 'definition':
        response = await provider.definitions(message.input, controller.signal);
        break;
      case 'callers':
        response = await provider.callers(message.input, controller.signal);
        break;
    }
  } catch (error) {
    if (controller.signal.aborted) {
      response = codeNavError('timeout', {
        message: 'Code navigation query timed out.',
        retryable: true,
      });
    } else {
      response = codeNavError('transient_io', {
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      });
    }
  } finally {
    inFlightControllers.delete(message.id);
  }
  send({ type: 'code-nav/result', id: message.id, response });
}

function shutdown(): void {
  for (const controller of inFlightControllers.values()) {
    controller.abort();
  }
  inFlightControllers.clear();
  provider.clearCaches();
  process.exitCode = 0;
  if (process.connected) {
    process.disconnect?.();
  }
}

process.on('message', (raw: unknown) => {
  if (!raw || typeof raw !== 'object' || !('type' in raw)) return;
  const message = raw as CodeNavWorkerParentMessage;
  if (message.type === 'code-nav/shutdown') {
    shutdown();
    return;
  }
  if (message.type === 'code-nav/cancel') {
    inFlightControllers.get(message.id)?.abort();
    return;
  }
  if (message.type === 'code-nav/query') {
    void handleQuery(message);
  }
});

process.on('disconnect', () => {
  shutdown();
});
