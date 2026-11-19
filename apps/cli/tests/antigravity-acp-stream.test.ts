// LAN fork: what Lody changes on agy's ACP stream (src/agent/antigravity-acp-stream.ts).
import type { AnyMessage, SessionNotification } from '@agentclientprotocol/sdk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ACPSessionId, AcpSessionNotification, SessionId, WorkspaceId } from '@lody/shared';

vi.mock('@/agent/login-shell-env', () => ({
  getCachedLoginShellEnvSyncLegacy: () => ({}),
  getLoginShellEnvLegacy: async () => ({}),
}));

const fixture = fileURLToPath(
  new URL('../src/agent/fixtures/fake-antigravity-acp.mjs', import.meta.url)
);

// Capability probes resolve the registry binary through the binary manager;
// point it at the fixture so the rest of the probe chain runs as shipped.
vi.mock('@/agent/acp-binary-manager', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getAcpBinaryManager: () => ({
    ensureBinary: async () => ({ command: process.execPath, args: [fixture], env: {} }),
  }),
}));

import { resolveACPProcessLaunchAsync } from '../src/agent/setting';
import { fetchAcpCapabilities } from '../src/agent/acp-capabilities';
import {
  ANTIGRAVITY_SKIP_PERMISSIONS_ARG,
  antigravityLaunchArgs,
  antigravityYoloChanged,
  withAntigravityAcpStream,
} from '../src/agent/antigravity-acp-stream';
import { applyAcpSessionRunConfig } from '../src/session/acp-session-config-applier';
import { Session } from '../src/session/session';
import type { CreateAgentConfig } from '../src/session/session-manager';
import type { Logger } from '../src/utils/logger';

const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  trace: () => {},
  setLevel: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

type Harness = {
  session: Session;
  workdir: string;
  /** The mode the session's config reports as current. */
  currentMode(): unknown;
  setMode(modeId: string): Promise<{ rejectedSelections: string[]; modeId?: string }>;
  prompt(text: string): Promise<string>;
};

const harnesses: Harness[] = [];
const workdirs: string[] = [];

const makeWorkdir = () => {
  const workdir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lody-agy-stream-test-')));
  workdirs.push(workdir);
  return workdir;
};

/** A Session started the way the daemon starts one, on the fake agy. */
async function startSession(
  options: {
    workdir?: string;
    configOptionValues?: Record<string, string>;
    /** Arguments after the agent, as the launch resolver appends them. */
    launchArgs?: string[];
    resumeSessionId?: ACPSessionId;
  } = {}
): Promise<Harness> {
  const workdir = options.workdir ?? makeWorkdir();
  const updates: AcpSessionNotification[] = [];
  const session = new Session(
    {
      workspaceId: 'workspace-1' as WorkspaceId,
      requesterUserId: 'user-1',
      machineId: 'machine-1',
      agentCliType: 'registry',
      agentType: 'antigravity-acp',
      sessionId: `session-${harnesses.length + 1}` as SessionId,
      userName: 'Test User',
      userEmail: 'test@example.com',
      ...(options.configOptionValues ? { configOptionValues: options.configOptionValues } : {}),
    },
    createSilentLogger(),
    workdir
  );
  await session.createAgent({
    cliType: 'registry',
    agentType: 'antigravity-acp',
    command: process.execPath,
    args: [fixture, ...(options.launchArgs ?? [])],
    ...(options.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : {}),
    onUpdateMessage: (message: AcpSessionNotification) => updates.push(message),
  } as unknown as CreateAgentConfig);
  const client = session.agentClient!;
  const acpSessionId = session.acpSessionId!;
  const harness: Harness = {
    session,
    workdir,
    currentMode: () =>
      client.getConfigOptions().find((option) => option.id === 'mode')?.currentValue,
    async setMode(modeId) {
      const result = await applyAcpSessionRunConfig({
        session: { sessionId: 'session-1' as SessionId, acpSessionId, agentClient: client },
        config: { cliType: 'registry', agentType: 'antigravity-acp', modeId },
        logger: createSilentLogger(),
      });
      return {
        rejectedSelections: result.rejectedSelections,
        modeId: result.runtimeConfigPatch?.modeId,
      };
    },
    async prompt(text) {
      const start = updates.length;
      await client.prompt(acpSessionId, [{ type: 'text', text }]);
      return updates
        .slice(start)
        .map((message) => (message as SessionNotification).update)
        .map((update) =>
          update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text'
            ? update.content.text
            : ''
        )
        .join('');
    },
  };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.session.terminate(true);
  for (const workdir of workdirs.splice(0)) fs.rmSync(workdir, { recursive: true, force: true });
});

