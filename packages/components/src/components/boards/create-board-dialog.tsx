import { buildAgentPrompt } from '@/lib';
import { buildAcpSelectorOptions } from '@/components/shared/acp-selector-options';
import { filterAcpSessionConfigOptionValues } from '@/lib/acp-session-config-selection';
import { useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { atomWithStorage } from 'jotai/utils';
import { useAtom, useStore } from 'jotai';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { v4 as uuid } from 'uuid';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Textarea } from '@lody/ui/textarea';
import { Dialog } from '@/ui/dialog';
import {
  DEFAULT_BOARD_RULES,
  normalizeBoardMeta,
  buildSessionTurnInputConfig,
  buildPendingUserHistoryEntry,
  getDefaultSelectedMcpServerIds,
  githubFetchDefaultBranch,
  type AgentRoleInstanceId,
  type BoardMeta,
  type BoardProjectRef,
  type MachineId,
  type ProjectRef,
  type SessionId,
} from '@lody/shared';
import { userAtom } from '@/atoms';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import {
  getSessionRunConfigDraftKey,
  getSessionRunConfigDraftTargetKey,
  sessionRunConfigDraftAccountAtom,
  sessionRunConfigDraftsAtom,
} from '@/atoms/session-run-config-drafts';
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
import { useVisibleLocalProjects } from '@/hooks/use-visible-local-projects';
import { useWorkspaceGitHubRepositories } from '@/hooks/use-workspace-github-repositories';
import { useOpenSettings } from '@/hooks/use-open-settings';
import { useAppCapability } from '@/lib/app-platform';
import { withGitHubTokenRetry } from '@/lib/github-token';
import { ProjectRefSelector } from '@/components/shared/project-ref-selector';
import { WorktreeCheckboxPill } from '@/components/shared/workdir-mode-selector';
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
import { BoardCreateDialogView } from './board-create-dialog-view';
import { BoardProjectScopePicker } from './board-project-scope-picker';

const lastBoardAgentAtom = atomWithStorage<{
  machineId: MachineId;
  agent: AgentRunRef;
  instanceId: AgentRoleInstanceId | null;
} | null>('lody-board-last-agent', null);

