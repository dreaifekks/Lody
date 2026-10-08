import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { Lock, MoreHorizontal, PencilLine, Search, Trash2 } from 'lucide-react';
import type { WorkspaceRepository } from '@lody/cloud-api';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Spinner } from '@lody/ui/spinner';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { currentWorkspaceIdAtom } from '@/atoms/workspace-context';
import { useLanGitHub, type LanGitHubMachine } from '@/hooks/use-lan-github';
import { invalidateGitHubTokensForWorkspace } from '@/lib/github-token';
import {
  forgetLocalGitHubRepositories,
  listLocalGitHubRepositories,
} from '@/lib/local-github-repositories';
import { withClassName } from '@/lib/stylex';
import { toast } from '@/lib/toast';
import { AlertDialog, Dialog } from '@/ui/dialog';
import { Menu } from '@/ui/menu';
import { CompactRow, CompactSection, SettingsEmptyList } from './compact-layout';
import { Field, FormMessage } from './form-primitives';
import { useSettingsPane } from './settings-page-header';
import {
  SETTINGS_EDITOR_DIALOG_LAYOUT,
  SETTINGS_EDITOR_DIALOG_WIDTH,
  settingsCatalog as catalog,
  settingsSurface as surface,
} from './surface';

/** Past this many repositories a person looks one up rather than scanning for it. */
const SEARCH_THRESHOLD = 5;

const styles = stylex.create({
  private: { flexShrink: 0, width: '12px', height: '12px', color: colors.tertiaryLabel },
  warning: { color: colors.warning },
  repo: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    minWidth: 0,
    paddingInline: space[4],
    paddingBlock: '0.6em',
  },
  repoName: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: colors.label,
  },
  count: { fontVariantNumeric: 'tabular-nums' },
});

/**
 * Settings > GitHub without the hosted GitHub App: the token the LAN's hub
 * keeps for its members, which credential each machine's agents use, and the
 * repositories the pickers offer. A token is sent to the hub and never shown.
 */
export function LocalGitHubSettings() {
  const { t } = useTranslation();
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const github = useLanGitHub(workspaceId);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [repositories, setRepositories] = useState<WorkspaceRepository[] | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!workspaceId) return undefined;
    let current = true;
    setRepositories(null);
    listLocalGitHubRepositories(workspaceId).then(
      (listed) => {
        if (current) setRepositories(listed);
      },
      () => {
        if (current) setRepositories([]);
      }
    );
    return () => {
      current = false;
    };
  }, [workspaceId, revision]);

  const save = useCallback(
    async (token: string | null) => {
      const answer = await github.saveToken(token);
      if (answer.ok && workspaceId) {
        invalidateGitHubTokensForWorkspace(workspaceId);
        forgetLocalGitHubRepositories(workspaceId);
        setRevision((value) => value + 1);
      }
      return answer;
    },
    [github, workspaceId]
  );

  const tokenHelper =
    github.hubToken === undefined ? (
      <Spinner size="small" />
    ) : github.hubToken ? (
      `@${github.hubToken.login ?? '?'}`
    ) : (
      t('settings.integrations.github.local.tokenNone')
    );

  return (
    <div {...stylex.props(surface.container)}>
      {github.lan ? (
        <CompactSection>
          <CompactRow label={t('settings.integrations.github.local.token')} helper={tokenHelper}>
            {github.hubToken === null ? (
              <Button variant="secondary" size="small" onClick={() => setEditing(true)}>
                {t('settings.integrations.github.local.tokenSet')}
              </Button>
            ) : github.hubToken ? (
              <Menu.Root>
                <Menu.Trigger
                  render={
                    <Button
                      variant="ghost"
                      size="small"
                      icon
                      aria-label={t('settings.integrations.github.local.token')}
                    >
                      <MoreHorizontal {...stylex.props(catalog.icon)} />
                    </Button>
                  }
                />
                <Menu.Content align="end">
                  <Menu.Item icon={<PencilLine />} onClick={() => setEditing(true)}>
                    {t('settings.integrations.github.local.tokenReplace')}
                  </Menu.Item>
                  <Menu.Item icon={<Trash2 />} onClick={() => setRemoving(true)}>
                    {t('settings.integrations.github.local.tokenRemove')}
                  </Menu.Item>
                </Menu.Content>
              </Menu.Root>
            ) : null}
          </CompactRow>
        </CompactSection>
      ) : null}

      {github.machines && github.machines.length > 0 ? (
        <CompactSection title={t('settings.lan.machines.title')} boxed>
          {github.machines.map((machine) => (
            <CompactRow
              key={machine.machineId}
              label={machine.name}
              helper={<MachineCredential machine={machine} />}
            />
          ))}
        </CompactSection>
      ) : null}

      <Repositories repositories={repositories} />

      <TokenDialog open={editing} onClose={() => setEditing(false)} onSave={save} />

      <AlertDialog.Root open={removing} onOpenChange={setRemoving}>
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>
              {t('settings.integrations.github.local.removeTitle')}
            </AlertDialog.Title>
            <AlertDialog.Description>
              {t('settings.integrations.github.local.removeDescription')}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel>{t('common.cancel')}</AlertDialog.Cancel>
            <Button
              variant="destructive"
              onClick={() => {
                setRemoving(false);
                void save(null).then((answer) => {
                  if (!answer.ok) toast.error(answer.message);
                });
              }}
            >
              {t('settings.integrations.github.local.tokenRemove')}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </div>
  );
}