describe('Antigravity modes through the session start chain', () => {
  it("offers agy's own modes and YOLO in probes and sessions", async () => {
    const probed = await fetchAcpCapabilities('registry', 'antigravity-acp', createSilentLogger());
    const offered = ['default', 'accept-edits', 'auto', 'plan', 'yolo'];
    expect(probed.modes.map((mode) => mode.id)).toEqual(offered);
    expect(
      probed.configOptions
        ?.find((option) => option.id === 'mode')
        ?.options.map((option) => option.value)
    ).toEqual(offered);

    const harness = await startSession();
    await expect(harness.setMode('auto')).resolves.toEqual({
      rejectedSelections: [],
      modeId: 'auto',
    });
    await expect(harness.prompt('report-mode')).resolves.toBe('mode=auto');

    // This process was started without agy's skip flag; YOLO waits for a new one.
    await expect(harness.setMode('yolo')).resolves.toEqual({
      rejectedSelections: ['mode="yolo"'],
      modeId: 'auto',
    });
    await expect(harness.prompt('report-mode')).resolves.toBe('mode=auto');
  });

  it('runs a YOLO session in default in an agy process started with the skip flag', async () => {
    const harness = await startSession({
      configOptionValues: { mode: 'yolo' },
      launchArgs: [ANTIGRAVITY_SKIP_PERMISSIONS_ARG],
    });
    expect(harness.currentMode()).toBe('yolo');
    // The fake agy, like agy, refuses a mode it does not know: `yolo` never reaches it.
    await expect(harness.prompt('report-mode')).resolves.toBe('mode=default');
    await expect(harness.setMode('yolo')).resolves.toEqual({
      rejectedSelections: [],
      modeId: 'yolo',
    });
    await expect(harness.prompt('report-mode')).resolves.toBe('mode=default');
  });

  it("runs a session saved in Lody's former Auto Review in agy's own auto", async () => {
    const first = await startSession({ configOptionValues: { mode: 'auto_review' } });
    expect(first.currentMode()).toBe('auto');
    await expect(first.prompt('report-mode')).resolves.toBe('mode=auto');
    const acpSessionId = first.session.acpSessionId!;
    await first.session.terminate(true);

    const resumed = await startSession({
      workdir: first.workdir,
      configOptionValues: { mode: 'auto_review' },
      resumeSessionId: acpSessionId,
    });
    expect(resumed.session.acpSessionId).toBe(acpSessionId);
    await expect(resumed.prompt('report-mode')).resolves.toBe('mode=auto');
    await expect(resumed.setMode('plan')).resolves.toMatchObject({ rejectedSelections: [] });
    await expect(resumed.setMode('auto_review')).resolves.toMatchObject({
      rejectedSelections: [],
    });
    await expect(resumed.prompt('report-mode')).resolves.toBe('mode=auto');
  });
});

