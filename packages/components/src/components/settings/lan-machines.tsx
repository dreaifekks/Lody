import { useState, type ComponentType, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import {
  DatabaseBackup,
  Download,
  Laptop,
  MoreHorizontal,
  PencilLine,
  RefreshCw,
  Server,
  ServerCog,
  SquareTerminal,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  LanAgentRuntime,
  LanMachine,
  LanMachineColor,
  LanMachines,
} from '@lody/shared/lan-control';
import { resolveLanUpdateAvailability } from '@lody/shared/lan-release';
import type { SshDestination } from '@lody/shared/lan-ssh';
import type { LanMachinesControl } from '@/hooks/use-lan-machines';
import { toast } from '@/lib/toast';
import { AlertDialog } from '@/ui/dialog';
import { Menu } from '@/ui/menu';
import { Badge } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { Spinner } from '@lody/ui/spinner';
import { Tooltip } from '@lody/ui/tooltip';
import { CompactSection } from './compact-layout';
import { LanHostedImport } from './lan-hosted-import';
import { LanMachineAlias } from './lan-machine-alias';
import { LanMachineSshEntry } from './lan-machine-ssh-entry';
import { lanMachineNameStyle } from '@/lib/lan-machine-color';
import { settingsCatalog as catalog } from './surface';

/**
 * What a machine does for the LAN's hub, a line each, for the hint over its
 * glyph: hosting it, or keeping the standby copy. A machine with neither part
 * has no hint: its glyph says all there is.
 */
function describeHubPart(machine: LanMachine, t: ReturnType<typeof useTranslation>['t']): string[] {
  const hub = machine.hub ?? null;
  if (!hub || hub.part === 'candidate') return [];
  const lines = [t(`settings.lan.machines.hub.part.${hub.part}`)];
  if (hub.part === 'hub') {
    if (hub.term !== null) lines.push(t('settings.lan.machines.hub.term', { term: hub.term }));
    return lines;
  }
  if (hub.snapshotAt) {
    const minutes = Math.max(0, Math.round((Date.now() - Date.parse(hub.snapshotAt)) / 60_000));
    lines.push(t('settings.lan.machines.hub.copiedAgo', { count: minutes }));
  }
  lines.push(
    hub.rttMs === null
      ? t('settings.lan.machines.hub.unreachable')
      : t('settings.lan.machines.hub.rtt', { ms: hub.rttMs })
  );
  return lines;
}

const styles = stylex.create({
  /** The machine that hosts the hub: its glyph is the one in color. */
  hubGlyph: { color: colors.accent },
  hubLine: { display: 'block' },
  /** A record that opens nothing: what it offers is in its trailing cluster. */
  body: {
    display: 'flex',
    flexGrow: 1,
    alignItems: 'flex-start',
    gap: '10px',
    minWidth: 0,
    paddingInline: '16px',
    paddingBlock: '8px',
  },
  /**
   * The machine's own name after the short name a member gave it: a step
   * below the caption and quiet, because the short name is the one to read.
   */
  machineName: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 'calc(var(--ui-font-size, 14px) * 0.786)',
    lineHeight: 1.45,
    color: colors.tertiaryLabel,
  },
  /**
   * One fact after another, set apart by the separator alone. A long line
   * wraps between facts first, and a fact longer than the line inside itself.
   */
  facts: {
    display: 'flex',
    flexWrap: 'wrap',
    columnGap: 0,
    rowGap: '2px',
    minWidth: 0,
    whiteSpace: 'pre-wrap',
  },
  /** What is under way on a machine: its mark, then what it is. */
  progress: { display: 'inline-flex', alignItems: 'center', gap: '6px' },
});

export type LanMachinesViewProps = Pick<
  LanMachinesControl,
  'updateMachine' | 'installAgent' | 'previewHostedImport' | 'importHostedConfig' | 'setAlias'
> & {
  inventory: LanMachines;
  /**
   * The entry of this computer's SSH configuration the user named for a
   * machine, by machine id and as it is written. Editors reach the machine
   * through it; one without an entry is reached through what answers first.
   */
  sshEntries?: Readonly<Record<string, string>>;
  /** Absent where no entry can be named, such as outside the desktop. */
  onSshEntryChange?: (machine: LanMachine, entry: SshDestination | null) => void;
  /** How long a machine that answers takes to, after its facts; absent outside the desktop. */
  Latency?: ComponentType<{ machine: LanMachine }>;
};

const OS_NAMES: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

