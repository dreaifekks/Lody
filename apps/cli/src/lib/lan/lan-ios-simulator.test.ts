import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MACHINE_PROTOCOL_CAPABILITIES,
  type IosSimulatorCommand,
  type IosSimulatorResponse,
  type LanMemberControlRequest,
  type LanMemberControlResponse,
  type MachineId,
  type MachineMeta,
  type WorkspaceId,
} from '@lody/shared';
import { LanMemberPorts, type MemberPortConnector } from '@/preview/lan-member-ports';
import { forwardIosSimulatorControl } from './lan-ios-simulator';

const silent = { debug: () => {} };
const SESSION = '0f6f6a43-2f7e-4c55-9d1b-0a3a8b1f2c11';
const OPERATION = '6b1f0c1e-9a51-4d1c-8f3e-0e4a9f6d7b22';
const UDID = '11111111-2222-4333-8444-555555555555';
const MEMBER = 'mini' as MachineId;

const mac = (capable: boolean): MachineMeta =>
  ({
    id: MEMBER,
    name: 'mini',
    os: 'darwin',
    protocolCapabilities: capable ? { [MACHINE_PROTOCOL_CAPABILITIES.lanIosSimulator]: 1 } : {},
  }) as unknown as MachineMeta;

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** The member's viewer: what reaches it comes back upper-cased. */
async function viewerServer(): Promise<net.Server> {
  const server = net.createServer((socket) =>
    socket.on('data', (data) => socket.write(data.toString().toUpperCase()))
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

const say = async (port: number, text: string): Promise<string> =>
  await new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
    socket.once('data', (data) => {
      resolve(data.toString());
      socket.destroy();
    });
    socket.once('error', reject);
  });

const listens = async (port: number): Promise<boolean> =>
  await new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

const preview = (
  phase: 'ready' | 'closed',
  viewerUrl?: string
): IosSimulatorResponse['preview'] => ({
  operationId: OPERATION,
  udid: UDID,
  phase,
  transport: 'local',
  ...(viewerUrl ? { viewerUrl } : {}),
});

/** A member that answers every simulator command with `answer`. */
const member =
  (answer: (command: IosSimulatorCommand) => IosSimulatorResponse) =>
  async (request: LanMemberControlRequest): Promise<LanMemberControlResponse> => {
    if (request.type !== 'lan/ios-simulator') throw new Error(`unexpected ${request.type}`);
    return { ok: true, type: request.type, result: answer(request.command) };
  };

describe('simulator commands for a session another member runs', () => {
  const closing: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of closing.splice(0)) await close();
  });

  const setup = async () => {
    const viewer = await viewerServer();
    closing.push(async () => await new Promise<void>((resolve) => viewer.close(() => resolve())));
    // Stands in for the LAN tunnel: the member connects to its own viewer.
    const connect: MemberPortConnector = async () =>
      net.connect((viewer.address() as net.AddressInfo).port, '127.0.0.1');
    const ports = new LanMemberPorts({ logger: silent, connect });
    closing.push(async () => await ports.closeAll());
    return ports;
  };

  const forward = (
    ports: LanMemberPorts,
    command: IosSimulatorCommand,
    ask: (request: LanMemberControlRequest) => Promise<LanMemberControlResponse>,
    capable = true
  ) =>
    forwardIosSimulatorControl({
      params: { sessionId: SESSION, requestedByUserId: 'local:user', command },
      workspaceId: 'ws' as WorkspaceId,
      memberId: MEMBER,
      member: mac(capable),
      ask,
      ports,
    });

  it('carries the member’s viewer under its own port number until the preview stops', async () => {
    const ports = await setup();
    const port = await freePort();
    const viewerUrl = `http://127.0.0.1:${port}/?lody_preview_token=t`;

    const started = await forward(
      ports,
      { action: 'status' },
      member(() => ({
        type: 'ios-simulator/control_response',
        sessionId: SESSION,
        success: true,
        preview: preview('ready', viewerUrl),
      }))
    );
    expect(started.preview?.viewerUrl).toBe(viewerUrl);
    expect(await say(port, 'frame')).toBe('FRAME');

    const stopped = await forward(
      ports,
      { action: 'stop', operationId: OPERATION },
      member(() => ({
        type: 'ios-simulator/control_response',
        sessionId: SESSION,
        success: true,
        preview: preview('closed'),
      }))
    );
    expect(stopped.success).toBe(true);
    expect(await listens(port)).toBe(false);
  });

  it('refuses a viewer whose port number this machine already uses', async () => {
    const ports = await setup();
    const taken = net.createServer();
    await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve));
    closing.push(async () => await new Promise<void>((resolve) => taken.close(() => resolve())));
    const port = (taken.address() as net.AddressInfo).port;

    const response = await forward(
      ports,
      { action: 'status' },
      member(() => ({
        type: 'ios-simulator/control_response',
        sessionId: SESSION,
        success: true,
        preview: preview('ready', `http://127.0.0.1:${port}/`),
      }))
    );
    expect(response).toMatchObject({ success: false, error: 'failed' });
    expect(response.message).toContain(String(port));
  });

  it('asks no member that cannot carry it out', async () => {
    const ports = await setup();
    const response = await forward(
      ports,
      { action: 'list' },
      async () => {
        throw new Error('an old member must not be asked');
      },
      false
    );
    expect(response).toMatchObject({ success: false, error: 'unsupported' });
    expect(response.message).toContain('mini');
  });

  it('reports why the member refused', async () => {
    const ports = await setup();
    const response = await forward(ports, { action: 'list' }, async (request) => ({
      ok: false,
      type: request.type,
      error: 'execution_failed',
      message: 'mini could not be reached: it accepts no connection from members',
    }));
    expect(response).toMatchObject({
      success: false,
      error: 'failed',
      message: 'mini could not be reached: it accepts no connection from members',
    });
  });
});