describe('Antigravity ACP stream', () => {
  /** The wrapper between a scripted client and agent. */
  const wire = (options: { agentType?: string; args?: string[] } = {}) => {
    const toClient: AnyMessage[] = [];
    const toAgent: AnyMessage[] = [];
    const agentOut = new TransformStream<AnyMessage, AnyMessage>();
    const agentWriter = agentOut.writable.getWriter();
    const wrapped = withAntigravityAcpStream(
      {
        readable: agentOut.readable,
        writable: new WritableStream<AnyMessage>({
          write: (message) => void toAgent.push(message),
        }),
      },
      { agentType: options.agentType ?? 'antigravity-acp', args: options.args ?? ['acp'] }
    );
    const clientWriter = wrapped.writable.getWriter();
    void wrapped.readable.pipeTo(
      new WritableStream({ write: (message) => void toClient.push(message) })
    );
    const settle = () => vi.advanceTimersByTimeAsync(0);
    const modeOption = (currentValue: string) => ({
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue,
      options: [{ value: 'default', name: 'Default' }],
    });
    return {
      toClient,
      toAgent,
      /** `reported` is the mode the agent then reports as current. */
      async start(mode: string, reported = 'default') {
        await clientWriter.write({
          jsonrpc: '2.0',
          id: 1,
          method: 'session/new',
          params: {
            cwd: '/synthetic-workspace',
            mcpServers: [],
            _meta: {
              lody: { sessionConfig: { version: 1, configOptionValues: { mode } } },
            },
          },
        });
        await agentWriter.write({
          jsonrpc: '2.0',
          id: 1,
          result: {
            sessionId: 's',
            modes: { currentModeId: reported, availableModes: agyModes },
          },
        });
        await settle();
      },
      /** Initialize, answered by the agent with `agentCapabilities`. */
      async initialize(agentCapabilities: Record<string, unknown>) {
        await clientWriter.write({
          jsonrpc: '2.0',
          id: 0,
          method: 'initialize',
          params: { protocolVersion: 1, clientCapabilities: {} },
        });
        await agentWriter.write({
          jsonrpc: '2.0',
          id: 0,
          result: { protocolVersion: 1, agentCapabilities },
        });
        await settle();
      },
      /** A request the agent has not answered. */
      async request(id: number, method: string, params: Record<string, unknown>) {
        await clientWriter.write({
          jsonrpc: '2.0',
          id,
          method,
          params: { sessionId: 's', ...params },
        });
        await settle();
      },
      /** A mode switch; `reported` is the mode the agent then reports as current. */
      async switchMode(id: number, value: string, reported = value) {
        await clientWriter.write({
          jsonrpc: '2.0',
          id,
          method: 'session/set_config_option',
          params: { sessionId: 's', configId: 'mode', value },
        });
        await agentWriter.write({
          jsonrpc: '2.0',
          id,
          result: { configOptions: [modeOption(reported)] },
        });
        await settle();
      },
    };
  };

  const agyModes = [
    { id: 'default', name: 'Default' },
    { id: 'accept-edits', name: 'Accept edits' },
    { id: 'auto', name: 'Auto' },
    { id: 'plan', name: 'Plan' },
  ];
  const answer = (messages: AnyMessage[], id: number) =>
    messages.find((message) => 'id' in message && message.id === id) as {
      result: { modes: unknown };
    };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['antigravity', 'antigravity-acp'])(
    'reports the Streamable HTTP MCP support %s has but does not advertise',
    async (agentType) => {
      const wired = wire({ agentType });
      await wired.initialize({ loadSession: true, mcpCapabilities: { sse: false } });
      expect(wired.toClient.at(-1)).toMatchObject({
        id: 0,
        result: {
          agentCapabilities: { loadSession: true, mcpCapabilities: { sse: false, http: true } },
        },
      });
    }
  );

  it('runs YOLO as default in an agy process started with the skip flag', async () => {
    const wired = wire({ args: ['acp', ANTIGRAVITY_SKIP_PERMISSIONS_ARG] });
    await wired.start('yolo');
    expect(wired.toAgent[0]).toMatchObject({
      params: { _meta: { lody: { sessionConfig: { configOptionValues: { mode: 'default' } } } } },
    });
    expect(answer(wired.toClient, 1).result.modes).toEqual({
      currentModeId: 'yolo',
      availableModes: [...agyModes, expect.objectContaining({ id: 'yolo' })],
    });

    await wired.switchMode(3, 'yolo', 'default');
    expect(wired.toAgent.at(-1)).toMatchObject({
      method: 'session/set_config_option',
      params: { configId: 'mode', value: 'default' },
    });
    expect(wired.toClient.at(-1)).toMatchObject({
      id: 3,
      result: {
        configOptions: [
          expect.objectContaining({
            currentValue: 'yolo',
            options: [
              { value: 'default', name: 'Default' },
              expect.objectContaining({ value: 'yolo' }),
            ],
          }),
        ],
      },
    });
  });

  it("sends a selection saved as Lody's former Auto Review as agy's own auto", async () => {
    const wired = wire();
    await wired.start('auto_review', 'auto');
    expect(wired.toAgent[0]).toMatchObject({
      params: { _meta: { lody: { sessionConfig: { configOptionValues: { mode: 'auto' } } } } },
    });
    expect(answer(wired.toClient, 1).result.modes).toEqual({
      currentModeId: 'auto',
      availableModes: [...agyModes, expect.objectContaining({ id: 'yolo' })],
    });

    await wired.switchMode(3, 'auto_review', 'auto');
    expect(wired.toAgent.at(-1)).toMatchObject({ params: { configId: 'mode', value: 'auto' } });
    await wired.request(4, 'session/set_mode', { modeId: 'auto_review' });
    expect(wired.toAgent.at(-1)).toMatchObject({
      method: 'session/set_mode',
      params: { modeId: 'auto' },
    });
  });

  it('refuses a switch the running agy process cannot make, without telling agy', async () => {
    const plain = wire();
    await plain.start('auto', 'auto');
    const sentToPlain = plain.toAgent.length;
    await plain.request(3, 'session/set_config_option', { configId: 'mode', value: 'yolo' });
    expect(plain.toAgent).toHaveLength(sentToPlain);
    expect(plain.toClient.at(-1)).toMatchObject({
      id: 3,
      error: { message: expect.stringContaining('next message') },
    });

    const flagged = wire({ args: ['acp', ANTIGRAVITY_SKIP_PERMISSIONS_ARG] });
    await flagged.start('yolo');
    const sentToFlagged = flagged.toAgent.length;
    await flagged.request(3, 'session/set_mode', { modeId: 'auto' });
    expect(flagged.toAgent).toHaveLength(sentToFlagged);
    expect(flagged.toClient.at(-1)).toMatchObject({
      id: 3,
      error: { message: expect.stringContaining('runs in YOLO') },
    });
  });
});

