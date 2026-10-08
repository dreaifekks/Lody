import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  ScheduleProposalDestinationSchema,
  ScheduleProposalRuleSchema,
  ScheduleProposalTargetSchema,
  type ScheduleCommand,
} from '@lody/shared';
import {
  ScheduleCreateToolInputSchema,
  ScheduleResumeToolInputSchema,
  ScheduleUpdateToolInputSchema,
  type ScheduleCreateToolInput,
  type ScheduleUpdateToolInput,
} from './schedule-agent-writes';
import type { createSessionToolRegistrar } from './session-tool-router';

export type ScheduleAgentWrite =
  | { action: 'create'; input: ScheduleCreateToolInput }
  | { action: 'update'; input: ScheduleUpdateToolInput }
  | { action: 'resume'; input: z.infer<typeof ScheduleResumeToolInputSchema> };

type Dependencies = {
  execute: (command: ScheduleCommand) => Promise<unknown>;
  /** Runs in the daemon: it reads the invoking Session's permission tier from its active Turn. */
  write: (request: ScheduleAgentWrite) => Promise<unknown>;
};
/** How the content of a schedule is described, for propose and create alike. */
const DRAFT_GUIDE = [
  'Never call this while the description is still vague: you must know (1) what the agent',
  'should do on each run, written as the full prompt it will receive with no reference to this',
  'conversation, (2) when — one of the named rules below, or manual for run-on-demand, and (3)',
  'optionally where the result goes. If any of these is missing or ambiguous, ask the user a',
  'short question instead of guessing. Rule shapes: manual; minutes {every}; hours {every};',
  'daily / weekdays {hour, minute}; weekly {weekdays: 0-6 with 0=Sunday, hour, minute}; monthly',
  '{days: 1-31, hour, minute}; once {at: RFC3339}. Times are in the user’s own time zone unless',
  'they named one. The Agent, permission mode, machine and project default to this',
  'conversation’s; set `target` only when the user explicitly named a different Agent Role,',
  'Agent, machine or project (resolve names to ids with lody_session_create_options).',
  'Destination: new_session (a fresh chat per run, default), own_session (one chat this task',
  'keeps continuing), or existing_session {sessionId}. Reuse requestId when retrying.',
].join(' ');

const id = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[a-zA-Z0-9_-]+$/);
export function registerScheduleTools(
  server: McpServer,
  registerSessionTool: ReturnType<typeof createSessionToolRegistrar>,
  deps: Dependencies
): void {
  const respond = async (run: () => Promise<unknown>) => {
    try {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(await run()) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: error instanceof Error ? error.message : 'Schedule request failed',
            }),
          },
        ],
      };
    }
  };
  const call = (command: ScheduleCommand) => respond(() => deps.execute(command));
  const write = (request: ScheduleAgentWrite) => respond(() => deps.write(request));
  const ceiling = [
    'The schedule may run with at most the permissions this conversation runs with now (its',
    'permission mode), and so may a chat it sends into; anything higher is refused, and then',
    'lody_schedule_propose lets the user confirm it instead. A permission option the Agent has',
    'beside its mode (such as permission_mode) must be set, by this conversation or by the',
    'Agent Role in target, or the schedule cannot be ranked and is refused. Pi schedules are',
    'exempt.',
  ].join(' ');
  registerSessionTool(
    'lody_schedule_create',
    {
      title: 'Create a scheduled task',
      description: [
        'Create and enable a scheduled task the user asked for; it runs without a confirmation',
        'card. The user is notified in this conversation and can review it in Schedules.',
        ceiling,
        DRAFT_GUIDE,
      ].join(' '),
      inputSchema: ScheduleCreateToolInputSchema,
    },
    (input) => write({ action: 'create', input })
  );
  registerSessionTool(
    'lody_schedule_update',
    {
      title: 'Change a scheduled task',
      description: [
        'Change the title, prompt, rule, destination or target of a Schedule the user owns.',
        'Omitted fields stay as they are; `target` is resolved as in lody_schedule_propose, with',
        'this conversation’s Agent and permission mode as defaults, and without it the Agent,',
        'machine and project stay. A schedule that already runs with more permissions than this',
        'conversation can only be changed by the user.',
        ceiling,
        'Reuse requestId when retrying.',
      ].join(' '),
      inputSchema: ScheduleUpdateToolInputSchema,
    },
    (input) => write({ action: 'update', input })
  );
  registerSessionTool(
    'lody_schedule_resume',
    {
      title: 'Resume a scheduled task',
      description: [
        'Resume a paused Schedule the user owns. Only a schedule within this conversation’s',
        'permissions can be resumed by you.',
        'Reuse requestId when retrying.',
      ].join(' '),
      inputSchema: ScheduleResumeToolInputSchema,
    },
    (input) => write({ action: 'resume', input })
  );
  server.registerTool(
    'lody_schedule_list',
    {
      description:
        'List scheduled-task summaries in the current workspace. Use get for details; execution belongs to the owner machine.',
      inputSchema: z
        .object({
          query: z.string().max(200).optional(),
          limit: z.number().int().min(1).max(100).default(30),
          offset: z.number().int().min(0).max(100_000).optional(),
        })
        .strict(),
    },
    (args) => call({ action: 'list', ...args })
  );
  server.registerTool(
    'lody_schedule_get',
    {
      description:
        'Read a Schedule, its prompt, recent configuration activity and next five times. Ordinary Sessions own execution results.',
      inputSchema: z.object({ scheduleId: id }).strict(),
    },
    (args) => call({ action: 'show', ...args })
  );
  server.registerTool(
    'lody_schedule_pause',
    {
      description:
        'Pause a Schedule owned by the authenticated user. Already accepted Sessions continue. Reuse requestId when retrying. lody_schedule_resume starts it again.',
      inputSchema: z.object({ scheduleId: id, requestId: id }).strict(),
    },
    (args) => call({ action: 'pause', ...args })
  );
  server.registerTool(
    'lody_schedule_propose',
    {
      description: [
        'Propose a scheduled task from what the user described. This writes a card into the',
        'current chat with a Create button; the user creates the schedule by pressing it — do not',
        'promise it is scheduled until they do. Use it when the user wants to confirm first, or',
        'when lody_schedule_create refuses the permissions the schedule would run with.',
        DRAFT_GUIDE,
      ].join(' '),
      inputSchema: z
        .object({
          requestId: id,
          title: z.string().trim().min(1).max(200),
          prompt: z.string().min(1).max(32768),
          rule: ScheduleProposalRuleSchema,
          destination: ScheduleProposalDestinationSchema.optional(),
          target: ScheduleProposalTargetSchema.optional(),
        })
        .strict(),
    },
    (args) => call({ action: 'propose', ...args })
  );
}
