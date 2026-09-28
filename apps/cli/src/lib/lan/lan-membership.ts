import {
  createStore,
  type CloudStreamsTokenPort,
  type ReadonlyStore,
  type WorkspaceSummary,
} from '@lody/platform';
import { createStaticLoroStreamsTokenProvider } from '@lody/shared';
import {
  classifyLanHubChange,
  readLanHubSettings,
  summarizeLanHubs,
  watchLanHubSettings,
  type LanHub,
  type LanHubSettings,
  type LanHubSettingsWatcher,
} from '@lody/shared/node/lan-hub';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';

export function toLanWorkspaces(hubs: readonly LanHub[]): WorkspaceSummary[] {
  return summarizeLanHubs(hubs).map((hub) => ({
    id: hub.workspaceId,
    name: hub.name,
    slug: hub.slug,
    role: 'owner',
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
  private restartRequested = false;

  constructor(
    private readonly options: {
      settings: LanHubSettings;
      logger: Logger;
      /** The change cannot be followed by this process; it has to start again. */
      onRestartRequired: (reason: string) => void;
      watch?: typeof watchLanHubSettings;
      read?: typeof readLanHubSettings;
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
        const hub = summarizeLanHubs(this.settings.hubs).find(
          (candidate) => candidate.workspaceId === workspaceId
        );
        const credentials = hub && this.settings.hubs.find((entry) => entry.id === hub.id);
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
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
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
