import * as React from 'react';
import { useAtomValue } from 'jotai';
import {
  getAgentRoleEmoji,
  getAgentRoleTargets,
  getAgentRoleMentionSlug,
  normalizeAgentRoleMentionSlug,
  type AgentRoleInstanceId,
  type MachineId,
  type MachineViewMeta,
  type TextRewrite,
} from '@lody/shared';
import { getAllAgentConfigAtom } from '@/atoms/agents';
import {
  hydrateSlugMentionsFromText,
  type HydratedMentions,
} from '@/components/mentions/mention-hydration';
import { rankMentionCandidates } from '@/components/mentions/mention-rank';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';
import {
  useAgentRoleAvailability,
  useComposerAgentRoleNames,
  useWorkspaceAgentRoles,
} from '@/hooks/use-workspace-agent-roles';
import {
  buildComposerAgentRoleItems,
  findComposerAgentRoleItem,
  findDefaultComposerAgentRoleItem,
  type ComposerAgentRoleItem,
} from '@/lib/composer-agent-roles';

/**
 * Agent Role mentions.
 *
 * Shaped like the session mention — the composer writes a readable
 * `@<mentionSlug>` and the committed RANGE carries the stable instance id — for
 * the same reason: the highlight overlay mirrors the textarea character for
 * character, so the text has to be something the user can read while the agent
 * receives something it can act on.
 *
 * What differs is what the rewrite produces. A session mention asks the agent to
 * read a history; a Role mention asks it to CREATE a Session, and the Role's
 * actual configuration is not in that instruction at all. The agent passes the
 * Role and instance ids back; the MCP create path resolves the current
 * workspace row and freezes that instance when it accepts the Operation.
 *
 * The list is the composer's: one entry per instance group of every Role, the
 * composer's machine first, exactly as its run-config menu lists them. A
 * mention starts a new Session, so an entry on another machine can be used
 * even where the composer's own conversation cannot move.
 *
 * A term naming a machine after `@` (`@ui@n1`) lists the instances on that
 * machine instead, every one PINNED: it runs that instance or nothing, never a
 * stand-in elsewhere in its group. The same `@<machine>` closes its token.
 */

/** The machine the surrounding composer runs on; Role mentions prefer it. */
export const AgentRoleMentionMachineContext = React.createContext<MachineId | null>(null);

export type AgentRoleMentionItem = ComposerAgentRoleItem & {
  /**
   * The text written after `@`: the Role's name, then `:` and the group's name
   * when the Role has several groups, then `@` and the machine's for a pinned
   * entry. Whitespace-free by construction, and it changes with the names —
   * which is why the committed range carries the id.
   */
  slug: string;
  /** What the committed range carries: the instance id, marked when pinned. */
  value: string;
  /** Runs exactly its instance (`@<token>@<machine>`); otherwise its group does. */
  pinned: boolean;
  /** The machine's name as written in a token. */
  machineSlug: string;
  /** The machine, carried so the detail pane can resolve the instance's ids. */
  machine?: Pick<MachineViewMeta, 'acpCapabilities' | 'name'> | null;
};

/** `@uiStyle` for a Role with one group, `@uiStyle:Claude-Code` when it has several. */
export const getAgentRoleInstanceMentionSlug = (
  item: Pick<ComposerAgentRoleItem, 'role' | 'groupName' | 'hasSiblingGroups'>
): string => {
  const roleSlug = getAgentRoleMentionSlug(item.role);
  return item.hasSiblingGroups
    ? `${roleSlug}:${normalizeAgentRoleMentionSlug(item.groupName)}`
    : roleSlug;
};

const PINNED_VALUE_PREFIX = 'pinned:';

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/**
 * The entries a term lists. `<role>@<machine>` lists the pinned entries on
 * each machine whose token starts with `<machine>`, one per group there: asking
 * for a machine means that machine, also where the group's own entry already
 * runs on it. Available matches precede disabled matches, even when the latter
 * score higher.
 */
export const selectAgentRoleMentionCandidates = (
  items: readonly AgentRoleMentionItem[],
  term: string,
  limit = items.length
): AgentRoleMentionItem[] => {
  const listed = items;
  const at = term.indexOf('@');
  const machineTerm = term.slice(at + 1).toLowerCase();
  const onMachine =
    at < 0
      ? []
      : items.filter(
          (item) => item.pinned && item.machineSlug.toLowerCase().startsWith(machineTerm)
        );
  const [pool, query] = onMachine.length > 0 ? [onMachine, term.slice(0, at)] : [listed, term];
  const rank = (available: boolean) =>
    rankMentionCandidates(
      pool.filter((item) => (item.availability.kind === 'available') === available),
      query,
      {
        limit,
        // Not `slug`: a pinned one ends in its machine, which is not the Role's term.
        fields: (item) => [getAgentRoleInstanceMentionSlug(item), item.role.name, item.groupName],
      }
    );
  return [...rank(true), ...rank(false)].slice(0, limit);
};

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/**
 * The composer's entries, then every instance of their groups again as a
 * pinned entry, which names its machine even when it is this one.
 */
export const buildAgentRoleMentionItems = (
  items: readonly ComposerAgentRoleItem[],
  machineOf: (machineId: MachineId) => AgentRoleMentionItem['machine']
): AgentRoleMentionItem[] => {
  return items.map((item) => {
    const machineSlug = normalizeAgentRoleMentionSlug(item.machineName);
    const token = getAgentRoleInstanceMentionSlug(item);
    return {
      ...item,
      slug: getAgentRoleTargets(item.role).length > 1 ? `${token}@${machineSlug}` : token,
      value: item.instance.id,
      pinned: true,
      machineSlug,
      machine: machineOf(item.instance.machineId) ?? null,
    };
  });
};

