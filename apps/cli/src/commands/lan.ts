import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { formatLanInvite, parseLanInvite } from '@lody/shared/lan-hub';
import {
  addLanHub,
  findLanHub,
  normalizeMachineNameInput,
  probeLanHub,
  readLanHubSettings,
  removeLanHub,
  resolveMachineName,
  summarizeLanHubs,
  updateLanHub,
  writeLanHubSettings,
  type LanHub,
  type LanHubSettings,
} from '@lody/shared/node/lan-hub';
import { printJson, runOneShotCommand, type CommonCommandOptions } from '@/lib/command-runtime';
import { machinesCommand, updateCommand } from './lan-machines';
import { renderTerminalTable } from '@/lib/terminal-table';
import {
  LAN_HUB_DEFAULT_PORT,
  getDefaultLanHubDataDir,
  startLanHubServer,
} from '@/lib/lan/hub-server';
import { hostLan, pickLanHostAddress } from '@/lib/lan/lan-host';
import { readApnsConfig, writeApnsConfig } from '@/lib/lan/apns';
import { LAN_PUSH_STATUS_PATH, LAN_PUSH_TEST_PATH } from '@/lib/lan/lan-push-protocol';
import {
  LAN_SERVICE_UNITS,
  LanServiceManager,
  renderLanServiceUnit,
  resolveLanServiceCommand,
  type LanServiceKind,
} from '@/lib/lan/service';

type OutputOptions = Pick<CommonCommandOptions, 'json' | 'debug'>;

const SERVICE_WAIT_MS = 30_000;
const SERVICE_POLL_MS = 250;

async function waitFor(condition: () => Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + SERVICE_WAIT_MS;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, SERVICE_POLL_MS));
  }
}

/**
 * How another server joins, in the words of this installation: the installer
 * names the command it created and where it came from, a checkout has neither.
 */
function describeServerJoin(invite: string): string {
  const installer = process.env.LODY_LAN_INSTALLER?.trim();
  if (installer) return `curl -fsSL ${installer} | bash -s -- join ${invite}`;
  return `${process.env.LODY_LAN_COMMAND?.trim() || 'lody'} lan join ${invite} --service`;
}

function getDataDirOverride(): string | null {
  const override = process.env.LODY_DATA_DIR?.trim();
  return override ? path.resolve(override) : null;
}

function readEditableSettings(): LanHubSettings {
  const settings = readLanHubSettings();
  if (settings.source === 'environment') {
    throw new Error(
      'LANs are set by LODY_LAN_HUB_URL and LODY_LAN_HUB_TOKEN here; unset them to manage LANs'
    );
  }
  return settings;
}

function save(settings: LanHubSettings, hubs: readonly LanHub[]): void {
  writeLanHubSettings({ hubs, machineName: settings.machineName });
}

function requireLan(settings: LanHubSettings, selector: string | undefined): LanHub {
  if (!selector) {
    if (settings.hubs.length === 1 && settings.hubs[0]) return settings.hubs[0];
    throw new Error(
      settings.hubs.length === 0
        ? 'This machine belongs to no LAN'
        : 'This machine belongs to several LANs; name the one you mean'
    );
  }
  const hub = findLanHub(settings.hubs, selector);
  if (!hub) throw new Error(`No LAN matches ${JSON.stringify(selector)}`);
  return hub;
}

function describeLan(hub: LanHub, hubs: readonly LanHub[]) {
  const summary = summarizeLanHubs(hubs).find((entry) => entry.id === hub.id);
  return {
    id: hub.id,
    name: hub.name,
    url: hub.url,
    slug: summary?.slug ?? null,
    workspaceId: summary?.workspaceId ?? null,
  };
}

/**
 * Makes sure an agent service runs on a machine without a desktop. A running
 * one follows the settings on its own, so it is only installed when missing.
 */
