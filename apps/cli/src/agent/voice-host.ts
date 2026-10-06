import os from 'os';
import { type ChildProcess } from 'child_process';
import * as acp from '@agentclientprotocol/sdk';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import {
  LODY_EXTENSION_METHODS,
  type LodyVoiceEventNotification,
  type LodyVoiceStartResponse,
  type LodyVoiceVoicesResponse,
} from 'acp-extension-core';
import {
  MACHINE_VOICE_POLL_MAX_WAIT_MS,
  type AgentConfigId,
  type AgentConfigMeta,
  type MachineVoiceEvent,
  type MachineVoiceRequest,
  type MachineVoiceResponse,
} from '@lody/shared';

import { spawnAcpProcess } from '@/agent/acp-runner';
import { withAcpSessionStartSlot } from '@/agent/acp-session-start-gate';
import { getCodexProfileStore, type ResolvedCodexProfile } from '@/agent/codex-profile-store';
import {
  codexProfileSpawnEnvironment,
  registerCodexProfileProcess,
} from '@/agent/codex-profile-runtime';
import { getLoginShellEnv } from '@/agent/login-shell-env';
import {
  mergeACPProcessEnv,
  mergeLoginShellEnv,
  resolveACPProcessLaunchAsync,
  withDefaultAcpPathEntries,
} from '@/agent/setting';
import { terminateChildProcess } from '@/lib/history-session-catalog-client';
import { createStdinWritableStream, createStdoutReadableStream } from '@/utils/stream';
import { formatErrorMessage } from '@/utils/format-error';
import type { Logger } from '@/utils/logger';

/** A call nobody polls for this long has lost its renderer; end it. */
const ABANDONED_CALL_MS = 45_000;
const VOICE_EVENT_METHOD = LODY_EXTENSION_METHODS.voiceEvent.replace(/^_/, '');

type VoiceCall = {
  id: string;
  host: VoiceHostProcess;
  events: { seq: number; event: MachineVoiceEvent }[];
  closed: boolean;
  lastPolledAt: number;
  wake: Set<() => void>;
};

type VoiceHostProcess = {
  configId: AgentConfigId;
  process: ChildProcess;
  connection: acp.ClientSideConnection;
  calls: Set<string>;
  /** Requests in flight that have no call yet: a start, or a voice list. */
  leases: number;
  modes: readonly string[];
  /** Whether the adapter lists voices and honours `voice` on start. */
  voices: boolean;
  /** This host's entry in `hosts`, so a newer host of the config is never dropped. */
  entry?: Promise<VoiceHostProcess>;
};

type VoiceStartRequest = Extract<MachineVoiceRequest, { action: 'start' }>;

export type VoiceHostDeps = {
  workspaceId: string;
  machineId: string;
  getAgentConfig: (configId: AgentConfigId) => Promise<AgentConfigMeta | null>;
  logger: Logger;
  now?: () => number;
};

/**
 * Hosts experimental realtime voice calls on a Codex agent config. One adapter
 * process per config serves every call of that config and exits with the last
 * one. The adapter never starts work for a call: spoken requests are queued as
 * events for the renderer, which sends them through the session's prompt path.
 */
