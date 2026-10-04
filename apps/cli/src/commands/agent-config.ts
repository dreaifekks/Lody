import { Command } from 'commander';
import { discoveryListCommand, discoveryGetCommand } from './discovery';
import { promises as fs } from 'node:fs';
import { v4 as uuidV4 } from 'uuid';
import { z } from 'zod';
import {
  MachineAcpCapabilitiesRefreshResponseSchema,
  isMachineDocRoomId,
  negotiatedAcpCapabilitiesRefreshForce,
  type AgentConfigCliType,
  type AgentConfigId,
  type AgentConfigMeta,
  type TerminalCommand,
  type TitleGenerationConfig,
  type LocalSessionControlResponse,
  type MachineId,
  type MachineMeta,
  type WorkspaceId,
} from '@lody/shared';
import {
  dispatchLocalControl,
  ensureWorkspaceMetaSynced,
  getAuthContextOrThrow,
  listAliveDocMetas,
  normalizeCliValue,
  printJson,
  resolveStructuredOutputMode,
  runOneShotCommand,
  type CommonCommandOptions,
} from '@/lib/command-runtime';
import { toAgentConfigOutput, type AgentConfigOutput } from './agent-config-output';
import { renderTerminalTable } from '@/lib/terminal-table';
import { formatErrorMessage } from '@/utils/format-error';
import { getCliPlatformKind } from '@/lib/cli-platform';
import {
  resolveTerminalToolTarget,
  runTerminalCommand,
  runWorkspaceCommand,
  type WorkspaceCommandContext,
} from '@/lib/terminal-session-tools';
import {
  deleteMachineAgentConfig,
  listMergedAgentConfigs,
  upsertMachineAgentConfig,
} from '@/lib/agent-config-machine-flock';

type AgentConfigCommandOptions = CommonCommandOptions;
type AgentConfigShowOptions = AgentConfigCommandOptions & { showSecrets?: boolean };

type AgentConfigCreateOptions = AgentConfigCommandOptions & {
  name?: string;
  description?: string;
  agentType: string;
  machine?: string;
  env?: string[];
  envFile?: string;
  prompt?: string;
  promptFile?: string;
  titleConfigOption?: string[];
};

type AgentConfigUpdateOptions = AgentConfigCommandOptions & {
  name?: string;
  description?: string;
  env?: string[];
  envFile?: string;
  unsetEnv?: string[];
  prompt?: string;
  promptFile?: string;
  titleConfigOption?: string[];
  clearTitleGeneration?: boolean;
};

type AgentConfigRefreshOptions = CommonCommandOptions & {
  machine?: string;
};

export function sortAgentConfigs(configs: AgentConfigMeta[]): AgentConfigMeta[] {
  return [...configs].sort((left, right) => {
    const nameCompare = left.name.localeCompare(right.name);
    if (nameCompare !== 0) {
      return nameCompare;
    }
    return left.id.localeCompare(right.id);
  });
}

function formatAgentConfigCandidates(configs: AgentConfigMeta[]): string {
  return sortAgentConfigs(configs)
    .map((config) => `${config.name} (${config.id})`)
    .join(', ');
}

function selectUniqueByIdOrName<T extends { id: string; name: string }>(
  entries: T[],
  selector: string,
  options: {
    label: string;
    candidates: string;
  }
): T {
  const normalizedSelector = normalizeCliValue(selector);
  if (!normalizedSelector) {
    throw new Error(`Missing ${options.label} selector.`);
  }

  const idMatch = entries.find((entry) => entry.id === normalizedSelector);
  if (idMatch) {
    return idMatch;
  }

  const nameMatches = entries.filter(
    (entry) => normalizeCliValue(entry.name) === normalizedSelector
  );
  if (nameMatches.length === 1) {
    return nameMatches[0]!;
  }
  if (nameMatches.length > 1) {
    throw new Error(
      `${options.label} selector is ambiguous: ${normalizedSelector}. Use an id instead. Candidates: ${options.candidates}`
    );
  }

  throw new Error(
    `${options.label} not found: ${normalizedSelector}. Candidates: ${options.candidates}`
  );
}