async function ensureAgentService(): Promise<string> {
  const services = new LanServiceManager();
  if (!(await services.isAvailable())) {
    return 'No user service manager here: run `lody daemon start` to start the agent service.';
  }
  const state = await services.getState('agent');
  if (state.installed && state.active) {
    return `${LAN_SERVICE_UNITS.agent} is running and follows the new settings.`;
  }
  await services.install(
    'agent',
    renderLanServiceUnit('agent', {
      command: resolveLanServiceCommand(),
      searchPath: process.env.PATH ?? '',
      dataDir: getDataDirOverride(),
    })
  );
  try {
    await waitFor(
      async () => (await services.getState('agent')).active,
      `${LAN_SERVICE_UNITS.agent} to start`
    );
  } catch {
    const log = await services.readRecentLog('agent');
    throw new Error(`${LAN_SERVICE_UNITS.agent} did not start.${log ? `\n${log}` : ''}`);
  }
  const lingering = await services.enableLinger();
  return lingering
    ? `${LAN_SERVICE_UNITS.agent} is running and starts with the machine.`
    : `${LAN_SERVICE_UNITS.agent} is running. It stops at logout: run \`loginctl enable-linger\` to keep it.`;
}

function printJoined(
  options: OutputOptions,
  result: { hub: LanHub; created: boolean; hubs: readonly LanHub[]; service?: string }
): void {
  if (options.json) {
    printJson({
      ok: true,
      created: result.created,
      lan: describeLan(result.hub, result.hubs),
      ...(result.service ? { service: result.service } : {}),
    });
    return;
  }
  console.log(
    result.created
      ? `Joined ${result.hub.name} at ${result.hub.url}.`
      : `Already a member of ${result.hub.name}; it is now reached at ${result.hub.url}.`
  );
  if (result.service) console.log(result.service);
}

const listCommand = new Command('list')
  .description('List the LANs this machine belongs to')
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .action(async (options: OutputOptions) => {
    await runOneShotCommand('lan', options, async () => {
      const settings = readLanHubSettings();
      const reachability = await Promise.all(settings.hubs.map((hub) => probeLanHub(hub)));
      const machineName = resolveMachineName({ settings });
      if (options.json) {
        printJson({
          ok: true,
          machineName: machineName.name,
          source: settings.source,
          lans: settings.hubs.map((hub, index) => ({
            ...describeLan(hub, settings.hubs),
            reachability: reachability[index],
          })),
        });
        return;
      }
      console.log(`This machine is called ${machineName.name}.`);
      if (settings.hubs.length === 0) {
        console.log('It belongs to no LAN.');
        return;
      }
      console.log(
        renderTerminalTable(
          [{ header: 'Name' }, { header: 'Address' }, { header: 'State' }, { header: 'ID' }],
          settings.hubs.map((hub, index) => [
            hub.name,
            hub.url,
            reachability[index],
            hub.id.slice(0, 8),
          ])
        )
      );
    });
  });

const joinCommand = new Command('join')
  .description('Join a LAN with the invite its host printed')
  .argument('<invite>', 'Invite link, lody-lan://…')
  .option('--name <name>', 'What to call this LAN on this machine')
  .option('--service', 'Keep an agent service running on this machine')
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .action(async (invite: string, options: OutputOptions & { name?: string; service?: boolean }) => {
    await runOneShotCommand('lan', options, async () => {
      const parsed = parseLanInvite(invite);
      const settings = readEditableSettings();
      const result = addLanHub(settings.hubs, {
        url: parsed.url,
        token: parsed.token,
        name: options.name ?? parsed.name,
      });
      save(settings, result.hubs);
      const service = options.service ? await ensureAgentService() : undefined;
      printJoined(options, { ...result, ...(service ? { service } : {}) });
    });
  });

