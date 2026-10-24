import {
  machineSupportsLanIosSimulator,
  type IosSimulatorRequest,
  type IosSimulatorResponse,
  type LanMemberControlRequest,
  type LanMemberControlResponse,
  type MachineId,
  type MachineMeta,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';
import type { LanMemberPorts } from '@/preview/lan-member-ports';
import { formatErrorMessage } from '@/utils/format-error';

/**
 * A simulator command of this machine's desktop for a session another member
 * of the LAN runs. The member carries it out as one from its own desktop, so
 * its viewer listens on its own loopback; a port of this machine with the
 * same number carries the viewer here. The viewer checks that its page comes
 * from the address it serves, so the number cannot change on the way.
 */
export async function forwardIosSimulatorControl(options: {
  params: IosSimulatorRequest;
  workspaceId: WorkspaceId;
  memberId: MachineId;
  /** What the member says about itself; `undefined` when this replica has nothing. */
  member: MachineMeta | undefined;
  ask: (request: LanMemberControlRequest) => Promise<LanMemberControlResponse>;
  ports: LanMemberPorts;
}): Promise<IosSimulatorResponse> {
  const { params, memberId, member, ports } = options;
  const sessionId = params.sessionId as SessionId;
  const failure = (
    error: NonNullable<IosSimulatorResponse['error']>,
    message: string
  ): IosSimulatorResponse => ({
    type: 'ios-simulator/control_response',
    sessionId,
    success: false,
    error,
    message,
  });
  if (!machineSupportsLanIosSimulator(member)) {
    return failure(
      'unsupported',
      `Update Lody on ${member?.name ?? 'that machine'} to preview its simulators.`
    );
  }
  const answer = await options.ask({
    type: 'lan/ios-simulator',
    machineId: memberId,
    workspaceId: options.workspaceId,
    sessionId,
    requestedByUserId: params.requestedByUserId,
    command: params.command,
  });
  if (!answer.ok) return failure('failed', answer.message);
  if (answer.type !== 'lan/ios-simulator') {
    return failure('failed', 'The machine answered something else.');
  }
  const response = answer.result;
  const viewerUrl = response.preview?.viewerUrl;
  if (!viewerUrl) {
    if (
      (params.command.action === 'stop' && response.success) ||
      response.preview?.phase === 'closed' ||
      response.preview?.phase === 'failed'
    ) {
      await ports.release(sessionId);
    }
    return response;
  }
  const port = Number(new URL(viewerUrl).port);
  try {
    const carried = await ports.open(sessionId, memberId, { host: '127.0.0.1', port });
    if (carried !== port) {
      await ports.release(sessionId);
      return failure(
        'failed',
        `Port ${port} is in use on this machine. Stop the preview and start it again.`
      );
    }
  } catch (error) {
    return failure('failed', formatErrorMessage(error));
  }
  return response;
}
