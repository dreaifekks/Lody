import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useAtomValue } from 'jotai';
import { Copy, LogOut, Network, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  ElectronLanFailure,
  ElectronLanReachability,
  ElectronLanState,
  ElectronLanSummary,
} from '@lody/shared/electron-ipc';
import type { MachineId, MachineMeta } from '@lody/shared';
import type { LanMachine } from '@lody/shared/lan-control';
import type { LanReleaseChannel } from '@lody/shared/lan-release';
import { currentWorkspaceIdAtom } from '@/atoms/workspace-context';
import { userAtom } from '@/atoms';
import { localMachineIdAtom } from '@/atoms/local-probe';
import { useDialogExitSnapshot } from '@/hooks/use-dialog-exit-snapshot';
import { useElectronUpdaterState } from '@/hooks/use-electron-updater-state';
import { useLanHubLatency } from '@/hooks/use-lan-hub-latency';
import { useLanMachines } from '@/hooks/use-lan-machines';
import { useMachineActions } from '@/hooks/use-machine-actions';
import { useMachineLatency } from '@/hooks/use-machine-latency';
import { useLanSettings, type LanSettings, type LanSettingsResult } from '@/hooks/use-lan-settings';
import { UpdateChangelogDialog } from '@/components/update-changelog-dialog';
import { writeTextToClipboard } from '@/lib/clipboard';
import { getIpcServices } from '@/lib/electron-ipc-client';
import { pickLocalizedReleaseNotes } from '@/lib/electron-update-banner';
import { useMachineSshEntries, writeMachineSshEntry } from '@/lib/machine-ssh-entry';
import { openExternalUrl } from '@/lib/native-browser';
import { withClassName } from '@/lib/stylex';
import { toast } from '@/lib/toast';
import { useLocalWorkspaces } from '../../providers/local-platform-provider';
import { AlertDialog, Dialog } from '@/ui/dialog';
import { Badge } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Spinner } from '@lody/ui/spinner';
import { Tabs } from '@lody/ui/tabs';
import { CompactRow, CompactSection, SettingsEmptyList } from './compact-layout';
import { Field, FormMessage } from './form-primitives';
import { LanAppUpdate } from './lan-app-update';
import { LanMachinesView } from './lan-machines';
import { LanMachineProcesses } from './lan-machine-processes';
import { SettingsPageActions, SettingsPageLead, useSettingsPane } from './settings-page-header';
import {
  SETTINGS_EDITOR_DIALOG_LAYOUT,
  SETTINGS_EDITOR_DIALOG_WIDTH,
  settingsCatalog as catalog,
  settingsSurface as surface,
} from './surface';

const styles = stylex.create({
  /** A fact after a LAN's address: it keeps its width, the address gives way. */
  fact: { flexShrink: 0, whiteSpace: 'nowrap' },
});

type Editor =
  | { mode: 'join' }
  | { mode: 'edit'; lan: ElectronLanSummary }
  | { mode: 'machine-name'; name: string; explicit: boolean };

export type LanSettingViewProps = Pick<
  LanSettings,
  'join' | 'add' | 'update' | 'remove' | 'setMachineName' | 'getInvite'
> & {
  state: ElectronLanState;
  reachability: Readonly<Record<string, ElectronLanReachability>>;
  /** The workspaces the agent service serves; a LAN without one is still starting. */
  servedWorkspaceIds: ReadonlySet<string>;
  /** The build of this application, a row beside the name of this machine. */
  application?: ReactNode;
  /** The machines the LANs reach, below them. */
  machines?: ReactNode;
};

/** Desktop Settings > LAN, wired to the desktop shell. */
export function LanSetting() {
  const { t } = useTranslation();
  const settings = useLanSettings();
  const workspaces = useLocalWorkspaces();

  if (settings.loading) {
    return (
      <div {...stylex.props(surface.container)}>
        <span {...stylex.props(catalog.syncing)}>
          <Spinner size="small" aria-hidden="true" />
          {t('common.loading')}
        </span>
      </div>
    );
  }
  if (!settings.state) {
    return (
      <div {...stylex.props(surface.container)}>
        <SettingsEmptyList>{t('settings.lan.unavailable')}</SettingsEmptyList>
      </div>
    );
  }
  return (
    <LanSettingView
      {...settings}
      state={settings.state}
      servedWorkspaceIds={new Set(workspaces.map((workspace) => workspace.id))}
      application={<LanApplication />}
      machines={<LanMachinesOfThisMachine />}
    />
  );
}

