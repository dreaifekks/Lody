import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useOrganization } from '@/hooks/useOrganization';
import { useIsMobile } from '@/hooks/use-mobile';
import { settingContainerClass } from '.';
import { type StackedAreaBucket } from './usage-stacked-area-chart';
import { StatsSettingsView } from './stats-setting-pure';
import { MobileStatsSettings } from '@/components/mobile/mobile-stats-settings';
import { stripRecommended } from '@/components/shared/acp-selector-options';
import { useAppCapability } from '@/lib/app-platform';
import {
  useSettingsDataCache,
  useSettingsUsageDay,
  type SettingsUsageRange,
  type SettingsUsageTimelineData,
} from './settings-data-cache';
import {
  createUsageTimelineFormatter,
  formatUsageTimelineBucketLabel,
} from './usage-timeline-bucket-label';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
import { UsageMemberLabelContext } from './usage-member-label';
import { useAtomValue } from 'jotai';
import { currentWorkspaceIdAtom } from '@/atoms/workspace-context';
import { useLanUsage } from '@/hooks/use-lan-usage';
import { buildLanUsageCalendar, buildLanUsageDay, buildLanUsageTimeline } from '@/lib/lan-usage';

export function StatsSettingsComponent() {
  const usageAnalyticsAvailable = useAppCapability('usageAnalytics');
  const localUsageAvailable = useAppCapability('localUsage');
  if (usageAnalyticsAvailable) return <CloudStatsSettings />;
  if (localUsageAvailable) return <LocalStatsSettings />;
  return null;
}

/**
 * Usage without the hosted service: every machine of the LAN reports what its
 * own agents used, split by machine where the hosted page splits by member.
 */
function LocalStatsSettings() {
  const { t, i18n } = useTranslation();
  const locale = toIntlLocaleOrEn(i18n.resolvedLanguage ?? i18n.language);
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const [range, setRange] = useState<SettingsUsageRange>('day');
  const [selectedUsageDayMs, setSelectedUsageDayMs] = useState<number | null>(null);
  const { reports, missing } = useLanUsage(workspaceId);
  const dayTimeFormatter = useMemo(() => createUsageTimelineFormatter(locale), [locale]);

  // One clock for every view of a round of answers.
  const views = useMemo(() => {
    if (!workspaceId || !reports) return null;
    const now = Date.now();
    return {
      timeline: buildLanUsageTimeline(workspaceId, range, reports, now),
      calendar: buildLanUsageCalendar(workspaceId, reports, now),
    };
  }, [range, reports, workspaceId]);
  const usageDay = useMemo(
    () =>
      workspaceId && reports && selectedUsageDayMs !== null
        ? buildLanUsageDay(workspaceId, selectedUsageDayMs, reports)
        : undefined,
    [reports, selectedUsageDayMs, workspaceId]
  );
  const usageTimeline = views?.timeline;
  const { byModelBuckets, byMemberBuckets } = useUsageTimelineBuckets(
    usageTimeline,
    dayTimeFormatter
  );

  const notice =
    missing.length > 0
      ? t('workspace.usage.machinesMissing', {
          names: missing.map((machine) => machine.name).join(', '),
        })
      : null;

  return (
    <UsageMemberLabelContext.Provider value={t('workspace.usage.byMachine')}>
      <div className={settingContainerClass}>
        <StatsSettingsView
          range={range}
          onRangeChange={setRange}
          ready={Boolean(usageTimeline)}
          totals={usageTimeline?.totals ?? null}
          byModelBuckets={byModelBuckets}
          byMemberBuckets={byMemberBuckets}
          usageCalendar={views?.calendar}
          usageTimeline={usageTimeline}
          usageDay={usageDay}
          usageDayLoading={false}
          onSelectedUsageDayChange={setSelectedUsageDayMs}
          workspaceId={workspaceId}
          loading={Boolean(workspaceId) && !usageTimeline}
          notice={notice}
        />
      </div>
    </UsageMemberLabelContext.Provider>
  );
}