export class VoiceHost {
  private readonly hosts = new Map<AgentConfigId, Promise<VoiceHostProcess>>();
  /** Hosts whose process exists; only these are waited for on dispose. */
  private readonly startedHosts = new Set<VoiceHostProcess>();
  /** Aborts every start still downloading, queued or initializing when the daemon stops. */
  private readonly shutdown = new AbortController();
  private readonly calls = new Map<string, VoiceCall>();
  private readonly now: () => number;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: VoiceHostDeps) {
    this.now = deps.now ?? Date.now;
  }

  async handle(request: MachineVoiceRequest): Promise<MachineVoiceResponse> {
    try {
      switch (request.action) {
        case 'start':
          return await this.start(request);
        case 'append': {
          const call = this.requireCall(request.voiceSessionId);
          await call.host.connection.request(LODY_EXTENSION_METHODS.voiceAppend, {
            voiceSessionId: call.id,
            text: request.text,
          });
          return { success: true, action: 'append' };
        }
        case 'stop': {
          const call = this.calls.get(request.voiceSessionId);
          if (call && !call.closed) {
            await call.host.connection
              .request(LODY_EXTENSION_METHODS.voiceStop, {
                voiceSessionId: call.id,
              })
              .catch(() => {});
            this.closeCall(call, 'requested');
          }
          return { success: true, action: 'stop' };
        }
        case 'poll':
          return await this.poll(request.voiceSessionId, request.after, request.waitMs ?? 0);
        case 'voices':
          return await this.listVoices(request.configId as AgentConfigId);
        default:
          return { success: false, error: 'Unknown voice action' };
      }
    } catch (error) {
      return { success: false, error: formatErrorMessage(error) };
    }
  }

  /**
   * Never waits for a start in progress: it may be downloading the runtime or
   * queued behind other agents, and daemon shutdown must not wait for that.
   * Aborting it makes the start fail before it spawns anything, or terminate
   * the process it already spawned.
   */
  async dispose(): Promise<void> {
    this.shutdown.abort();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const call of [...this.calls.values()]) this.closeCall(call, 'shutdown');
    this.hosts.clear();
    const started = [...this.startedHosts];
    this.startedHosts.clear();
    await Promise.all(started.map((host) => terminateChildProcess(host.process).catch(() => {})));
  }

  private async start(request: VoiceStartRequest): Promise<MachineVoiceResponse> {
    return await this.withHost(request.configId as AgentConfigId, async (host) => {
      if (!host.modes.includes(request.mode)) {
        throw new Error(`This Codex agent build cannot start a ${request.mode} voice call`);
      }
      const response = (await host.connection.request(LODY_EXTENSION_METHODS.voiceStart, {
        mode: request.mode,
        sdp: request.sdp,
        ...(request.instructions ? { instructions: request.instructions } : {}),
        ...(request.context ? { context: request.context } : {}),
        // An adapter that predates voices would ignore it; the default voice then plays.
        ...(request.voice && host.voices ? { voice: request.voice } : {}),
      })) as Partial<LodyVoiceStartResponse>;
      if (typeof response.voiceSessionId !== 'string' || typeof response.sdp !== 'string') {
        throw new Error('The agent returned no voice call');
      }
      return this.openCall(host, response.voiceSessionId, response.sdp);
    });
  }

  private async listVoices(configId: AgentConfigId): Promise<MachineVoiceResponse> {
    return await this.withHost(configId, async (host) => {
      if (!host.voices) throw new Error('This Codex agent build cannot list voices');
      const response = (await host.connection.request(
        LODY_EXTENSION_METHODS.voiceVoices,
        {}
      )) as Partial<LodyVoiceVoicesResponse>;
      if (!Array.isArray(response.voices) || typeof response.defaultVoice !== 'string') {
        throw new Error('The agent returned no voice list');
      }
      return {
        success: true,
        action: 'voices',
        voices: response.voices.filter((voice): voice is string => typeof voice === 'string'),
        defaultVoice: response.defaultVoice,
      };
    });
  }

  /**
   * Runs `run` on the config's adapter, holding it open meanwhile; an adapter
   * left with no call afterwards (a voice list, a failed start) exits.
   */
  private async withHost<T>(
    configId: AgentConfigId,
    run: (host: VoiceHostProcess) => Promise<T>
  ): Promise<T> {
    const host = await this.getHost(configId);
    host.leases += 1;
    try {
      return await run(host);
    } finally {
      host.leases -= 1;
      this.releaseIfIdle(host);
    }
  }

  private releaseIfIdle(host: VoiceHostProcess): void {
    if (host.calls.size > 0 || host.leases > 0) return;
    if (this.hosts.get(host.configId) === host.entry) this.hosts.delete(host.configId);
    void terminateChildProcess(host.process).catch(() => {});
  }

  private openCall(host: VoiceHostProcess, voiceSessionId: string, sdp: string) {
    const call: VoiceCall = {
      id: voiceSessionId,
      host,
      events: [],
      closed: false,
      lastPolledAt: this.now(),
      wake: new Set(),
    };
    this.calls.set(call.id, call);
    host.calls.add(call.id);
    this.ensureSweep();
    return {
      success: true as const,
      action: 'start' as const,
      voiceSessionId: call.id,
      sdp,
    };
  }

  private async poll(
    voiceSessionId: string,
    after: number,
    waitMs: number
  ): Promise<MachineVoiceResponse> {
    const call = this.requireCall(voiceSessionId);
    call.lastPolledAt = this.now();
    const pending = () => call.events.filter((entry) => entry.seq > after);
    if (pending().length === 0 && !call.closed && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          call.wake.delete(done);
          resolve();
        };
        const timer = setTimeout(done, Math.min(waitMs, MACHINE_VOICE_POLL_MAX_WAIT_MS));
        call.wake.add(done);
      });
    }
    call.lastPolledAt = this.now();
    const events = pending();
    if (events.some((entry) => entry.event.type === 'closed')) {
      // Every event, including `closed`, has now been delivered.
      this.calls.delete(call.id);
    }
    return { success: true, action: 'poll', events, closed: call.closed };
  }

  private requireCall(voiceSessionId: string): VoiceCall {
    const call = this.calls.get(voiceSessionId);
    if (!call) throw new Error(`Unknown voice call: ${voiceSessionId}`);
    return call;
  }

  private pushEvent(call: VoiceCall, event: MachineVoiceEvent): void {
    const seq = (call.events.at(-1)?.seq ?? 0) + 1;
    call.events.push({ seq, event });
    for (const wake of [...call.wake]) wake();
  }

  private closeCall(call: VoiceCall, reason: string | null): void {
    if (call.closed) return;
    this.pushEvent(call, { type: 'closed', reason });
    call.closed = true;
    call.host.calls.delete(call.id);
    this.releaseIfIdle(call.host);
  }

  private handleVoiceEvent(params: LodyVoiceEventNotification): void {
    const call = this.calls.get(params.voiceSessionId);
    if (!call || call.closed) return;
    if (params.event.type === 'closed') {
      this.closeCall(call, params.event.reason);
      return;
    }
    this.pushEvent(call, params.event);
  }

  private ensureSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      const now = this.now();
      for (const call of [...this.calls.values()]) {
        if (now - call.lastPolledAt < ABANDONED_CALL_MS) continue;
        if (call.closed) {
          this.calls.delete(call.id);
          continue;
        }
        void call.host.connection
          .request(LODY_EXTENSION_METHODS.voiceStop, { voiceSessionId: call.id })
          .catch(() => {});
        this.closeCall(call, 'abandoned');
        this.calls.delete(call.id);
      }
      if (this.calls.size === 0 && this.sweepTimer) {
        clearInterval(this.sweepTimer);
        this.sweepTimer = null;
      }
    }, ABANDONED_CALL_MS / 3);
    this.sweepTimer.unref?.();
  }

  private getHost(configId: AgentConfigId): Promise<VoiceHostProcess> {
    if (this.shutdown.signal.aborted) {
      return Promise.reject(new Error('The machine is shutting down'));
    }
    const existing = this.hosts.get(configId);
    if (existing) return existing;
    const created = this.startHost(configId);
    this.hosts.set(configId, created);
    void created.then(
      (host) => {
        host.entry = created;
      },
      () => {}
    );
    created.catch(() => {
      if (this.hosts.get(configId) === created) this.hosts.delete(configId);
    });
    return created;
  }

  private async startHost(configId: AgentConfigId): Promise<VoiceHostProcess> {
    const signal = this.shutdown.signal;
    const config = await this.deps.getAgentConfig(configId);
    signal.throwIfAborted();
    if (!config) throw new Error('The selected agent no longer exists on this machine');
    if (config.cliType !== 'builtin' || config.agentType !== 'codex') {
      throw new Error('Voice needs a built-in Codex agent');
    }
    let codexProfile: ResolvedCodexProfile | undefined;
    if (config.codexAuth) {
      codexProfile = await getCodexProfileStore().resolve(this.deps.workspaceId, config, true);
      if (!codexProfile || !(await getCodexProfileStore().isReady(codexProfile))) {
        throw new Error('The selected Codex account is not signed in');
      }
    }
    const provider = {
      cliType: config.cliType,
      agentType: config.agentType,
      customAcp: config.customAcp,
      runtimeOverrides: config.runtimeOverrides,
      env: config.env,
      signal,
    };
    const launch = await resolveACPProcessLaunchAsync(provider);
    signal.throwIfAborted();
    const env = withDefaultAcpPathEntries(
      mergeLoginShellEnv(
        mergeACPProcessEnv(launch, { ...process.env, ...config.env }),
        await getLoginShellEnv()
      ),
      config.agentType
    );
    return await withAcpSessionStartSlot(
      { label: 'codex-voice', logger: this.deps.logger, abortSignal: signal },
      async () => {
        signal.throwIfAborted();
        const releaseProfile =
          codexProfile?.profile.mode === 'chatgpt'
            ? await registerCodexProfileProcess(codexProfile)
            : undefined;
        let closeBroker: (() => Promise<void>) | undefined;
        const release = async () => {
          await closeBroker?.();
          await releaseProfile?.();
        };
        let child: ChildProcess;
        try {
          const prepared = codexProfile
            ? await codexProfileSpawnEnvironment({ profile: codexProfile }, env)
            : { env, close: undefined };
          closeBroker = prepared.close;
          if (releaseProfile) prepared.env.LODY_CODEX_PROCESS_TOKEN = releaseProfile.token;
          signal.throwIfAborted();
          child = spawnAcpProcess({
            cliType: config.cliType,
            agentType: config.agentType,
            workdir: os.tmpdir(),
            env: prepared.env,
            command: launch.command,
            args: launch.args,
          });
        } catch (error) {
          await releaseProfile?.abandonBeforeSpawn();
          await release();
          throw error;
        }
        if (!child.stdout || !child.stdin) {
          await terminateChildProcess(child);
          await release();
          throw new Error('The Codex agent did not expose stdio streams');
        }
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => {
          this.deps.logger.debug(`[codex-voice] ACP stderr: ${chunk.slice(0, 1200)}`);
        });

        const host: VoiceHostProcess = {
          configId,
          process: child,
          connection: null as unknown as acp.ClientSideConnection,
          calls: new Set(),
          leases: 0,
          modes: [],
          voices: false,
        };
        this.startedHosts.add(host);
        // A shutdown during `initialize` ends the process, which fails the handshake.
        const stopOnShutdown = () => void terminateChildProcess(child).catch(() => {});
        signal.addEventListener('abort', stopOnShutdown, { once: true });
        child.once('exit', () => {
          signal.removeEventListener('abort', stopOnShutdown);
          this.startedHosts.delete(host);
          void release().catch(() => {});
          if (this.hosts.get(configId) === host.entry) this.hosts.delete(configId);
          for (const id of [...host.calls]) {
            const call = this.calls.get(id);
            if (call) this.closeCall(call, 'agent exited');
          }
        });
        const client: acp.Client = {
          requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
          sessionUpdate: async () => {},
          extNotification: async (method, params) => {
            if (method.replace(/^_/, '') === VOICE_EVENT_METHOD) {
              this.handleVoiceEvent(params as LodyVoiceEventNotification);
            }
          },
          extMethod: async () => ({}),
        };
        host.connection = new acp.ClientSideConnection(
          () => client,
          ndJsonStream(
            createStdinWritableStream(child.stdin),
            createStdoutReadableStream(child.stdout)
          )
        );
        try {
          const init = await host.connection.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {
              terminal: false,
              fs: { readTextFile: false, writeTextFile: false },
            },
          });
          const voice = (
            init.agentCapabilities?._meta as {
              lody?: { voice?: { version?: number; modes?: unknown; voices?: unknown } };
            }
          )?.lody?.voice;
          if (voice?.version !== 1) {
            throw new Error('This Codex agent build does not support voice');
          }
          host.modes = Array.isArray(voice.modes)
            ? voice.modes.filter((mode): mode is string => typeof mode === 'string')
            : ['conversation', 'dictation'];
          host.voices = voice.voices === true;
          signal.throwIfAborted();
        } catch (error) {
          await terminateChildProcess(child);
          throw error;
        }
        return host;
      }
    );
  }
}