/**
 * What is said about the build of a machine, and whether a member can ask it
 * to update. A machine updates on request only when it said it would come
 * back: a service that replaces itself and is started again.
 */
export function describeLanMachineBuild(
  machine: LanMachine,
  newestVersion: string | null
): {
  state: 'updating' | 'failed' | 'available' | 'newest' | 'unknown';
  /** Who installs the newest build, when there is one to install. */
  by: 'request' | 'application' | 'hand' | null;
} {
  if (machine.update && machine.update.phase !== 'failed') return { state: 'updating', by: null };
  const availability = resolveLanUpdateAvailability(machine.version, newestVersion);
  const by =
    availability !== 'available'
      ? null
      : machine.build?.update === 'service' && machine.controllable
        ? 'request'
        : machine.build?.update === 'desktop'
          ? 'application'
          : 'hand';
  if (machine.update) return { state: 'failed', by };
  if (availability === 'unknown') return { state: 'unknown', by: null };
  return { state: availability === 'available' ? 'available' : 'newest', by };
}

/** Whether a member can ask anything of the machine right now. */
function takesRequests(machine: LanMachine): boolean {
  return machine.self || (machine.controllable && machine.online !== false);
}

function needsRuntime(agent: LanAgentRuntime): boolean {
  return agent.state === 'outdated' || agent.state === 'missing';
}

/**
 * Whether the names of a machine's LANs tell machines apart: they do once the
 * machines listed are not all in the same LANs.
 */
function lansDiffer(machines: readonly LanMachine[]): boolean {
  const said = new Set(
    machines.map((machine) =>
      machine.lans
        .map((lan) => lan.workspaceId)
        .sort()
        .join(' ')
    )
  );
  return said.size > 1;
}

/** Desktop Settings > LAN: the machines this machine reaches through its LANs. */
export function LanMachinesView({
  inventory,
  updateMachine,
  installAgent,
  previewHostedImport,
  importHostedConfig,
  setAlias,
  sshEntries,
  onSshEntryChange,
  Latency,
}: LanMachinesViewProps) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState<LanMachine | null>(null);
  const [importing, setImporting] = useState<LanMachine | null>(null);
  const [naming, setNaming] = useState<LanMachine | null>(null);
  const [aliasing, setAliasing] = useState<LanMachine | null>(null);
  const [asked, setAsked] = useState<ReadonlySet<string>>(new Set());
  const newest = inventory.newest?.version ?? null;
  const showLans = lansDiffer(inventory.machines);

  const asking = (machineId: string, run: () => Promise<void>) => {
    setAsked((current) => new Set(current).add(machineId));
    void run().finally(() =>
      setAsked((current) => {
        const next = new Set(current);
        next.delete(machineId);
        return next;
      })
    );
  };

  const update = (machine: LanMachine) =>
    asking(machine.machineId, async () => {
      const answer = await updateMachine(machine);
      if (!answer.ok) {
        toast.error(
          t(`settings.lan.machines.refused.${answer.reason ?? 'other'}`, {
            name: machine.name,
            message: answer.message,
          })
        );
        return;
      }
      toast.success(
        t(`settings.lan.machines.update.${answer.result.outcome}`, {
          name: machine.name,
          version: answer.result.version,
        })
      );
    });

  const install = (machine: LanMachine, agent: LanAgentRuntime) =>
    asking(machine.machineId, async () => {
      const answer = await installAgent(machine, agent.agentType);
      if (!answer.ok) {
        toast.error(
          t('settings.lan.machines.refused.other', { name: machine.name, message: answer.message })
        );
        return;
      }
      toast.success(
        t(`settings.lan.machines.agentInstall.${answer.result.outcome}`, {
          name: machine.name,
          agent: agent.name,
        })
      );
    });

  const alias = (machine: LanMachine, next: string | null, color: LanMachineColor | null) =>
    asking(machine.machineId, async () => {
      const answer = await setAlias(machine, next, color);
      if (!answer.ok) {
        toast.error(
          t('settings.lan.machines.alias.failed', { name: machine.name, message: answer.message })
        );
      }
    });

  return (
    <>
      <CompactSection title={t('settings.lan.machines.title')} boxed>
        {inventory.machines.map((machine) => (
          <MachineRow
            key={machine.machineId}
            machine={machine}
            newest={newest}
            busy={asked.has(machine.machineId)}
            showLans={showLans}
            onUpdate={() => setConfirming(machine)}
            onImport={() => setImporting(machine)}
            onAlias={() => setAliasing(machine)}
            onInstallAgent={(agent) => install(machine, agent)}
            onNameSshEntry={onSshEntryChange ? () => setNaming(machine) : undefined}
            Latency={Latency}
          />
        ))}
      </CompactSection>

      <AlertDialog.Root
        open={confirming !== null}
        onOpenChange={(next) => {
          if (!next) setConfirming(null);
        }}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>
              {t('settings.lan.machines.confirmTitle', { name: confirming?.name ?? '' })}
            </AlertDialog.Title>
            <AlertDialog.Description>
              {t('settings.lan.machines.confirmUpdate', {
                name: confirming?.name ?? '',
                version: newest ?? '',
              })}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel>{t('common.cancel')}</AlertDialog.Cancel>
            <Button
              onClick={() => {
                if (confirming) update(confirming);
                setConfirming(null);
              }}
            >
              {t('settings.lan.machines.updateAction')}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>

      <LanHostedImport
        machine={importing}
        onClose={() => setImporting(null)}
        previewHostedImport={previewHostedImport}
        importHostedConfig={importHostedConfig}
      />

      <LanMachineAlias machine={aliasing} onClose={() => setAliasing(null)} onChange={alias} />

      {onSshEntryChange ? (
        <LanMachineSshEntry
          machine={naming}
          entry={naming ? (sshEntries?.[naming.machineId] ?? null) : null}
          onClose={() => setNaming(null)}
          onChange={onSshEntryChange}
        />
      ) : null}
    </>
  );
}

