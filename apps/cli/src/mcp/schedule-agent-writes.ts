import { z } from 'zod';
import {
  resolveScheduleProposalTarget,
  ScheduleProposalDestinationSchema,
  ScheduleProposalRuleSchema,
  ScheduleProposalTargetSchema,
  ScheduleDefinitionSchema,
  scheduleProposalRuleToTrigger,
  type CatalogAgentRole,
  type ProposalConversation,
  type ProposalTargetAgent,
  type ProposalTargetProblem,
  type ScheduleCommand,
  type ScheduleDefinition,
  type ScheduleDocument,
  type ScheduleProposalMeta,
} from '@lody/shared';

type ScheduleDraft = Extract<ScheduleCommand, { action: 'create' }>['draft'];

const id = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[a-zA-Z0-9_-]+$/);
const fields = {
  title: z.string().trim().min(1).max(200),
  prompt: z.string().min(1).max(32768),
  rule: ScheduleProposalRuleSchema,
  destination: ScheduleProposalDestinationSchema,
  target: ScheduleProposalTargetSchema,
};

export const ScheduleCreateToolInputSchema = z
  .object({
    requestId: id,
    boardId: ScheduleDefinitionSchema.shape.boardId,
    title: fields.title,
    prompt: fields.prompt,
    rule: fields.rule,
    destination: fields.destination.optional(),
    target: fields.target.optional(),
    mcpServerIds: ScheduleDefinitionSchema.shape.mcpServerIds,
  })
  .strict();
export type ScheduleCreateToolInput = z.infer<typeof ScheduleCreateToolInputSchema>;

export const ScheduleUpdateToolInputSchema = z
  .object({
    scheduleId: id,
    requestId: id,
    boardId: ScheduleDefinitionSchema.shape.boardId,
    title: fields.title.optional(),
    prompt: fields.prompt.optional(),
    rule: fields.rule.optional(),
    destination: fields.destination.optional(),
    target: fields.target.optional(),
    // null clears the saved choice so runs follow workspace defaults again.
    mcpServerIds: ScheduleDefinitionSchema.shape.mcpServerIds.nullable(),
  })
  .strict();
export type ScheduleUpdateToolInput = z.infer<typeof ScheduleUpdateToolInputSchema>;

export const ScheduleResumeToolInputSchema = z.object({ scheduleId: id, requestId: id }).strict();

/** What a draft is resolved against: the calling conversation and the catalog it can see. */
export type ScheduleDraftContext = {
  now: number;
  conversation: ProposalConversation;
  agents: readonly ProposalTargetAgent[];
  roles: readonly CatalogAgentRole[];
  /** The clock of the machine a schedule runs on; a rule without a zone uses it. */
  machineTimeZone: (machineId: string) => string | undefined;
};

const PROBLEMS: Record<ProposalTargetProblem, string> = {
  role_not_found: 'No Agent Role with that id is readable here.',
  agent_not_found: 'No Agent config with that id is readable here.',
  machine_mismatch: 'The named machine is not the one that Agent runs on.',
  no_agent: 'This conversation has no Agent config; name one in target.',
  role_with_chat:
    'A schedule that sends into an existing chat follows that chat’s Agent; an Agent Role cannot be named with it.',
};

const resolveTarget = (
  meta: Pick<ScheduleProposalMeta, 'target' | 'destination' | 'boardId'>,
  context: ScheduleDraftContext
) => {
  const resolved = resolveScheduleProposalTarget({
    meta,
    conversation: context.conversation,
    agents: context.agents,
    roles: context.roles,
  });
  if (!resolved.ok) throw new Error(PROBLEMS[resolved.problem]);
  return resolved.target;
};

/**
 * The moment a draft is built at. An interval rule anchors on it, so a retry
 * of a write that already landed rebuilds at that write's anchor and matches
 * it exactly; anything else still conflicts on the same request id.
 */
export function scheduleDraftNow(
  now: number,
  stored: ScheduleDocument | null | undefined,
  requestId: string
): number {
  if (!stored?.timeline.some((entry) => entry.id === requestId)) return now;
  const { trigger } = stored.definition;
  return trigger.kind === 'interval' ? Date.parse(trigger.anchorAt) : now;
}

/** The same defaults a confirmed proposal card creates with. */
export function buildScheduleCreateDraft(
  input: ScheduleCreateToolInput,
  context: ScheduleDraftContext
): ScheduleDraft {
  const target = resolveTarget(input, context);
  const machineId = target.agentConfig.machineId;
  return {
    title: input.title,
    boardId: input.boardId,
    prompt: input.prompt,
    trigger: scheduleProposalRuleToTrigger(
      input.rule,
      context.now,
      context.machineTimeZone(machineId)
    ),
    machineId,
    agent: target.agent,
    ...(input.mcpServerIds !== undefined ? { mcpServerIds: input.mcpServerIds } : {}),
    ...(target.agentRole ? { agentRole: target.agentRole } : {}),
    ...(target.project ? { project: target.project } : {}),
    destination: target.destination,
    misfirePolicy: { kind: 'run_once' },
    overlapPolicy: 'queue_one',
    retryPolicy: { dispatchMaxAttempts: 5, dispatchMaxAgeMs: 86_400_000 },
  };
}

const proposalDestination = (
  destination: ScheduleDefinition['destination']
): ScheduleProposalMeta['destination'] =>
  destination.kind === 'own_session' ? { kind: 'own_session' } : destination;

/**
 * An existing Schedule with the named fields replaced. `target` means what it
 * means to a proposal, defaults included; without it the Agent, its Role
 * reference, machine and project stay. A `target` replaces the reference too:
 * one that names no Role leaves the Schedule on the Agent it resolves to. A
 * chat destination never keeps a project, and a Schedule that already keeps its
 * own chat keeps continuing that chat.
 */
export function buildScheduleEditDraft(
  input: ScheduleUpdateToolInput,
  current: ScheduleDocument,
  context: ScheduleDraftContext
): ScheduleDraft {
  const { definition } = current;
  const destinationMeta = input.destination ?? proposalDestination(definition.destination);
  const target = input.target
    ? resolveTarget({ target: input.target, destination: destinationMeta }, context)
    : undefined;
  const machineId = target?.agentConfig.machineId ?? definition.machineId;
  const destination: ScheduleDefinition['destination'] =
    destinationMeta?.kind === 'own_session'
      ? {
          kind: 'own_session',
          epoch: definition.destination.kind === 'own_session' ? definition.destination.epoch : 0,
        }
      : (destinationMeta ?? { kind: 'new_session' });
  const project =
    destination.kind !== 'new_session'
      ? undefined
      : target
        ? (target.project ?? undefined)
        : definition.project;
  return {
    title: input.title ?? definition.title,
    boardId: input.boardId ?? definition.boardId,
    prompt: input.prompt ?? current.prompt,
    trigger: input.rule
      ? scheduleProposalRuleToTrigger(input.rule, context.now, context.machineTimeZone(machineId))
      : definition.trigger,
    machineId,
    agent: target?.agent ?? definition.agent,
    mcpServerIds:
      input.mcpServerIds === null ? undefined : (input.mcpServerIds ?? definition.mcpServerIds),
    ...(target
      ? target.agentRole
        ? { agentRole: target.agentRole }
        : {}
      : definition.agentRole
        ? { agentRole: definition.agentRole }
        : {}),
    ...(project ? { project } : {}),
    destination,
    misfirePolicy: definition.misfirePolicy,
    overlapPolicy: definition.overlapPolicy,
    retryPolicy: definition.retryPolicy,
  };
}
