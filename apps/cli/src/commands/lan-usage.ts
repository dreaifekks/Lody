import { Command } from 'commander';
import {
  LAN_USAGE_IMPORT_MAX_ROWS,
  type LanMachine,
  type MachineId,
  type WorkspaceId,
} from '@lody/shared';
import { printJson, runOneShotCommand, type CommonCommandOptions } from '@/lib/command-runtime';
import {
  askLanMachine,
  listLanMachinesOfThisMachine,
  resolveLocalMachineId,
} from '@/lib/lan/lan-control-client';
import { renderTerminalTable } from '@/lib/terminal-table';
import {
  bareHost,
  chunkRows,
  defaultVibeConfigPath,
  fetchVibeBuckets,
  matchVibeHost,
  readVibeConfig,
  VIBE_USAGE_SOURCE,
  vibeBucketsToRows,
} from '@/lib/usage/vibe-usage-import';

type ImportOptions = Pick<CommonCommandOptions, 'json' | 'debug'> & {
  days: string;
  lan?: string;
  map: string[];
  config: string;
  dryRun?: boolean;
};

type HostOutcome = {
  host: string;
  machine: string | null;
  days: number;
  tokens: number;
  costUSD: number;
  kept?: number;
  dropped?: number;
  cutoff?: string;
  error?: string;
};

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseMap(entries: readonly string[]): Map<string, string> {
  const mapped = new Map<string, string>();
  for (const entry of entries) {
    const at = entry.indexOf('=');
    if (at <= 0 || at === entry.length - 1) {
      throw new Error(`--map takes host=machine, not ${entry}`);
    }
    mapped.set(bareHost(entry.slice(0, at)), entry.slice(at + 1).trim());
  }
  return mapped;
}

/** The LAN the import goes to: the one named, or the only one this machine is in. */
function resolveWorkspace(self: LanMachine, selector: string | undefined): WorkspaceId {
  const { lans } = self;
  const lan = selector
    ? lans.find((entry) => entry.workspaceId === selector || entry.name === selector)
    : lans.length === 1
      ? lans[0]
      : undefined;
  if (!lan) {
    throw new Error(
      lans.length === 0
        ? 'This machine is in no LAN'
        : `Name the LAN with --lan: ${lans.map((entry) => entry.name).join(', ')}`
    );
  }
  return lan.workspaceId as WorkspaceId;
}

const tokensOf = (rows: readonly { [key: string]: number | string }[]) =>
  rows.reduce(
    (sum, row) =>
      sum +
      Number(row.inputTokens) +
      Number(row.outputTokens) +
      Number(row.cacheReadInputTokens) +
      Number(row.cacheCreationInputTokens) +
      Number(row.reasoningOutputTokens),
    0
  );

const importVibeCommand = new Command('import-vibe')
  .description(
    'Fill the usage of the machines of a LAN, for the days before they counted it, from Vibe Usage'
  )
  .option('--days <days>', 'How far back to read', '365')
  .option('--lan <name>', 'The LAN whose usage page shows it, when this machine is in several')
  .option(
    '--map <host=machine>',
    'A Vibe host name and the machine it is (repeatable)',
    collect,
    []
  )
  .option(
    '--config <path>',
    'The vibe-usage configuration to read the key from',
    defaultVibeConfigPath()
  )
  .option('--dry-run', 'Say what would be imported without sending it')
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .addHelpText(
    'after',
    [
      '',
      'Each machine keeps the rows of the whole days before the first one it counted',
      'itself, so nothing is counted twice; importing again replaces what an import gave.',
    ].join('\n')
  )
  .action(async (options: ImportOptions) => {
    await runOneShotCommand('lan', options, async () => {
      const days = Number(options.days);
      if (!Number.isInteger(days) || days < 1) throw new Error('--days takes a number of days');
      const mapped = parseMap(options.map);
      const localMachineId = await resolveLocalMachineId();
      const { machines } = await listLanMachinesOfThisMachine(localMachineId);
      const self = machines.find((machine) => machine.self);
      if (!self) throw new Error('This machine is not in its own list');
      const workspaceId = resolveWorkspace(self, options.lan);
      const members = machines.filter(
        (machine) => machine.self || machine.lans.some((lan) => lan.workspaceId === workspaceId)
      );

      const config = readVibeConfig(options.config);
      const byHost = vibeBucketsToRows(await fetchVibeBuckets(config, days));
      const outcomes: HostOutcome[] = [];
      for (const [host, rows] of byHost) {
        const machine = matchVibeHost(host, members, mapped);
        const outcome: HostOutcome = {
          host,
          machine: machine ? (machine.alias ?? machine.name) : null,
          days: new Set(rows.map((row) => row.startMs)).size,
          tokens: tokensOf(rows),
          costUSD: rows.reduce((sum, row) => sum + row.costUSD, 0),
        };
        outcomes.push(outcome);
        if (!machine || options.dryRun) continue;
        if (!machine.self && machine.online === false) {
          outcome.error = 'offline';
          continue;
        }
        let kept = 0;
        let dropped = 0;
        try {
          for (const [index, chunk] of chunkRows(rows, LAN_USAGE_IMPORT_MAX_ROWS).entries()) {
            const response = await askLanMachine(localMachineId, {
              type: 'lan/usage-import',
              machineId: (machine.self ? localMachineId : machine.machineId) as MachineId,
              workspaceId,
              source: VIBE_USAGE_SOURCE,
              replace: index === 0,
              rows: chunk,
            });
            if (!response.ok) throw new Error(response.message);
            if (response.type !== 'lan/usage-import') throw new Error('Unexpected response');
            kept += response.result.kept;
            dropped += response.result.dropped;
            outcome.cutoff = new Date(response.result.cutoffMs).toISOString().slice(0, 10);
          }
          outcome.kept = kept;
          outcome.dropped = dropped;
        } catch (error) {
          outcome.error = error instanceof Error ? error.message : String(error);
        }
      }

      if (options.json) {
        printJson({ ok: true, workspaceId, dryRun: Boolean(options.dryRun), hosts: outcomes });
      } else {
        console.log(
          renderTerminalTable(
            [
              { header: 'Vibe host' },
              { header: 'Machine' },
              { header: 'Days' },
              { header: 'Tokens' },
              { header: 'Cost (USD)' },
              { header: 'Result' },
            ],
            outcomes.map((outcome) => [
              outcome.host,
              outcome.machine ?? '(no machine; use --map)',
              String(outcome.days),
              outcome.tokens.toLocaleString('en'),
              outcome.costUSD.toFixed(2),
              outcome.error
                ? `failed: ${outcome.error}`
                : options.dryRun || !outcome.machine
                  ? ''
                  : `kept ${outcome.kept} rows before ${outcome.cutoff}, dropped ${outcome.dropped}`,
            ])
          )
        );
      }
      if (outcomes.some((outcome) => outcome.error)) {
        throw Object.assign(new Error('Some machines did not take their usage'), {
          suppressCommandErrorOutput: Boolean(!options.json),
        });
      }
    });
  });

export const usageCommand = new Command('usage')
  .description('The usage the machines of a LAN keep')
  .addCommand(importVibeCommand);