export function resolveAgentConfigSelector(
  configs: AgentConfigMeta[],
  options: {
    selector?: string;
    envSelector?: string;
  } = {}
): AgentConfigMeta {
  const selector = normalizeCliValue(options.selector) ?? normalizeCliValue(options.envSelector);
  if (selector) {
    return selectUniqueByIdOrName(configs, selector, {
      label: 'Agent config',
      candidates: formatAgentConfigCandidates(configs),
    });
  }

  if (configs.length === 1) {
    return configs[0]!;
  }
  if (configs.length === 0) {
    throw new Error('No agent configs found in the target workspace.');
  }

  throw new Error(
    `Multiple agent configs are available; pass an id or name. Candidates: ${formatAgentConfigCandidates(configs)}`
  );
}

// CLI inference predates explicit cliType. Keep the historical Claude/Codex
// aliases and the unambiguous built-in Grok/Bub/Dimcode aliases here; `kimi` continues
// to mean the registry agent for backward compatibility.
const LEGACY_BUILTIN_AGENT_TYPES = new Set(['claude', 'codex', 'grok', 'bub', 'dimcode']);

export function inferAgentConfigCliType(agentType: string): AgentConfigCliType {
  const normalized = normalizeCliValue(agentType)?.toLowerCase();
  return normalized && LEGACY_BUILTIN_AGENT_TYPES.has(normalized) ? 'builtin' : 'registry';
}

export function parseEnvAssignments(entries: string[] | undefined): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const [index, entry] of (entries ?? []).entries()) {
    const normalizedEntry = normalizeCliValue(entry);
    if (!normalizedEntry) {
      continue;
    }
    const separatorIndex = normalizedEntry.indexOf('=');
    if (separatorIndex <= 0) {
      throw new Error(`Invalid assignment at entry ${index + 1}. Expected KEY=VALUE.`);
    }
    const key = normalizedEntry.slice(0, separatorIndex).trim();
    if (!key) {
      throw new Error(`Invalid assignment at entry ${index + 1}. Expected KEY=VALUE.`);
    }
    parsed[key] = normalizedEntry.slice(separatorIndex + 1);
  }
  return parsed;
}

export function parseEnvFileText(text: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) {
      throw new Error(`Invalid env file entry at line ${index + 1}. Expected KEY=VALUE.`);
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!key) {
      throw new Error(`Invalid env file entry at line ${index + 1}. Expected KEY=VALUE.`);
    }

    parsed[key] = line.slice(separatorIndex + 1);
  }
  return parsed;
}

export function applyEnvUpdates(
  baseEnv: Record<string, string>,
  fileEnv: Record<string, string>,
  inlineEnv: Record<string, string>,
  unsetEnv: string[] = []
): Record<string, string> {
  const nextEnv = {
    ...baseEnv,
    ...fileEnv,
    ...inlineEnv,
  };

  for (const key of unsetEnv) {
    const normalizedKey = normalizeCliValue(key);
    if (!normalizedKey) {
      continue;
    }
    delete nextEnv[normalizedKey];
  }

  return nextEnv;
}

function parseUnsetEnvKeys(entries: string[] | undefined): string[] {
  const keys: string[] = [];
  for (const entry of entries ?? []) {
    const normalized = normalizeCliValue(entry);
    if (!normalized) {
      throw new Error('Invalid --unset-env entry: expected a non-empty key.');
    }
    keys.push(normalized);
  }
  return keys;
}

async function readOptionalTextInput(options: {
  text?: string;
  filePath?: string;
}): Promise<string | undefined> {
  if (options.text !== undefined) {
    return normalizeCliValue(options.text);
  }

  const filePath = options.filePath;
  if (filePath === undefined) {
    return undefined;
  }

  const rawText =
    filePath === '-'
      ? await readStdinText()
      : await fs.readFile(filePath, 'utf8').catch((error: unknown) => {
          const message = formatErrorMessage(error);
          throw new Error(`Failed to read file ${filePath}: ${message}`);
        });
  return normalizeCliValue(rawText);
}

