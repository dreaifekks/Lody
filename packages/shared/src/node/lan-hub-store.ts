// The LANs of this installation as a long-running process holds them: read
// once, kept current while the settings file changes, and edited through one
// place so every edit is validated and written the same way.
import {
  LanHubInputError,
  formatLanInvite,
  parseLanInvite,
  type LanHubSummary,
} from '../lan-hub';
import {
  addLanHub,
  normalizeMachineNameInput,
  readLanHubSettings,
  removeLanHub,
  resolveMachineName,
  summarizeLanHubs,
  updateLanHub,
  watchLanHubSettings,
  writeLanHubSettings,
  type LanHub,
  type LanHubSettings,
  type LanHubSettingsLocation,
  type LanHubSettingsWatcher,
} from './lan-hub';

export type LanHubStoreState = {
  /** `false` when the LANs come from the environment and cannot be edited here. */
  editable: boolean;
  /** Why the settings could not be read; the LANs read before stay in use. */
  error: string | null;
  machineName: { name: string; explicit: boolean };
  lans: LanHubSummary[];
};

export type LanHubStoreFailure = {
  ok: false;
  code: LanHubInputError['code'] | 'not_editable' | 'write_failed';
  message: string;
};

export type LanHubStoreResult<T = Record<never, never>> =
  | ({ ok: true; state: LanHubStoreState } & T)
  | LanHubStoreFailure;

const UNREADABLE: LanHubSettings = { hubs: [], machineName: null, source: 'none' };

export class LanHubStore {
  private settings: LanHubSettings = UNREADABLE;
  private error: string | null = null;
  private watcher: LanHubSettingsWatcher | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly options: LanHubSettingsLocation & {
      hostname?: string;
      watch?: typeof watchLanHubSettings;
    } = {}
  ) {
    this.reload();
  }

  /** Follows edits made by other processes, such as `lody lan join`. */
  start(): void {
    if (this.watcher || this.settings.source === 'environment') return;
    this.watcher = (this.options.watch ?? watchLanHubSettings)({
      env: this.options.env,
      filePath: this.options.filePath,
      onChange: (settings) => this.adopt(settings, null),
      onError: (error) => this.adopt(this.settings, describe(error)),
    });
    // The settings were read before they were watched.
    this.reload();
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
    this.listeners.clear();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getHubs(): readonly LanHub[] {
    return this.settings.hubs;
  }

  /** The hub a renderer addressed, with the credential the renderer never sees. */
  resolve(hubId: string): LanHub | null {
    return this.settings.hubs.find((hub) => hub.id === hubId) ?? null;
  }

  getState(): LanHubStoreState {
    return {
      editable: this.settings.source !== 'environment',
      error: this.error,
      machineName: resolveMachineName({
        settings: this.settings,
        ...(this.options.hostname ? { hostname: this.options.hostname } : {}),
      }),
      lans: summarizeLanHubs(this.settings.hubs),
    };
  }

  join(input: { invite: string; name?: string | null }): LanHubStoreResult<{ lan: LanHubSummary }> {
    return this.editLan((hubs) => {
      const invite = parseLanInvite(input.invite);
      return addLanHub(hubs, {
        url: invite.url,
        token: invite.token,
        name: input.name?.trim() ? input.name : invite.name,
      });
    });
  }

  add(input: {
    url: string;
    token: string;
    name?: string | null;
  }): LanHubStoreResult<{ lan: LanHubSummary }> {
    return this.editLan((hubs) => addLanHub(hubs, input));
  }

  update(input: {
    id: string;
    name?: string | null;
    url?: string | null;
  }): LanHubStoreResult<{ lan: LanHubSummary }> {
    return this.editLan((hubs) => updateLanHub(hubs, input.id, { name: input.name, url: input.url }));
  }

  remove(input: { id: string }): LanHubStoreResult {
    return this.edit((settings) => ({
      ...settings,
      hubs: removeLanHub(settings.hubs, input.id).hubs,
    }));
  }

  setMachineName(input: { name: string | null }): LanHubStoreResult {
    return this.edit((settings) => ({
      ...settings,
      machineName: normalizeMachineNameInput(input.name),
    }));
  }

  /** The link another device joins this LAN with. It carries the credential. */
  getInvite(input: { id: string }): { ok: true; invite: string } | LanHubStoreFailure {
    const hub = this.resolve(input.id);
    if (!hub) return { ok: false, code: 'unknown_hub', message: 'This LAN no longer exists' };
    return { ok: true, invite: formatLanInvite(hub) };
  }

  private reload(): void {
    try {
      this.adopt(readLanHubSettings(this.options), null);
    } catch (error) {
      this.adopt(this.settings, describe(error));
    }
  }

  private adopt(settings: LanHubSettings, error: string | null): void {
    this.settings = settings;
    this.error = error;
    for (const listener of [...this.listeners]) listener();
  }

  private editLan(
    change: (hubs: readonly LanHub[]) => { hubs: LanHub[]; hub: LanHub }
  ): LanHubStoreResult<{ lan: LanHubSummary }> {
    let lanId: string | null = null;
    const result = this.edit((settings) => {
      const changed = change(settings.hubs);
      lanId = changed.hub.id;
      return { ...settings, hubs: changed.hubs };
    });
    if (!result.ok) return result;
    const lan = result.state.lans.find((entry) => entry.id === lanId);
    if (!lan) {
      return { ok: false, code: 'unknown_hub', message: 'This LAN no longer exists' };
    }
    return { ...result, lan };
  }

  private edit(change: (settings: LanHubSettings) => LanHubSettings): LanHubStoreResult {
    let current: LanHubSettings;
    try {
      // Read again: another process may have edited the file since.
      current = readLanHubSettings(this.options);
    } catch (error) {
      return { ok: false, code: 'write_failed', message: describe(error) };
    }
    if (current.source === 'environment') {
      return {
        ok: false,
        code: 'not_editable',
        message: 'LANs are set by the environment of this application',
      };
    }
    let next: LanHubSettings;
    try {
      next = change(current);
    } catch (error) {
      if (error instanceof LanHubInputError) {
        return { ok: false, code: error.code, message: error.message };
      }
      throw error;
    }
    try {
      writeLanHubSettings(next, this.options);
    } catch (error) {
      return { ok: false, code: 'write_failed', message: describe(error) };
    }
    this.adopt({ ...next, source: 'file' }, null);
    return { ok: true, state: this.getState() };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