const addCommand = new Command('add')
  .description('Join a LAN by its address and credential')
  .argument('<address>', 'Address of the LAN host, e.g. 100.64.0.1:8788')
  .requiredOption('--token <token>', 'Credential of the LAN')
  .option('--name <name>', 'What to call this LAN on this machine')
  .option('--service', 'Keep an agent service running on this machine')
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .action(
    async (
      address: string,
      options: OutputOptions & { token: string; name?: string; service?: boolean }
    ) => {
      await runOneShotCommand('lan', options, async () => {
        const settings = readEditableSettings();
        const result = addLanHub(settings.hubs, {
          url: address,
          token: options.token,
          name: options.name ?? null,
        });
        save(settings, result.hubs);
        const service = options.service ? await ensureAgentService() : undefined;
        printJoined(options, { ...result, ...(service ? { service } : {}) });
      });
    }
  );

const removeCommand = new Command('remove')
  .alias('leave')
  .description('Leave a LAN; what it stored on this machine stays on disk')
  .argument('<lan>', 'Name or id of the LAN')
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .action(async (selector: string, options: OutputOptions) => {
    await runOneShotCommand('lan', options, async () => {
      const settings = readEditableSettings();
      const result = removeLanHub(settings.hubs, selector);
      save(settings, result.hubs);
      if (options.json) {
        printJson({ ok: true, lan: describeLan(result.hub, settings.hubs) });
        return;
      }
      console.log(`Left ${result.hub.name}.`);
    });
  });

const renameCommand = new Command('rename')
  .description('Change what a LAN is called on this machine')
  .argument('<lan>', 'Name or id of the LAN')
  .argument('<name>', 'New name')
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .action(async (selector: string, name: string, options: OutputOptions) => {
    await runOneShotCommand('lan', options, async () => {
      const settings = readEditableSettings();
      const result = updateLanHub(settings.hubs, selector, { name });
      save(settings, result.hubs);
      if (options.json) {
        printJson({ ok: true, lan: describeLan(result.hub, result.hubs) });
        return;
      }
      console.log(`Renamed to ${result.hub.name}.`);
    });
  });

const moveCommand = new Command('move')
  .description('Reach a LAN at another address; it keeps everything it stores')
  .argument('<lan>', 'Name or id of the LAN')
  .argument('<address>', 'New address of the LAN host')
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .action(async (selector: string, address: string, options: OutputOptions) => {
    await runOneShotCommand('lan', options, async () => {
      const settings = readEditableSettings();
      const result = updateLanHub(settings.hubs, selector, { url: address });
      save(settings, result.hubs);
      if (options.json) {
        printJson({ ok: true, lan: describeLan(result.hub, result.hubs) });
        return;
      }
      console.log(`${result.hub.name} is now reached at ${result.hub.url}.`);
    });
  });

const inviteCommand = new Command('invite')
  .description('Print the link another machine joins a LAN with')
  .argument('[lan]', 'Name or id of the LAN')
  .option('--address <address>', 'Address the other machine reaches the LAN host at')
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .action(async (selector: string | undefined, options: OutputOptions & { address?: string }) => {
    await runOneShotCommand('lan', options, async () => {
      const hub = requireLan(readLanHubSettings(), selector);
      const invite = formatLanInvite({ ...hub, url: options.address ?? hub.url });
      if (options.json) {
        printJson({ ok: true, invite });
        return;
      }
      // Alone on its line, so it can be piped.
      console.log(invite);
    });
  });

const nameCommand = new Command('name')
  .description('Show or set the name this machine has in every LAN')
  .argument('[name]', 'New name of this machine')
  .option('--reset', 'Follow the host name again')
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .action(async (name: string | undefined, options: OutputOptions & { reset?: boolean }) => {
    await runOneShotCommand('lan', options, async () => {
      let settings = readLanHubSettings();
      if (name !== undefined || options.reset) {
        settings = readEditableSettings();
        const machineName = options.reset ? null : normalizeMachineNameInput(name);
        writeLanHubSettings({ hubs: settings.hubs, machineName });
        settings = { ...settings, machineName };
      }
      const resolved = resolveMachineName({ settings });
      if (options.json) {
        printJson({ ok: true, machineName: resolved.name, explicit: resolved.explicit });
        return;
      }
      console.log(
        resolved.explicit
          ? `This machine is called ${resolved.name}.`
          : `This machine is called ${resolved.name}, after its host name.`
      );
    });
  });

