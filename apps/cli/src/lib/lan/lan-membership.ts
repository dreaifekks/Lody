import fs from 'node:fs';
import path from 'node:path';
import {
  createStore,
  type CloudGithubTokenPort,
  type CloudStreamsTokenPort,
  type ReadonlyStore,
  type WorkspaceSummary,
} from '@lody/platform';
import { createStaticLoroStreamsTokenProvider } from '@lody/shared';
import { normalizeLanHubUrl } from '@lody/shared/lan-hub';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { z } from 'zod';
import {
  classifyLanHubChange,
  readLanHubSettings,
  summarizeLanHubs,
  updateLanHub,
  watchLanHubSettings,
  writeLanHubSettings,
  type LanHub,
  type LanHubSettings,
  type LanHubSettingsWatcher,
} from '@lody/shared/node/lan-hub';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import { askWhereLanHubIs } from './hub-handover';
import { createLanGitHubTokenPort } from './lan-github-tokens';

/** How often a member asks its hubs whether they moved. */
const FOLLOW_INTERVAL_MS = 60_000;
const TERMS_FILE_NAME = 'lan-hub-terms.json';
const TermsSchema = z.record(
  z.string(),
  z.object({ url: z.string(), term: z.number().int().nonnegative() })
);

export function toLanWorkspaces(hubs: readonly LanHub[]): WorkspaceSummary[] {
  return summarizeLanHubs(hubs).map((hub) => ({
    id: hub.workspaceId,
    name: hub.name,
    slug: hub.slug,
    role: 'owner',
    userId: hub.userId,
  }));
}

/**
 * The LANs a running agent service belongs to. Each LAN carries one workspace
 * through its own gateway; the set follows the settings file, so a LAN joined
 * or left while the service runs needs no restart.
 */
export class LanMembership {
  private settings: LanHubSettings;
  private readonly workspaceStore;
  private watcher: LanHubSettingsWatcher | null = null;
  private followTimer: NodeJS.Timeout | null = null;
  private following: Promise<void> | null = null;
  private restartRequested = false;

  constructor(
    private readonly options: {
      settings: LanHubSettings;
      logger: Logger;
      /** The change cannot be followed by this process; it has to start again. */
      onRestartRequired: (reason: string) => void;
      watch?: typeof watchLanHubSettings;
      read?: typeof readLanHubSettings;
      write?: typeof writeLanHubSettings;
      askWhere?: typeof askWhereLanHubIs;
      /** Where the terms of the hubs this machine follows are kept. */
      termsPath?: string;
      followIntervalMs?: number;
      env?: NodeJS.ProcessEnv;
      filePath?: string;
    }
  ) {
    this.settings = options.settings;
    this.workspaceStore = createStore<readonly WorkspaceSummary[]>(
      toLanWorkspaces(options.settings.hubs)
    );
  }

  get workspaces(): ReadonlyStore<readonly WorkspaceSummary[]> {
    return this.workspaceStore;
  }

  get hubs(): readonly LanHub[] {
    return this.settings.hubs;
  }

  /**
   * `null` for a service that started without a LAN: its data plane is local
   * for as long as it runs, and joining the first LAN starts it again.
   */
  get streamsTokens(): CloudStreamsTokenPort | null {
    if (this.options.settings.hubs.length === 0) return null;
    return {
      createTokenProvider: ({ workspaceId }) => {
        const credentials = this.hubOf(workspaceId);
        if (!credentials) {
          // Reached when a workspace outlives its LAN for a moment; the attach
          // fails and the fleet stops the workspace with the next list.
          throw new Error(`No LAN carries workspace ${workspaceId}`);
        }
        return createStaticLoroStreamsTokenProvider({
          gatewayBaseUrl: credentials.url,
          token: credentials.token,
        });
      },
    };
  }

  /**
   * The GitHub credential the host of each LAN keeps; `null` without a LAN,
   * where nothing may be asked of any host.
   */
  get githubTokens(): CloudGithubTokenPort | null {
    if (this.options.settings.hubs.length === 0) return null;
    return createLanGitHubTokenPort({
      resolveHub: (workspaceId) => this.hubOf(workspaceId),
      logger: this.options.logger,
    });
  }

  private hubOf(workspaceId: string): LanHub | null {
    const hub = summarizeLanHubs(this.settings.hubs).find(
      (candidate) => candidate.workspaceId === workspaceId
    );
    return (hub && this.settings.hubs.find((entry) => entry.id === hub.id)) ?? null;
  }