function MachineRow({
  machine,
  newest,
  busy,
  showLans,
  onUpdate,
  onImport,
  onAlias,
  onInstallAgent,
  onNameSshEntry,
  Latency,
}: {
  machine: LanMachine;
  newest: string | null;
  busy: boolean;
  /** Whether the LANs of a machine are worth naming. */
  showLans: boolean;
  onUpdate: () => void;
  onImport: () => void;
  onAlias: () => void;
  onInstallAgent: (agent: LanAgentRuntime) => void;
  /** Absent for this machine, and where no entry can be named. */
  onNameSshEntry?: () => void;
  Latency?: ComponentType<{ machine: LanMachine }>;
}) {
  const { t } = useTranslation();
  const build = describeLanMachineBuild(machine, newest);
  const reachable = takesRequests(machine);
  // An entry is named on this computer, whether the machine answers or not.
  const nameSshEntry = machine.self ? undefined : onNameSshEntry;
  const runtimes = reachable ? machine.agents.filter(needsRuntime) : [];
  const hub = machine.hub ?? null;
  const Glyph =
    hub?.part === 'hub'
      ? ServerCog
      : hub?.part === 'standby'
        ? DatabaseBackup
        : machine.build?.update === 'desktop'
          ? Laptop
          : Server;
  const hubLines = describeHubPart(machine, t);
  const separator = t('settings.lan.machines.factSeparator');
  const facts = [
    machine.version,
    machine.os ? (OS_NAMES[machine.os] ?? machine.os) : null,
    showLans
      ? machine.lans.map((lan) => lan.name).join(t('settings.hostedImport.separator'))
      : null,
  ].filter(Boolean);
  const notes = describeMachineNotes(machine, build, newest, t);
  const glyph = (
    <span
      {...stylex.props(catalog.glyph, hub?.part === 'hub' && styles.hubGlyph)}
      aria-label={hubLines.length > 0 ? hubLines.join(' · ') : undefined}
      aria-hidden={hubLines.length > 0 ? undefined : true}
    >
      <Glyph {...stylex.props(catalog.icon)} aria-hidden="true" />
    </span>
  );

  return (
    <div {...stylex.props(catalog.row)}>
      <div {...stylex.props(styles.body)}>
        {hubLines.length > 0 ? (
          <Tooltip.Root>
            <Tooltip.Trigger render={glyph} />
            <Tooltip.Content side="right">
              {hubLines.map((line, position) => (
                <span key={position} {...stylex.props(styles.hubLine)}>
                  {line}
                </span>
              ))}
            </Tooltip.Content>
          </Tooltip.Root>
        ) : (
          glyph
        )}
        <span {...stylex.props(catalog.body)}>
          <span {...stylex.props(catalog.titleLine)}>
            <span {...stylex.props(catalog.name)} style={lanMachineNameStyle(machine.color)}>
              {machine.alias ?? machine.name}
            </span>
            {machine.alias ? (
              <span {...stylex.props(styles.machineName)}>{machine.name}</span>
            ) : null}
            {/* A machine that answers is the resting state: only one that is away is marked. */}
            {machine.self ? (
              <Badge>{t('settings.lan.machines.self')}</Badge>
            ) : machine.online === false ? (
              <Badge>{t('settings.lan.machines.offline')}</Badge>
            ) : null}
          </span>
          <span {...stylex.props(catalog.meta, styles.facts)}>
            {facts.map((fact, position) => (
              <span key={position}>
                {position > 0 ? separator : null}
                {fact}
              </span>
            ))}
            {Latency && (machine.self || machine.online) ? (
              <span>
                <Latency machine={machine} />
              </span>
            ) : null}
          </span>
          {notes.length > 0 ? (
            <span {...stylex.props(catalog.meta, styles.facts)}>
              {notes.map((note, position) => (
                <span key={position}>
                  {position > 0 ? separator : null}
                  {note}
                </span>
              ))}
            </span>
          ) : null}
        </span>
      </div>
      <div {...stylex.props(catalog.actions)}>
        {busy ? <Spinner size="small" aria-hidden="true" /> : null}
        {build.by === 'request' && reachable ? (
          <Button size="small" variant="secondary" disabled={busy} onClick={onUpdate}>
            <Download {...stylex.props(catalog.icon)} />
            {t('settings.lan.machines.updateAction')}
          </Button>
        ) : null}
        <Menu.Root>
          <Menu.Trigger
            render={
              <Button
                variant="ghost"
                size="small"
                icon
                aria-label={t('settings.lan.machines.more', { name: machine.name })}
              >
                <MoreHorizontal {...stylex.props(catalog.icon)} />
              </Button>
            }
          />
          <Menu.Content align="end">
            <Menu.Item icon={<PencilLine />} onClick={onAlias}>
              {t('settings.lan.machines.alias.action')}
            </Menu.Item>
            {nameSshEntry ? (
              <Menu.Item icon={<SquareTerminal />} onClick={nameSshEntry}>
                {t('settings.lan.machines.sshEntry.action')}
              </Menu.Item>
            ) : null}
            {reachable ? (
              <Menu.Item icon={<Download />} onClick={onImport}>
                {t('settings.lan.machines.importHosted')}
              </Menu.Item>
            ) : null}
            {runtimes.map((agent) => (
              <Menu.Item
                key={agent.agentType}
                icon={<RefreshCw />}
                disabled={busy}
                onClick={() => onInstallAgent(agent)}
              >
                {t(`settings.lan.machines.agentAction.${agent.state}`, {
                  name: agent.name,
                  target: agent.target ?? '',
                })}
              </Menu.Item>
            ))}
          </Menu.Content>
        </Menu.Root>
      </div>
    </div>
  );
}