/**
 * Every Role's entries, the composer's machine first, with execution
 * availability retained for disabled menu rows. Only available items may
 * expand before send.
 *
 * One owner, like `useSessionMentionItems`: the menu and the before-send
 * expansion both need the same list, and deriving it twice would re-resolve
 * every instance's availability on each machine-presence tick.
 */
export function useAgentRoleMentionItems(
  /** For a host above its own provider; otherwise the surrounding composer's machine. */
  machineIdOverride?: MachineId | null
): AgentRoleMentionItem[] {
  const contextMachineId = React.useContext(AgentRoleMentionMachineContext);
  const machineId = machineIdOverride === undefined ? contextMachineId : machineIdOverride;
  const agentConfigs = useAtomValue(getAllAgentConfigAtom);
  const { machines } = useVisibleMachineMetas();
  const { roles } = useWorkspaceAgentRoles();
  const { resolveInstance } = useAgentRoleAvailability(roles);
  const names = useComposerAgentRoleNames();

  return React.useMemo(
    () =>
      buildAgentRoleMentionItems(
        buildComposerAgentRoleItems({
          roles,
          machineId,
          agentConfigs,
          resolveAvailability: resolveInstance,
          names,
        }),
        (id) => machines.get(id)
      ),
    [agentConfigs, machineId, machines, names, resolveInstance, roles]
  );
}

/** Resolve stored target pins exactly, including legacy instance-id ranges. */
const findMentionTarget = (
  items: readonly AgentRoleMentionItem[],
  value: string
): ComposerAgentRoleItem | undefined => {
  if (value.startsWith(PINNED_VALUE_PREFIX))
    return findComposerAgentRoleItem(
      items,
      value.slice(PINNED_VALUE_PREFIX.length) as AgentRoleInstanceId
    );
  const named = findComposerAgentRoleItem(items, value as AgentRoleInstanceId);
  return named ?? findDefaultComposerAgentRoleItem(items, value);
};

// ---------------------------------------------------------------------------
// Text: hydration and before-send expansion
// ---------------------------------------------------------------------------

/**
 * The instruction the current agent receives in place of the chip.
 *
 * Carries the Role and instance ids and nothing else that matters: the
 * machine, agent config, model, reasoning, and prompt prefix come from the
 * workspace catalog, so the agent cannot restate them differently. Operation
 * acceptance freezes the resolved configuration for recovery and retry.
 */
export const buildAgentRoleMentionPrompt = (
  role: { id: string; name: string },
  instance: { id: string; name: string }
): string =>
  `use lody mcp to create a session with agent role[id: ${role.id}, instance: ${instance.id}, name: ${role.name} · ${instance.name}]`;

export const buildAgentRoleMentionRewrites = (
  text: string,
  mentions: readonly { start: number; end: number; kind?: string; value: string }[],
  items: readonly AgentRoleMentionItem[]
): TextRewrite[] => {
  const rewrites: TextRewrite[] = [];
  for (const mention of mentions) {
    if (mention.kind !== 'agent_role' || !mention.value) continue;
    const item = findMentionTarget(items, mention.value);
    const label = text.slice(mention.start, mention.end).replace(/^@/, '');
    // An unknown Role id is left verbatim on purpose: the Role may have been
    // deleted, unshared, or become unavailable since the draft was written, and
    // a stale token the agent can ignore beats an instruction to create a
    // Session from something that no longer authorizes one.
    if (!item || item.availability.kind !== 'available' || !label) continue;
    rewrites.push({
      start: mention.start,
      end: mention.end,
      replacement: buildAgentRoleMentionPrompt(item.role, {
        id: item.instance.id,
        name: item.groupName,
      }),
      // The mark is frozen with the span, not resolved when the bubble renders:
      // a sent message shows the Role as it was, and painting history must not
      // depend on the mutable catalog being loaded.
      span: {
        kind: 'agent_role',
        label,
        // The Role, not the instance: what a sent message refers to.
        target: item.role.id,
        mark: getAgentRoleEmoji(item.role),
      },
    });
  }
  return rewrites;
};

/**
 * Recover Role ranges from a reloaded draft's text.
 *
 * The fallback, not the mechanism: ranges are persisted with the draft. Like
 * the session hydrator it may only claim a token no file path claims, because a
 * slug and a path are the same shape and mistaking a path for a Role would turn
 * a file reference into a Session-creation instruction.
 */
export const hydrateAgentRoleMentionsFromText = (
  text: string,
  items: readonly AgentRoleMentionItem[],
  knownFileTokens?: ReadonlySet<string>
): HydratedMentions =>
  hydrateSlugMentionsFromText({
    text,
    slugToValue: buildAgentRoleMentionSlugMap(items),
    kind: 'agent_role',
    knownFileTokens,
  });

/** Hydrate only uniquely named targets, even when other matches are unavailable. */
export const buildAgentRoleMentionSlugMap = (
  items: readonly AgentRoleMentionItem[]
): Map<string, string> => {
  const claims = new Map<string, AgentRoleMentionItem[]>();
  for (const item of items) {
    for (const slug of new Set([
      item.slug,
      getAgentRoleInstanceMentionSlug(item),
      getAgentRoleMentionSlug(item.role),
      `${getAgentRoleMentionSlug(item.role)}@${item.machineSlug}`,
    ])) {
      claims.set(slug, [...(claims.get(slug) ?? []), item]);
    }
  }
  return new Map(
    [...claims].flatMap(([slug, owners]) =>
      owners.length === 1 && owners[0]!.availability.kind === 'available'
        ? [[slug, owners[0]!.value]]
        : []
    )
  );
};
