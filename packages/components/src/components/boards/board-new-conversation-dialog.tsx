import { useState, type ReactNode } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import type { BoardCoordinatorAgent, MachineId } from '@lody/shared';
import { Dialog } from '@/ui/dialog';
import { getAllAgentConfigAtom } from '@/atoms/agents';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';
import { useMachineFlockAgentConfigs } from '@/hooks/use-machine-flock-agent-configs';
import { ScheduleAgentControls } from '../schedules/schedule-agent-controls';
import type { AgentRunRef } from '../shared/agent-run-ref';
import { boardStyles } from './board-view';

/** The dialog around the agent controls; Start waits until an agent is chosen. */
export function BoardNewConversationDialogView({
  controls,
  canStart,
  onStart,
  onClose,
}: {
  controls: ReactNode;
  canStart: boolean;
  onStart: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Content>
        <Dialog.Header>
          <Dialog.Title>
            {t('boards.maintenance.newConversation', 'Start a new conversation')}
          </Dialog.Title>
          <Dialog.Description>
            {t(
              'boards.maintenance.newConversationHelp',
              'The coordinator writes a handoff, then continues in a fresh agent conversation with the agent chosen here. The Board, its threads, notes and instructions stay.'
            )}
          </Dialog.Description>
        </Dialog.Header>
        <div {...stylex.props(boardStyles.controls)}>{controls}</div>
        <Dialog.Footer>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button disabled={!canStart} onClick={onStart}>
            {t('boards.maintenance.start', 'Start')}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}

/**
 * Starts a Board coordinator's new agent conversation with the agent and
 * settings it continues with: the current ones as its composer shows them, or
 * another agent on the coordinator's machine.
 */
export function BoardNewConversationDialog({
  machineId,
  current,
  onStart,
  onClose,
}: {
  machineId: MachineId;
  /** The coordinator's agent and the run settings its composer shows. */
  current: AgentRunRef | null;
  onStart: (agent: BoardCoordinatorAgent) => void;
  onClose: () => void;
}) {
  const { machines } = useVisibleMachineMetas();
  useMachineFlockAgentConfigs();
  const agents = useAtomValue(getAllAgentConfigAtom);
  const [agent, setAgent] = useState(current);
  return (
    <BoardNewConversationDialogView
      controls={
        <ScheduleAgentControls
          machine={machines.get(machineId)}
          agentConfigs={agents.filter((config) => config.machineId === machineId)}
          value={agent}
          onChange={setAgent}
        />
      }
      canStart={agent !== null}
      onStart={() => {
        if (!agent) return;
        // A memory binding stays with the coordinator's turns; the divider names only the agent.
        const { memory: _memory, ...chosen } = agent;
        onStart(chosen);
        onClose();
      }}
      onClose={onClose}
    />
  );
}
