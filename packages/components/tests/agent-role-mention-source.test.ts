// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_ROLE_VERSION,
  DEFAULT_AGENT_ROLE_EMOJI,
  applyTextRewrites,
  resolveAgentRoleInstanceAvailability,
  type AgentConfigId,
  type AgentConfigMeta,
  type AgentRole,
  type AgentRoleAvailability,
  type AgentRoleId,
  type AgentRoleInstance,
  type AgentRoleInstanceId,
  type CatalogAgentRole,
  type LocalProjectId,
  type MachineId,
  type WorkspaceId,
} from '@lody/shared';
import { buildAgentRoleCandidates } from '../src/components/mentions/mention-registry';
import {
  AgentRoleMentionMachineContext,
  buildAgentRoleMentionItems,
  buildAgentRoleMentionPrompt,
  buildAgentRoleMentionRewrites,
  buildAgentRoleMentionSlugMap,
  hydrateAgentRoleMentionsFromText,
  selectAgentRoleMentionCandidates,
  type AgentRoleMentionItem,
} from '../src/components/mentions/mention-agent-role-source';
import {
  useMentionPromptExpansion,
  type MentionPromptExpansion,
} from '../src/components/mentions/mention-expansion';
import { buildComposerAgentRoleItems } from '../src/lib/composer-agent-roles';
import { singleMachineRole } from './agent-role-fixture';

