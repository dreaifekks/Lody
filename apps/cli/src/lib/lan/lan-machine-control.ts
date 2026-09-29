// What this machine tells the members of its LANs about itself, and what it
// does when one of them asks: replace its agent service with the newest build,
// or install the runtime an agent runs with.
import {
  MANAGED_BUILTIN_RUNTIMES,
  getManagedBuiltinRuntimeByAgentType,
  type AgentConfigMeta,
  type BuiltinRuntimeOverrides,
  type LanAgentInstallResult,
  type LanAgentRuntime,
  type LanControlRefusal,
  type LanMachineUpdateResult,
} from '@lody/shared';
import {
  resolveLanUpdateAvailability,
  summarizeLanRelease,
  type LanMachineBuild,
  type LanMachineUpdate,
  type LanMachineUpdatePhase,
  type LanReleaseSummary,
} from '@lody/shared/lan-release';
import type { ManagedRuntimeName, ManagedRuntimeStatus } from '@/agent/managed-agent-runtime';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import type { LanInstallation } from './lan-build';
import {
  LanSelfUpdateError,
  applyLanSelfUpdate,
  readNewestLanRelease,
  type LanSelfUpdateOptions,
} from './lan-self-update';

/** A request a member made that this machine does not carry out. */
export class LanControlRefused extends Error {
  constructor(
    readonly reason: LanControlRefusal,
    message: string
  ) {
    super(message);
    this.name = 'LanControlRefused';
  }
}

export type LanAgentRuntimeSource = {
  getRuntimeStatus: (name: ManagedRuntimeName) => Promise<ManagedRuntimeStatus>;
  ensureCurrentRuntime: (name: ManagedRuntimeName) => Promise<unknown>;
  pruneSupersededVersions: (name: ManagedRuntimeName) => Promise<void>;
};

const NEWEST_RELEASE_TTL_MS = 10 * 60_000;
const UNREAD_RELEASE_TTL_MS = 60_000;
// What the machine reports has to reach the hub before the machine is gone.
const REPORT_SETTLE_MS = 1_500;
const ERROR_MAX = 500;

/** The path a provider may run its agent from instead of the managed runtime. */
const RUNTIME_OVERRIDE: Record<string, keyof BuiltinRuntimeOverrides> = {
  claude: 'claudeCodeExecutable',
  codex: 'codexPath',
  kimi: 'kimiPath',
  grok: 'grokPath',
};

function runsManagedRuntime(config: AgentConfigMeta): boolean {
  if (config.cliType !== 'builtin') return false;
  const override = RUNTIME_OVERRIDE[config.agentType];
  const path = override ? config.runtimeOverrides?.[override] : undefined;
  return typeof path !== 'string' || path.trim() === '';
}

/**
 * An update a machine reported before it started again, as it stands now. It
 * is over when the machine runs the version it installed; anything else it
 * was in the middle of did not happen.
 */
export function settleLanMachineUpdate(
  reported: LanMachineUpdate | null,
  runningVersion: string,
  now: number
): LanMachineUpdate | null {
  if (!reported || reported.version === runningVersion) return null;
  if (reported.phase === 'failed') return reported;
  return {
    phase: 'failed',
    version: reported.version,
    at: now,
    error: 'The agent service started again with the build it had',
  };
}

// An update takes minutes. A machine that says it is in the middle of one
// for longer than this went away without saying how it ended.
const UNFINISHED_UPDATE_MS = 30 * 60_000;

/**
 * An update another machine reported, as it stands for a member that reads
 * it. The machine may run a build that does not take its report back, so the
 * version it registered with decides whether the update is over.
 */
export function readLanMachineUpdate(
  reported: LanMachineUpdate | null,
  registeredVersion: string | null,
  now: number
): LanMachineUpdate | null {
  if (!reported || reported.version === registeredVersion) return null;
  if (reported.phase === 'failed' || now - reported.at < UNFINISHED_UPDATE_MS) return reported;
  return {
    phase: 'failed',
    version: reported.version,
    at: reported.at,
    error: 'The machine did not say how the update ended',
  };
}

export type LanMachineControlOptions = {
  logger: Logger;
  build: LanMachineBuild;
  installation: LanInstallation;
  runtimes: () => LanAgentRuntimeSource;
  /** Starts this agent service again with the build that is on disk. */
  restart: (reason: string) => void;
  /** Starts again what else on this machine runs the build that was replaced. */
  restartCompanions?: () => Promise<void>;
  applyUpdate?: (options: LanSelfUpdateOptions) => Promise<unknown>;
  readNewest?: typeof readNewestLanRelease;
  now?: () => number;
  settle?: (ms: number) => Promise<void>;
};

export class LanMachineControl {
  private reported: LanMachineUpdate | null = null;
  private updating = false;
  private readonly installing = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private newest: { readAt: number; release: LanReleaseSummary | null } | null = null;

  constructor(private readonly options: LanMachineControlOptions) {}

  get build(): LanMachineBuild {
    return this.options.build;
  }

  /** `null` unless this process is updating the machine or failed to. */
  get update(): LanMachineUpdate | null {
    return this.reported;
  }

  /** Called whenever what this machine tells the members changed. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * The newest build of the release this machine follows, or `null` when it
   * follows none or the release cannot be read right now.
   */
  async readNewestRelease(): Promise<LanReleaseSummary | null> {
    const { source } = this.options.build;
    if (!source) return null;
    const now = this.now();
    if (this.newest) {
      const ttl = this.newest.release ? NEWEST_RELEASE_TTL_MS : UNREAD_RELEASE_TTL_MS;
      if (now - this.newest.readAt < ttl) return this.newest.release;
    }
    let release: LanReleaseSummary | null = null;
    try {
      release = summarizeLanRelease(
        await (this.options.readNewest ?? readNewestLanRelease)({ source })
      );
    } catch (error) {
      this.options.logger.debug(
        `[lan] The release could not be read: ${formatErrorMessage(error)}`
      );
    }
    this.newest = { readAt: now, release };
    return release;
  }

