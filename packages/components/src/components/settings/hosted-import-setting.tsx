import { useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  HOSTED_CONFIG_CATEGORIES,
  countHostedConfigItems,
  type HostedConfigCategory,
  type HostedConfigItem,
  type HostedConfigSource,
} from '@lody/shared/hosted-config';
import { useHostedImport, type HostedImport } from '@/hooks/use-hosted-import';
import { toast } from '@/lib/toast';
import { Button } from '@lody/ui/button';
import { Spinner } from '@lody/ui/spinner';
import { Switch } from '@lody/ui/switch';
import { CompactRow, CompactSection, SettingsEmptyList } from './compact-layout';
import { FormMessage } from './form-primitives';
import { SettingsPageLead } from './settings-page-header';
import { settingsCatalog as catalog, settingsSurface as surface } from './surface';

export type HostedImportSettingViewProps = Pick<HostedImport, 'run'> & {
  sources: readonly HostedConfigSource[];
};

/** Desktop Settings > Import, wired to the agent service of this machine. */
export function HostedImportSetting() {
  const { t } = useTranslation();
  const hosted = useHostedImport();

  if (hosted.loading) {
    return (
      <div {...stylex.props(surface.container)}>
        <span {...stylex.props(catalog.syncing)}>
          <Spinner size="small" aria-hidden="true" />
          {t('common.loading')}
        </span>
      </div>
    );
  }
  if (!hosted.preview) {
    return (
      <div {...stylex.props(surface.container)}>
        <SettingsPageLead>{t('settings.hostedImport.description')}</SettingsPageLead>
        <FormMessage tone="error">
          {hosted.error ?? t('settings.hostedImport.unavailable')}
        </FormMessage>
      </div>
    );
  }
  return <HostedImportSettingView sources={hosted.preview.sources} run={hosted.run} />;
}

export function HostedImportSettingView({ sources, run }: HostedImportSettingViewProps) {
  const { t } = useTranslation();
  return (
    <div {...stylex.props(surface.container)}>
      <SettingsPageLead>{t('settings.hostedImport.description')}</SettingsPageLead>
      {sources.length === 0 ? (
        <SettingsEmptyList>{t('settings.hostedImport.empty')}</SettingsEmptyList>
      ) : (
        sources.map((source) => (
          <HostedSource key={source.workspaceId} source={source} run={run} />
        ))
      )}
    </div>
  );
}

function HostedSource({
  source,
  run,
}: {
  source: HostedConfigSource;
  run: HostedImport['run'];
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
    const outcome = await run({ sourceWorkspaceId: source.workspaceId, categories: selected });
    setImporting(false);
    if (!outcome.ok) {
      toast.error(t('settings.hostedImport.failed', { message: outcome.message }));
      return;
    }
    const { items } = outcome.result;
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
        <span key={line.key} style={{ display: 'block' }}>
          {t(`settings.hostedImport.summary.${line.key}`, { names: line.names })}
        </span>
      ))}
    </>
  );
}
