import { useState } from 'react';
import { useAtomValue } from 'jotai';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import {
  type LocalProjectMeta,
  deriveBoardSessionStatus,
  LODY_MAX_CHAIN_DEPTH,
  type SessionMeta,
} from '@lody/shared';
import { sessionLiveStatusAtomFamily } from '@/atoms/presence';
import { getMachineMetaMapAtom } from '@/atoms/machines';
import { getAllAgentConfigAtom } from '@/atoms/agents';
import { useSessionDoc } from '@/hooks/use-session-doc';
import { useConversationTail } from '@/hooks/use-conversation-view';
import { BoardSessionRowView, boardStyles } from './board-view';

export function BoardSessionRow({
  session,
  depth,
  localProjects,
  onOpen,
}: {
  session: SessionMeta;
  depth: number;
  localProjects?: Readonly<Record<string, LocalProjectMeta>>;
  onOpen: () => void;
}) {
  const [expanded, setExpanded] = useState(session.boardRole === 'coordinator');
  const liveStatus = useAtomValue(sessionLiveStatusAtomFamily(session.id));
  const machines = useAtomValue(getMachineMetaMapAtom);
  const agents = useAtomValue(getAllAgentConfigAtom);
  const { t } = useTranslation();
  // No session document is acquired for a collapsed row.
  const { history, ready } = useSessionDoc(session.id, { enabled: expanded });
  const { turns } = useConversationTail(expanded ? history : null, { extendToLastUserTurn: true });
  const lastUser = turns.findLast((turn) => turn.role === 'user');
  const lastAssistant = turns.findLast((turn) => turn.role === 'assistant');
  const text = (turn: typeof lastUser) =>
    turn?.items?.flatMap((item) => (item.type === 'text' ? [item.text] : [])).join('\n') ?? '';
  const status = deriveBoardSessionStatus({
    liveStatus,
    awaitingUserSince: session.awaitingUserSince,
    lastMessageAt: session.lastMessageAt,
    lastUserTurn: lastUser,
    chatFailed: turns
      .slice(lastUser ? turns.indexOf(lastUser) : turns.length)
      .some(
        (turn) =>
          turn.role === 'system' &&
          turn.items?.some((item) => item.type === 'system_notice' && item.name === 'chat_failed')
      ),
  });
  const project = session.project;
  const machine = machines.get(session.machineId);
  const projects: Readonly<Record<string, LocalProjectMeta>> = {
    ...machine?.localProjects,
    ...localProjects,
  };
  const context =
    project?.kind === 'local'
      ? (projects[project.localProjectId]?.name ?? t('boards.localProject', 'Local project'))
      : project?.kind === 'github'
        ? project.repoFullName
        : t('boards.chat', 'Chat');
  const detail = [
    session.lastModel?.name ??
      agents.find((agent) => agent.id === session.agentConfigId)?.name ??
      session.agentType,
    machines.get(session.machineId)?.name ?? session.machineId,
    context,
    ...(session.isWorktree ? [t('boards.worktree', 'Worktree')] : []),
  ].join(' · ');
  return (
    <BoardSessionRowView
      session={session}
      detail={detail}
      depth={depth}
      status={status}
      expanded={expanded}
      onExpand={() => setExpanded(!expanded)}
      onOpen={onOpen}
    >
      <div {...stylex.props(boardStyles.preview)}>
        {session.boardRole === 'coordinator' ? (
          <p>
            {t('boards.chain', 'Autonomous chain {{depth}}/{{limit}}', {
              depth: lastUser ? (lastUser.inputConfig?.chainDepth ?? 0) : '—',
              limit: LODY_MAX_CHAIN_DEPTH,
            })}
          </p>
        ) : null}
        {!ready ? (
          t('boards.loading', 'Loading…')
        ) : (
          <>
            <p>{text(lastUser).split('\n')[0]}</p>
            <p>
              {text(lastAssistant).slice(-4000) || t('boards.noConclusion', 'No conclusion yet.')}
            </p>
          </>
        )}
      </div>
    </BoardSessionRowView>
  );
}