/**
 * The build of this application, wired to what keeps it current. A leaf, so
 * the progress of a download re-renders only its row; where it shows nothing
 * its line of the group has no height and draws no rule.
 */
function LanApplication() {
  const updater = useElectronUpdaterState();
  const { i18n } = useTranslation();
  const [updating, setUpdating] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);

  const failure = updater?.error;
  const phase = updater?.phase;
  useEffect(() => {
    // An update that was started and failed is one that can be started again.
    if (failure) setUpdating(false);
  }, [failure, phase]);

  const check = useCallback(() => {
    void getIpcServices()?.updater.checkForUpdates();
  }, []);
  const follow = useCallback((channel: LanReleaseChannel) => {
    void getIpcServices()?.updater.follow(channel);
  }, []);
  const update = useCallback(() => {
    const ipc = getIpcServices();
    if (!ipc) return;
    setUpdating(true);
    void ipc.updater
      .quitAndInstall()
      .then((result) => {
        if (result.ok) return;
        setUpdating(false);
        toast.error(result.error ?? 'update_failed');
      })
      .catch(() => setUpdating(false));
  }, []);

  const version = updater?.downloadedVersion ?? updater?.availableVersion;
  const followed = updater?.followed?.url;
  return (
    <>
      <LanAppUpdate
        updater={updater}
        updating={updating}
        onCheck={check}
        onFollow={follow}
        onUpdate={update}
        onViewChanges={() => setChangesOpen(true)}
      />
      {version ? (
        <UpdateChangelogDialog
          open={changesOpen}
          onOpenChange={setChangesOpen}
          version={version}
          releaseDate={updater?.releaseDate}
          notes={pickLocalizedReleaseNotes(updater, i18n.resolvedLanguage)}
          onOpenChangelogSite={() => {
            if (followed) void openExternalUrl(followed);
          }}
        />
      ) : null}
    </>
  );
}

/** The machines of the LANs, wired to the agent service of this machine. */
function LanMachinesOfThisMachine() {
  const { t } = useTranslation();
  const { inventory, ...control } = useLanMachines();
  const sshEntries = useMachineSshEntries();
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const user = useAtomValue(userAtom);
  const localMachineId = useAtomValue(localMachineIdAtom);
  // Every member of a LAN is the same user, who may remove any of its machines.
  const { deleteMachine } = useMachineActions({
    currentUserId: user?.id ?? null,
    localMachineId,
    canManageAllMachines: true,
  });
  const [processesOf, setProcessesOf] = useState<LanMachine | null>(null);
  // The window reaches the machines of the LAN it shows; another LAN keeps its own record.
  const inShownLan = (machine: LanMachine) =>
    machine.lans.some((lan) => lan.workspaceId === workspaceId);
  const removeMachine = async (machine: LanMachine) => {
    if (!inShownLan(machine)) throw new Error(t('settings.lan.machines.otherLan'));
    await deleteMachine({
      id: machine.machineId as MachineId,
      name: machine.name,
    } as MachineMeta);
  };
  const showProcesses = (machine: LanMachine) => {
    if (inShownLan(machine)) setProcessesOf(machine);
    else toast.info(t('settings.lan.machines.otherLan'));
  };
  return inventory ? (
    <>
      <LanMachinesView
        inventory={inventory}
        {...control}
        removeMachine={removeMachine}
        onShowProcesses={showProcesses}
        sshEntries={sshEntries}
        onSshEntryChange={(machine, entry) => writeMachineSshEntry(machine.machineId, entry)}
        Latency={LanMachineLatency}
      />
      <LanMachineProcesses machine={processesOf} onClose={() => setProcessesOf(null)} />
    </>
  ) : null;
}

