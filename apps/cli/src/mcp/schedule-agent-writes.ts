import { z } from 'zod';
import {
  resolveScheduleProposalTarget,
  ScheduleProposalDestinationSchema,
  ScheduleProposalRuleSchema,
  ScheduleProposalTargetSchema,
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
    title: fields.title,
    prompt: fields.prompt,
    rule: fields.rule,
    destination: fields.destination.optional(),
    target: fields.target.optional(),
  })
  .strict();
export type ScheduleCreateToolInput = z.infer<typeof ScheduleCreateToolInputSchema>;

export const ScheduleUpdateToolInputSchema = z
  .object({
    scheduleId: id,
    requestId: id,
    title: fields.title.optional(),
    prompt: fields.prompt.optional(),
    rule: fields.rule.optional(),
    destination: fields.destination.optional(),
    target: fields.target.optional(),
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
};

const resolveTarget = (
  meta: Pick<ScheduleProposalMeta, 'target' | 'destination'>,
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
    prompt: input.prompt,
    trigger: scheduleProposalRuleToTrigger(
      input.rule,
      context.now,
      context.machineTimeZone(machineId)
    ),
    machineId,
    agent: target.agent,
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
 * means to a proposal, defaults included; without it the Agent, machine and
 * project stay. A chat destination never keeps a project, and a Schedule that
 * already keeps its own chat keeps continuing that chat.
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
    prompt: input.prompt ?? current.prompt,
    trigger: input.rule
      ? scheduleProposalRuleToTrigger(input.rule, context.now, context.machineTimeZone(machineId))
      : definition.trigger,
    machineId,
    agent: target?.agent ?? definition.agent,
    ...(project ? { project } : {}),
    destination,
    misfirePolicy: definition.misfirePolicy,
    overlapPolicy: definition.overlapPolicy,
    retryPolicy: definition.retryPolicy,
  };
}
