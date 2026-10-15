import { z } from 'zod';
import type { LoroDoc } from 'loro-crdt';
import {
  BOARD_NOTES_MAX_BYTES,
  deriveBoardSessionStatus,
  isBoardSessionStopped,
  findFreshSessionPresenceState,
  getBoardRoomId,
  getSessionRoomId,
  getWorkspaceFlockDocId,
  normalizeBoardMeta,
  readBoardDocument,
  workspaceFlockKeys,
  writeBoardNotes,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import { getSessionCommandEnvironment } from '@/lib/session-command-environment';
import { listAliveSessionMetas } from '@/lib/command-runtime';
import type { createSessionToolRegistrar } from './session-tool-router';
import type { McpSessionContext } from './lody-mcp-server';

/** Invocations run only on the daemon's replica; headers advertise, metadata authorizes. */
export function registerBoardTools(
  register: ReturnType<typeof createSessionToolRegistrar>,
  context: () => McpSessionContext
) {
  const text = z.string().max(BOARD_NOTES_MAX_BYTES);
  const tools = [
    [
      'lody_board_get',
      'Read this Board, its rules, coordinator and your role.',
      z.object({}).strict(),
    ],
    [
      'lody_board_overview',
      'Read up to 100 Board member status rows (64 KiB maximum). Status uses metadata and live presence like collapsed Overview rows; use session_history for conclusions and failures.',
      z.object({}).strict(),
    ],
    ['lody_board_notes_get', 'Read the shared Board Markdown notes.', z.object({}).strict()],
    [
      'lody_board_notes_append',
      'Append a section to shared Board notes. Concurrent appends merge. The document is limited to 256 KiB UTF-8.',
      z.object({ text, heading: z.string().max(200).optional() }).strict(),
    ],
    [
      'lody_board_notes_replace',
      'Replace shared notes; only the Board coordinator may call this. Limit: 256 KiB UTF-8.',
      z.object({ text }).strict(),
    ],
  ] as const;
  for (const [name, description, inputSchema] of tools) {
    register(name, { description, inputSchema }, async (input) => {
      try {
        const environment = getSessionCommandEnvironment();
        if (!environment) throw new Error('Board tools require the local daemon');
        const { manager, workspace } = environment;
        const sessionId = context().sessionId;
        await manager
          .syncFlockDocOrThrow(getWorkspaceFlockDocId(workspace.id as WorkspaceId), {
            reason: 'board-tools',
          })
          .catch((error) => {
            console.warn('Board catalog refresh failed; using local rows', error);
          });
        const catalog = await manager.repo.openFlockDoc(
          getWorkspaceFlockDocId(workspace.id as WorkspaceId)
        );
        const readMember = async () => {
          const row = await manager.repo.getDocMeta(getSessionRoomId(sessionId));
          const session = row?.meta as SessionMeta | undefined;
          if (!session?.boardId) throw new Error('BOARD_NOT_MEMBER');
          const board = normalizeBoardMeta(
            catalog.flock.get(workspaceFlockKeys.board(session.boardId))
          );
          if (!board) throw new Error('BOARD_NOT_FOUND');
          return { session, board };
        };
        let { session, board } = await readMember();
        let result: unknown;
        if (name === 'lody_board_get') {
          result = { ...board, role: session.boardRole ?? 'thread' };
        } else if (name === 'lody_board_overview') {
          const sessions = new Map(
            (await listAliveSessionMetas(manager)).map(({ meta }) => [meta.id, meta])
          );
          const members = [...sessions.values()]
            .filter((meta) => meta.boardId === board.id)
            .sort((a, b) => a.id.localeCompare(b.id));
          const presence = manager.getPresenceStates() ?? {};
          const rows = [];
          for (const meta of members.slice(0, 100)) {
            const row = {
              sessionId: meta.id,
              title: meta.title,
              machineId: meta.machineId,
              agentType: meta.agentType,
              model: meta.lastModel?.name,
              project: meta.project,
              parentSessionId: meta.parentSessionId,
              openedBySessionId: meta.openedBySessionId,
              role: meta.boardRole ?? 'thread',
              archived: !!meta.isArchived,
              lastMessageAt: meta.lastMessageAt,
              status: deriveBoardSessionStatus({
                liveStatus: findFreshSessionPresenceState(presence, meta.id, Date.now())?.status,
                collaborationStopped: isBoardSessionStopped(meta, (id) => sessions.get(id)),
                awaitingUserSince: meta.awaitingUserSince,
                lastMessageAt: meta.lastMessageAt,
              }),
            };
            if (
              Buffer.byteLength(
                JSON.stringify({ boardId: board.id, rows: [...rows, row], truncated: true })
              ) >
              64 * 1024
            )
              break;
            rows.push(row);
          }
          result = { boardId: board.id, rows, truncated: rows.length < members.length };
        } else {
          const roomId = getBoardRoomId(board.id);
          const handle = await manager.repo.openPersistedDoc(roomId);
          // sync() uses the daemon's configured transport; local-only replicas need no network.
          await manager.syncDocOrThrow(roomId, { reason: 'board-notes' }).catch((error) => {
            console.warn('Board notes refresh failed; using local document', error);
          });
          const current = await readMember();
          if (current.board.id !== board.id) throw new Error('BOARD_NOT_MEMBER');
          ({ session, board } = current);
          const doc = handle.doc as LoroDoc;
          if (name === 'lody_board_notes_get') result = readBoardDocument(doc);
          else {
            if (
              name === 'lody_board_notes_replace' &&
              (session.boardRole !== 'coordinator' || board.coordinatorSessionId !== sessionId)
            )
              throw new Error('BOARD_COORDINATOR_REQUIRED');
            const body = 'text' in input ? input.text : '';
            const heading =
              'heading' in input && input.heading !== undefined
                ? input.heading
                : `${new Date().toISOString().slice(0, 10)} · ${session.title || sessionId}`;
            result = writeBoardNotes(doc, {
              kind: name === 'lody_board_notes_append' ? 'append' : 'replace',
              text: name === 'lody_board_notes_append' ? `\n\n## ${heading}\n\n${body}\n` : body,
              updatedBy: sessionId,
              now: Date.now(),
            });
            await manager.repo.flush();
            // The durable write succeeds even if the remote upload is temporarily unavailable.
            void manager.syncDocOrThrow(roomId, { reason: 'board-notes-upload' }).catch((error) => {
              console.warn('Board notes upload deferred', error);
            });
            result = { ok: true, boardId: board.id, workspaceId: workspace.id };
          }
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: 'text' as const, text: error instanceof Error ? error.message : String(error) },
          ],
        };
      }
    });
  }
}
