import { useEffect, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  HOSTED_CONFIG_CATEGORIES,
  countHostedConfigItems,
  type HostedConfigCategory,
  type HostedConfigItem,
  type HostedConfigPreview,
  type HostedConfigSource,
} from '@lody/shared/hosted-config';
import type { LanMachine } from '@lody/shared/lan-control';
import type { LanMachinesControl } from '@/hooks/use-lan-machines';
import { withClassName } from '@/lib/stylex';
import { toast } from '@/lib/toast';
import { Dialog } from '@/ui/dialog';
import { Button } from '@lody/ui/button';
import { Spinner } from '@lody/ui/spinner';
import { Switch } from '@lody/ui/switch';
import { CompactRow, CompactSection, SettingsEmptyList } from './compact-layout';
import { FormMessage } from './form-primitives';
import { useSettingsPane } from './settings-page-header';
import {
  SETTINGS_EDITOR_DIALOG_LAYOUT,
  SETTINGS_EDITOR_DIALOG_WIDTH,
  settingsCatalog as catalog,
} from './surface';

const styles = stylex.create({
  /** What an import does with a category, one kind of outcome to a line. */
  outcome: { display: 'block' },
});

type Loaded =
  | { state: 'loading' }
  | { state: 'failed'; message: string }
  | { state: 'ready'; preview: HostedConfigPreview };

export type LanHostedImportProps = Pick<
  LanMachinesControl,
  'previewHostedImport' | 'importHostedConfig'
> & {
  /** The machine whose hosted installation is imported; `null` closes the dialog. */
  machine: LanMachine | null;
  onClose: () => void;
};

/**
 * What the hosted Lody of a machine configured, and the import of it into the
 * installation of that machine. The machine reads and writes both; this asks.
 */