/** Which credential a machine's agents use: its own `gh` login first, then the LAN's token. */
function MachineCredential({ machine }: { machine: LanGitHubMachine }) {
  const { t } = useTranslation();
  const { state } = machine;
  if (state === null) return <Spinner size="small" />;
  if (state === 'offline' || state === 'unanswered') {
    return <>{t(`settings.integrations.github.local.${state}`)}</>;
  }
  const account = state.own ?? state.lan;
  if (!account) {
    return (
      <span {...stylex.props(styles.warning)}>{t('settings.integrations.github.local.none')}</span>
    );
  }
  const source = state.own
    ? t('settings.integrations.github.local.ownLogin')
    : t('settings.integrations.github.local.token');
  return <>{account.login ? `${source} · @${account.login}` : source}</>;
}

function Repositories({ repositories }: { repositories: WorkspaceRepository[] | null }) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const query = search.trim().toLowerCase();
  const owners = useMemo(() => groupByOwner(repositories ?? [], query), [repositories, query]);

  if (repositories === null) {
    return (
      <CompactSection title={t('settings.integrations.github.local.repositories')}>
        <p {...stylex.props(surface.cardNote)}>
          <Spinner size="small" /> {t('settings.integrations.github.loading')}
        </p>
      </CompactSection>
    );
  }
  if (repositories.length === 0) {
    return <SettingsEmptyList>{t('settings.integrations.github.local.noRepos')}</SettingsEmptyList>;
  }
  return (
    <>
      {repositories.length > SEARCH_THRESHOLD ? (
        <Input
          type="search"
          size="small"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('repos.search')}
          aria-label={t('repos.search')}
          leading={<Search {...stylex.props(catalog.icon)} aria-hidden="true" />}
        />
      ) : null}
      {owners.length === 0 ? (
        <CompactSection>
          <p {...stylex.props(surface.cardNote)}>{t('settings.integrations.github.noRepos')}</p>
        </CompactSection>
      ) : (
        owners.map((owner) => (
          <CompactSection
            key={owner.name}
            boxed
            title={owner.name}
            headerRight={<span {...stylex.props(styles.count)}>{owner.repos.length}</span>}
          >
            {owner.repos.map((repo) => (
              <div key={repo.fullName} {...stylex.props(styles.repo)}>
                <span {...stylex.props(styles.repoName)} title={repo.fullName}>
                  {repo.name}
                </span>
                {repo.private ? (
                  <Lock
                    {...stylex.props(styles.private)}
                    role="img"
                    aria-label={t('settings.integrations.github.private')}
                  >
                    <title>{t('settings.integrations.github.private')}</title>
                  </Lock>
                ) : null}
              </div>
            ))}
          </CompactSection>
        ))
      )}
    </>
  );
}

function TokenDialog({
  open,
  onClose,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (token: string) => Promise<{ ok: true } | { ok: false; message: string }>;
}) {
  const { t } = useTranslation();
  const settingsPane = useSettingsPane();
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Content
        width={SETTINGS_EDITOR_DIALOG_WIDTH}
        centerOn={settingsPane}
        className={SETTINGS_EDITOR_DIALOG_LAYOUT}
      >
        <Dialog.Header>
          <Dialog.Title>{t('settings.integrations.github.local.tokenTitle')}</Dialog.Title>
          <Dialog.Description>
            {t('settings.integrations.github.local.tokenDescription')}
          </Dialog.Description>
        </Dialog.Header>
        {/* Mounted only while open, so a closed dialog keeps no token. */}
        {open ? <TokenForm onCancel={onClose} onSave={onSave} onSaved={onClose} /> : null}
      </Dialog.Content>
    </Dialog.Root>
  );
}

function TokenForm({
  onCancel,
  onSave,
  onSaved,
}: {
  onCancel: () => void;
  onSave: (token: string) => Promise<{ ok: true } | { ok: false; message: string }>;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const fieldId = useId();
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      {...withClassName(stylex.props(catalog.editorForm))}
      onSubmit={(event) => {
        event.preventDefault();
        if (!token.trim() || saving) return;
        setSaving(true);
        setError(null);
        void onSave(token.trim()).then((answer) => {
          setSaving(false);
          if (answer.ok) onSaved();
          else setError(answer.message);
        });
      }}
    >
      <div {...withClassName(stylex.props(catalog.editorBody), 'scrollbar-pro')}>
        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
        <Field htmlFor={`${fieldId}-token`} label={t('settings.integrations.github.local.token')}>
          <Input
            id={`${fieldId}-token`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </Field>
      </div>
      <Dialog.Footer>
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" disabled={!token.trim() || saving}>
          {saving ? <Spinner size="small" /> : null}
          {t('common.save')}
        </Button>
      </Dialog.Footer>
    </form>
  );
}

interface OwnerGroup {
  name: string;
  repos: WorkspaceRepository[];
}

function groupByOwner(repos: WorkspaceRepository[], query: string): OwnerGroup[] {
  const groups = new Map<string, OwnerGroup>();
  for (const repo of repos) {
    if (query && !repo.fullName.toLowerCase().includes(query)) continue;
    const slash = repo.fullName.indexOf('/');
    const name = slash === -1 ? repo.fullName : repo.fullName.slice(0, slash);
    let group = groups.get(name);
    if (!group) {
      group = { name, repos: [] };
      groups.set(name, group);
    }
    group.repos.push(repo);
  }
  return [...groups.values()];
}
