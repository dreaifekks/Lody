import net from 'node:net';
import { Command } from 'commander';
import { getLocalTunnelSocketPath } from '@lody/shared/node/local-terminal';
import { printJson, runOneShotCommand, type CommonCommandOptions } from '@/lib/command-runtime';
import {
  findLanMachine,
  listLanMachinesOfThisMachine,
  resolveLocalMachineId,
} from '@/lib/lan/lan-control-client';
import { joinSockets, requestTunnel } from '@/lib/lan/lan-tunnel';
import { formatErrorMessage } from '@/utils/format-error';

type ForwardOptions = Pick<CommonCommandOptions, 'json' | 'debug'> & { bind: string };

/** `host` is absent for the machine's own loopback interface. */
export type PortMapping = { local: number; host?: string; remote: number };

const MAPPING_FORMS = '<port>, <local port>:<port> or <local port>:<host>:<port>';

function parsePort(value: string, spec: string): number {
  const port = Number(value);
  if (!/^\d+$/.test(value) || port < 1 || port > 65_535) {
    throw new Error(`${spec} is no port; write ${MAPPING_FORMS}`);
  }
  return port;
}

/**
 * `3000` forwards 3000 to 3000 there; `8080:3000` forwards local 8080 to 3000
 * there; `8080:nas.lan:80` forwards local 8080 to what the machine reaches as
 * nas.lan:80, as `ssh -L` does. An IPv6 host is written in brackets.
 */
export function parsePortMapping(spec: string): PortMapping {
  const trimmed = spec.trim();
  const bracketed = /^(\d+):\[([^\]]+)\]:(\d+)$/.exec(trimmed);
  if (bracketed?.[1] && bracketed[2] && bracketed[3]) {
    return {
      local: parsePort(bracketed[1], spec),
      host: bracketed[2],
      remote: parsePort(bracketed[3], spec),
    };
  }
  const parts = trimmed.split(':');
  if (parts.length === 1 && parts[0]) {
    const port = parsePort(parts[0], spec);
    return { local: port, remote: port };
  }
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { local: parsePort(parts[0], spec), remote: parsePort(parts[1], spec) };
  }
  if (parts.length === 3 && parts[0] && parts[1] && parts[2]) {
    return { local: parsePort(parts[0], spec), host: parts[1], remote: parsePort(parts[2], spec) };
  }
  throw new Error(`${spec} is no port; write ${MAPPING_FORMS}`);
}

function describeTarget(name: string, mapping: PortMapping): string {
  return mapping.host
    ? `${mapping.host}:${mapping.remote} via ${name}`
    : `${name}:${mapping.remote}`;
}

/** Connects one local connection to the port through the agent service of this machine. */
async function carry(client: net.Socket, machineId: string, mapping: PortMapping): Promise<void> {
  const tunnel = net.connect(getLocalTunnelSocketPath());
  await new Promise<void>((resolve, reject) => {
    tunnel.once('connect', resolve);
    tunnel.once('error', reject);
  });
  tunnel.pause();
  await requestTunnel(tunnel, {
    port: mapping.remote,
    machineId,
    ...(mapping.host ? { host: mapping.host } : {}),
  });
  joinSockets(client, tunnel);
}

function listen(server: net.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

export const forwardCommand = new Command('forward')
  .description(
    'Reach ports through a machine of a LAN, such as a dev server an agent started there'
  )
  .argument('<machine>', 'Name, short name or id of a member')
  .argument('<ports...>', `A port there: ${MAPPING_FORMS}`)
  .option('--bind <address>', 'Local address to listen on', '127.0.0.1')
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .addHelpText(
    'after',
    [
      '',
      'Like ssh -L: a port alone is one of the machine itself, and a host names',
      'anything the machine reaches. The forwarding lasts until this command ends (Ctrl-C).',
    ].join('\n')
  )
  .action(async (selector: string, specs: string[], options: ForwardOptions) => {
    await runOneShotCommand('lan', options, async () => {
      const mappings = specs.map(parsePortMapping);
      const localMachineId = await resolveLocalMachineId();
      const { machines } = await listLanMachinesOfThisMachine(localMachineId);
      const machine = findLanMachine(machines, selector);
      const name = machine.alias ?? machine.name;

      const servers: net.Server[] = [];
      try {
        for (const mapping of mappings) {
          const server = net.createServer({ pauseOnConnect: true }, (client) => {
            carry(client, machine.machineId, mapping).catch((error: unknown) => {
              client.destroy();
              process.stderr.write(
                `${describeTarget(name, mapping)}: ${formatErrorMessage(error).replace(/^remote_unreachable:/, '')}\n`
              );
            });
          });
          await listen(server, mapping.local, options.bind);
          servers.push(server);
        }
      } catch (error) {
        for (const server of servers) server.close();
        throw error;
      }

      if (options.json) {
        printJson({
          ok: true,
          machineId: machine.machineId,
          forwards: mappings.map((mapping) => ({ ...mapping, bind: options.bind })),
        });
      } else {
        for (const mapping of mappings) {
          console.log(`${options.bind}:${mapping.local} -> ${describeTarget(name, mapping)}`);
        }
        console.log('Ctrl-C ends the forwarding.');
      }

      await new Promise<void>((resolve) => {
        process.once('SIGINT', resolve);
        process.once('SIGTERM', resolve);
      });
      // Open connections end with the command.
      for (const server of servers) server.close();
    });
  });