/** The two stacked charts of a timeline: by model and by member (or machine). */
function useUsageTimelineBuckets(
  usageTimeline: SettingsUsageTimelineData | undefined,
  dayTimeFormatter: Intl.DateTimeFormat
): { byModelBuckets: StackedAreaBucket[]; byMemberBuckets: StackedAreaBucket[] } {
  return useMemo(() => {
    if (!usageTimeline) return { byModelBuckets: [], byMemberBuckets: [] };
    const label = (bucket: SettingsUsageTimelineData['buckets'][number]) =>
      formatUsageTimelineBucketLabel(usageTimeline, bucket, dayTimeFormatter);
    return {
      byModelBuckets: usageTimeline.buckets.map((bucket) => ({
        label: label(bucket),
        values: bucket.byModel.map((item) => ({
          id: item.modelId,
          label: stripRecommended(item.modelId),
          value: item.tokens,
        })),
      })),
      byMemberBuckets: usageTimeline.buckets.map((bucket) => ({
        label: label(bucket),
        values: bucket.byUser.map((item) => ({
          id: item.userId,
          label:
            usageTimeline.users?.[item.userId]?.name ||
            usageTimeline.users?.[item.userId]?.email ||
            item.userId,
          value: item.tokens,
        })),
      })),
    };
  }, [dayTimeFormatter, usageTimeline]);
}

function CloudStatsSettings() {
  const { i18n } = useTranslation();
  const locale = toIntlLocaleOrEn(i18n.resolvedLanguage ?? i18n.language);
  const isMobile = useIsMobile();
  const { activeOrganization } = useOrganization();
  const [range, setRange] = useState<SettingsUsageRange>('day');
  const { workspaceId, usageTimelineByRange, usageCalendar } = useSettingsDataCache();
  const [selectedUsageDayMs, setSelectedUsageDayMs] = useState<number | null>(null);
  const { day: usageDay, loading: usageDayLoading } = useSettingsUsageDay(selectedUsageDayMs);
  const dayTimeFormatter = useMemo(() => createUsageTimelineFormatter(locale), [locale]);

  const usageTimeline = usageTimelineByRange[range];

  const activeTotals = usageTimeline?.totals;

  const getBucketLabel = useCallback(
    (bucket: SettingsUsageTimelineData['buckets'][number]): string => {
      if (!usageTimeline) {
        return bucket.bucketLabel;
      }
      return formatUsageTimelineBucketLabel(usageTimeline, bucket, dayTimeFormatter);
    },
    [dayTimeFormatter, usageTimeline]
  );

  const byModelBuckets = useMemo<StackedAreaBucket[]>(() => {
    if (!usageTimeline) return [];
    return usageTimeline.buckets.map((bucket) => ({
      label: getBucketLabel(bucket),
      values: bucket.byModel.map((item) => ({
        id: item.modelId,
        label: stripRecommended(item.modelId),
        value: item.tokens,
      })),
    }));
  }, [getBucketLabel, usageTimeline]);

  const byMemberBuckets = useMemo<StackedAreaBucket[]>(() => {
    if (!usageTimeline) return [];
    return usageTimeline.buckets.map((bucket) => ({
      label: getBucketLabel(bucket),
      values: bucket.byUser.map((item) => ({
        id: item.userId,
        label:
          usageTimeline.users?.[item.userId]?.name ||
          usageTimeline.users?.[item.userId]?.email ||
          item.userId,
        value: item.tokens,
      })),
    }));
  }, [getBucketLabel, usageTimeline]);

  if (isMobile) return <MobileStatsSettings />;

  return (
    <div className={settingContainerClass}>
      <StatsSettingsView
        workspaceName={activeOrganization?.name}
        range={range}
        onRangeChange={setRange}
        ready={Boolean(activeTotals)}
        totals={activeTotals ?? null}
        byModelBuckets={byModelBuckets}
        byMemberBuckets={byMemberBuckets}
        usageCalendar={usageCalendar}
        usageTimeline={usageTimeline}
        usageDay={usageDay}
        usageDayLoading={usageDayLoading}
        onSelectedUsageDayChange={setSelectedUsageDayMs}
        workspaceId={workspaceId}
        loading={Boolean(workspaceId) && !usageTimeline}
        shareCard
      />
    </div>
  );
}
