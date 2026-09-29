import { useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Download, Laptop, MoreHorizontal, RefreshCw, Server } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { LanAgentRuntime, LanMachine, LanMachines } from '@lody/shared/lan-control';
import { resolveLanUpdateAvailability } from '@lody/shared/lan-release';
import type { LanMachinesControl } from '@/hooks/use-lan-machines';
import { toast } from '@/lib/toast';
import { AlertDialog } from '@/ui/dialog';
import { Menu } from '@/ui/menu';
import { Badge } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { Spinner } from '@lody/ui/spinner';
import { CompactSection } from './compact-layout';
import { LanHostedImport } from './lan-hosted-import';
import { settingsCatalog as catalog } from './surface';

const styles = stylex.create({
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
  /** One fact after another, each as long as it is; a long line wraps between facts. */
  facts: { display: 'flex', flexWrap: 'wrap', rowGap: '2px', minWidth: 0, whiteSpace: 'pre' },
});

export type LanMachinesViewProps = Pick<
  LanMachinesControl,
  'updateMachine' | 'installAgent' | 'previewHostedImport' | 'importHostedConfig'
> & {
  inventory: LanMachines;
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

/** Desktop Settings > LAN: the machines this machine reaches through its LANs. */
export function LanMachinesView({
  inventory,
  updateMachine,
  installAgent,
  previewHostedImport,
  importHostedConfig,
}: LanMachinesViewProps) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState<LanMachine | null>(null);
  const [importing, setImporting] = useState<LanMachine | null>(null);
  const [asked, setAsked] = useState<ReadonlySet<string>>(new Set());
  const newest = inventory.newest?.version ?? null;

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

  return (
    <>
      <CompactSection title={t('settings.lan.machines.title')} boxed>
        {inventory.machines.map((machine) => (
          <MachineRow
            key={machine.machineId}
            machine={machine}
            newest={newest}
            busy={asked.has(machine.machineId)}
            onUpdate={() => setConfirming(machine)}
            onImport={() => setImporting(machine)}
            onInstallAgent={(agent) => install(machine, agent)}
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
    </>
  );
}

function MachineRow({
  machine,
  newest,
  busy,
  onUpdate,
  onImport,
  onInstallAgent,
}: {
  machine: LanMachine;
  newest: string | null;
  busy: boolean;
  onUpdate: () => void;
  onImport: () => void;
  onInstallAgent: (agent: LanAgentRuntime) => void;
}) {
  const { t } = useTranslation();
  const build = describeLanMachineBuild(machine, newest);
  const reachable = takesRequests(machine);
  const runtimes = reachable ? machine.agents.filter(needsRuntime) : [];
  const Glyph = machine.build?.update === 'desktop' ? Laptop : Server;
  const separator = t('settings.lan.machines.factSeparator');
  const facts = [
    machine.version,
    machine.os ? (OS_NAMES[machine.os] ?? machine.os) : null,
    machine.lans.map((lan) => lan.name).join(t('settings.hostedImport.separator')),
  ].filter(Boolean);

  return (
    <div {...stylex.props(catalog.row)}>
      <div {...stylex.props(styles.body)}>
        <span {...stylex.props(catalog.glyph)}>
          <Glyph {...stylex.props(catalog.icon)} aria-hidden="true" />
        </span>
        <span {...stylex.props(catalog.body)}>
          <span {...stylex.props(catalog.titleLine)}>
            <span {...stylex.props(catalog.name)}>{machine.name}</span>
            {machine.self ? (
              <Badge>{t('settings.lan.machines.self')}</Badge>
            ) : machine.online === null ? null : (
              <Badge tone={machine.online ? 'success' : undefined}>
                {t(machine.online ? 'settings.lan.machines.online' : 'settings.lan.machines.offline')}
              </Badge>
            )}
          </span>
          <span {...stylex.props(catalog.meta, styles.facts)}>
            {facts.map((fact, position) => (
              <span key={position}>
                {position > 0 ? separator : null}
                {fact}
              </span>
            ))}
          </span>
          <MachineBuildLine machine={machine} build={build} newest={newest} />
          {machine.agents.length > 0 ? (
            <span {...stylex.props(catalog.meta, styles.facts)}>
              {machine.agents.map((agent, position) => (
                <span key={agent.agentType}>
                  {position > 0 ? separator : null}
                  <span {...stylex.props(needsRuntime(agent) && catalog.metaWarning)}>
                    {t(`settings.lan.machines.agent.${agent.state}`, {
                      name: agent.name,
                      version: agent.version ?? '',
                      target: agent.target ?? '',
                    })}
                  </span>
                </span>
              ))}
            </span>
          ) : null}
          {!machine.self && !machine.controllable ? (
            <span {...stylex.props(catalog.meta, catalog.metaHint)}>
              {t('settings.lan.machines.tooOld')}
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
        {reachable ? (
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
              <Menu.Item icon={<Download />} onClick={onImport}>
                {t('settings.lan.machines.importHosted')}
              </Menu.Item>
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
        ) : null}
      </div>
    </div>
  );
}

function MachineBuildLine({
  machine,
  build,
  newest,
}: {
  machine: LanMachine;
  build: ReturnType<typeof describeLanMachineBuild>;
  newest: string | null;
}) {
  const { t } = useTranslation();
  if (build.state === 'unknown') return null;

  if (build.state === 'updating' && machine.update) {
    return (
      <span {...stylex.props(catalog.meta)}>
        <Spinner size="small" aria-hidden="true" />
        {t(`settings.lan.machines.phase.${machine.update.phase}`, {
          version: machine.update.version,
        })}
      </span>
    );
  }

  const offer =
    build.by === null
      ? null
      : t(`settings.lan.machines.available.${machine.self ? 'self' : 'member'}.${build.by}`, {
          version: newest ?? '',
        });
  if (build.state === 'failed' && machine.update) {
    return (
      <span {...stylex.props(catalog.meta, catalog.metaWarning, styles.facts)}>
        <span title={machine.update.error}>
          {t('settings.lan.machines.failed', { version: machine.update.version })}
        </span>
        {machine.update.error ? <span>{machine.update.error}</span> : null}
      </span>
    );
  }
  return (
    <span {...stylex.props(catalog.meta, offer ? catalog.metaWarning : catalog.metaHint)}>
      {offer ?? t('settings.lan.machines.newest')}
    </span>
  );
}
