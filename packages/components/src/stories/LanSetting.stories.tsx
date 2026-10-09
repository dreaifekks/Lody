import type { Meta, StoryObj } from '@storybook/react';
import type {
  ElectronLanState,
  ElectronLanSummary,
  ElectronUpdaterState,
} from '@lody/shared/electron-ipc';
import type { HostedConfigPreview } from '@lody/shared/hosted-config';
import type { LanMachine, LanMachines } from '@lody/shared/lan-control';
import { LanAppUpdate } from '@/components/settings/lan-app-update';
import { LanMachinesView } from '@/components/settings/lan-machines';
import { LanSettingView } from '@/components/settings/lan-setting';
import type { LanSettingsResult } from '@/hooks/use-lan-settings';

const lan = (id: string, name: string, url: string): ElectronLanSummary => ({
  id: id.repeat(32),
  name,
  url,
  slug: name.toLowerCase(),
  workspaceId: `lw_${id.repeat(32)}`,
  userId: `local:${id.repeat(32)}`,
});

const home = lan('a', 'Home', 'http://100.64.0.1:8788');
const office = lan('b', 'Office', 'https://hub.example.com');
const lab = lan('c', 'Lab', 'http://192.168.1.5:8788');

const state: ElectronLanState = {
  editable: true,
  error: null,
  machineName: { name: 'macbook-air', explicit: false },
  lans: [home, office, lab],
};

const accepted = async (): Promise<LanSettingsResult> => ({ ok: true });

const RUNNING = '0.100.0-lan.4';
const NEWEST = '0.100.0-lan.5';
const source = { repository: 'someone/Lody', tag: 'lan-latest' };

const updater = (overrides: Partial<ElectronUpdaterState> = {}): ElectronUpdaterState => ({
  phase: 'available',
  currentVersion: RUNNING,
  availableVersion: NEWEST,
  followed: { ...source, url: 'https://github.com/someone/Lody/releases/tag/lan-latest' },
  ...overrides,
});

const machine = (overrides: Partial<LanMachine> & { machineId: string }): LanMachine => ({
  name: overrides.machineId,
  alias: null,
  os: 'linux',
  self: false,
  online: true,
  lans: [{ workspaceId: home.workspaceId, name: home.name }],
  version: RUNNING,
  build: { version: RUNNING, update: 'service', source },
  update: null,
  controllable: true,
  agents: [],
  ...overrides,
});

const machines: LanMachines = {
  newest: { version: NEWEST, commit: 'abcdef12', builtAt: '2026-09-29T00:00:00.000Z' },
  machines: [
    machine({
      machineId: 'macbook-air',
      os: 'darwin',
      self: true,
      lans: [
        { workspaceId: home.workspaceId, name: home.name },
        { workspaceId: office.workspaceId, name: office.name },
      ],
      build: { version: RUNNING, update: 'desktop', source },
      agents: [
        { agentType: 'claude', name: 'Claude Code', version: '2.1.280', state: 'current' },
        { agentType: 'codex', name: 'Codex', target: '0.156.0', state: 'missing' },
      ],
    }),
    machine({
      machineId: 'home-server',
      name: 'home-server-ubuntu-2404-lts',
      alias: 'home',
      color: 'teal',
      hub: { part: 'hub', term: 3, snapshotAt: null, rttMs: 0 },
      agents: [
        { agentType: 'claude', name: 'Claude Code', version: '2.1.280', state: 'current' },
        {
          agentType: 'codex',
          name: 'Codex',
          version: '0.155.0',
          target: '0.156.0',
          state: 'outdated',
        },
      ],
    }),
    machine({
      machineId: 'build-box',
      version: NEWEST,
      update: null,
      build: { version: NEWEST, update: 'service', source },
      hub: {
        part: 'standby',
        term: 3,
        snapshotAt: new Date(Date.now() - 4 * 60_000).toISOString(),
        rttMs: 4,
      },
    }),
    machine({
      machineId: 'render-farm',
      update: { phase: 'installing', version: NEWEST, at: 1 },
    }),
    machine({
      machineId: 'attic',
      update: {
        phase: 'failed',
        version: NEWEST,
        at: 1,
        error: 'npm could not install the build: ENOSPC no space left on device',
      },
    }),
    machine({ machineId: 'old-laptop', online: false, controllable: false, build: null }),
  ],
};