/**
 * What a machine's row says beyond its facts, one after another on a line of
 * its own: where an update stands or what is out, and each runtime that is not
 * the one its agent runs with. A machine with nothing to say has no such line.
 */
function describeMachineNotes(
  machine: LanMachine,
  build: ReturnType<typeof describeLanMachineBuild>,
  newest: string | null,
  t: ReturnType<typeof useTranslation>['t']
): ReactNode[] {
  const notes: ReactNode[] = [];

  if (build.state === 'updating' && machine.update) {
    notes.push(
      <span {...stylex.props(styles.progress)}>
        <Spinner size="small" aria-hidden="true" />
        {t(`settings.lan.machines.phase.${machine.update.phase}`, {
          version: machine.update.version,
        })}
      </span>
    );
  } else if (build.state === 'failed' && machine.update) {
    notes.push(
      <span {...stylex.props(catalog.metaWarning)}>
        {t('settings.lan.machines.failed', { version: machine.update.version })}
        {machine.update.error ? ` ${machine.update.error}` : null}
      </span>
    );
  } else if (build.by !== null && !(machine.self && build.by === 'application')) {
    // What this application installs is offered beside its own build, above.
    notes.push(
      <span {...stylex.props(catalog.metaWarning)}>
        {t(`settings.lan.machines.available.${machine.self ? 'self' : 'member'}.${build.by}`, {
          version: newest ?? '',
        })}
      </span>
    );
  }

  for (const agent of machine.agents) {
    if (agent.state === 'current') continue;
    notes.push(
      <span {...stylex.props(needsRuntime(agent) && catalog.metaWarning)}>
        {t(`settings.lan.machines.agent.${agent.state}`, {
          name: agent.name,
          version: agent.version ?? '',
          target: agent.target ?? '',
        })}
      </span>
    );
  }
  return notes;
}