  start(): void {
    // Settings from the environment cannot change while the process runs.
    if (this.watcher || this.settings.source === 'environment') return;
    const watch = this.options.watch ?? watchLanHubSettings;
    const location = { env: this.options.env, filePath: this.options.filePath };
    // A running service keeps the LANs it has: a broken edit must not take the
    // machine out of every LAN.
    const onError = (error: unknown) =>
      this.options.logger.warn(
        `[lan] Ignoring LAN settings that cannot be read: ${formatErrorMessage(error)}`
      );
    this.watcher = watch({ ...location, onChange: (next) => this.apply(next), onError });
    // The settings this service started with were read before it watched.
    try {
      this.apply((this.options.read ?? readLanHubSettings)(location));
    } catch (error) {
      onError(error);
    }
    this.followTimer = setInterval(
      () => void this.follow(),
      this.options.followIntervalMs ?? FOLLOW_INTERVAL_MS
    );
    this.followTimer.unref?.();
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.followTimer) clearInterval(this.followTimer);
    this.followTimer = null;
  }

  /**
   * Asks every hub whether it moved, and writes where one went into the
   * settings, which the watcher then follows like any other move. A hub
   * that is away has not moved; only one that says so with the credential's
   * signature is followed.
   */
  follow(): Promise<void> {
    this.following ??= this.followOnce().finally(() => {
      this.following = null;
    });
    return this.following;
  }

  private async followOnce(): Promise<void> {
    const askWhere = this.options.askWhere ?? askWhereLanHubIs;
    for (const hub of this.settings.hubs) {
      const moved = await askWhere(hub);
      if (!moved || this.restartRequested) continue;
      this.adopt(hub.id, { url: moved.url, term: moved.term }, 'its hub points there', hub.url);
    }
  }

  /** The term of the hub this machine follows for a LAN; 0 before any move it saw. */
  termOf(hubId: string): number {
    return this.readTerms()[hubId]?.term ?? 0;
  }

  /**
   * Follows a LAN's hub to where it is now. A later term wins; within one
   * term, two hubs that both took over settle on the address that sorts
   * first, so every member ends up at the same one. Returns whether the
   * settings changed, which restarts the agent service.
   */
  adopt(
    hubId: string,
    location: { url: string; term: number | null },
    reason: string,
    /** Only while the settings still name this address: a pointer speaks for its own address. */
    from?: string
  ): boolean {
    const settingsAt = { env: this.options.env, filePath: this.options.filePath };
    const url = normalizeLanHubUrl(location.url);
    try {
      const current = (this.options.read ?? readLanHubSettings)(settingsAt);
      const entry = current.hubs.find((candidate) => candidate.id === hubId);
      if (!entry || (from !== undefined && entry.url !== from)) return false;
      const known = this.termOf(hubId);
      const term = location.term ?? known + 1;
      const later = term > known || (term === known && url !== entry.url && url < entry.url);
      if (!later) return false;
      this.writeTerm(hubId, { url, term });
      if (url === entry.url) return false;
      const { hubs } = updateLanHub(current.hubs, hubId, { url });
      (this.options.write ?? writeLanHubSettings)(
        { hubs, machineName: current.machineName },
        settingsAt
      );
      this.options.logger.info(
        `[lan] ${entry.name} is at ${url} (term ${term}): ${reason}; following it.`
      );
      return true;
    } catch (error) {
      this.options.logger.warn(
        `[lan] The hub moved to ${url}, and the settings could not follow: ${formatErrorMessage(error)}`
      );
      return false;
    }
  }

  private termsPath(): string {
    return this.options.termsPath ?? path.join(getLodyDataDir(), TERMS_FILE_NAME);
  }

  private readTerms(): Record<string, { url: string; term: number }> {
    try {
      return TermsSchema.parse(JSON.parse(fs.readFileSync(this.termsPath(), 'utf8')));
    } catch {
      return {};
    }
  }

  private writeTerm(hubId: string, value: { url: string; term: number }): void {
    const target = this.termsPath();
    const terms = { ...this.readTerms(), [hubId]: value };
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${target}.${process.pid}.tmp`, `${JSON.stringify(terms, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.renameSync(`${target}.${process.pid}.tmp`, target);
  }

  private apply(next: LanHubSettings): void {
    if (this.restartRequested) return;
    const change = classifyLanHubChange(this.settings, next);
    if (change.kind === 'none') return;
    if (change.kind === 'restart') {
      this.restartRequested = true;
      this.options.logger.info(`[lan] Restarting the agent service: ${change.reason}.`);
      this.options.onRestartRequired(change.reason);
      return;
    }
    this.settings = next;
    const workspaces = toLanWorkspaces(next.hubs);
    this.options.logger.info(
      `[lan] Now a member of ${workspaces.length} LAN(s): ${workspaces
        .map((workspace) => workspace.name)
        .join(', ')}`
    );
    this.workspaceStore.set(workspaces);
  }
}