const hosted: HostedConfigPreview = {
  found: true,
  sources: [
    {
      workspaceId: 'hosted',
      name: 'Team',
      items: [
        { category: 'agentConfigs', id: 'a1', name: 'Claude Code', action: 'unchanged' },
        { category: 'agentConfigs', id: 'a2', name: 'Codex', action: 'update', needsSignIn: true },
        { category: 'localProjects', id: 'p1', name: 'mizuki', action: 'create' },
        {
          category: 'localProjects',
          id: 'p2',
          name: 'gone',
          action: 'skip',
          reason: 'missing_directory',
        },
      ],
    },
  ],
};

const machinesView = (
  <LanMachinesView
    inventory={machines}
    setAlias={async (_machine, alias, color) => ({ ok: true, result: { alias, color } })}
    updateMachine={async () => ({ ok: true, result: { outcome: 'started', version: NEWEST } })}
    installAgent={async (_machine, agentType) => ({
      ok: true,
      result: { agentType, outcome: 'started' },
    })}
    previewHostedImport={async () => ({ ok: true, result: hosted })}
    importHostedConfig={async () => ({
      ok: true,
      result: { workspaceId: home.workspaceId, items: hosted.sources[0]?.items ?? [] },
    })}
    sshEntries={{ 'home-server': 'ts:home-server' }}
    onSshEntryChange={() => {}}
    Latency={({ machine: of }) => <> · {of.self ? 18 : 12} ms</>}
  />
);

const application = (reported: ElectronUpdaterState, updating = false) => (
  <LanAppUpdate
    updater={reported}
    updating={updating}
    onCheck={() => {}}
    onFollow={() => {}}
    onUpdate={() => {}}
    onViewChanges={() => {}}
  />
);

const meta = {
  title: 'Settings/LanSetting',
  component: LanSettingView,
  args: {
    state,
    reachability: { [home.id]: 'reachable', [office.id]: 'unreachable', [lab.id]: 'unauthorized' },
    servedWorkspaceIds: new Set([home.workspaceId, office.workspaceId, lab.workspaceId]),
    join: accepted,
    add: accepted,
    update: accepted,
    remove: accepted,
    setMachineName: accepted,
    getInvite: async () => 'lody-lan://example-token@100.64.0.1:8788/Home',
  },
  decorators: [
    (Story) => (
      <div className="mx-auto w-[640px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof LanSettingView>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One LAN that answers, one whose host is down, one that rejects the invite. */
export const SeveralLans: Story = {};

export const NoLan: Story = {
  args: { state: { ...state, lans: [] }, reachability: {} },
};

/** The LAN was joined a moment ago; the agent service has not started its workspace yet. */
export const JustJoined: Story = {
  args: { servedWorkspaceIds: new Set([home.workspaceId, office.workspaceId]) },
};

export const NamedMachine: Story = {
  args: { state: { ...state, machineName: { name: 'Studio Mac', explicit: true } } },
};

export const SetByEnvironment: Story = {
  args: { state: { ...state, editable: false, lans: [home] } },
};

export const UnreadableSettings: Story = {
  args: { state: { ...state, error: 'LAN config is not valid JSON' } },
};

/** The shell refuses every edit, so an editor shows how it explains a failure. */
export const RejectedEdit: Story = {
  args: {
    join: async (): Promise<LanSettingsResult> => ({
      ok: false,
      code: 'invalid_invite',
      message: 'A LAN invite starts with lody-lan:// or lody-lans://',
    }),
  },
};

/**
 * A later build is out: this application offers it, a server is updated from
 * here, and a machine whose build is too old is updated by hand once.
 */
export const WithMachines: Story = {
  args: { application: application(updater()), machines: machinesView },
};

export const ApplicationDownloading: Story = {
  args: {
    application: application(updater({ phase: 'downloading', percent: 41.6 }), true),
    machines: machinesView,
  },
};

export const ApplicationUpToDate: Story = {
  args: {
    application: application(updater({ phase: 'up_to_date', availableVersion: undefined })),
    machines: machinesView,
  },
};

/** Switched to the dev release, which has nothing later than the running build. */
export const ApplicationFollowsDev: Story = {
  args: {
    application: application(
      updater({
        phase: 'up_to_date',
        availableVersion: undefined,
        followed: {
          repository: source.repository,
          tag: 'lan-dev',
          url: 'https://github.com/someone/Lody/releases/tag/lan-dev',
        },
      })
    ),
    machines: machinesView,
  },
};

/** The application runs from a disk image, where it cannot replace itself. */
export const ApplicationNotInstalled: Story = {
  args: {
    application: application(updater({ phase: 'disabled', disabledReason: 'not_installed' })),
    machines: machinesView,
  },
};
