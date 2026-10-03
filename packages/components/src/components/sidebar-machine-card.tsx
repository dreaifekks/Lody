import type { ReactNode } from 'react';
import { describeLanHubPart, type LanHubRole } from '@lody/shared/lan-hub-role';
import { Activity, DatabaseBackup, Folder, Monitor, Server, ServerCog, User } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MachineId } from '@lody/shared';
import { useMachineLatency } from '@/hooks/use-machine-latency';
import { useMachineOnlineStatus } from '@/hooks/use-machine-online-status';
import { lanMachineNameStyle } from '@/lib/lan-machine-color';
import { cn } from '@/lib/utils';
import { UserAvatar } from '@/components/user-avatar';
import { SidebarHoverCard } from '@/components/session-info-hover-card';
import {
  SessionRowStatusIndicator,
  hasSidebarGroupActivity,
  useSidebarGroupActivityDescription,
  type SidebarGroupActivity,
} from '@/components/sidebar-row-shared';

/** A machine's `os` (Node's `process.platform`) as people name it. */
const OS_LABELS: Readonly<Record<string, string>> = {
  darwin: 'macOS',
  linux: 'Linux',
  win32: 'Windows',
};

export type SidebarMachineInfo = {
  machineId: MachineId;
  /** The machine's full name (the sidebar label may drop `.local`). */
  name: string;
  /** The name it registered under, when `name` is the short name its LAN gave it. */
  ownName?: string;
  /** The color its LAN gave the name (`lanColor`). */
  nameColor?: string;
  owner?: { name?: string | null; image?: string | null } | null;
  /** The signed-in user owns this machine. */
  isOwn: boolean;
  /** This is the device the app runs on. */
  isCurrent: boolean;
  os?: string | null;
  projectCount: number;
  /**
   * What the machine's FOLDED group hides. The header draws only the mark; the
   * card, which already owns the header's hover, says how many of each.
   */
  activity?: SidebarGroupActivity | null;
  /** What the machine said about its part in keeping its LAN's hub. */
  hubRole?: LanHubRole | null;
};

/**
 * "Offline" after a machine group's name. Online is the resting state and shows
 * nothing; an unknown status (presence not synced yet) shows nothing either, so
 * a machine never flashes offline while the app connects. A leaf, so presence
 * updates re-render only this pill, never the sidebar.
 */
export function SidebarMachineOfflinePill({ machineId }: { machineId: MachineId }) {
  const { t } = useTranslation();
  const status = useMachineOnlineStatus(machineId);
  if (status !== 'offline') return null;
  return (
    <span className="inline-flex h-4 shrink-0 items-center rounded-full border border-foreground/[0.12] px-1.5 text-[10px] font-normal leading-none tracking-normal text-muted-foreground">
      {t('workspace.machines.offline', 'Offline')}
    </span>
  );
}

/**
 * Hovering a machine group header shows what the group is: the machine, who
 * owns it, whether it is online, its OS and how many projects it holds. The
 * header itself carries no icon; this card is where "this is a machine" is said.
 * Pass it as the header's `wrapToggle`, so it fills the label's flex slot and
 * leaves the header's action buttons (and the menus they open) uncovered.
 */
export function SidebarMachineHoverCard({
  machine,
  disabled,
  children,
}: {
  machine: SidebarMachineInfo;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <SidebarHoverCard
      disabled={disabled}
      content={<SidebarMachineCard machine={machine} />}
      triggerClassName="flex min-w-0 flex-1"
    >
      {children}
    </SidebarHoverCard>
  );
}

