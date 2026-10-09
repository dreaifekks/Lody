import { Command } from 'commander';
import type { LanAgentRuntime, LanMachine, MachineId } from '@lody/shared';
import { readLanCliRelease } from '@lody/shared/lan-release';
import { printJson, runOneShotCommand, type CommonCommandOptions } from '@/lib/command-runtime';
import {
  describeLanMachineBuild,
  getLanReleaseSource,
  resolveLanInstallation,
} from '@/lib/lan/lan-build';
import {
  askLanMachine,
  describeLanMachineUpdate,
  findLanMachine,
  listLanMachinesOfThisMachine,
  resolveControlWorkspace,
  resolveLocalMachineId,
} from '@/lib/lan/lan-control-client';
import {
  LanSelfUpdateError,
  applyLanSelfUpdate,
  readNewestLanRelease,
} from '@/lib/lan/lan-self-update';
import { LAN_SERVICE_UNITS, LanServiceManager, type LanServiceKind } from '@/lib/lan/service';
import { renderTerminalTable } from '@/lib/terminal-table';
import { version } from '@/pkg';

type OutputOptions = Pick<CommonCommandOptions, 'json' | 'debug'>;

const POLL_MS = 3_000;
const WAIT_MS = 20 * 60_000;

function describeAgent(agent: LanAgentRuntime): string {
  if (agent.state === 'unsupported') return `${agent.name} (cannot run here)`;
  if (agent.state === 'missing') return `${agent.name} (not installed)`;
  const installed = `${agent.name} ${agent.version ?? ''}`.trim();
  if (agent.state === 'current' || !agent.target) return installed;
  return `${installed} -> ${agent.target}${agent.state === 'updating' ? ' (updating)' : ''}`;
}

function describePresence(machine: LanMachine): string {
  if (machine.self) return 'this machine';
  return machine.online === null ? 'unknown' : machine.online ? 'online' : 'offline';
}

export const machinesCommand = new Command('machines')
  .description('List the machines this machine reaches through its LANs')
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .action(async (options: OutputOptions) => {
    await runOneShotCommand('lan', options, async () => {
      const inventory = await listLanMachinesOfThisMachine(await resolveLocalMachineId());
      if (options.json) {
        printJson({ ok: true, ...inventory });
        return;
      }
      const newest = inventory.newest?.version ?? null;
      console.log(
        renderTerminalTable(
          [
            { header: 'Name' },
            { header: 'State' },
            { header: 'Version' },
            { header: 'Update' },
            { header: 'LANs' },
            { header: 'Agents' },
          ],
          inventory.machines.map((machine) => [
            machine.alias ? `${machine.alias} (${machine.name})` : machine.name,
            describePresence(machine),
            machine.version ?? '',
            describeLanMachineUpdate(machine, newest),
            machine.lans.map((lan) => lan.name).join(', '),
            machine.agents.map(describeAgent).join(', '),
          ])
        )
      );
      for (const machine of inventory.machines) {
        if (machine.update?.phase === 'failed' && machine.update.error) {
          console.log(`${machine.name}: ${machine.update.error}`);
        }
      }
    });
  });

type UpdateOptions = OutputOptions & {
  check?: boolean;
  force?: boolean;
  wait: boolean;
  lan?: string;
};

/** The services of this machine that ran the build that was replaced. */
async function restartServices(): Promise<string[]> {
  const services = new LanServiceManager();
  if (!(await services.isAvailable())) return [];
  const restarted: string[] = [];
  // The hub first: the agent service reaches the LAN through it.
  for (const kind of ['hub', 'agent'] satisfies LanServiceKind[]) {
    const state = await services.getState(kind);
    if (!state.installed || !state.active) continue;
    await services.restartIfActive(kind);
    restarted.push(LAN_SERVICE_UNITS[kind]);
  }
  return restarted;
}