async function readStdinText(): Promise<string | undefined> {
  if (process.stdin.isTTY) {
    return undefined;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return normalizeCliValue(raw);
}

type RefreshCapabilitiesOutput = Omit<
  z.infer<typeof MachineAcpCapabilitiesRefreshResponseSchema>,
  'cliType'
>;

function toRefreshCapabilitiesOutput(
  response: z.infer<typeof MachineAcpCapabilitiesRefreshResponseSchema>
): RefreshCapabilitiesOutput {
  const { cliType: _cliType, ...rest } = response;
  return rest;
}

function printHumanAgentConfig(config: AgentConfigOutput): void {
  console.log(`id: ${config.id}`);
  console.log(`name: ${config.name}`);
  console.log(`agentType: ${config.agentType}`);
  console.log(`description: ${normalizeCliValue(config.description) ?? '-'}`);
  console.log(`prompt: ${normalizeCliValue(config.prompt) ?? '-'}`);
  if (config.envKeys.length === 0) {
    console.log('env: -');
  } else {
    console.log('env:');
    for (const key of config.envKeys) {
      console.log(`  ${key}=${config.env ? config.env[key] : '[configured]'}`);
    }
  }

  const tc = config.titleGeneration;
  if (!tc) {
    console.log('titleGeneration: -');
  } else {
    console.log('titleGeneration:');
    if (tc.configOptionValues) {
      console.log('  configOptions:');
      for (const [key, value] of Object.entries(tc.configOptionValues)) {
        console.log(`    ${key}=${value}`);
      }
    }
  }
}

function printHumanRefreshSummary(input: {
  config: Pick<AgentConfigMeta, 'id' | 'name' | 'agentType'>;
  machine: MachineMeta;
  response: z.infer<typeof MachineAcpCapabilitiesRefreshResponseSchema>;
}): void {
  console.log(`agentConfig: ${input.config.name} (${input.config.id})`);
  console.log(`agent: ${input.config.agentType}`);
  console.log(`machine: ${input.machine.name} (${input.machine.id})`);
  console.log(`modes: ${input.response.modes?.length ?? 0}`);
  console.log(`models: ${input.response.models?.length ?? 0}`);
  console.log(`configOptions: ${input.response.configOptions?.length ?? 0}`);

  if (input.response.modes?.length) {
    console.log('');
    console.log(
      renderTerminalTable(
        [{ header: 'Mode ID' }, { header: 'Name' }, { header: 'Description' }],
        input.response.modes.map((mode) => [mode.id, mode.name, mode.description])
      )
    );
  }

  if (input.response.models?.length) {
    console.log('');
    console.log(
      renderTerminalTable(
        [{ header: 'Model ID' }, { header: 'Name' }, { header: 'Description' }],
        input.response.models.map((model) => [model.modelId, model.name, model.description])
      )
    );
  }

  if (input.response.configOptions?.length) {
    console.log('');
    console.log(
      renderTerminalTable(
        [{ header: 'Option ID' }, { header: 'Name' }, { header: 'Category' }, { header: 'Values' }],
        input.response.configOptions.map((option) => [
          option.id,
          option.name,
          option.category,
          String(option.optionCount),
        ])
      )
    );
  }
}

async function listAgentConfigsForWorkspace(
  manager: import('@/lib/loro/doc').LoroDocumentManager,
  workspaceId: WorkspaceId
): Promise<AgentConfigMeta[]> {
  const machines = await listMachineMetasForWorkspace(manager);
  const configs = await listMergedAgentConfigs(
    manager.repo,
    workspaceId,
    machines.map((machine) => machine.id)
  );
  return sortAgentConfigs(configs);
}

async function listMachineMetasForWorkspace(
  manager: import('@/lib/loro/doc').LoroDocumentManager
): Promise<MachineMeta[]> {
  return (await listAliveDocMetas<MachineMeta>(manager, isMachineDocRoomId)).map(
    (entry) => entry.meta
  );
}

function formatMachineCandidates(machines: MachineMeta[]): string {
  return machines
    .map((machine) => `${machine.name} (${machine.id})`)
    .sort((left, right) => left.localeCompare(right))
    .join(', ');
}

export function resolveMachineOrThrow(
  machines: MachineMeta[],
  options: {
    selector?: string;
    envSelector?: string;
    authMachineId: MachineId;
  }
): MachineMeta {
  const selector =
    normalizeCliValue(options.selector) ??
    normalizeCliValue(options.envSelector) ??
    options.authMachineId;
  return selectUniqueByIdOrName(machines, selector, {
    label: 'Machine',
    candidates: formatMachineCandidates(machines),
  });
}

function extractRefreshResponse(
  responses: LocalSessionControlResponse[]
): z.infer<typeof MachineAcpCapabilitiesRefreshResponseSchema> {
  const target = responses.find(
    (response) => response.type === 'machine/acp-capabilities-refresh_response'
  );
  if (!target) {
    throw new Error('Missing machine/acp-capabilities-refresh_response from local CLI daemon.');
  }
  return MachineAcpCapabilitiesRefreshResponseSchema.parse(target);
}

function collectListOption(value: string, previous: string[] = []): string[] {
  previous.push(value);
  return previous;
}

function buildTitleGenerationConfig(options: {
  titleConfigOption?: string[];
}): TitleGenerationConfig | undefined {
  const configOptionValues = parseEnvAssignments(options.titleConfigOption);
  if (Object.keys(configOptionValues).length === 0) {
    return undefined;
  }
  return { configOptionValues };
}

type AgentConfigInput<C extends TerminalCommand['command']> = Omit<
  Extract<TerminalCommand, { command: C }>,
  'command'
>;

/**
 * The bodies of the `agent-config` writes. Each reads and writes only the
 * workspace replica it is given, so the hosted command line runs it on its
 * own replica and a local daemon on its (`runWorkspaceCommand`).
 */
export async function showAgentConfig(
  { workspace, manager }: WorkspaceCommandContext,
  input: AgentConfigInput<'agent-config-show'>
) {
  const config = resolveAgentConfigSelector(
    await listAgentConfigsForWorkspace(manager, workspace.id as WorkspaceId),
    { selector: input.selector }
  );
  return {
    workspaceId: workspace.id,
    agentConfig: toAgentConfigOutput(config, input.showSecrets === true),
  };
}

export async function resolveAgentConfigTarget(
  { auth, workspace, manager }: WorkspaceCommandContext,
  input: AgentConfigInput<'agent-config-target'>
) {
  const config = resolveAgentConfigSelector(
    await listAgentConfigsForWorkspace(manager, workspace.id as WorkspaceId),
    { selector: input.selector }
  );
  const machine = resolveMachineOrThrow(await listMachineMetasForWorkspace(manager), {
    selector: input.machine,
    authMachineId: auth.machineId,
  });
  const onlineMachineIds = await manager.getOnlineMachineIds();
  return {
    workspaceId: workspace.id,
    config: { id: config.id, name: config.name, agentType: config.agentType },
    machine,
    // Null when presence is unknown: the refresh then fails on its own if the machine is down.
    online: onlineMachineIds ? onlineMachineIds.has(machine.id) : null,
  };
}

export async function createAgentConfig(
  { auth, workspace, manager }: WorkspaceCommandContext,
  input: AgentConfigInput<'agent-config-create'>
) {
  const machine = resolveMachineOrThrow(await listMachineMetasForWorkspace(manager), {
    selector: input.machine,
    authMachineId: auth.machineId,
  });
  const config: AgentConfigMeta = {
    id: uuidV4() as AgentConfigId,
    machineId: machine.id,
    name: input.name ?? input.agentType,
    description: input.description,
    cliType: inferAgentConfigCliType(input.agentType),
    agentType: input.agentType,
    env: input.env,
    ...(input.prompt ? { prompt: input.prompt } : {}),
    ...(input.titleGeneration ? { titleGeneration: input.titleGeneration } : {}),
  };
  await upsertMachineAgentConfig(manager.repo, workspace.id as WorkspaceId, config);
  await ensureWorkspaceMetaSynced(manager, `agent-config.create:${config.id}`);
  return {
    workspaceId: workspace.id,
    agentConfigId: config.id,
    changedFields: [
      'name',
      'agentType',
      'machineId',
      'env',
      ...(config.description !== undefined ? ['description'] : []),
      ...(config.prompt !== undefined ? ['prompt'] : []),
      ...(config.titleGeneration !== undefined ? ['titleGeneration'] : []),
    ],
  };
}

export async function updateAgentConfig(
  { workspace, manager }: WorkspaceCommandContext,
  input: AgentConfigInput<'agent-config-update'>
) {
  const current = resolveAgentConfigSelector(
    await listAgentConfigsForWorkspace(manager, workspace.id as WorkspaceId),
    { selector: input.selector }
  );
  const nextConfig: AgentConfigMeta = {
    ...current,
    name: input.name ?? current.name,
    description: input.description ? input.description.value : current.description,
    env: input.env ? applyEnvUpdates(current.env, {}, input.env.set, input.env.unset) : current.env,
    prompt: input.prompt ? input.prompt.value : current.prompt,
    titleGeneration: input.titleGeneration ? input.titleGeneration.value : current.titleGeneration,
  };
  await upsertMachineAgentConfig(manager.repo, workspace.id as WorkspaceId, nextConfig);
  await ensureWorkspaceMetaSynced(manager, `agent-config.update:${current.id}`);
  return {
    workspaceId: workspace.id,
    agentConfigId: nextConfig.id,
    changedFields: [
      ...(input.name !== undefined ? ['name'] : []),
      ...(input.description ? ['description'] : []),
      ...(input.env ? ['env'] : []),
      ...(input.prompt ? ['prompt'] : []),
      ...(input.titleGeneration ? ['titleGeneration'] : []),
    ],
  };
}

export async function deleteAgentConfig(
  { workspace, manager }: WorkspaceCommandContext,
  input: AgentConfigInput<'agent-config-delete'>
) {
  const config = resolveAgentConfigSelector(
    await listAgentConfigsForWorkspace(manager, workspace.id as WorkspaceId),
    { selector: input.selector }
  );
  await deleteMachineAgentConfig(manager.repo, workspace.id as WorkspaceId, config);
  await ensureWorkspaceMetaSynced(manager, `agent-config.delete:${config.id}`);
  return { workspaceId: workspace.id, agentConfigId: config.id };
}

/** The config a command names: its argument, else `LODY_AGENT_CONFIG_ID`. */
const configSelector = (selector: string | undefined) =>
  normalizeCliValue(selector) ?? normalizeCliValue(process.env.LODY_AGENT_CONFIG_ID);

const agentConfigListCommand = discoveryListCommand('agent_config');

const agentConfigShowCommand = new Command('show')
  .description('Show an agent config; environment values are hidden by default')
  .option('--show-secrets', 'Include raw environment values in output; may expose credentials')
  .option('--workspace <selector>', 'Target workspace id, slug, or name')
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .argument('[idOrName]', 'Agent config id or name; falls back to LODY_AGENT_CONFIG_ID')
  .action(async (selector: string | undefined, options: AgentConfigShowOptions) => {
    await runOneShotCommand('agent-config', options, async () => {
      const input = { selector: configSelector(selector), showSecrets: options.showSecrets };
      const result = await runWorkspaceCommand(
        'agent-config',
        options.workspace,
        { command: 'agent-config-show', ...input },
        (context) => showAgentConfig(context, input)
      );
      if (options.json) {
        printJson({ ok: true, ...result });
        return;
      }
      printHumanAgentConfig(result.agentConfig);
    });
  });

const agentConfigRefreshCapabilitiesCommand = new Command('refresh-capabilities')
  .description('Refresh ACP capabilities for an agent config on a machine')
  .option('--workspace <selector>', 'Target workspace id, slug, or name')
  .option('--machine <idOrName>', 'Machine id or name; defaults to the current machine')
  .option('--json', 'Print JSON output')
  .option('--jsonl', 'Print JSON Lines output')
  .option('--debug', 'Enable debug output')
  .argument('[idOrName]', 'Agent config id or name; falls back to LODY_AGENT_CONFIG_ID')
  .action(async (selector: string | undefined, options: AgentConfigRefreshOptions) => {
    await runOneShotCommand('agent-config', options, async () => {
      const outputMode = resolveStructuredOutputMode(options);
      const input = {
        selector: configSelector(selector),
        machine:
          normalizeCliValue(options.machine) ?? normalizeCliValue(process.env.LODY_MACHINE_ID),
      };
      const local = getCliPlatformKind() === 'local';
      const localTarget = local ? await resolveTerminalToolTarget(options.workspace) : undefined;
      const target = await runWorkspaceCommand(
        'agent-config',
        options.workspace,
        { command: 'agent-config-target', ...input },
        (context) => resolveAgentConfigTarget(context, input)
      );
      const { config, machine } = target;
      const currentMachineId =
        localTarget?.machineId ?? getAuthContextOrThrow('agent-config').machineId;
      if (target.online === false)
        throw new Error(`Machine ${machine.id} appears offline. Run \`lody start\` there first.`);

      // This command exists to pick up changes Lody cannot see in the launch
      // inputs, so it must start the agent instead of accepting the stored
      // entry. Negotiated because the CLI binary can be newer than the
      // running daemon, which would reject an unknown field outright.
      let response: z.infer<typeof MachineAcpCapabilitiesRefreshResponseSchema>;
      if (machine.id === currentMachineId) {
        response = extractRefreshResponse(
          await dispatchLocalControl({
            type: 'machine/acp-capabilities-refresh',
            machineId: machine.id,
            workspaceId: target.workspaceId as WorkspaceId,
            configId: config.id as AgentConfigId,
            ...negotiatedAcpCapabilitiesRefreshForce(machine, true),
          })
        );
      } else if (localTarget) {
        // Another machine of the LAN refreshes through the daemon's connection to it.
        response = MachineAcpCapabilitiesRefreshResponseSchema.parse(
          await runTerminalCommand(localTarget, {
            command: 'agent-config-refresh',
            machineId: machine.id,
            configId: config.id,
          })
        );
      } else {
        throw new Error(
          `Remote machine capability refresh is not implemented in CLI yet. Current machine: ${currentMachineId}`
        );
      }

      if (!response.success) {
        throw new Error(
          response.error ??
            `Failed to refresh capabilities for ${config.name} on machine ${machine.id}.`
        );
      }

      if (outputMode === 'json') {
        printJson({
          ok: true,
          workspaceId: target.workspaceId,
          machineId: machine.id,
          agentConfigId: config.id,
          response: toRefreshCapabilitiesOutput(response),
        });
        return;
      }

      if (outputMode === 'jsonl') {
        printJson({
          event: 'response',
          workspaceId: target.workspaceId,
          agentConfigId: config.id,
          ...toRefreshCapabilitiesOutput(response),
        });
        return;
      }

      printHumanRefreshSummary({ config, machine, response });
    });
  });

const agentConfigCreateCommand = new Command('create')
  .description('Create a new agent config')
  .requiredOption('--agent-type <type>', 'Agent type identifier')
  .option('--workspace <selector>', 'Target workspace id, slug, or name')
  .option('--machine <idOrName>', 'Machine id or name; defaults to the current machine')
  .option('--name <name>', 'Agent config name')
  .option('--description <text>', 'Agent config description')
  .option(
    '--env <keyValue>',
    'Environment variable in KEY=VALUE form; repeatable',
    collectListOption,
    []
  )
  .option('--env-file <path>', 'Read environment variables from a file')
  .option('--prompt <text>', 'Default prompt prefix')
  .option('--prompt-file <path|->', 'Read default prompt prefix from file or stdin')
  .option(
    '--title-config-option <keyValue>',
    'Title generation config option in KEY=VALUE form; repeatable',
    collectListOption,
    []
  )
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .action(async (options: AgentConfigCreateOptions) => {
    await runOneShotCommand('agent-config', options, async () => {
      const agentType = normalizeCliValue(options.agentType);
      if (!agentType) {
        throw new Error('Missing --agent-type.');
      }
      const fileEnv = options.envFile
        ? parseEnvFileText(await fs.readFile(options.envFile, 'utf8'))
        : {};
      const prompt = await readOptionalTextInput({
        text: options.prompt,
        filePath: options.promptFile,
      });
      const input: AgentConfigInput<'agent-config-create'> = {
        agentType,
        machine:
          normalizeCliValue(options.machine) ?? normalizeCliValue(process.env.LODY_MACHINE_ID),
        name: normalizeCliValue(options.name),
        description: normalizeCliValue(options.description),
        env: applyEnvUpdates({}, fileEnv, parseEnvAssignments(options.env)),
        prompt,
        titleGeneration: buildTitleGenerationConfig(options),
      };
      const result = await runWorkspaceCommand(
        'agent-config',
        options.workspace,
        { command: 'agent-config-create', ...input },
        (context) => createAgentConfig(context, input)
      );
      if (options.json) {
        printJson({ ok: true, ...result });
        return;
      }
      console.log(result.agentConfigId);
    });
  });

const agentConfigUpdateCommand = new Command('update')
  .description('Update an existing agent config')
  .option('--workspace <selector>', 'Target workspace id, slug, or name')
  .option('--name <name>', 'Updated agent config name')
  .option('--description <text>', 'Updated agent config description; pass empty to clear')
  .option(
    '--env <keyValue>',
    'Environment variable in KEY=VALUE form; repeatable',
    collectListOption,
    []
  )
  .option('--env-file <path>', 'Read environment variables from a file')
  .option('--unset-env <key>', 'Remove an environment variable; repeatable', collectListOption, [])
  .option('--prompt <text>', 'Updated default prompt prefix; pass empty to clear')
  .option('--prompt-file <path|->', 'Read default prompt prefix from file or stdin')
  .option(
    '--title-config-option <keyValue>',
    'Title generation config option in KEY=VALUE form; repeatable',
    collectListOption,
    []
  )
  .option('--clear-title-generation', 'Remove title generation settings')
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .argument('[idOrName]', 'Agent config id or name; falls back to LODY_AGENT_CONFIG_ID')
  .action(async (selector: string | undefined, options: AgentConfigUpdateOptions) => {
    await runOneShotCommand('agent-config', options, async () => {
      const requestedEnvUpdate =
        !!options.envFile || (options.env?.length ?? 0) > 0 || (options.unsetEnv?.length ?? 0) > 0;
      const requestedPromptUpdate =
        options.prompt !== undefined || options.promptFile !== undefined;
      const requestedNameUpdate = options.name !== undefined;
      const requestedDescriptionUpdate = options.description !== undefined;
      const requestedTitleUpdate =
        (options.titleConfigOption?.length ?? 0) > 0 || !!options.clearTitleGeneration;

      if (
        !requestedEnvUpdate &&
        !requestedPromptUpdate &&
        !requestedNameUpdate &&
        !requestedDescriptionUpdate &&
        !requestedTitleUpdate
      ) {
        throw new Error('No updates specified.');
      }
      const name = requestedNameUpdate ? normalizeCliValue(options.name) : undefined;
      if (requestedNameUpdate && !name) {
        throw new Error('Updated name must be non-empty.');
      }

      const fileEnv = options.envFile
        ? parseEnvFileText(await fs.readFile(options.envFile, 'utf8'))
        : {};
      const input: AgentConfigInput<'agent-config-update'> = {
        selector: configSelector(selector),
        name,
        ...(requestedDescriptionUpdate
          ? { description: { value: normalizeCliValue(options.description) } }
          : {}),
        ...(requestedEnvUpdate
          ? {
              env: {
                set: { ...fileEnv, ...parseEnvAssignments(options.env) },
                unset: parseUnsetEnvKeys(options.unsetEnv),
              },
            }
          : {}),
        ...(requestedPromptUpdate
          ? {
              prompt: {
                value: await readOptionalTextInput({
                  text: options.prompt,
                  filePath: options.promptFile,
                }),
              },
            }
          : {}),
        ...(requestedTitleUpdate
          ? {
              titleGeneration: {
                value: options.clearTitleGeneration
                  ? undefined
                  : buildTitleGenerationConfig(options),
              },
            }
          : {}),
      };
      const result = await runWorkspaceCommand(
        'agent-config',
        options.workspace,
        { command: 'agent-config-update', ...input },
        (context) => updateAgentConfig(context, input)
      );
      if (options.json) {
        printJson({ ok: true, ...result });
        return;
      }
      console.log(`Updated ${result.agentConfigId}`);
    });
  });

const agentConfigDeleteCommand = new Command('delete')
  .description('Delete an agent config')
  .option('--workspace <selector>', 'Target workspace id, slug, or name')
  .option('--json', 'Print JSON output')
  .option('--debug', 'Enable debug output')
  .argument('[idOrName]', 'Agent config id or name; falls back to LODY_AGENT_CONFIG_ID')
  .action(async (selector: string | undefined, options: AgentConfigCommandOptions) => {
    await runOneShotCommand('agent-config', options, async () => {
      const input = { selector: configSelector(selector) };
      const result = await runWorkspaceCommand(
        'agent-config',
        options.workspace,
        { command: 'agent-config-delete', ...input },
        (context) => deleteAgentConfig(context, input)
      );
      if (options.json) {
        printJson({ ok: true, ...result });
        return;
      }
      console.log(`Deleted ${result.agentConfigId}`);
    });
  });

export const agentConfigCommand = new Command('agent-config')
  .description('Manage agent configs')
  .addCommand(agentConfigListCommand)
  .addCommand(discoveryGetCommand('agent_config'))
  .addCommand(agentConfigShowCommand)
  .addCommand(agentConfigRefreshCapabilitiesCommand)
  .addCommand(agentConfigCreateCommand)
  .addCommand(agentConfigUpdateCommand)
  .addCommand(agentConfigDeleteCommand);
