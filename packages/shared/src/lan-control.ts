import { z } from 'zod';
import {
  LanMachineBuildSchema,
  LanMachineUpdateSchema,
  LanReleaseSummarySchema,
} from './lan-release';

/**
 * What the members of a LAN see of each other's machines and ask of them.
 * A machine publishes facts about itself in its machine metadata of each
 * LAN's workspace; a request reaches it as a project-control request, which
 * the agent service of the asking machine forwards through the hub.
 */
const NAME_MAX = 128;
const VERSION_MAX = 64;

/**
 * - `current`: the installed runtime is the one this build runs agents with.
 * - `outdated`: an earlier one is installed and still used.
 * - `missing`: none is installed; the first session downloads it.
 * - `updating`: the machine is downloading the one it should have.
 * - `unsupported`: this machine cannot run the runtime.
 */
export const LAN_AGENT_RUNTIME_STATES = [
  'current',
  'outdated',
  'missing',
  'updating',
  'unsupported',
] as const;
export type LanAgentRuntimeState = (typeof LAN_AGENT_RUNTIME_STATES)[number];

/** The runtime of one kind of agent a machine has providers for. */
export const LanAgentRuntimeSchema = z
  .object({
    agentType: z.string().min(1).max(VERSION_MAX),
    name: z.string().min(1).max(NAME_MAX),
    /** The version installed. Absent while none is. */
    version: z.string().min(1).max(VERSION_MAX).optional(),
    /** The version the agent service of the machine runs this agent with. */
    target: z.string().min(1).max(VERSION_MAX).optional(),
    state: z.enum(LAN_AGENT_RUNTIME_STATES),
  })
  .strict();
export type LanAgentRuntime = z.infer<typeof LanAgentRuntimeSchema>;

export const LanAgentRuntimesSchema = z.array(LanAgentRuntimeSchema).max(16);

/** Tolerant of what a later build publishes: an entry it cannot read is left out. */
export function parseLanAgentRuntimes(value: unknown): LanAgentRuntime[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = LanAgentRuntimeSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

export function sameLanAgentRuntimes(
  left: readonly LanAgentRuntime[],
  right: readonly LanAgentRuntime[]
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** How long a short name a member gives a machine may be. */
export const LAN_MACHINE_ALIAS_MAX = 32;

/**
 * A short name for a machine as it is written, or `null` for none. Anything
 * that is not text, or holds nothing but spaces, is none.
 */
export function normalizeLanMachineAlias(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const alias = value.replace(/\s+/g, ' ').trim();
  return alias ? alias.slice(0, LAN_MACHINE_ALIAS_MAX) : null;
}

/** The colors a member may give a machine's name, by name so each theme picks its shade. */
export const LAN_MACHINE_COLORS = [
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
  'pink',
] as const;
export type LanMachineColor = (typeof LAN_MACHINE_COLORS)[number];

/** A machine's color as it is written, or `null` for none or one this build does not know. */
export function normalizeLanMachineColor(value: unknown): LanMachineColor | null {
  return (LAN_MACHINE_COLORS as readonly unknown[]).includes(value)
    ? (value as LanMachineColor)
    : null;
}

export const LanMachineSchema = z
  .object({
    machineId: z.string().min(1),
    name: z.string(),
    /**
     * The short name a member gave the machine, shown before its name and
     * used by alerts where room is short. `null` while it has none.
     */
    alias: z.string().max(LAN_MACHINE_ALIAS_MAX).nullable(),
    /** The color a member gave the machine's name; absent from builds before it. */
    color: z.enum(LAN_MACHINE_COLORS).nullish(),
    os: z.string().nullable(),
    /** The machine that answers. */
    self: z.boolean(),
    /** `null` while the hub has not said who is there. */
    online: z.boolean().nullable(),
    /** The LANs of the answering machine this machine is a member of. */
    lans: z.array(z.object({ workspaceId: z.string().min(1), name: z.string() }).strict()),
    /** The version of its agent service, as it registered. */
    version: z.string().nullable(),
    /** `null` for a build that says nothing about itself, which predates this. */
    build: LanMachineBuildSchema.nullable(),
    update: LanMachineUpdateSchema.nullable(),
    /** Whether the machine understands what members ask of each other. */
    controllable: z.boolean(),
    agents: z.array(LanAgentRuntimeSchema),
    /**
     * What it does for the hub: hosts it, keeps the standby copy, or could
     * do either. `null` for a machine that could host no hub; absent from
     * builds before it.
     */
    hub: z
      .object({
        part: z.enum(['hub', 'standby', 'candidate']),
        term: z.number().int().nonnegative().nullable(),
        /** When its copy of the hub was taken (ISO 8601). */
        snapshotAt: z.string().nullable(),
        rttMs: z.number().nullable(),
      })
      .strict()
      .nullish(),
  })
  .strict();
export type LanMachine = z.infer<typeof LanMachineSchema>;

export const LanMachinesSchema = z
  .object({
    machines: z.array(LanMachineSchema),
    /**
     * The newest build of the release the answering machine follows, which a
     * machine of the same release is measured against. `null` when it follows
     * none or the release could not be read.
     */
    newest: LanReleaseSummarySchema.nullable(),
  })
  .strict();
export type LanMachines = z.infer<typeof LanMachinesSchema>;

export const LAN_MEMBER_CONTROL_TYPES = [
  'lan/update-machine',
  'lan/install-agent',
  'hosted-config/preview',
  'hosted-config/import',
] as const;
export type LanMemberControlType = (typeof LAN_MEMBER_CONTROL_TYPES)[number];

/** Whether a request is one the members of a LAN put to each other. */
export function isLanMemberControlType(type: string): type is LanMemberControlType {
  return (LAN_MEMBER_CONTROL_TYPES as readonly string[]).includes(type);
}

/**
 * - `started`: the machine works on it and reports where it stands in its
 *   metadata; it answers before it is done, because being done restarts it.
 * - `current`: there is nothing later to install.
 */
export const LanMachineUpdateResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('started'), version: z.string().min(1) }).strict(),
  z.object({ outcome: z.literal('current'), version: z.string().min(1) }).strict(),
]);
export type LanMachineUpdateResult = z.infer<typeof LanMachineUpdateResultSchema>;

export const LanAgentInstallResultSchema = z
  .object({ agentType: z.string().min(1), outcome: z.enum(['started', 'current']) })
  .strict();
export type LanAgentInstallResult = z.infer<typeof LanAgentInstallResultSchema>;

/**
 * Why a machine refuses what a member asks, as `data.reason` of the refusal:
 * - `desktop`: a desktop application carries the agent service and updates it.
 * - `manual`: nothing would start the agent service again, or nothing
 *   installed it that the service could repeat.
 * - `busy`: it is already working on one.
 * - `release`: the release it follows could not be read.
 * - `unknown_agent`: it has no runtime of that kind to install.
 */
export const LAN_CONTROL_REFUSALS = [
  'desktop',
  'manual',
  'busy',
  'release',
  'unknown_agent',
] as const;
export type LanControlRefusal = (typeof LAN_CONTROL_REFUSALS)[number];

export function readLanControlRefusal(data: unknown): LanControlRefusal | null {
  const reason =
    typeof data === 'object' && data !== null ? (data as { reason?: unknown }).reason : null;
  return LAN_CONTROL_REFUSALS.find((candidate) => candidate === reason) ?? null;
}
