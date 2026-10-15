import { buildAgentPrompt } from '@/lib';
import { buildAcpSelectorOptions } from '@/components/shared/acp-selector-options';
import { filterAcpSessionConfigOptionValues } from '@/lib/acp-session-config-selection';
import { useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { atomWithStorage } from 'jotai/utils';
import { useAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { v4 as uuid } from 'uuid';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Textarea } from '@lody/ui/textarea';
import { Switch } from '@lody/ui/switch';
import { Dialog } from '@/ui/dialog';
import {
  DEFAULT_BOARD_RULES,
  normalizeBoardMeta,
  buildSessionTurnInputConfig,
  buildPendingUserHistoryEntry,
  getDefaultSelectedMcpServerIds,
  type AgentRoleInstanceId,
  type BoardMeta,
  type MachineId,
} from '@lody/shared';
import { userAtom } from '@/atoms';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { getAllAgentConfigAtom } from '@/atoms/agents';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';
import { useMachineFlockAgentConfigs } from '@/hooks/use-machine-flock-agent-configs';
import {
  useWorkspaceAgentRoles,
  useAgentRoleAvailability,
  useComposerAgentRoleNames,
} from '@/hooks/use-workspace-agent-roles';
import { useWorkspaceCatalog } from '@/hooks/use-workspace-catalog';
import { useSessionActions } from '@/hooks/use-session-actions';
import {
  buildComposerAgentRoleItems,
  findComposerAgentRoleItem,
  buildAgentRoleTurnSelection,
} from '@/lib/composer-agent-roles';
import { createWorkspaceBoard } from '@/lib/workspace-catalog-write';
import { readChatLandingDefaults } from '@/lib/chat-landing-defaults';
import { ScheduleAgentControls } from '../schedules/schedule-agent-controls';
import { pickScheduleAgent, seedScheduleAgentRunRef } from '../schedules/schedule-agent-defaults';
import { DesktopMachineMenu } from '../sessions/desktop-run-config-menu';
import type { AgentRunRef } from '../shared/agent-run-ref';
import { boardStyles } from './board-view';

const lastBoardAgentAtom = atomWithStorage<{
  machineId: MachineId;
  agent: AgentRunRef;
  instanceId: AgentRoleInstanceId | null;
} | null>('lody-board-last-agent', null);

export function CreateBoardDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (board: BoardMeta) => void;
}) {
  const { t } = useTranslation();
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const user = useAtomValue(userAtom);
  const { servers } = useWorkspaceCatalog();
  const { machines } = useVisibleMachineMetas();
  useMachineFlockAgentConfigs();
  const agents = useAtomValue(getAllAgentConfigAtom);
  const { roles } = useWorkspaceAgentRoles();
  const availability = useAgentRoleAvailability(roles);
  const names = useComposerAgentRoleNames();
  const { startSession, requestSessionDispatch } = useSessionActions();
  const [lastAgent, setLastAgent] = useAtom(lastBoardAgentAtom);
  const ownedMachines = useMemo(
    () => new Map([...machines].filter(([, machine]) => machine.ownerUserId === user?.id)),
    [machines, user?.id]
  );
  const defaultConfig = pickScheduleAgent({
    landing: lastAgent
      ? { machineId: lastAgent.machineId, agentId: lastAgent.agent.agentConfigId }
      : readChatLandingDefaults(runtime?.workspaceId),
    agents,
    machines: ownedMachines,
  });
  const [choice, setChoice] = useState<typeof lastAgent>(null);
  const pickedMachineId = choice?.machineId ?? defaultConfig?.machineId;
  const roleItems = buildComposerAgentRoleItems({
    roles,
    machineId: pickedMachineId ?? null,
    agentConfigs: agents,
    resolveAvailability: availability.resolveInstance,
    names,
  });
  const selectedInstanceId = choice?.instanceId ?? (choice === null ? lastAgent?.instanceId : null);
  const role = findComposerAgentRoleItem(roleItems, selectedInstanceId);
  const machineId = role?.instance.machineId ?? pickedMachineId;
  const machine = machineId ? ownedMachines.get(machineId) : undefined;
  const agent =
    choice?.agent ??
    (defaultConfig
      ? lastAgent?.agent.agentConfigId === defaultConfig.id
        ? lastAgent.agent
        : seedScheduleAgentRunRef(defaultConfig, machine)
      : null);
  const shownAgent = role
    ? { agentConfigId: role.instance.agentConfigId, ...role.instance.runConfig }
    : agent;
  const config = agents.find((entry) => entry.id === shownAgent?.agentConfigId);
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [rules, setRules] = useState(DEFAULT_BOARD_RULES);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [ids] = useState(() => ({ board: `bd_${uuid()}`, session: uuid() }));
  const chooseMachine = (id: MachineId) => {
    const next = pickScheduleAgent({
      landing: { machineId: id },
      agents,
      machines: new Map([...ownedMachines].filter(([key]) => key === id)),
    });
    if (next)
      setChoice({
        machineId: id,
        agent: seedScheduleAgentRunRef(next, machines.get(id)),
        instanceId: null,
      });
  };
  const create = async () => {
    if (!runtime || !user || !machine || !config || !shownAgent || saving) return;
    const board = normalizeBoardMeta({
      version: 1,
      id: ids.board,
      name: name.trim(),
      purpose: purpose.trim(),
      rules,
      coordinatorSessionId: ids.session,
      createdAtMs: Date.now(),
      createdByUserId: user.id,
    });
    if (!board) {
      setError(
        t(
          'boards.invalid',
          'Enter a name and goal within the limits. A workspace can have up to 50 active boards.'
        )
      );
      return;
    }
    if (role && role.availability.kind !== 'available') {
      setError(t('boards.agentUnavailable', 'Choose an available agent.'));
      return;
    }
    setSaving(true);
    setError('');
    const inputBlocks = [{ type: 'text' as const, text: board.purpose }];
    const prompt = buildAgentPrompt(
      board.purpose,
      buildAgentPrompt(role?.role.promptPrefix ?? '', config.prompt)
    );
    const selectors = buildAcpSelectorOptions({
      configId: config.id,
      cliType: config.cliType,
      agentType: config.agentType,
      selectedModeId: shownAgent.modeId,
      selectedModelId: shownAgent.modelId,
      configOptionValues: shownAgent.configOptionValues,
      runtimeOverrides: config.runtimeOverrides,
      machine,
    });
    const configOptionValues = filterAcpSessionConfigOptionValues(
      shownAgent.configOptionValues,
      selectors.configOptionSelectors
    );
    const inputConfig = buildSessionTurnInputConfig({
      inputBlocks,
      prompt,
      cliType: config.cliType,
      agentType: config.agentType,
      ...shownAgent,
      configOptionValues,
      mcpServerIds: getDefaultSelectedMcpServerIds(servers),
      ...(role ? buildAgentRoleTurnSelection(role) : { agentRoleId: null }),
    });
    const history = buildPendingUserHistoryEntry({
      userId: user.id,
      inputBlocks,
      timestamp: new Date().toISOString(),
      inputConfig,
    });
    if (!history) {
      setSaving(false);
      return;
    }
    try {
      const created = await createWorkspaceBoard(runtime, board, () =>
        startSession(
          {
            sessionId: board.coordinatorSessionId,
            userId: user.id,
            machineId: machine.id,
            cliType: config.cliType,
            agentType: config.agentType,
            agentConfigId: config.id,
            customAcp: config.customAcp,
            runtimeOverrides: config.runtimeOverrides,
            env: config.env,
            title: board.name,
            boardId: board.id,
            boardRole: 'coordinator',
            ...(role
              ? {
                  agentRoleId: role.role.id,
                  agentRoleRevision: role.role.revision,
                  agentRoleInstanceId: role.instance.id,
                }
              : {}),
          },
          history
        )
      );
      // The accepted turn already owns dispatch. RPC only accelerates it.
      void requestSessionDispatch(created.sessionId, created.historyEntry.id, {
        inputConfig,
        machineId: machine.id,
      }).catch((cause: unknown) => console.warn('Board coordinator dispatch deferred', cause));
      setLastAgent({
        machineId: machine.id,
        agent: shownAgent,
        instanceId: role?.instance.id ?? null,
      });
      onCreated(board);
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message === 'BOARD_LIMIT'
          ? t(
              'boards.invalid',
              'Enter a name and goal within the limits. A workspace can have up to 50 active boards.'
            )
          : cause instanceof Error
            ? cause.message
            : String(cause)
      );
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <Dialog.Content>
        <Dialog.Header>
          <Dialog.Title>{t('boards.create', 'New board')}</Dialog.Title>
          <Dialog.Description>
            {t('boards.createHelp', 'Choose a coordinator. Your goal will be its first message.')}
          </Dialog.Description>
        </Dialog.Header>
        <form
          {...stylex.props(boardStyles.form)}
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <label {...stylex.props(boardStyles.field)}>
            {t('boards.name', 'Name')}
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label {...stylex.props(boardStyles.field)}>
            {t('boards.purpose', 'Goal')}
            <Textarea
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              required
              rows={4}
            />
          </label>
          <div {...stylex.props(boardStyles.controls)}>
            <DesktopMachineMenu
              value={machineId ?? null}
              options={[...ownedMachines.values()]
                .filter((entry) => agents.some((a) => a.machineId === entry.id))
                .map((entry) => ({ value: entry.id, label: entry.name }))}
              selectedLabel={machine?.name}
              onChange={chooseMachine}
            />
            <ScheduleAgentControls
              machine={machine}
              agentConfigs={agents.filter((a) => a.machineId === machineId)}
              value={shownAgent}
              onChange={(next) => {
                if (machineId) setChoice({ machineId, agent: next, instanceId: null });
              }}
              agentRoles={{
                items: roleItems,
                selectedInstanceId: role?.instance.id ?? null,
                machine: machine ?? null,
                onSelect: (id) => {
                  const item = findComposerAgentRoleItem(roleItems, id);
                  if (item)
                    setChoice({
                      machineId: item.instance.machineId,
                      agent: {
                        agentConfigId: item.instance.agentConfigId,
                        ...item.instance.runConfig,
                      },
                      instanceId: id,
                    });
                  else if (shownAgent && machineId)
                    setChoice({ machineId, agent: shownAgent, instanceId: null });
                },
              }}
            />
          </div>
          <label {...stylex.props(boardStyles.field)}>
            {t('boards.maxRounds', 'Rounds per thread')}
            <Input
              type="number"
              min={1}
              value={rules.maxRoundsPerThread}
              onChange={(e) => setRules({ ...rules, maxRoundsPerThread: Number(e.target.value) })}
            />
          </label>
          <label {...stylex.props(boardStyles.controls)}>
            <Switch
              checked={rules.reportHumanTurns}
              onCheckedChange={(value) => setRules({ ...rules, reportHumanTurns: value })}
            />
            {t('boards.reportHumanTurns', 'Report completed human turns')}
          </label>
          <label {...stylex.props(boardStyles.field)}>
            {t('boards.constraints', 'Executor instructions')}
            <Textarea
              value={rules.executorConstraints}
              onChange={(e) => setRules({ ...rules, executorConstraints: e.target.value })}
              rows={3}
            />
          </label>
          <p {...stylex.props(boardStyles.muted)}>
            {t(
              'boards.rulesLater',
              'Rules are saved for the upcoming reporting and handoff features.'
            )}
          </p>
          {error ? (
            <p role="alert" {...stylex.props(boardStyles.error)}>
              {error}
            </p>
          ) : null}
          <Button type="submit" disabled={saving || !config || !machine}>
            {saving ? t('boards.creating', 'Creating…') : t('boards.create', 'New board')}
          </Button>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}