// The composer-facing hooks read the authenticated machine index, the agent
// configs and the workspace catalog. Stub those inputs, keep the real
// availability rule.
const reach = vi.hoisted(() => ({
  roles: [] as CatalogAgentRole[],
  authorized: new Set<string>(),
}));
vi.mock('../src/hooks/use-visible-machine-metas', () => ({
  useVisibleMachineMetas: () => ({
    machines: new Map([...reach.authorized].map((id) => [id, { id, name: id }])),
  }),
}));
vi.mock('../src/atoms/agents', async (importOriginal) => {
  const { atom } = await import('jotai');
  return {
    ...(await importOriginal<object>()),
    getAllAgentConfigAtom: atom(() =>
      reach.roles.flatMap((entry) =>
        entry.instances.map((instance) => ({
          id: instance.agentConfigId,
          machineId: instance.machineId,
          name: 'Codex',
          cliType: 'builtin',
          agentType: 'codex',
          env: {},
        }))
      )
    ),
  };
});
vi.mock('../src/hooks/use-workspace-agent-roles', () => ({
  useWorkspaceAgentRoles: () => ({ roles: reach.roles, synced: true }),
  useAgentRoleAvailability: () => ({
    resolveInstance: (instance: AgentRoleInstance) =>
      resolveAgentRoleInstanceAvailability(instance, {
        authorizedMachineIds: reach.authorized as Set<MachineId>,
        onlineMachineIds: reach.authorized as Set<MachineId>,
        agentConfigMachineIds: new Map(
          reach.roles.flatMap((entry) =>
            entry.instances.map((candidate) => [candidate.agentConfigId, candidate.machineId])
          )
        ),
        loadedAgentConfigMachineIds: reach.authorized as Set<MachineId>,
      }),
  }),
  useComposerAgentRoleNames: () => ({
    machine: (id: string) => id,
    unknownAgent: 'Unknown agent',
  }),
}));
vi.mock('../src/components/mentions/mention-session-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSessionMentionItems: () => [],
}));
vi.mock('../src/components/mentions/mention-skill-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSkillMentionRewrites: () => () => [],
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const machineId = 'machine-1' as MachineId;

const role = (overrides: Partial<AgentRole> = {}): CatalogAgentRole =>
  singleMachineRole({
    v: AGENT_ROLE_VERSION,
    id: 'role-1' as AgentRoleId,
    ownerUserId: 'user-1',
    visibility: 'private',
    name: 'Code Reviewer',
    emoji: '🔍',
    machineId,
    agentConfigId: 'config-1' as AgentConfigId,
    runConfig: { modelId: 'gpt-5.6', configOptionValues: { thought_level: 'high' } },
    revision: 3,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  });

const instance = (
  id: string,
  alias: string,
  agentConfigId: string,
  onMachine: MachineId = machineId
): AgentRoleInstance => ({
  id: id as AgentRoleInstanceId,
  alias,
  machineId: onMachine,
  agentConfigId: agentConfigId as AgentConfigId,
  runConfig: {},
});

/** uiStyle: a Claude group here and on machine-2, and a Gemini group here. */
const uiStyle = role({
  id: 'ui-style' as AgentRoleId,
  name: 'uiStyle',
  emoji: '🎨',
  instances: [
    instance('ui-claude', 'Claude', 'config-claude'),
    instance('ui-gemini', 'Gemini', 'config-gemini'),
    instance('ui-remote', 'Claude', 'config-remote', 'machine-2' as MachineId),
  ],
});

const agentConfigFor = (id: string) =>
  ({
    id,
    machineId,
    name: id === 'config-1' ? 'Codex' : id.replace('config-', 'Agent '),
    cliType: 'builtin',
    agentType: 'codex',
    env: {},
  }) as unknown as AgentConfigMeta;

const itemsWith = (
  roles: CatalogAgentRole[],
  resolveAvailability: (entry: AgentRoleInstance) => AgentRoleAvailability = () => ({
    kind: 'available',
  })
): AgentRoleMentionItem[] =>
  buildAgentRoleMentionItems(
    buildComposerAgentRoleItems({
      roles,
      machineId,
      agentConfigs: roles.flatMap((entry) =>
        entry.instances.map((candidate) => agentConfigFor(candidate.agentConfigId))
      ),
      resolveAvailability,
      names: { machine: () => 'Build box', unknownAgent: 'Unknown agent' },
    }),
    () => ({ name: 'Studio' })
  );
const items = (...roles: CatalogAgentRole[]) => itemsWith(roles);

/** The instruction for one instance, named by its group. */
const promptFor = (entry: CatalogAgentRole, index = 0, name = 'Codex') =>
  buildAgentRoleMentionPrompt(entry, { id: entry.instances[index]!.id, name });

describe('agent role reach from a composer', () => {
  it('expands a Role on any machine this user may reach, never one it cannot', async () => {
    const here = role({ id: 'here' as AgentRoleId, name: 'Here Reviewer' });
    const remote = role({
      id: 'remote' as AgentRoleId,
      name: 'Remote Reviewer',
      machineId: 'machine-2' as MachineId,
      agentConfigId: 'config-2' as AgentConfigId,
    });
    const unreachable = role({
      id: 'unreachable' as AgentRoleId,
      name: 'Unreachable Reviewer',
      machineId: 'machine-3' as MachineId,
      agentConfigId: 'config-3' as AgentConfigId,
    });
    reach.roles = [here, remote, unreachable];
    reach.authorized = new Set([machineId, 'machine-2']);

    let expansion: MentionPromptExpansion | undefined;
    function LocalProjectComposer() {
      expansion = useMentionPromptExpansion({
        source: {
          kind: 'local',
          machineId,
          workspaceId: 'w' as WorkspaceId,
          localProjectId: 'p' as LocalProjectId,
        },
        skillAgent: undefined,
        promptValue: '',
      });
      return null;
    }
    const root = createRoot(document.createElement('div'));
    await act(async () =>
      root.render(
        createElement(
          AgentRoleMentionMachineContext.Provider,
          { value: machineId },
          createElement(LocalProjectComposer)
        )
      )
    );

    const text = '@Here-Reviewer and @Remote-Reviewer or @Unreachable-Reviewer';
    const expanded = expansion!.expand({
      text,
      mentions: [
        { start: 0, end: 14, kind: 'agent_role', value: here.instances[0]!.id },
        { start: 19, end: 35, kind: 'agent_role', value: remote.instances[0]!.id },
        { start: 39, end: 60, kind: 'agent_role', value: unreachable.instances[0]!.id },
      ],
    });
    // A mention starts a new Session, so the composer's own machine is no limit.
    expect(expanded.text).toBe(
      `${promptFor(here)} and ${promptFor(remote)} or @Unreachable-Reviewer`
    );
    await act(async () => root.unmount());
  });
});

describe('agent role mention tokens', () => {
  it('names a Role with one group by the Role alone', () => {
    expect(items(role({ name: 'Code Reviewer' })).map((item) => item.slug)).toEqual([
      'Code-Reviewer',
    ]);
  });

  it("names each group by Role and group, one entry for a group's instances everywhere", () => {
    const list = items(uiStyle);
    expect(list.map((item) => [item.slug, item.title, item.instance.id])).toEqual([
      ['uiStyle:Claude', 'uiStyle · Claude', 'ui-claude'],
      ['uiStyle:Gemini', 'uiStyle · Gemini', 'ui-gemini'],
    ]);
    // Unaliased instances take their agent's name.
    const plain = items(
      role({
        id: 'plain' as AgentRoleId,
        name: 'Plain',
        instances: [
          { ...instance('p-1', '', 'config-1'), alias: undefined },
          { ...instance('p-2', 'Strict', 'config-1'), machineId: 'machine-2' as MachineId },
        ],
      })
    );
    expect(plain.map((item) => [item.slug, item.title])).toEqual([
      ['Plain:Codex', 'Plain · Codex'],
      ['Plain:Strict', 'Plain · Strict · Build box'],
    ]);
  });

  it('matches the group name as well as the Role name', () => {
    const list = items(uiStyle, role());
    expect(selectAgentRoleMentionCandidates(list, 'gem').map((item) => item.slug)).toEqual([
      'uiStyle:Gemini',
    ]);
    expect(selectAgentRoleMentionCandidates(list, 'uistyle').map((item) => item.slug)).toEqual([
      'uiStyle:Claude',
      'uiStyle:Gemini',
    ]);
  });

  it('reads a bare Role name as what a bare pick runs, and a group token as its first that can run', () => {
    expect(hydrateAgentRoleMentionsFromText('ask @uiStyle', items(uiStyle)).values).toEqual([
      'ui-claude',
    ]);
    expect(hydrateAgentRoleMentionsFromText('ask @uiStyle:Gemini', items(uiStyle)).values).toEqual([
      'ui-gemini',
    ]);
    // The local Claude cannot run: the group's token, and the bare Role, go on
    // to its instance elsewhere before another group.
    const localClaudeDown = itemsWith([uiStyle], (entry) =>
      entry.id === 'ui-claude'
        ? { kind: 'unavailable', reason: 'machine_offline' }
        : { kind: 'available' }
    );
    expect(hydrateAgentRoleMentionsFromText('@uiStyle:Claude', localClaudeDown).values).toEqual([
      'ui-remote',
    ]);
    expect(hydrateAgentRoleMentionsFromText('@uiStyle', localClaudeDown).values).toEqual([
      'ui-remote',
    ]);
  });

  it('leaves a token two entries would both produce as plain text', () => {
    // A Role literally named `uiStyle:Claude` collides with uiStyle's Claude instance.
    const lookalike = role({ id: 'lookalike' as AgentRoleId, name: 'uiStyle:Claude' });
    const list = items(uiStyle, lookalike);
    expect(buildAgentRoleMentionSlugMap(list).has('uiStyle:Claude')).toBe(false);
    expect(hydrateAgentRoleMentionsFromText('@uiStyle:Claude', list).mentions).toEqual([]);
    expect(buildAgentRoleMentionSlugMap(list).get('uiStyle:Gemini')).toBe('ui-gemini');
    // Still a clash while the lookalike cannot run: it never falls to the other.
    const lookalikeOffline = itemsWith([uiStyle, lookalike], (entry) =>
      entry.id === lookalike.instances[0]!.id
        ? { kind: 'unavailable', reason: 'machine_offline' }
        : { kind: 'available' }
    );
    expect(hydrateAgentRoleMentionsFromText('@uiStyle:Claude', lookalikeOffline).mentions).toEqual(
      []
    );
  });
});

describe('agent role candidates', () => {
  it('derives the token from the name, whitespace and all', () => {
    expect(items(role({ name: 'Code Reviewer' }))[0]?.slug).toBe('Code-Reviewer');
  });

  it('ranks a prefix match over a substring one, on token or name', () => {
    const list = items(
      role({ id: 'a' as AgentRoleId, name: 'Deep reviewer' }),
      role({ id: 'b' as AgentRoleId, name: 'Reviewer' })
    );
    expect(selectAgentRoleMentionCandidates(list, 'rev').map((item) => item.slug)).toEqual([
      'Reviewer',
      'Deep-reviewer',
    ]);
    expect(selectAgentRoleMentionCandidates(list, 'nope')).toEqual([]);
  });

  it('lists the entire role catalog, with an explicit cap for aggregate search', () => {
    const many = items(
      ...Array.from({ length: 60 }, (_unused, index) =>
        role({ id: `role-${index}` as AgentRoleId, name: `Reviewer ${index}` })
      )
    );
    expect(selectAgentRoleMentionCandidates(many, '')).toHaveLength(60);
    expect(selectAgentRoleMentionCandidates(many, '', 4)).toHaveLength(4);
  });
});

describe('agent role availability in mentions', () => {
  it('puts available matches first even when a disabled match has a higher score', () => {
    const available = items(role({ id: 'ready' as AgentRoleId, name: 'Deep Reviewer' }))[0]!;
    const offline = {
      ...items(role({ name: 'Reviewer' }))[0]!,
      availability: { kind: 'unavailable', reason: 'machine_offline' } as const,
    };
    const loading = {
      ...available,
      role: role({ id: 'loading' as AgentRoleId }),
      availability: { kind: 'unknown' } as const,
    };
    const list = [offline, loading, available];
    expect(selectAgentRoleMentionCandidates(list, '').map((item) => item.role.id)).toEqual([
      'ready',
      'role-1',
      'loading',
    ]);
    expect(selectAgentRoleMentionCandidates(list, 'rev', 1)).toEqual([available]);
    expect(selectAgentRoleMentionCandidates([offline, loading], 'rev')).toHaveLength(2);
  });
});

describe('agent role menu rows', () => {
  it('carries the role own mark instead of the category glyph', () => {
    const [candidate] = buildAgentRoleCandidates(items(role({ emoji: '🔍' })), '');
    expect(candidate).toMatchObject({
      iconEmoji: '🔍',
      // The name alone: the emoji is the row's icon, not a prefix on the text.
      title: 'Code Reviewer',
      insertText: '@Code-Reviewer',
      value: 'role-1:machine-1',
    });
    // Nothing restated in the detail: the pane heads itself with the same mark
    // and name.
    expect(candidate?.detail?.title).toBeUndefined();
    // Who does the work; every row runs on this composer's machine.
    expect(candidate?.hint).toBe('Codex');
  });

  it('hands the Role to the shared pane instead of restating it as rows', () => {
    const withPrompt = role({ promptPrefix: 'Check correctness before style.' });
    const [candidate] = buildAgentRoleCandidates(items(withPrompt), '');
    // The pane reads the Role itself — including its instruction — resolving
    // each stored id against the BOUND agent's capabilities. Generic rows here
    // could only print those ids raw, which is how this menu ended up labelling
    // the permission mode "Reasoning".
    expect(candidate?.detail?.agentRole).toEqual({
      role: withPrompt,
      instance: withPrompt.instances[0],
      agentConfig: agentConfigFor('config-1'),
      machine: { name: 'Studio' },
    });
    expect(candidate?.detail?.rows).toBeUndefined();
    // No badges at all: every Role the menu offers is one this user may run, so
    // visibility changes nothing about accepting it.
    expect(candidate?.detail?.badges).toBeUndefined();
  });

  it.each([{ kind: 'unknown' }, { kind: 'unavailable', reason: 'machine_offline' }] as const)(
    'disables unavailable/loading rows and carries the reason below the title',
    (availability) => {
      const list = itemsWith([role()], () => availability);
      const [candidate] = buildAgentRoleCandidates(list, '', undefined, () => 'Machine offline');
      expect(candidate).toMatchObject({
        disabled: true,
        subtitle: 'Machine offline',
        title: 'Code Reviewer',
      });
      expect(
        buildAgentRoleMentionRewrites(
          '@Code-Reviewer',
          [{ start: 0, end: 14, kind: 'agent_role', value: 'role-1:machine-1' }],
          list
        )
      ).toEqual([]);
      expect(hydrateAgentRoleMentionsFromText('@Code-Reviewer', list).mentions).toEqual([]);
    }
  );

  it('names the agent beside the title only where the title does not', () => {
    const hints = (entry: CatalogAgentRole) =>
      buildAgentRoleCandidates(items(entry), '').map((candidate) => [
        candidate.title,
        candidate.hint,
      ]);
    // One group: the title is the Role alone, so the agent is said beside it.
    expect(hints(role())).toEqual([['Code Reviewer', 'Codex']]);
    // Unaliased groups are titled by their agent; aliased ones are not.
    expect(
      hints(
        role({
          id: 'pair' as AgentRoleId,
          name: 'Pair',
          instances: [
            { ...instance('p-1', '', 'config-1'), alias: undefined },
            instance('p-2', 'Strict', 'config-strict'),
          ],
        })
      )
    ).toEqual([
      ['Pair · Codex', undefined],
      ['Pair · Strict', 'Agent strict'],
    ]);
  });

  it('falls back to the shared default mark', () => {
    const [candidate] = buildAgentRoleCandidates(items(role({ emoji: undefined })), '');
    expect(candidate?.iconEmoji).toBe(DEFAULT_AGENT_ROLE_EMOJI);
  });
});

describe('agent role before-send expansion', () => {
  const text = 'please @Code-Reviewer this diff';
  const mention = { start: 7, end: 21, kind: 'agent_role', value: 'role-1:machine-1' };

  it('rewrites the range into an id-bearing instruction and keeps the chip label', () => {
    const expanded = applyTextRewrites(
      text,
      buildAgentRoleMentionRewrites(text, [mention], items(role()))
    );
    expect(expanded.text).toBe(`please ${promptFor(role())} this diff`);
    expect(expanded.spans).toEqual([
      {
        start: 7,
        end: 7 + promptFor(role()).length,
        kind: 'agent_role',
        label: 'Code-Reviewer',
        target: 'role-1',
        // Frozen with the span so the bubble paints without the catalog.
        mark: '🔍',
      },
    ]);
  });

  it('carries no run configuration into the instruction', () => {
    const prompt = promptFor(role());
    expect(prompt).not.toContain('gpt-5.6');
    expect(prompt).not.toContain('thought_level');
    expect(prompt).not.toContain('config-1');
  });

  it("expands a range written before instances to the Role's default instance here", () => {
    const legacy = { ...mention, value: 'role-1' };
    const expanded = applyTextRewrites(
      text,
      buildAgentRoleMentionRewrites(text, [legacy], items(role()))
    );
    expect(expanded.text).toBe(`please ${promptFor(role())} this diff`);
  });

  it('names the picked group, and stands in for an instance that cannot run', () => {
    const picked = 'ask @uiStyle:Gemini';
    const expanded = applyTextRewrites(
      picked,
      buildAgentRoleMentionRewrites(
        picked,
        [{ start: 4, end: 19, kind: 'agent_role', value: 'ui-gemini' }],
        items(uiStyle)
      )
    );
    expect(expanded.text).toBe(`ask ${promptFor(uiStyle, 1, 'Gemini')}`);
    expect(expanded.spans[0]).toMatchObject({ label: 'uiStyle:Gemini', target: 'ui-style' });
    // A range on the local Claude, which went offline: its group runs elsewhere.
    const claude = 'ask @uiStyle:Claude';
    expect(
      applyTextRewrites(
        claude,
        buildAgentRoleMentionRewrites(
          claude,
          [{ start: 4, end: 19, kind: 'agent_role', value: 'ui-claude' }],
          itemsWith([uiStyle], (entry) =>
            entry.id === 'ui-claude'
              ? { kind: 'unavailable', reason: 'machine_offline' }
              : { kind: 'available' }
          )
        )
      ).text
    ).toBe(`ask ${promptFor(uiStyle, 2, 'Claude')}`);
  });

  it('leaves a role that is no longer offered as plain text', () => {
    expect(buildAgentRoleMentionRewrites(text, [mention], [])).toEqual([]);
  });
});

describe('agent role draft hydration', () => {
  it('recognises a known token and yields a range carrying the instance id', () => {
    expect(hydrateAgentRoleMentionsFromText('ping @Code-Reviewer now', items(role()))).toEqual({
      mentions: [{ value: 'role-1:machine-1', start: 5, end: 19, kind: 'agent_role' }],
      values: ['role-1:machine-1'],
    });
  });

  it('leaves a token the file source already knows to the file hydrator', () => {
    expect(
      hydrateAgentRoleMentionsFromText(
        'open @Code-Reviewer',
        items(role()),
        new Set(['Code-Reviewer'])
      ).mentions
    ).toEqual([]);
  });

  it('claims nothing when no role is offered', () => {
    expect(hydrateAgentRoleMentionsFromText('@Code-Reviewer', [])).toEqual({
      mentions: [],
      values: [],
    });
  });
});
