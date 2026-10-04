import { z } from 'zod';
import {
  callTerminalSessionTool,
  resolveTerminalToolTarget,
  TerminalToolError,
  type TerminalToolTarget,
} from '@/lib/terminal-session-tools';
import { renderTerminalTable } from '@/lib/terminal-table';

/**
 * Local-platform `session list/history/status`: the daemon answers through
 * its read-only terminal tools, so a LAN's other machines are included.
 */

// The tools' own page bounds (lody-mcp-server.ts).
const SESSION_LIST_PAGE = 100;
const SESSION_HISTORY_PAGE = 50;

const SessionSummarySchema = z.looseObject({
  id: z.string(),
  title: z.string().optional(),
  lastActivityAt: z.string(),
  archived: z.boolean(),
  machineId: z.string(),
  executionState: z.string(),
});
type SessionSummary = z.infer<typeof SessionSummarySchema>;

const PageSchema = <T extends z.ZodType>(item: T) =>
  z.looseObject({ items: z.array(item), nextCursor: z.string().optional() });

const HistoryEntrySchema = z.looseObject({
  index: z.number(),
  id: z.string(),
  role: z.string(),
  timestamp: z.string(),
  text: z.string(),
});
export type TerminalHistoryEntry = z.infer<typeof HistoryEntrySchema>;

const MachineRowSchema = z.looseObject({ id: z.string(), name: z.string() });

export type TerminalSessionListOptions = {
  workspace?: string;
  archived?: boolean;
  all?: boolean;
  openedBy?: string;
  query?: string;
  machineId?: string;
  agentConfigId?: string;
  agentRoleId?: string;
  limit?: number;
};

export async function readTerminalSessionList(options: TerminalSessionListOptions) {
  const target = await resolveTerminalToolTarget(options.workspace);
  const filters = {
    archive: options.all ? 'any' : options.archived ? 'archived' : 'active',
    openedBy: options.openedBy,
    query: options.query,
    machineId: options.machineId,
    agentConfigId: options.agentConfigId,
    agentRoleId: options.agentRoleId,
  };
  const sessions: SessionSummary[] = [];
  let cursor: string | undefined;
  do {
    const remaining = options.limit === undefined ? undefined : options.limit - sessions.length;
    const page = PageSchema(SessionSummarySchema).parse(
      await callTerminalSessionTool(target, 'lody_session_list', {
        ...filters,
        limit: Math.min(remaining ?? SESSION_LIST_PAGE, SESSION_LIST_PAGE),
        cursor,
      })
    );
    sessions.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor && (options.limit === undefined || sessions.length < options.limit));
  return { target, sessions };
}

/** Machine names by id, for human output; ids stand in for any it cannot read. */
async function readMachineNames(target: TerminalToolTarget): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  let cursor: string | undefined;
  do {
    const page = PageSchema(MachineRowSchema).parse(
      await callTerminalSessionTool(target, 'lody_machine_list', { limit: 100, cursor })
    );
    for (const machine of page.items) names.set(machine.id, machine.name);
    cursor = page.nextCursor;
  } while (cursor);
  return names;
}

export async function printTerminalSessionList(
  target: TerminalToolTarget,
  sessions: SessionSummary[]
): Promise<void> {
  if (sessions.length === 0) {
    console.log('No sessions found.');
    return;
  }
  const machines = await readMachineNames(target);
  console.log(
    renderTerminalTable(
      [
        { header: 'ID' },
        { header: 'Execution' },
        { header: 'State' },
        { header: 'Machine' },
        { header: 'Last activity' },
        { header: 'Title' },
      ],
      sessions.map((session) => [
        session.id,
        session.executionState,
        session.archived ? 'archived' : 'active',
        machines.get(session.machineId) ?? session.machineId,
        session.lastActivityAt,
        session.title,
      ])
    )
  );
}

/**
 * The newest `limit` visible entries (every one with `all`), oldest first.
 * The daemon caps each page at 128 KiB, so a long entry may arrive shortened
 * and marked `truncated`.
 */
export async function readTerminalSessionHistory(
  sessionId: string,
  options: { workspace?: string; limit: number; all?: boolean }
) {
  const target = await resolveTerminalToolTarget(options.workspace);
  let entries: TerminalHistoryEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = PageSchema(HistoryEntrySchema).parse(
      await callTerminalSessionTool(target, 'lody_session_history', {
        sessionId,
        limit: SESSION_HISTORY_PAGE,
        cursor,
      })
    );
    entries = [...page.items, ...entries];
    cursor = page.nextCursor;
  } while (cursor && (options.all || entries.length < options.limit));
  return { target, entries: options.all ? entries : entries.slice(-options.limit) };
}

const StatusItemSchema = z.discriminatedUnion('ok', [
  z.looseObject({ ok: z.literal(true), value: z.record(z.string(), z.unknown()) }),
  z.looseObject({
    ok: z.literal(false),
    error: z.object({ code: z.string().optional(), message: z.string() }),
  }),
]);

const StatusValueSchema = z.looseObject({
  summary: SessionSummarySchema,
  execution: z.looseObject({ executionState: z.string(), liveStatus: z.string().optional() }),
  machine: z.object({ state: z.string() }),
  observation: z.looseObject({ quality: z.string(), observedAt: z.string() }),
  actions: z.looseObject({
    chat: z.string(),
    reason: z.object({ message: z.string() }).optional(),
  }),
});

export async function readTerminalSessionStatus(sessionId: string, workspace?: string) {
  const target = await resolveTerminalToolTarget(workspace);
  const result = z
    .object({ items: z.array(StatusItemSchema).length(1) })
    .parse(
      await callTerminalSessionTool(target, 'lody_session_status_many', { sessionIds: [sessionId] })
    );
  const item = result.items[0]!;
  if (!item.ok) throw new TerminalToolError(item.error.message, item.error.code);
  return { target, status: item.value };
}

export async function printTerminalSessionStatus(
  target: TerminalToolTarget,
  status: Record<string, unknown>
): Promise<void> {
  const value = StatusValueSchema.parse(status);
  const machines = await readMachineNames(target);
  const { summary, execution, actions } = value;
  console.log(`id: ${summary.id}`);
  if (summary.title) console.log(`title: ${summary.title}`);
  console.log(
    `machine: ${machines.get(summary.machineId) ?? summary.machineId} (${value.machine.state})`
  );
  console.log(`state: ${summary.archived ? 'archived' : 'active'}`);
  console.log(
    `execution: ${execution.executionState}${execution.liveStatus ? ` (${execution.liveStatus})` : ''}`
  );
  console.log(`observed: ${value.observation.quality} at ${value.observation.observedAt}`);
  console.log(`last activity: ${summary.lastActivityAt}`);
  console.log(`chat: ${actions.chat}${actions.reason ? ` (${actions.reason.message})` : ''}`);
}