  /**
   * Answers as soon as it knows what it will do: an update ends with the
   * machine starting again, which no answer would survive.
   */
  async startUpdate(): Promise<LanMachineUpdateResult> {
    const { build } = this.options;
    if (build.update === 'desktop') {
      throw new LanControlRefused('desktop', 'The desktop application updates this agent service');
    }
    if (build.update !== 'service' || !build.source) {
      throw new LanControlRefused(
        'manual',
        'This agent service does not update itself; update it where it was installed'
      );
    }
    if (this.updating) {
      throw new LanControlRefused('busy', 'This machine is already updating');
    }

    let manifest;
    try {
      manifest = await (this.options.readNewest ?? readNewestLanRelease)({ source: build.source });
    } catch (error) {
      throw new LanControlRefused('release', formatErrorMessage(error));
    }
    this.newest = { readAt: this.now(), release: summarizeLanRelease(manifest) };
    if (resolveLanUpdateAvailability(build.version, manifest.version) !== 'available') {
      return { outcome: 'current', version: build.version };
    }

    this.updating = true;
    this.report('downloading', manifest.version);
    void this.runUpdate(manifest);
    return { outcome: 'started', version: manifest.version };
  }

  private async runUpdate(manifest: NonNullable<LanSelfUpdateOptions['manifest']>): Promise<void> {
    const { build, logger } = this.options;
    try {
      await (this.options.applyUpdate ?? applyLanSelfUpdate)({
        installation: this.options.installation,
        source: build.source ?? null,
        runningVersion: build.version,
        manifest,
        onPhase: (phase) => this.report(phase, manifest.version),
      });
      logger.info(`[lan] Installed ${manifest.version}; starting again.`);
      this.report('restarting', manifest.version);
      await (this.options.settle ?? settle)(REPORT_SETTLE_MS);
      await this.options.restartCompanions?.().catch((error: unknown) => {
        logger.warn(`[lan] ${formatErrorMessage(error)}`);
      });
      this.options.restart(`updated to ${manifest.version}`);
    } catch (error) {
      const message =
        error instanceof LanSelfUpdateError ? error.message : formatErrorMessage(error);
      logger.warn(`[lan] The update to ${manifest.version} failed: ${message}`);
      this.updating = false;
      this.report('failed', manifest.version, message);
    }
  }

  async installAgent(agentType: string): Promise<LanAgentInstallResult> {
    const runtime = getManagedBuiltinRuntimeByAgentType(agentType);
    if (!runtime) {
      throw new LanControlRefused(
        'unknown_agent',
        `This machine installs no runtime for ${agentType}`
      );
    }
    const name = runtime.runtimeName as ManagedRuntimeName;
    const status = await this.options.runtimes().getRuntimeStatus(name);
    if (status.kind === 'unsupported-platform' || status.kind === 'incompatible-host') {
      throw new LanControlRefused(
        'unknown_agent',
        `This machine cannot run ${runtime.displayName}`
      );
    }
    if (status.kind === 'installed' && !status.updateAvailable) {
      return { agentType, outcome: 'current' };
    }
    if (!this.installing.has(agentType)) {
      this.installing.add(agentType);
      this.notify();
      void this.runInstall(agentType, name);
    }
    return { agentType, outcome: 'started' };
  }

  private async runInstall(agentType: string, name: ManagedRuntimeName): Promise<void> {
    const runtimes = this.options.runtimes();
    try {
      await runtimes.ensureCurrentRuntime(name);
      await runtimes.pruneSupersededVersions(name);
    } catch (error) {
      this.options.logger.warn(
        `[lan] The runtime of ${agentType} could not be installed: ${formatErrorMessage(error)}`
      );
    } finally {
      this.installing.delete(agentType);
      this.notify();
    }
  }

  /** The runtimes of the agents these providers run, which are this machine's. */
  async describeAgents(agentConfigs: readonly AgentConfigMeta[]): Promise<LanAgentRuntime[]> {
    const used = new Set(agentConfigs.filter(runsManagedRuntime).map((config) => config.agentType));
    const runtimes = this.options.runtimes();
    const agents: LanAgentRuntime[] = [];
    for (const runtime of MANAGED_BUILTIN_RUNTIMES) {
      if (!used.has(runtime.agentType)) continue;
      const entry = { agentType: runtime.agentType, name: runtime.displayName };
      let status: ManagedRuntimeStatus;
      try {
        status = await runtimes.getRuntimeStatus(runtime.runtimeName as ManagedRuntimeName);
      } catch (error) {
        this.options.logger.debug(
          `[lan] The runtime of ${runtime.agentType} could not be read: ${formatErrorMessage(error)}`
        );
        continue;
      }
      const updating = this.installing.has(runtime.agentType);
      if (status.kind === 'installed') {
        agents.push({
          ...entry,
          version: status.version,
          target: status.targetVersion,
          state: !status.updateAvailable ? 'current' : updating ? 'updating' : 'outdated',
        });
      } else if (status.kind === 'not-installed') {
        agents.push({ ...entry, target: status.version, state: updating ? 'updating' : 'missing' });
      } else {
        agents.push({ ...entry, state: 'unsupported' });
      }
    }
    return agents;
  }

  private report(phase: LanMachineUpdatePhase, version: string, error?: string): void {
    this.reported = {
      phase,
      version,
      at: this.now(),
      ...(error ? { error: error.slice(0, ERROR_MAX) } : {}),
    };
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