export function CreateBoardDialog({
  onClose,
  onCreated,
  existingBoard,
}: {
  existingBoard?: BoardMeta;
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
  const { createSession, startSession, requestSessionDispatch } = useSessionActions();
  const store = useStore();
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
  const [projectScope, setProjectScope] = useState<BoardProjectRef[]>([]);
  // A new thread starts as a chat, or in any project: the scope limits what
  // agents open, not what the user starts by hand.
  const [threadProject, setThreadProject] = useState<ProjectRef | null>(null);
  const localProjects = useVisibleLocalProjects({ includeMachineFlock: true });
  const repositories = useWorkspaceGitHubRepositories(
    existingBoard ? runtime?.workspaceId : undefined
  );
  const { openSettings } = useOpenSettings();
  const githubIntegrationAvailable = useAppCapability('githubIntegration');
  const localGitHubCredentialAvailable = useAppCapability('localGitHubCredential');
  const githubSettingsAvailable = githubIntegrationAvailable || localGitHubCredentialAvailable;
  const machineProjects = [...localProjects.projects.values()]
    .filter((entry) => entry.machineId === machineId)
    .map((entry) => ({
      key: entry.key,
      machineId: entry.machineId,
      localProjectId: entry.project.id,
      name: entry.project.name,
      rootPath: entry.project.rootPath,
    }));
  // A local project belongs to one machine; choosing another machine leaves a chat.
  const project =
    threadProject?.kind === 'local' &&
    !machineProjects.some((entry) => entry.localProjectId === threadProject.localProjectId)
      ? null
      : threadProject;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [ids] = useState(() => ({ board: `bd_${uuid()}`, session: uuid() as SessionId }));
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
  const sessionPayload = (
    ready: { userId: string; machineId: MachineId; config: NonNullable<typeof config> },
    board: BoardMeta,
    sessionId: SessionId,
    title: string,
    threadProjectRef?: ProjectRef | null
  ) => ({
    sessionId,
    userId: ready.userId,
    machineId: ready.machineId,
    cliType: ready.config.cliType,
    agentType: ready.config.agentType,
    agentConfigId: ready.config.id,
    customAcp: ready.config.customAcp,
    runtimeOverrides: ready.config.runtimeOverrides,
    env: ready.config.env,
    title,
    boardId: board.id,
    ...(threadProjectRef ? { project: threadProjectRef } : {}),
    ...(role
      ? {
          agentRoleId: role.role.id,
          agentRoleRevision: role.role.revision,
          agentRoleInstanceId: role.instance.id,
        }
      : {}),
  });
  const seedRunConfig = (sessionId: SessionId) => {
    const accountId = store.get(sessionRunConfigDraftAccountAtom).accountId;
    if (!accountId || !runtime || !config || !shownAgent) return;
    const scope = {
      accountId,
      workspaceId: runtime.workspaceId,
      sessionId,
      targetKey: getSessionRunConfigDraftTargetKey({
        cliType: config.cliType,
        agentType: config.agentType,
        agentConfigId: config.id,
      }),
    };
    store.set(sessionRunConfigDraftsAtom, (drafts) =>
      new Map(drafts).set(getSessionRunConfigDraftKey(scope), {
        scope,
        ...(shownAgent.modeId !== undefined ? { mode: { value: shownAgent.modeId } } : {}),
        ...(shownAgent.modelId !== undefined ? { model: { value: shownAgent.modelId } } : {}),
        configOptions: Object.fromEntries(
          Object.entries(shownAgent.configOptionValues ?? {}).map(([id, value]) => [id, { value }])
        ),
      })
    );
  };
  /**
   * A new Board: its row, and a coordinator that has said nothing yet. The user
   * speaks first; the run config chosen here waits in the composer, the way a
   * draft of a new chat does.
   */
  const createBoard = async () => {
    if (!runtime || !user || !machine || !config || !shownAgent || saving) return;
    const board = normalizeBoardMeta({
      version: 1,
      id: ids.board,
      name: name.trim(),
      purpose: purpose.trim(),
      rules: DEFAULT_BOARD_RULES,
      coordinatorSessionId: ids.session,
      createdAtMs: Date.now(),
      createdByUserId: user.id,
      // The coordinator's machine keeps the Board directory.
      files: { machineId: machine.id },
      context: { projects: projectScope },
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
    try {
      await createWorkspaceBoard(runtime, board, () =>
        createSession({
          ...sessionPayload(
            { userId: user.id, machineId: machine.id, config },
            board,
            board.coordinatorSessionId,
            board.name
          ),
          boardRole: 'coordinator',
        })
      );
      if (!role) seedRunConfig(board.coordinatorSessionId);
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
  /** A new thread of an existing Board: it starts with its task, like a new chat. */
  const create = async () => {
    if (!existingBoard) return await createBoard();
    if (!runtime || !user || !machine || !config || !shownAgent || saving) return;
    const board = existingBoard;
    if (role && role.availability.kind !== 'available') {
      setError(t('boards.agentUnavailable', 'Choose an available agent.'));
      return;
    }
    setSaving(true);
    setError('');
    const task = purpose.trim();
    const inputBlocks = [{ type: 'text' as const, text: task }];
    const prompt = buildAgentPrompt(
      task,
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
      // The selector names no branch for a repository: start from its default one.
      const threadProjectRef =
        project?.kind === 'github'
          ? {
              ...project,
              branch: await withGitHubTokenRetry(
                runtime.workspaceId,
                project.repoFullName,
                (token) => githubFetchDefaultBranch(token, project.repoFullName)
              ),
            }
          : project;
      const created = await startSession(
        sessionPayload(
          { userId: user.id, machineId: machine.id, config },
          board,
          ids.session,
          name.trim(),
          threadProjectRef
        ),
        history
      );
      // The accepted turn already owns dispatch. RPC only accelerates it.
      void requestSessionDispatch(created.sessionId, created.historyEntry.id, {
        inputConfig,
        machineId: machine.id,
      }).catch((cause: unknown) => console.warn('Board thread dispatch deferred', cause));
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
  const coordinatorControls = (
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
  );
  if (!existingBoard)
    return (
      <BoardCreateDialogView
        goal={purpose}
        name={name}
        onGoalChange={setPurpose}
        onNameChange={setName}
        coordinator={coordinatorControls}
        projectScope={<BoardProjectScopePicker value={projectScope} onChange={setProjectScope} />}
        saving={saving}
        error={error}
        onSubmit={() => void create()}
        onClose={onClose}
      />
    );
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <Dialog.Content>
        <Dialog.Header>
          <Dialog.Title>{t('boards.newThread', '+ New thread')}</Dialog.Title>
          <Dialog.Description>
            {t(
              'boards.threadHelp',
              'Choose an agent and describe its task. The session joins this board.'
            )}
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
          {coordinatorControls}
          <div {...stylex.props(boardStyles.controls)}>
            <ProjectRefSelector
              triggerVariant="chip"
              value={project}
              onChange={setThreadProject}
              localProjects={machineProjects}
              repositories={(repositories ?? []).map((repository) => ({
                fullName: repository.fullName,
              }))}
              onAddLocalProject={() => openSettings('projects')}
              onConnectGitRepo={githubSettingsAvailable ? () => openSettings('github') : undefined}
            />
            {project?.kind === 'local' ? (
              <WorktreeCheckboxPill
                checked={project.useWorktree === true}
                onCheckedChange={(checked) =>
                  setThreadProject({ ...project, useWorktree: checked })
                }
              />
            ) : null}
          </div>
          {error ? (
            <p role="alert" {...stylex.props(boardStyles.error)}>
              {error}
            </p>
          ) : null}
          <Button type="submit" disabled={saving || !config || !machine}>
            {saving ? t('boards.creating', 'Creating…') : t('boards.newThread', '+ New thread')}
          </Button>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}