/**
 * How long a machine takes to answer through the hub of the workspace this
 * window shows; a machine of another LAN only, which that hub does not reach,
 * says nothing.
 */
function LanMachineLatency({ machine }: { machine: LanMachine }) {
  const { t } = useTranslation();
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const shared = machine.lans.some((lan) => lan.workspaceId === workspaceId);
  const reach = useMachineLatency(shared ? (machine.machineId as MachineId) : null);
  if (!reach || reach.state === 'checking') return null;
  return (
    <>
      {t('settings.lan.machines.factSeparator')}
      {reach.state === 'online'
        ? t('settings.lan.latency', { ms: reach.ms })
        : t('settings.lan.noAnswer')}
    </>
  );
}

/** The hub's round trip after a LAN that answers. */
function LanHubLatency({ lanId }: { lanId: string }) {
  const { t } = useTranslation();
  const latency = useLanHubLatency(lanId);
  if (latency === undefined) return null;
  return (
    <>
      {t('settings.lan.machines.factSeparator')}
      {latency === null ? t('settings.lan.noAnswer') : t('settings.lan.latency', { ms: latency })}
    </>
  );
}

export function LanSettingView({
  state,
  reachability,
  servedWorkspaceIds,
  application,
  machines,
  join,
  add,
  update,
  remove,
  setMachineName,
  getInvite,
}: LanSettingViewProps) {
  const { t } = useTranslation();
  const settingsPane = useSettingsPane();
  const [editor, setEditor] = useState<Editor | null>(null);
  const { shown: shownEditor, onOpenChangeComplete } = useDialogExitSnapshot(editor);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<ElectronLanFailure | null>(null);
  const [leaving, setLeaving] = useState<ElectronLanSummary | null>(null);
  const [leaveInFlight, setLeaveInFlight] = useState(false);

  const describeFailure = (result: ElectronLanFailure): string =>
    t(`settings.lan.errors.${result.code}`, { defaultValue: result.message });

  const open = (next: Editor) => {
    setFailure(null);
    setEditor(next);
  };
  const close = () => {
    setFailure(null);
    setEditor(null);
  };
  const submit = async (run: () => Promise<LanSettingsResult>) => {
    setSubmitting(true);
    setFailure(null);
    const result = await run();
    setSubmitting(false);
    if (result.ok) close();
    else setFailure(result);
  };

  const copyInvite = async (lan: ElectronLanSummary) => {
    const invite = await getInvite({ id: lan.id });
    if (invite && (await writeTextToClipboard(invite))) {
      toast.success(t('settings.lan.inviteCopied', { name: lan.name }));
      return;
    }
    toast.error(t('settings.lan.inviteFailed'));
  };

  const confirmLeave = async () => {
    if (!leaving) return;
    setLeaveInFlight(true);
    const result = await remove({ id: leaving.id });
    setLeaveInFlight(false);
    setLeaving(null);
    if (!result.ok) toast.error(describeFailure(result));
  };

  return (
    <div {...stylex.props(surface.container)}>
      <SettingsPageLead>{t('settings.lan.description')}</SettingsPageLead>

      <SettingsPageActions>
        <Button
          size="small"
          variant="secondary"
          disabled={!state.editable}
          onClick={() => open({ mode: 'join' })}
        >
          <Plus {...stylex.props(catalog.icon)} />
          {t('settings.lan.join')}
        </Button>
      </SettingsPageActions>

      {state.error ? (
        <FormMessage tone="error">{t('settings.lan.settingsUnreadable')}</FormMessage>
      ) : null}
      {!state.editable ? (
        <FormMessage tone="warning">{t('settings.lan.notEditable')}</FormMessage>
      ) : null}

      <CompactSection title={t('settings.lan.thisMachine')}>
        <CompactRow label={state.machineName.name}>
          <Button
            size="small"
            variant="secondary"
            disabled={!state.editable}
            onClick={() =>
              open({
                mode: 'machine-name',
                name: state.machineName.name,
                explicit: state.machineName.explicit,
              })
            }
          >
            {t('settings.lan.rename')}
          </Button>
        </CompactRow>
        {application}
      </CompactSection>

      {state.lans.length === 0 ? (
        <SettingsEmptyList>{t('settings.lan.empty')}</SettingsEmptyList>
      ) : (
        <CompactSection title={t('settings.lan.lans')} boxed>
          {state.lans.map((lan) => (
            <LanRow
              key={lan.id}
              lan={lan}
              editable={state.editable}
              status={!servedWorkspaceIds.has(lan.workspaceId) ? 'starting' : reachability[lan.id]}
              onEdit={() => open({ mode: 'edit', lan })}
              onCopyInvite={() => void copyInvite(lan)}
              onLeave={() => setLeaving(lan)}
            />
          ))}
        </CompactSection>
      )}

      {machines}

      <Dialog.Root
        open={editor !== null}
        onOpenChange={(next) => {
          if (!next) close();
        }}
        onOpenChangeComplete={onOpenChangeComplete}
      >
        <Dialog.Content
          width={SETTINGS_EDITOR_DIALOG_WIDTH}
          centerOn={settingsPane}
          className={SETTINGS_EDITOR_DIALOG_LAYOUT}
        >
          <Dialog.Header>
            <Dialog.Title>
              {shownEditor?.mode === 'edit'
                ? t('settings.lan.editTitle')
                : shownEditor?.mode === 'machine-name'
                  ? t('settings.lan.machineNameTitle')
                  : t('settings.lan.joinTitle')}
            </Dialog.Title>
            <Dialog.Description>
              {shownEditor?.mode === 'edit'
                ? t('settings.lan.editDescription')
                : shownEditor?.mode === 'machine-name'
                  ? t('settings.lan.machineNameDescription')
                  : t('settings.lan.joinDescription')}
            </Dialog.Description>
          </Dialog.Header>
          {shownEditor?.mode === 'join' ? (
            <JoinLanForm
              submitting={submitting}
              error={failure ? describeFailure(failure) : undefined}
              onCancel={close}
              onJoin={(input) => void submit(() => join(input))}
              onAdd={(input) => void submit(() => add(input))}
            />
          ) : null}
          {shownEditor?.mode === 'edit' ? (
            <EditLanForm
              key={shownEditor.lan.id}
              lan={shownEditor.lan}
              submitting={submitting}
              error={failure ? describeFailure(failure) : undefined}
              onCancel={close}
              onSubmit={(input) => void submit(() => update({ id: shownEditor.lan.id, ...input }))}
            />
          ) : null}
          {shownEditor?.mode === 'machine-name' ? (
            <MachineNameForm
              name={shownEditor.name}
              explicit={shownEditor.explicit}
              submitting={submitting}
              error={failure ? describeFailure(failure) : undefined}
              onCancel={close}
              onSubmit={(name) => void submit(() => setMachineName({ name }))}
            />
          ) : null}
        </Dialog.Content>
      </Dialog.Root>

      <AlertDialog.Root
        open={leaving !== null}
        onOpenChange={(next) => {
          if (!next && !leaveInFlight) setLeaving(null);
        }}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>{t('settings.lan.leaveTitle')}</AlertDialog.Title>
            <AlertDialog.Description>
              {t('settings.lan.confirmLeave', { name: leaving?.name ?? '' })}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel disabled={leaveInFlight}>{t('common.cancel')}</AlertDialog.Cancel>
            <Button
              disabled={leaveInFlight}
              variant="destructive"
              onClick={() => void confirmLeave()}
            >
              {leaveInFlight ? <Spinner size="small" /> : null}
              {t('settings.lan.leave')}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </div>
  );
}