type HubOptions = {
  host: string;
  port: string;
  dataDir: string;
  publicUrl?: string;
  tlsCert?: string;
  tlsKey?: string;
};

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

// A long-running process: it owns its signals and exit code like `lody start`.
const hubCommand = new Command('hub')
  .description('Host a LAN in the foreground')
  .option('--host <address>', 'Interface to listen on', '127.0.0.1')
  .option('--port <port>', 'Port to listen on', String(LAN_HUB_DEFAULT_PORT))
  .option(
    '--data-dir <path>',
    'Where the LAN stores its streams and credential',
    getDefaultLanHubDataDir()
  )
  .option('--public-url <url>', 'Address other machines use, printed in the invite')
  .option('--tls-cert <path>', 'Serve HTTPS with this certificate (requires --tls-key)')
  .option('--tls-key <path>', 'Private key of --tls-cert')
  .action(async (options: HubOptions) => {
    try {
      if (Boolean(options.tlsCert) !== Boolean(options.tlsKey)) {
        throw new Error('--tls-cert and --tls-key must be passed together');
      }
      const hub = await startLanHubServer({
        host: options.host,
        port: parsePort(options.port),
        dataDir: path.resolve(options.dataDir),
        log: (line) => console.log(line),
        tls:
          options.tlsCert && options.tlsKey
            ? { cert: fs.readFileSync(options.tlsCert), key: fs.readFileSync(options.tlsKey) }
            : null,
      });
      console.log(`Lody LAN host listening on ${hub.url}`);
      console.log(`Data directory: ${path.resolve(options.dataDir)}`);
      // The invite carries the credential. Output that nobody watches, such as
      // a service's journal, is a log, and the credential never goes there.
      if (process.stdout.isTTY) {
        console.log('');
        console.log('Join this LAN from another server with:');
        console.log(
          `  ${describeServerJoin(formatLanInvite({ url: options.publicUrl ?? hub.url, token: hub.token }))}`
        );
      } else {
        console.log('`lody lan invite` on a member of this LAN prints its invite.');
      }
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.once(signal, () => void hub.close());
      }
      const { error } = await hub.stopped;
      if (error) throw error;
      process.exit(0);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

type UpOptions = OutputOptions & {
  name?: string;
  host?: string;
  port: string;
  dataDir: string;
  publicUrl?: string;
  agent: boolean;
};

const upCommand = new Command('up')
  .description('Host a LAN on this machine and keep it running as a service')
  .option('--name <name>', 'What to call the LAN')
  .option('--host <address>', 'Interface to listen on (default: a private address of this machine)')
  .option('--port <port>', 'Port to listen on', String(LAN_HUB_DEFAULT_PORT))
  .option(
    '--data-dir <path>',
    'Where the LAN stores its streams and credential',
    getDefaultLanHubDataDir()
  )
  .option('--public-url <url>', 'Address other machines use when it differs')
  .option('--no-agent', 'Host the LAN without running agents on this machine')
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .action(async (options: UpOptions) => {
    await runOneShotCommand('lan', options, async () => {
      const services = new LanServiceManager();
      if (!(await services.isAvailable())) {
        throw new Error(
          'This machine has no systemd user session to run services in. Run `lody lan hub` and ' +
            '`lody daemon start` yourself, for example from a terminal multiplexer.'
        );
      }
      const host = options.host ?? pickLanHostAddress(os.networkInterfaces());
      if (!host) {
        throw new Error(
          'This machine has no private network address to host a LAN on. Pass --host to choose ' +
            'one; a public address exposes the LAN to the internet.'
        );
      }
      const result = await hostLan(
        {
          name: options.name ?? null,
          host,
          port: parsePort(options.port),
          dataDir: path.resolve(options.dataDir),
          publicUrl: options.publicUrl ?? null,
          withAgent: options.agent,
        },
        {
          services,
          command: resolveLanServiceCommand(),
          searchPath: process.env.PATH ?? '',
          dataDir: getDataDirOverride(),
          waitFor,
        }
      );
      if (options.json) {
        printJson({
          ok: true,
          lan: describeLan(result.hub, readLanHubSettings().hubs),
          invite: result.invite,
          agent: result.agent,
          lingering: result.lingering,
        });
        if (result.agent === 'failed') process.exitCode = 1;
        return;
      }
      console.log(`${result.hub.name} is hosted at ${result.hub.url}.`);
      if (result.agent === 'started') console.log('The agent service of this machine is running.');
      if (result.agent === 'failed') {
        console.log(`${LAN_SERVICE_UNITS.agent} did not start:`);
        console.log(result.agentLog || '(no log output)');
      }
      if (!result.lingering) {
        console.log(
          'The services stop at logout. Run `loginctl enable-linger` to keep them running.'
        );
      }
      console.log('');
      console.log('Join from another server:');
      console.log(`  ${describeServerJoin(result.invite)}`);
      console.log('Join from the desktop application: Settings, LAN, then paste');
      console.log(`  ${result.invite}`);
      if (result.agent === 'failed') process.exitCode = 1;
    });
  });

const downCommand = new Command('down')
  .description('Stop hosting and remove the services; stored data stays on disk')
  .option('--keep-agent', 'Only stop hosting the LAN')
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .action(async (options: OutputOptions & { keepAgent?: boolean }) => {
    await runOneShotCommand('lan', options, async () => {
      const services = new LanServiceManager();
      const kinds: LanServiceKind[] = options.keepAgent ? ['hub'] : ['agent', 'hub'];
      const removed: string[] = [];
      for (const kind of kinds) {
        if (await services.remove(kind)) removed.push(LAN_SERVICE_UNITS[kind]);
      }
      if (options.json) {
        printJson({ ok: true, removed });
        return;
      }
      console.log(
        removed.length > 0 ? `Removed ${removed.join(' and ')}.` : 'No service to remove.'
      );
    });
  });

const statusCommand = new Command('status')
  .description('Show the services of this machine and the LANs it belongs to')
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .action(async (options: OutputOptions) => {
    await runOneShotCommand('lan', options, async () => {
      const services = new LanServiceManager();
      const available = await services.isAvailable();
      const states = available
        ? await Promise.all([services.getState('hub'), services.getState('agent')])
        : [];
      const settings = readLanHubSettings();
      const reachability = await Promise.all(settings.hubs.map((hub) => probeLanHub(hub)));
      if (options.json) {
        printJson({
          ok: true,
          services: states,
          lans: settings.hubs.map((hub, index) => ({
            ...describeLan(hub, settings.hubs),
            reachability: reachability[index],
          })),
        });
        return;
      }
      for (const state of states) {
        console.log(`${state.unit}: ${state.installed ? state.state : 'not installed'}`);
      }
      if (settings.hubs.length === 0) {
        console.log('This machine belongs to no LAN.');
        return;
      }
      for (const [index, hub] of settings.hubs.entries()) {
        console.log(`${hub.name} at ${hub.url}: ${reachability[index]}`);
      }
    });
  });

type PushSetupOptions = OutputOptions & {
  key: string;
  keyId?: string;
  teamId: string;
  dataDir: string;
};

const pushSetupCommand = new Command('setup')
  .description('Give the LAN host an APNs key so it can push to phones')
  .requiredOption('--key <path>', 'AuthKey_<KEYID>.p8 downloaded from Apple Developer')
  .option('--key-id <id>', 'Key ID; read from the file name when omitted')
  .requiredOption('--team-id <id>', 'Apple Developer team ID')
  .option('--data-dir <path>', 'Data directory of the LAN host', getDefaultLanHubDataDir())
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .action(async (options: PushSetupOptions) => {
    await runOneShotCommand('lan', options, async () => {
      const keyId = options.keyId ?? /AuthKey_([A-Z0-9]{10})\.p8$/.exec(options.key)?.[1];
      if (!keyId) throw new Error('Pass --key-id; it is not in the file name');
      writeApnsConfig(path.resolve(options.dataDir), {
        keyId,
        teamId: options.teamId,
        privateKey: fs.readFileSync(options.key, 'utf8'),
      });
      if (options.json) {
        printJson({ ok: true, keyId, teamId: options.teamId });
        return;
      }
      console.log(`APNs key ${keyId} saved. The running host uses it from its next push.`);
    });
  });

async function callHubPush(hub: LanHub, method: 'GET' | 'POST', pushPath: string) {
  const response = await fetch(`${hub.url}${pushPath}`, {
    method,
    headers: { Authorization: `Bearer ${hub.token}` },
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.status === 404) throw new Error(`${hub.name} runs a host without push; update it`);
  return { status: response.status, body };
}

const pushStatusCommand = new Command('status')
  .description('Show whether the LAN host can push and how many phones registered')
  .argument('[lan]', 'Name or id of the LAN')
  .option('--data-dir <path>', 'Data directory, when this machine is the LAN host')
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .action(async (selector: string | undefined, options: OutputOptions & { dataDir?: string }) => {
    await runOneShotCommand('lan', options, async () => {
      const hub = requireLan(readLanHubSettings(), selector);
      const { body } = await callHubPush(hub, 'GET', LAN_PUSH_STATUS_PATH);
      const local = readApnsConfig(path.resolve(options.dataDir ?? getDefaultLanHubDataDir()));
      if (options.json) {
        printJson({ ok: true, ...body, localKeyId: local?.keyId ?? null });
        return;
      }
      console.log(
        `${hub.name}: ${body.configured ? 'APNs configured' : 'no APNs key (run `lody lan push setup` on the host)'}, ` +
          `${String(body.devices ?? 0)} phone(s) registered`
      );
    });
  });

const pushTestCommand = new Command('test')
  .description('Send a test notification to every registered phone')
  .argument('[lan]', 'Name or id of the LAN')
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .action(async (selector: string | undefined, options: OutputOptions) => {
    await runOneShotCommand('lan', options, async () => {
      const hub = requireLan(readLanHubSettings(), selector);
      const { status, body } = await callHubPush(hub, 'POST', LAN_PUSH_TEST_PATH);
      if (status === 409)
        throw new Error('The LAN host has no APNs key; run `lody lan push setup`');
      if (options.json) {
        printJson({ ok: true, ...body });
        return;
      }
      console.log(`Delivered to ${String(body.delivered)} of ${String(body.devices)} phone(s).`);
    });
  });

const pushCommand = new Command('push')
  .description('Push notifications and Live Activities for phones in a LAN')
  .addCommand(pushSetupCommand)
  .addCommand(pushStatusCommand)
  .addCommand(pushTestCommand);

export const lanCommand = new Command('lan')
  .description('Host and join LANs: machines that reach each other without an account')
  .addCommand(listCommand)
  .addCommand(joinCommand)
  .addCommand(addCommand)
  .addCommand(removeCommand)
  .addCommand(renameCommand)
  .addCommand(moveCommand)
  .addCommand(inviteCommand)
  .addCommand(nameCommand)
  .addCommand(upCommand)
  .addCommand(downCommand)
  .addCommand(statusCommand)
  .addCommand(hubCommand)
  .addCommand(machinesCommand)
  .addCommand(updateCommand)
  .addCommand(pushCommand);