async function updateThisMachine(options: UpdateOptions): Promise<void> {
  const source = getLanReleaseSource();
  if (options.check) {
    const newest = readLanCliRelease(await readNewestLanRelease({ source }));
    const build = describeLanMachineBuild('manual', source);
    if (options.json) {
      printJson({ ok: true, running: build.version, newest });
      return;
    }
    console.log(
      newest.version === version
        ? `${version} is the newest build.`
        : `This machine runs ${version}; the newest build is ${newest.version}.`
    );
    return;
  }

  let updated;
  try {
    updated = await applyLanSelfUpdate({
      installation: resolveLanInstallation(),
      source,
      runningVersion: version,
      force: options.force,
      onPhase: (phase, manifest) => {
        if (options.json) return;
        console.log(
          phase === 'downloading'
            ? `Downloading ${manifest.version}...`
            : `Installing ${manifest.version}...`
        );
      },
    });
  } catch (error) {
    if (!(error instanceof LanSelfUpdateError) || error.code !== 'current') throw error;
    if (options.json) printJson({ ok: true, outcome: 'current', version });
    else console.log(`${version} is the newest build.`);
    return;
  }

  const restarted = await restartServices();
  if (options.json) {
    printJson({ ok: true, outcome: 'updated', ...updated, restarted });
    return;
  }
  console.log(`Updated from ${updated.from} to ${updated.to}.`);
  console.log(
    restarted.length > 0
      ? `Started again: ${restarted.join(', ')}.`
      : 'Start the agent service again to run the new build.'
  );
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Follows a member until it runs what it installs, or says that it failed. */
async function followUpdate(
  localMachineId: MachineId,
  target: LanMachine,
  targetVersion: string,
  report: (line: string) => void
): Promise<{ version: string | null; error?: string }> {
  const deadline = Date.now() + WAIT_MS;
  let reported = '';
  while (Date.now() < deadline) {
    await wait(POLL_MS);
    const { machines } = await listLanMachinesOfThisMachine(localMachineId);
    const machine = machines.find((entry) => entry.machineId === target.machineId);
    if (!machine) continue;
    if (machine.version === targetVersion && machine.online !== false) {
      return { version: machine.version };
    }
    if (machine.update?.phase === 'failed' && machine.update.version === targetVersion) {
      return { version: machine.version, error: machine.update.error ?? 'The update failed' };
    }
    const phase = machine.update?.phase ?? '';
    if (phase && phase !== reported) {
      reported = phase;
      report(`${machine.name}: ${phase} ${targetVersion}`);
    }
  }
  return { version: null, error: `${target.name} did not come back in time` };
}

async function updateMember(selector: string, options: UpdateOptions): Promise<void> {
  const localMachineId = await resolveLocalMachineId();
  const inventory = await listLanMachinesOfThisMachine(localMachineId);
  const target = findLanMachine(inventory.machines, selector);
  if (target.self) {
    await updateThisMachine(options);
    return;
  }
  const newest = inventory.newest?.version ?? null;
  if (options.check) {
    if (options.json) printJson({ ok: true, running: target.version, newest: inventory.newest });
    else console.log(`${target.name}: ${describeLanMachineUpdate(target, newest)}`);
    return;
  }

  const response = await askLanMachine(localMachineId, {
    type: 'lan/update-machine',
    machineId: target.machineId as MachineId,
    workspaceId: await resolveControlWorkspace(target, options.lan),
  });
  if (!response.ok) throw new Error(response.message);
  if (response.type !== 'lan/update-machine') throw new Error('Unexpected response');

  const { outcome, version: targetVersion } = response.result;
  if (outcome === 'current') {
    if (options.json) printJson({ ok: true, outcome, version: targetVersion });
    else console.log(`${target.name} runs the newest build, ${targetVersion}.`);
    return;
  }
  if (!options.wait) {
    if (options.json) printJson({ ok: true, outcome, version: targetVersion });
    else console.log(`${target.name} installs ${targetVersion} and starts again when it is done.`);
    return;
  }

  if (!options.json) console.log(`${target.name} installs ${targetVersion}...`);
  const followed = await followUpdate(localMachineId, target, targetVersion, (line) => {
    if (!options.json) console.log(line);
  });
  if (followed.error) throw new Error(`${target.name}: ${followed.error}`);
  if (options.json) printJson({ ok: true, outcome: 'updated', version: targetVersion });
  else console.log(`${target.name} runs ${targetVersion}.`);
}

export const updateCommand = new Command('update')
  .description('Install the newest build on this machine or on a member of a LAN')
  .argument('[machine]', 'Name or id of a member; this machine when left out')
  .option('--check', 'Only say whether a newer build exists')
  .option('--force', 'Install the newest build even when this machine runs it')
  .option('--no-wait', 'Do not wait for a member to come back')
  .option('--lan <name>', 'The LAN to reach a member through, when it is in several')
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .action(async (machine: string | undefined, options: UpdateOptions) => {
    await runOneShotCommand('lan', options, async () => {
      if (machine?.trim()) await updateMember(machine, options);
      else await updateThisMachine(options);
    });
  });
