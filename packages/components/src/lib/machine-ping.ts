import type { MachineId, WorkspaceId } from '@lody/shared';
import type { WorkspaceRuntime } from '@/atoms/runtime';

export const createMachineRequestId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/**
 * Milliseconds for a machine to answer `machine/ping` through the workspace's
 * transport; rejects when it fails or does not answer within `timeoutMs`.
 */
export async function pingMachineWithRuntime(args: {
  runtime: WorkspaceRuntime;
  workspaceId: WorkspaceId;
  machineId: MachineId;
  timeoutMessage: string;
  failedMessage: string;
  timeoutMs?: number;
}): Promise<number> {
  const requestId = createMachineRequestId();
  const startedAt = performance.now();
  const responsePromise = args.runtime.waitForMachinePingResponse(args.machineId, requestId, {
    timeoutMs: args.timeoutMs ?? 30000,
  });
  args.runtime.sendControl({
    type: 'machine/ping',
    machineId: args.machineId,
    workspaceId: args.workspaceId,
    requestId,
  });
  const response = await responsePromise;
  if (!response) {
    throw new Error(args.timeoutMessage);
  }
  if (!response.success || response.message !== 'pong') {
    const errorMessage =
      typeof response.error === 'string' && response.error.length > 0
        ? response.error
        : args.failedMessage;
    throw new Error(errorMessage);
  }
  return Math.max(0, Math.round(performance.now() - startedAt));
}
