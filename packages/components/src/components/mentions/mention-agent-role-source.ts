import * as React from 'react';
import { useAtomValue } from 'jotai';
import {
  getAgentRoleEmoji,
  getAgentRoleMentionSlug,
  normalizeAgentRoleMentionSlug,
  type AgentRoleInstance,
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
  useWorkspaceAgentRoles,
} from '@/hooks/use-workspace-agent-roles';
import {
  buildComposerAgentRoleItems,
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
 * The list is the composer's: the Role instances on the machine it runs on,
 * one entry each, exactly as its run-config menu lists them.
 */

/** The machine the surrounding composer runs on; Role mentions list its instances. */
export const AgentRoleMentionMachineContext = React.createContext<MachineId | null>(null);

export type AgentRoleMentionItem = Pick<
  ComposerAgentRoleItem,
  'role' | 'instance' | 'title' | 'availability' | 'agentConfig'
> & {
  /**
   * The text written after `@`: the Role's name, then `:` and the instance's
   * label when the machine holds several. Whitespace-free by construction, and
   * it changes with the names — which is why the committed range carries the id.
   */
  slug: string;
  /** The machine, carried so the detail pane can resolve the instance's ids. */
  machine?: Pick<MachineViewMeta, 'acpCapabilities' | 'name'> | null;
};

/** `@uiStyle` for a machine's only instance, `@uiStyle:Claude` when there are several. */
export const getAgentRoleInstanceMentionSlug = (
  item: Pick<ComposerAgentRoleItem, 'role' | 'instance' | 'title'>
): string => {
  const roleSlug = getAgentRoleMentionSlug(item.role);
  return item.title === item.role.name
    ? roleSlug
    : `${roleSlug}:${normalizeAgentRoleMentionSlug(item.instance.label)}`;
};

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/** Available matches precede disabled matches, even when the latter score higher. */
export const selectAgentRoleMentionCandidates = (
  items: readonly AgentRoleMentionItem[],
  term: string,
  limit = items.length
): AgentRoleMentionItem[] => {
  const rank = (available: boolean) =>
    rankMentionCandidates(
      items.filter((item) => (item.availability.kind === 'available') === available),
      term,
      { limit, fields: (item) => [item.slug, item.role.name, item.instance.label] }
    );
  return [...rank(true), ...rank(false)].slice(0, limit);
};

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export const buildAgentRoleMentionItems = (
  items: readonly ComposerAgentRoleItem[],
  machine: AgentRoleMentionItem['machine']
): AgentRoleMentionItem[] =>
  items.map((item) => ({
    slug: getAgentRoleInstanceMentionSlug(item),
    role: item.role,
    instance: item.instance,
    title: item.title,
    availability: item.availability,
    agentConfig: item.agentConfig,
    machine: machine ?? null,
  }));

/**
 * The Role instances on the composer's machine, with execution availability
 * retained for disabled menu rows. Only available items may expand before send.
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

  return React.useMemo(
    () =>
      buildAgentRoleMentionItems(
        buildComposerAgentRoleItems({
          roles,
          machineId,
          agentConfigs,
          resolveAvailability: resolveInstance,
        }),
        machineId ? machines.get(machineId) : null
      ),
    [agentConfigs, machineId, machines, resolveInstance, roles]
  );
}

/**
 * The item a committed range names: its instance, or — a range written before
 * instances carried the Role id — that Role's default instance here.
 */
const findMentionItem = (items: readonly AgentRoleMentionItem[], value: string) =>
  items.find((item) => item.instance.id === value) ?? items.find((item) => item.role.id === value);

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
  instance: Pick<AgentRoleInstance, 'id' | 'label'>
): string =>
  `use lody mcp to create a session with agent role[id: ${role.id}, instance: ${instance.id}, name: ${role.name} · ${instance.label}]`;

export const buildAgentRoleMentionRewrites = (
  text: string,
  mentions: readonly { start: number; end: number; kind?: string; value: string }[],
  items: readonly AgentRoleMentionItem[]
): TextRewrite[] => {
  const rewrites: TextRewrite[] = [];
  for (const mention of mentions) {
    if (mention.kind !== 'agent_role' || !mention.value) continue;
    const item = findMentionItem(items, mention.value);
    const label = text.slice(mention.start, mention.end).replace(/^@/, '');
    // An unknown Role id is left verbatim on purpose: the Role may have been
    // deleted, unshared, or become unavailable since the draft was written, and
    // a stale token the agent can ignore beats an instruction to create a
    // Session from something that no longer authorizes one.
    if (!item || item.availability.kind !== 'available' || !label) continue;
    rewrites.push({
      start: mention.start,
      end: mention.end,
      replacement: buildAgentRoleMentionPrompt(item.role, item.instance),
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

/**
 * Token → instance id for the available items. A bare Role name also names the
 * Role's default instance here (its first). A token two entries would both
 * produce — a Role named `a:b` beside Role `a`'s instance `b` — is left out, so
 * it stays plain text rather than picking one of them.
 */
export const buildAgentRoleMentionSlugMap = (
  items: readonly AgentRoleMentionItem[]
): Map<string, string> => {
  const available = items.filter((item) => item.availability.kind === 'available');
  const claims = new Map<string, Set<string>>();
  const claim = (slug: string, instanceId: string) =>
    claims.set(slug, (claims.get(slug) ?? new Set()).add(instanceId));
  for (const item of available) claim(item.slug, item.instance.id);
  const map = new Map<string, string>();
  for (const [slug, ids] of claims) if (ids.size === 1) map.set(slug, [...ids][0]!);
  for (const item of available) {
    const roleSlug = getAgentRoleMentionSlug(item.role);
    if (!claims.has(roleSlug) && !map.has(roleSlug)) map.set(roleSlug, item.instance.id);
  }
  return map;
};