export function LanHostedImport({
  machine,
  onClose,
  previewHostedImport,
  importHostedConfig,
}: LanHostedImportProps) {
  const { t } = useTranslation();
  const settingsPane = useSettingsPane();
  const [shown, setShown] = useState<LanMachine | null>(machine);
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  // A dialog that closes keeps what it showed until it is gone.
  if (machine && machine !== shown) setShown(machine);

  const machineId = machine?.machineId;
  useEffect(() => {
    if (!machine) return undefined;
    let current = true;
    setLoaded({ state: 'loading' });
    void previewHostedImport(machine).then((answer) => {
      if (!current) return;
      setLoaded(
        answer.ok
          ? { state: 'ready', preview: answer.result }
          : { state: 'failed', message: answer.message }
      );
    });
    return () => {
      current = false;
    };
    // The machine is asked once for each time the dialog opens for it; the
    // list it comes from changes identity with every answer of the service.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [machineId, previewHostedImport]);

  const name = shown?.name ?? '';
  return (
    <Dialog.Root
      open={machine !== null}
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
          <Dialog.Title>{t('settings.hostedImport.title', { name })}</Dialog.Title>
          <Dialog.Description>
            {shown?.self
              ? t('settings.hostedImport.description')
              : t('settings.hostedImport.descriptionMember', { name })}
          </Dialog.Description>
        </Dialog.Header>
        <div {...withClassName(stylex.props(catalog.editorBody), 'scrollbar-pro')}>
          {loaded.state === 'loading' ? (
            <span {...stylex.props(catalog.syncing)}>
              <Spinner size="small" aria-hidden="true" />
              {t('common.loading')}
            </span>
          ) : null}
          {loaded.state === 'failed' ? (
            <FormMessage tone="error">{loaded.message}</FormMessage>
          ) : null}
          {loaded.state === 'ready' && shown ? (
            loaded.preview.sources.length === 0 ? (
              <SettingsEmptyList>{t('settings.hostedImport.empty', { name })}</SettingsEmptyList>
            ) : (
              loaded.preview.sources.map((source) => (
                <HostedSource
                  key={source.workspaceId}
                  source={source}
                  run={async (categories) => {
                    const answer = await importHostedConfig(shown, {
                      sourceWorkspaceId: source.workspaceId,
                      categories,
                    });
                    if (answer.ok) {
                      const again = await previewHostedImport(shown);
                      if (again.ok) setLoaded({ state: 'ready', preview: again.result });
                    }
                    return answer;
                  }}
                />
              ))
            )
          ) : null}
        </div>
        <Dialog.Footer>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('common.close')}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function HostedSource({
  source,
  run,
}: {
  source: HostedConfigSource;
  run: (
    categories: HostedConfigCategory[]
  ) => ReturnType<LanMachinesControl['importHostedConfig']>;
}) {
  const { t } = useTranslation();
  const [excluded, setExcluded] = useState<ReadonlySet<HostedConfigCategory>>(new Set());
  const [importing, setImporting] = useState(false);

  const groups = HOSTED_CONFIG_CATEGORIES.map((category) => ({
    category,
    items: source.items.filter((item) => item.category === category),
  })).filter((group) => group.items.length > 0);
  const selected = groups
    .filter((group) => !excluded.has(group.category))
    .map((group) => group.category);
  const pending = countHostedConfigItems(
    source.items.filter((item) => selected.includes(item.category)),
    ['create', 'update']
  );

  const toggle = (category: HostedConfigCategory, included: boolean) => {
    setExcluded((current) => {
      const next = new Set(current);
      if (included) next.delete(category);
      else next.add(category);
      return next;
    });
  };

  const submit = async () => {
    setImporting(true);
    const answer = await run(selected);
    setImporting(false);
    if (!answer.ok) {
      toast.error(t('settings.hostedImport.failed', { message: answer.message }));
      return;
    }
    const { items } = answer.result;
    toast.success(
      t('settings.hostedImport.imported', {
        count: countHostedConfigItems(items, ['create', 'update']),
      })
    );
    if (items.some((item) => item.needsSignIn && item.action !== 'unchanged')) {
      toast.info(t('settings.hostedImport.signInAgain'));
    }
  };

  return (
    <CompactSection
      title={t('settings.hostedImport.sourceTitle', { name: source.name })}
      headerRight={
        <Button
          size="small"
          variant="secondary"
          disabled={importing || pending === 0}
          onClick={() => void submit()}
        >
          {importing ? (
            <Spinner size="small" aria-hidden="true" />
          ) : (
            <Download {...stylex.props(catalog.icon)} />
          )}
          {pending === 0
            ? t('settings.hostedImport.upToDate')
            : t('settings.hostedImport.import', { count: pending })}
        </Button>
      }
    >
      {groups.length === 0 ? (
        <CompactRow label={t('settings.hostedImport.nothing')} />
      ) : (
        groups.map(({ category, items }) => (
          <CompactRow
            key={category}
            alignTop
            label={t(`settings.hostedImport.categories.${category}`, { count: items.length })}
            helper={<CategorySummary items={items} />}
          >
            <Switch
              checked={!excluded.has(category)}
              disabled={importing}
              aria-label={t(`settings.hostedImport.categories.${category}`, {
                count: items.length,
              })}
              onCheckedChange={(checked) => toggle(category, checked)}
            />
          </CompactRow>
        ))
      )}
    </CompactSection>
  );
}

function CategorySummary({ items }: { items: readonly HostedConfigItem[] }) {
  const { t } = useTranslation();
  const names = (actions: HostedConfigItem['action'][]) =>
    items
      .filter((item) => actions.includes(item.action))
      .map((item) => item.name)
      .join(t('settings.hostedImport.separator'));
  const lines = [
    { key: 'add', names: names(['create']) },
    { key: 'update', names: names(['update']) },
    { key: 'present', names: names(['unchanged']) },
    { key: 'skip', names: names(['skip']) },
  ].filter((line) => line.names !== '');

  return (
    <>
      {lines.map((line) => (
        <span key={line.key} {...stylex.props(styles.outcome)}>
          {t(`settings.hostedImport.summary.${line.key}`, { names: line.names })}
        </span>
      ))}
    </>
  );
}