describe('Antigravity YOLO launch', () => {
  it('starts agy with its skip flag only for a session that selects YOLO', () => {
    const agy = 'antigravity-acp';
    expect(antigravityLaunchArgs({ agentType: agy, modeId: 'yolo' })).toEqual([
      ANTIGRAVITY_SKIP_PERMISSIONS_ARG,
    ]);
    expect(antigravityLaunchArgs({ agentType: agy, configOptionValues: { mode: 'yolo' } })).toEqual(
      [ANTIGRAVITY_SKIP_PERMISSIONS_ARG]
    );
    expect(antigravityLaunchArgs({ agentType: agy, modeId: 'auto' })).toEqual([]);
    expect(antigravityLaunchArgs({ agentType: 'gemini', modeId: 'yolo' })).toEqual([]);

    expect(
      antigravityYoloChanged({ agentType: agy, modeId: 'auto' }, { agentType: agy, modeId: 'yolo' })
    ).toBe(true);
    expect(
      antigravityYoloChanged({ agentType: agy, modeId: 'yolo' }, { agentType: agy, modeId: 'plan' })
    ).toBe(true);
    expect(antigravityYoloChanged({ agentType: agy }, { agentType: agy, modeId: 'auto' })).toBe(
      false
    );
    // A turn that names no mode keeps the running process.
    expect(antigravityYoloChanged({ agentType: agy, modeId: 'yolo' }, { agentType: agy })).toBe(
      false
    );
  });

  it.each([
    ['builtin', 'antigravity'],
    ['registry', 'antigravity-acp'],
  ] as const)(
    'keeps %s/%s permission bypass scoped to each session',
    async (cliType, agentType) => {
      const modes = ['yolo', 'auto'];
      const launches = await Promise.all(
        modes.map((modeId) =>
          resolveACPProcessLaunchAsync({
            cliType,
            agentType,
            runtimeOverrides: {
              antigravityPath: '/synthetic/agy',
              antigravitySkipPermissions: true,
            },
            extraArgs: antigravityLaunchArgs({ agentType, modeId }),
          })
        )
      );
      for (const [index, launch] of launches.entries()) {
        expect(launch.command).toBe(cliType === 'builtin' ? '/synthetic/agy' : process.execPath);
        expect(launch.args).toEqual([
          ...(cliType === 'builtin'
            ? ['acp', '--process-per-session', '--disable-telemetry']
            : [fixture]),
          ...(modes[index] === 'yolo' ? ['--dangerously-skip-permissions'] : []),
        ]);
        expect(launch.env).toEqual(
          cliType === 'builtin' ? { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' } : {}
        );
      }
    }
  );
});
