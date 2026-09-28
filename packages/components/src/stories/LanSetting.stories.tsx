import type { Meta, StoryObj } from '@storybook/react';
import type { ElectronLanState, ElectronLanSummary } from '@lody/shared/electron-ipc';
import { LanSettingView } from '@/components/settings/lan-setting';
import type { LanSettingsResult } from '@/hooks/use-lan-settings';

const lan = (id: string, name: string, url: string): ElectronLanSummary => ({
  id: id.repeat(32),
  name,
  url,
  slug: name.toLowerCase(),
  workspaceId: `lw_${id.repeat(32)}`,
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