type LanRowStatus = ElectronLanReachability | 'starting' | undefined;

function LanRow({
  lan,
  status,
  editable,
  onEdit,
  onCopyInvite,
  onLeave,
}: {
  lan: ElectronLanSummary;
  status: LanRowStatus;
  editable: boolean;
  onEdit: () => void;
  onCopyInvite: () => void;
  onLeave: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div {...stylex.props(catalog.row, surface.pressableLine)}>
      <button
        type="button"
        onClick={onEdit}
        disabled={!editable}
        aria-label={t('settings.lan.editLan', { name: lan.name })}
        {...stylex.props(catalog.rowMain)}
      >
        <span {...stylex.props(catalog.glyph)}>
          <Network {...stylex.props(catalog.icon)} aria-hidden="true" />
        </span>
        <span {...stylex.props(catalog.body)}>
          <span {...stylex.props(catalog.titleLine)}>
            <span {...stylex.props(catalog.name)}>{lan.name}</span>
            {/* A LAN that answers is the resting state: only one that does not is marked. */}
            {status === undefined || status === 'reachable' ? null : (
              <Badge>{t(`settings.lan.status.${status}`)}</Badge>
            )}
          </span>
          <span {...stylex.props(catalog.meta)}>
            <span {...stylex.props(catalog.truncate, catalog.mono)}>{lan.url}</span>
            {status === 'reachable' ? (
              <span {...stylex.props(styles.fact)}>
                <LanHubLatency lanId={lan.id} />
              </span>
            ) : null}
          </span>
        </span>
      </button>
      <div {...stylex.props(catalog.actions)}>
        <Button
          type="button"
          variant="ghost"
          size="small"
          icon
          aria-label={t('settings.lan.copyInvite', { name: lan.name })}
          title={t('settings.lan.copyInvite', { name: lan.name })}
          onClick={onCopyInvite}
        >
          <Copy {...stylex.props(catalog.icon)} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="small"
          icon
          tone="destructive"
          disabled={!editable}
          aria-label={t('settings.lan.leaveLan', { name: lan.name })}
          title={t('settings.lan.leaveLan', { name: lan.name })}
          onClick={onLeave}
        >
          <LogOut {...stylex.props(catalog.icon)} />
        </Button>
      </div>
    </div>
  );
}