function SidebarMachineCard({ machine }: { machine: SidebarMachineInfo }) {
  const { t } = useTranslation();
  const status = useMachineOnlineStatus(machine.machineId);
  const activityDescription = useSidebarGroupActivityDescription(machine.activity);
  const ownerLabel = machine.isOwn
    ? t('sidebar.machineCard.yours', 'You')
    : machine.owner?.name?.trim() || t('sidebar.machineCard.unknownOwner', 'A teammate');

  const rows: Array<{ key: string; icon: ReactNode; label: string; value: ReactNode }> = [
    {
      key: 'owner',
      icon:
        !machine.isOwn && machine.owner ? (
          <UserAvatar user={machine.owner} className="h-3.5 w-3.5 text-[7px]" />
        ) : (
          <User className="h-3.5 w-3.5" aria-hidden="true" />
        ),
      label: t('sidebar.machineCard.owner', 'Owner'),
      value: (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-foreground">{ownerLabel}</span>
          {machine.isCurrent ? (
            <span className="shrink-0 text-muted-foreground">
              · {t('sidebar.thisDevice', 'This device')}
            </span>
          ) : null}
        </span>
      ),
    },
  ];
  if (machine.os) {
    rows.push({
      key: 'os',
      icon: <Monitor className="h-3.5 w-3.5" aria-hidden="true" />,
      label: t('sidebar.machineCard.system', 'System'),
      value: (
        <span className="min-w-0 truncate text-foreground">
          {OS_LABELS[machine.os] ?? machine.os}
        </span>
      ),
    });
  }
  rows.push({
    key: 'projects',
    icon: <Folder className="h-3.5 w-3.5" aria-hidden="true" />,
    label: t('sidebar.machineCard.projects', 'Projects'),
    value: (
      <span className="text-foreground">
        {t('sidebar.machineCard.projectCount', '{{count}} projects', {
          count: machine.projectCount,
        })}
      </span>
    ),
  });

  if (machine.activity && hasSidebarGroupActivity(machine.activity) && activityDescription) {
    rows.push({
      key: 'activity',
      // The same mark the folded header draws, so the card reads as its legend.
      icon: (
        <SessionRowStatusIndicator
          isWaitingPermission={machine.activity.waiting > 0}
          isWorking={machine.activity.working > 0}
          hasUnreadMessages={machine.activity.unread > 0}
        />
      ),
      label: t('sidebar.machineCard.activity', 'Activity'),
      value: <span className="min-w-0 truncate text-foreground">{activityDescription}</span>,
    });
  }
  const hubPart = describeLanHubPart(machine.hubRole ?? null, Date.now());
  if (hubPart) {
    const HubGlyph =
      hubPart === 'hub' ? ServerCog : hubPart === 'standby' ? DatabaseBackup : Server;
    const term = machine.hubRole?.term;
    rows.push({
      key: 'hub',
      icon: <HubGlyph className="h-3.5 w-3.5" aria-hidden="true" />,
      label: t('sidebar.machineCard.hub', 'Hub'),
      value: (
        <span className="min-w-0 truncate text-foreground">
          {t(`settings.lan.machines.hub.part.${hubPart}`)}
          {hubPart === 'hub' && term !== undefined
            ? ` · ${t('settings.lan.machines.hub.term', { term })}`
            : null}
        </span>
      ),
    });
  }
  if (machine.machineId && status !== 'offline') {
    rows.push({
      key: 'latency',
      icon: <Activity className="h-3.5 w-3.5" aria-hidden="true" />,
      label: t('sidebar.machineCard.latency', 'Latency'),
      value: <SidebarMachineLatency machineId={machine.machineId} />,
    });
  }

  return (
    <div className="flex min-w-0 flex-col text-xs text-foreground">
      <div className="mb-2 flex items-baseline gap-2">
        <span
          className="min-w-0 flex-1 truncate text-sm text-foreground"
          style={lanMachineNameStyle(machine.nameColor)}
          title={machine.ownName ?? machine.name}
        >
          {machine.name}
          {machine.ownName ? (
            <span className="ms-1.5 text-xs text-muted-foreground">{machine.ownName}</span>
          ) : null}
        </span>
        {status === 'unknown' ? null : (
          <span
            className={cn(
              'flex shrink-0 items-center gap-1',
              status === 'online' ? 'text-status-success' : 'text-muted-foreground'
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                status === 'online' ? 'bg-status-success' : 'bg-muted-foreground/60'
              )}
            />
            {status === 'online'
              ? t('workspace.machines.online', 'Online')
              : t('workspace.machines.offline', 'Offline')}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1">
        {rows.map((row) => (
          <div key={row.key} className="flex items-center gap-2">
            <span
              className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-muted-foreground"
              title={row.label}
              aria-label={row.label}
            >
              {row.icon}
            </span>
            <div className="flex min-w-0 flex-1">{row.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The round trip of a ping through the hub, measured while the card is open;
 * a leaf, so each answer re-renders only this line.
 */
function SidebarMachineLatency({ machineId }: { machineId: MachineId }) {
  const { t } = useTranslation();
  const reach = useMachineLatency(machineId);
  if (!reach) return null;
  if (reach.state === 'online') {
    return (
      <span className="text-foreground">
        {t('sidebar.machineCard.latencyMs', '{{ms}} ms', { ms: reach.ms })}
      </span>
    );
  }
  return (
    <span className={reach.state === 'offline' ? 'text-status-danger' : 'text-muted-foreground'}>
      {reach.state === 'offline'
        ? t('sidebar.machineCard.noAnswer', 'No answer')
        : t('sidebar.machineCard.measuring', 'Measuring…')}
    </span>
  );
}
