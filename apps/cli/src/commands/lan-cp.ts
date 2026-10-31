import net from 'node:net';
import path from 'node:path';
import type { LanMachine } from '@lody/shared';
import { getLocalTunnelSocketPath } from '@lody/shared/node/local-terminal';
import { Command } from 'commander';
import { printJson, runOneShotCommand, type CommonCommandOptions } from '@/lib/command-runtime';
import {
  findLanMachine,
  listLanMachinesOfThisMachine,
  resolveLocalMachineId,
} from '@/lib/lan/lan-control-client';
import {
  getCopy,
  prepareCopyTarget,
  putCopy,
  statCopySources,
  type LanCopyResult,
} from '@/lib/lan/lan-copy';
import { formatErrorMessage } from '@/utils/format-error';

type CopyOptions = Pick<CommonCommandOptions, 'json' | 'debug'> & {
  recursive?: boolean;
  preserve?: boolean;
};

/** A path of this machine, or one of the machine named before its colon. */
export type CopyOperand = { machine?: string; path: string };

/**
 * `mba:~/x` names `~/x` of mba. A colon after the first `/` or `\`, or after
 * a single letter (`C:\x`), belongs to a path of this machine.
 */
export function parseCopyOperand(arg: string): CopyOperand {
  const colon = arg.indexOf(':');
  const separator = arg.search(/[\\/]/);
  if (colon < 1 || (separator >= 0 && separator < colon) || /^[A-Za-z]:/.test(arg)) {
    return { path: arg };
  }
  return { machine: arg.slice(0, colon), path: arg.slice(colon + 1) };
}

export type CopyPlan = {
  direction: 'put' | 'get';
  machine: LanMachine;
  /** Paths of the side that sends. */
  sources: string[];
  /** The path of the side that receives. */
  target: string;
};

/** What a command line copies: one side is this machine, the other one member. */
export function planCopy(args: readonly string[], machines: readonly LanMachine[]): CopyPlan {
  if (args.length < 2) throw new Error('Name what to copy and where to');
  const operands = args.map(parseCopyOperand);
  const target = operands[operands.length - 1] as CopyOperand;
  const sources = operands.slice(0, -1);
  if (target.machine !== undefined) {
    if (sources.some((source) => source.machine !== undefined)) {
      throw new Error('Copies between two other machines are not supported; copy through this one');
    }
    return {
      direction: 'put',
      machine: findLanMachine(machines, target.machine),
      sources: sources.map((source) => source.path),
      target: target.path,
    };
  }
  const named = new Set(sources.map((source) => source.machine));
  if (named.has(undefined)) {
    throw new Error(
      sources.length === 1
        ? 'Name the machine of one side as <machine>:<path>'
        : 'Sources must all be on the same machine: <machine>:<path> each'
    );
  }
  const found = [...named].map((selector) => findLanMachine(machines, selector as string));
  const machine = found[0] as LanMachine;
  if (found.some((entry) => entry.machineId !== machine.machineId)) {
    throw new Error('Sources must all be on the same machine');
  }
  return {
    direction: 'get',
    machine,
    sources: sources.map((source) => source.path),
    target: target.path,
  };
}

function formatSize(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${units[unit]}`;
}

async function connectLocalTunnel(): Promise<net.Socket> {
  const socket = net.connect(getLocalTunnelSocketPath());
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return socket;
}

/** Carries the copy through the agent service of this machine. */
async function transfer(
  plan: CopyPlan,
  name: string,
  options: { recursive: boolean; preserveTimes: boolean }
): Promise<{ result: LanCopyResult; destination: string }> {
  if (plan.direction === 'put') {
    const sources = await statCopySources(
      plan.sources.map((source) => path.resolve(source)),
      options.recursive
    );
    const socket = await connectLocalTunnel();
    try {
      const put = await putCopy(socket, {
        ...options,
        target: plan.target,
        sources,
        machineId: plan.machine.machineId,
      });
      return { result: put, destination: `${name}:${put.path}` };
    } finally {
      socket.destroy();
    }
  }
  const target = prepareCopyTarget(path.resolve(plan.target), plan.sources.length);
  const socket = await connectLocalTunnel();
  try {
    const result = await getCopy(socket, {
      ...options,
      sources: plan.sources,
      target,
      machineId: plan.machine.machineId,
    });
    return { result, destination: target.path };
  } finally {
    socket.destroy();
  }
}

export const cpCommand = new Command('cp')
  .description('Copy files between this machine and a machine of a LAN, like scp')
  .argument('<paths...>', 'Sources, then where to copy them; <machine>:<path> names one there')
  .option('-r, --recursive', 'Copy directories with what they hold')
  .option('-p, --preserve', 'Keep modification times')
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .addHelpText(
    'after',
    [
      '',
      'One side is this machine, the other one member: <machine>:<path>, the',
      'machine by name, short name or id as `lan machines` lists them. Several',
      'sources go into a directory that exists; a target that is a directory',
      'receives each source under its own name, any other target is the copy',
      'itself. Files that exist are replaced. -r copies directories; links to',
      'files are copied as files, links to directories are left out.',
      '',
      'A path there is read by that machine: ~ and a relative path start at its',
      'home, and a Windows machine takes a Windows path. C:\\x, a single letter',
      'before the colon, is a path of this machine. There is no pattern matching',
      'there; name each source. Permission bits are kept between POSIX machines.',
      '',
      'Examples:',
      '  lody-lan lan cp app.bin mba:~/x/              into ~/x of mba',
      '  lody-lan lan cp mba:~/x/app.bin ./             from mba into this directory',
      '  lody-lan lan cp -r ./site mba:/srv/site        a directory, as /srv/site',
      "  lody-lan lan cp a.txt b.txt 'DESKTOP-PFNTFPI:D:\\code\\x'",
      '  lody-lan lan cp DESKTOP-PFNTFPI:~/Desktop/out.log .',
    ].join('\n')
  )
  .action(async (args: string[], options: CopyOptions) => {
    await runOneShotCommand('lan', options, async () => {
      const localMachineId = await resolveLocalMachineId();
      const { machines } = await listLanMachinesOfThisMachine(localMachineId);
      const plan = planCopy(args, machines);
      const name = plan.machine.alias ?? plan.machine.name;
      if (!plan.machine.self && plan.machine.online === false)
        throw new Error(`${name} is offline`);
      const started = performance.now();
      const { result, destination } = await transfer(plan, name, {
        recursive: options.recursive === true,
        preserveTimes: options.preserve === true,
      }).catch((error: unknown) => {
        throw new Error(formatErrorMessage(error).replace(/^remote_unreachable:/, ''));
      });

      const seconds = (performance.now() - started) / 1000;
      if (options.json) {
        printJson({ ok: true, ...result, seconds: Number(seconds.toFixed(3)) });
        return;
      }
      const rate = seconds > 0 ? (result.bytes / 1_000_000 / seconds).toFixed(1) : '-';
      const skipped =
        result.skipped > 0
          ? `; left out ${result.skipped} link${result.skipped === 1 ? '' : 's'} to directories or other non-files`
          : '';
      console.log(
        `Copied ${result.files} file${result.files === 1 ? '' : 's'} (${formatSize(result.bytes)}) to ${destination} in ${seconds.toFixed(1)} s (${rate} MB/s)${skipped}`
      );
    });
  });