type FormFrameProps = {
  submitting: boolean;
  error?: string;
  onCancel: () => void;
};

function FormFooter({
  submitting,
  disabled,
  submitLabel,
  onCancel,
}: {
  submitting: boolean;
  disabled: boolean;
  submitLabel: string;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog.Footer>
      <Button type="button" variant="secondary" disabled={submitting} onClick={onCancel}>
        {t('common.cancel')}
      </Button>
      <Button type="submit" disabled={submitting || disabled}>
        {submitting ? <Spinner size="small" aria-hidden="true" /> : null}
        {submitLabel}
      </Button>
    </Dialog.Footer>
  );
}

function JoinLanForm({
  submitting,
  error,
  onCancel,
  onJoin,
  onAdd,
}: FormFrameProps & {
  onJoin: (input: { invite: string; name: string | null }) => void;
  onAdd: (input: { url: string; token: string; name: string | null }) => void;
}) {
  const { t } = useTranslation();
  const fieldId = useId();
  const [how, setHow] = useState<'invite' | 'address'>('invite');
  const [invite, setInvite] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [name, setName] = useState('');

  const complete =
    how === 'invite' ? invite.trim() !== '' : url.trim() !== '' && token.trim() !== '';
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const chosenName = name.trim() || null;
    if (how === 'invite') onJoin({ invite: invite.trim(), name: chosenName });
    else onAdd({ url: url.trim(), token: token.trim(), name: chosenName });
  };

  return (
    <form {...withClassName(stylex.props(catalog.editorForm))} onSubmit={submit}>
      <div {...withClassName(stylex.props(catalog.editorBody), 'scrollbar-pro')}>
        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
        <Tabs.Root value={how} onValueChange={(next) => setHow(next as typeof how)}>
          <Tabs.List aria-label={t('settings.lan.form.how')}>
            <Tabs.Tab value="invite">{t('settings.lan.form.byInvite')}</Tabs.Tab>
            <Tabs.Tab value="address">{t('settings.lan.form.byAddress')}</Tabs.Tab>
          </Tabs.List>
        </Tabs.Root>
        {how === 'invite' ? (
          // The tab above names this field; a label under it would say it twice.
          <Input
            aria-label={t('settings.lan.form.invite')}
            autoComplete="off"
            spellCheck={false}
            placeholder="lody-lan://…"
            value={invite}
            onChange={(event) => setInvite(event.target.value)}
          />
        ) : (
          <>
            <Field htmlFor={`${fieldId}-url`} label={t('settings.lan.form.address')}>
              <Input
                id={`${fieldId}-url`}
                autoComplete="off"
                spellCheck={false}
                placeholder="100.64.0.1:8788"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
            </Field>
            <Field htmlFor={`${fieldId}-token`} label={t('settings.lan.form.token')}>
              <Input
                id={`${fieldId}-token`}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
            </Field>
          </>
        )}
        <Field
          htmlFor={`${fieldId}-name`}
          label={t('settings.lan.form.name')}
          hint={t('settings.lan.form.nameHint')}
        >
          <Input
            id={`${fieldId}-name`}
            autoComplete="off"
            placeholder={t('settings.lan.form.namePlaceholder')}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
      </div>
      <FormFooter
        submitting={submitting}
        disabled={!complete}
        submitLabel={t('settings.lan.join')}
        onCancel={onCancel}
      />
    </form>
  );
}

function EditLanForm({
  lan,
  submitting,
  error,
  onCancel,
  onSubmit,
}: FormFrameProps & {
  lan: ElectronLanSummary;
  onSubmit: (input: { name: string; url: string }) => void;
}) {
  const { t } = useTranslation();
  const fieldId = useId();
  const [name, setName] = useState(lan.name);
  const [url, setUrl] = useState(lan.url);
  const moved = url.trim() !== lan.url;

  return (
    <form
      {...withClassName(stylex.props(catalog.editorForm))}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ name: name.trim(), url: url.trim() });
      }}
    >
      <div {...withClassName(stylex.props(catalog.editorBody), 'scrollbar-pro')}>
        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
        {moved ? (
          <FormMessage tone="warning">{t('settings.lan.form.moveWarning')}</FormMessage>
        ) : null}
        <Field htmlFor={`${fieldId}-name`} label={t('settings.lan.form.name')}>
          <Input
            id={`${fieldId}-name`}
            required
            autoComplete="off"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field htmlFor={`${fieldId}-url`} label={t('settings.lan.form.address')}>
          <Input
            id={`${fieldId}-url`}
            required
            autoComplete="off"
            spellCheck={false}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </Field>
      </div>
      <FormFooter
        submitting={submitting}
        disabled={name.trim() === '' || url.trim() === ''}
        submitLabel={t('common.save')}
        onCancel={onCancel}
      />
    </form>
  );
}

function MachineNameForm({
  name: initialName,
  explicit,
  submitting,
  error,
  onCancel,
  onSubmit,
}: FormFrameProps & {
  name: string;
  explicit: boolean;
  /** `null` follows the host name again. */
  onSubmit: (name: string | null) => void;
}) {
  const { t } = useTranslation();
  const fieldId = useId();
  const [name, setName] = useState(initialName);

  return (
    <form
      {...withClassName(stylex.props(catalog.editorForm))}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(name.trim());
      }}
    >
      <div {...withClassName(stylex.props(catalog.editorBody), 'scrollbar-pro')}>
        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
        <FormMessage tone="warning">{t('settings.lan.form.machineNameWarning')}</FormMessage>
        <Field htmlFor={`${fieldId}-machine-name`} label={t('settings.lan.form.machineName')}>
          <Input
            id={`${fieldId}-machine-name`}
            required
            autoComplete="off"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        {explicit ? (
          <div>
            <Button
              type="button"
              variant="ghost"
              size="small"
              disabled={submitting}
              onClick={() => onSubmit(null)}
            >
              {t('settings.lan.form.followHostName')}
            </Button>
          </div>
        ) : null}
      </div>
      <FormFooter
        submitting={submitting}
        disabled={name.trim() === '' || (name.trim() === initialName && explicit)}
        submitLabel={t('common.save')}
        onCancel={onCancel}
      />
    </form>
  );
}
