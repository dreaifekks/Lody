import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { LoroDoc } from 'loro-crdt';
import {
  BOARD_NOTES_MAX_BYTES,
  BoardFileAreaSchema,
  BoardFilePathSchema,
  boardFilesMachineId,
  deriveBoardSessionStatus,
  isBoardMaintenanceEntry,
  isBoardMaintenanceTurnId,
  isBoardSessionStopped,
  findFreshSessionPresenceState,
  getBoardRoomId,
  getSessionRoomId,
  getWorkspaceFlockDocId,
  normalizeBoardMeta,
  readBoardDocument,
  workspaceFlockKeys,
  writeBoardNotes,
  type SessionHistoryInput,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import {
  BOARD_LINE_MAX_PINS,
  BoardLineStore,
  clampCodePoints,
  isValidBoardLineNodeId,
} from '@/lib/board-line-store';
import { getSessionCommandEnvironment } from '@/lib/session-command-environment';
import { listAliveSessionMetas } from '@/lib/command-runtime';
import { resolveContainedUploadPath } from '@/lib/session-file-attachments';
import { extractVisibleTurnText } from '@/orchestration/board-fold-opening';
import { createSessionBackend } from '@/session/session-backend';
import type { createSessionToolRegistrar } from './session-tool-router';
import type { McpSessionContext } from './lody-mcp-server';

const BOARD_LINE_EXPAND_DEFAULT_LIMIT = 20;
const BOARD_LINE_EXPAND_MAX_BYTES = 32 * 1024;
const BOARD_LINE_EXPAND_TURN_MAX_CHARS = 8_000;

type ExpandedSegmentTurn = {
  id: string;
  role: SessionHistoryInput['role'];
  timestamp: string;
  userTurnId?: string;
  text: string;
};

function sliceSegmentHistoryTurns(
  history: readonly SessionHistoryInput[],
  turnRange: { startTurnId: string; endTurnId: string; turnCount: number }
): ExpandedSegmentTurn[] {
  if (turnRange.turnCount === 0 || history.length === 0) return [];
  const startIndex = history.findIndex((entry) => entry.id === turnRange.startTurnId);
  let endIndex = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.id === turnRange.endTurnId) {
      endIndex = i;
      break;
    }
  }
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) return [];
  const out: ExpandedSegmentTurn[] = [];
  for (let i = startIndex; i <= endIndex; i++) {
    const entry = history[i]!;
    if (isBoardMaintenanceTurnId(entry.id) || isBoardMaintenanceEntry(entry)) continue;
    const text = extractVisibleTurnText(entry);
    if (!text) continue;
    out.push({
      id: entry.id,
      role: entry.role,
      timestamp: entry.timestamp,
      ...(entry.userTurnId ? { userTurnId: entry.userTurnId } : {}),
      text: clampCodePoints(text, BOARD_LINE_EXPAND_TURN_MAX_CHARS),
    });
  }
  return out;
}

function fitTurnTextToByteBudget(
  build: (turn: ExpandedSegmentTurn) => unknown,
  turn: ExpandedSegmentTurn,
  maxBytes: number
): ExpandedSegmentTurn {
  if (Buffer.byteLength(JSON.stringify(build(turn))) <= maxBytes) return turn;
  const chars = Array.from(turn.text);
  let low = 0;
  let high = chars.length;
  let best = '';
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = mid === 0 ? '…' : `${chars.slice(0, mid).join('')}…`;
    if (Buffer.byteLength(JSON.stringify(build({ ...turn, text: candidate }))) <= maxBytes) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return { ...turn, text: best || '…' };
}

/** Invocations run only on the daemon's replica; headers advertise, metadata authorizes. */
export function registerBoardTools(
  register: ReturnType<typeof createSessionToolRegistrar>,
  context: () => McpSessionContext
) {
  const text = z.string().max(BOARD_NOTES_MAX_BYTES);
  const tools = [
    [
      'lody_board_get',
      'Read this Board, its rules, project scope, coordinator and your role.',
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
    [
      'lody_board_files_list',
      'List the Board shared directory: area "files" (shared files, the default) or "memory" (agent memory, indexed by MEMORY.md). Works from any machine of the Board.',
      z.object({ area: BoardFileAreaSchema.optional() }).strict(),
    ],
    [
      'lody_board_files_read',
      'Copy a file of the Board shared directory to saveTo, an absolute path in your working directory that does not exist yet.',
      z
        .object({
          path: BoardFilePathSchema,
          area: BoardFileAreaSchema.optional(),
          saveTo: z.string().min(1).max(4096),
        })
        .strict(),
    ],
    [
      'lody_board_files_write',
      'Put a file of your working directory (source, an absolute path) into the Board shared directory at path (default: its file name). Replaces a file of that name.',
      z
        .object({
          source: z.string().min(1).max(4096),
          path: BoardFilePathSchema.optional(),
          area: BoardFileAreaSchema.optional(),
        })
        .strict(),
    ],
    [
      'lody_board_line_expand',
      'Expand a Board fold-rollover history node. For a fold node, returns its covered lower-level nodes with full summaries; for a segment node, reads the coordinator Loro transcript turns in that segment (paginated, up to 32 KiB).',
      z
        .object({
          nodeId: z.string().min(1).max(64),
          offset: z.number().int().min(0).optional(),
          limit: z.number().int().min(1).max(100).optional(),
        })
        .strict(),
    ],
    [
      'lody_board_line_pin',
      'Pin or unpin a Board fold-rollover history node (maximum 8 pins) so it stays preserved across rollovers. Only the Board coordinator may call this.',
      z
        .object({
          nodeId: z.string().min(1).max(64),
          pinned: z.boolean(),
        })
        .strict(),
    ],
  ] as const;
  for (const [name, description, inputSchema] of tools) {
    register(name, { summary: description, description, inputSchema }, async (input) => {
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
        } else if (
          name === 'lody_board_files_list' ||
          name === 'lody_board_files_read' ||
          name === 'lody_board_files_write'
        ) {
          const files = environment.host.boardFiles;
          if (!files) throw new Error('BOARD_FILES_UNAVAILABLE');
          const scope = {
            boardId: board.id,
            sessionId,
            area: ('area' in input && input.area) || ('files' as const),
          };
          // Like attachments, the caller's own paths stay inside its working
          // directory, links resolved, so the tools reach no more than the Agent may.
          const { workdir } = context();
          if (name === 'lody_board_files_list') result = await files.list(scope);
          else if (name === 'lody_board_files_read' && 'saveTo' in input) {
            if (!path.isAbsolute(input.saveTo)) throw new Error('saveTo must be an absolute path');
            const saveTo = await resolveContainedUploadPath(input.saveTo, workdir);
            result = { ...(await files.read(scope, input.path, saveTo)), savedTo: saveTo };
          } else if ('source' in input) {
            if (!path.isAbsolute(input.source)) throw new Error('source must be an absolute path');
            const source = await resolveContainedUploadPath(
              await fs.promises.realpath(input.source),
              workdir
            );
            result = await files.put(scope, input.path ?? path.basename(input.source), source);
          }
        } else if (name === 'lody_board_line_expand' || name === 'lody_board_line_pin') {
          if (
            name === 'lody_board_line_pin' &&
            (session.boardRole !== 'coordinator' || board.coordinatorSessionId !== sessionId)
          ) {
            throw new Error('BOARD_COORDINATOR_REQUIRED');
          }
          const coordinatorRow = await manager.repo.getDocMeta(
            getSessionRoomId(board.coordinatorSessionId)
          );
          const coordinatorMeta = coordinatorRow?.meta as SessionMeta | undefined;
          const keeper = boardFilesMachineId(board, coordinatorMeta);
          const localMachineId = environment.auth?.machineId ?? context().machineId;
          if (keeper && keeper !== localMachineId) {
            throw new Error('BOARD_LINE_LOCAL_ONLY');
          }
          const lineStore = environment.host.boardLineStore ?? new BoardLineStore(getLodyDataDir);
          const nodeId = 'nodeId' in input ? input.nodeId : '';
          if (!isValidBoardLineNodeId(nodeId)) {
            throw new Error(`BOARD_LINE_INVALID_NODE_ID:Invalid nodeId "${nodeId}"`);
          }
          if (name === 'lody_board_line_pin' && 'pinned' in input) {
            const updated = await lineStore.setPinned(workspace.id, board.id, nodeId, input.pinned);
            result = {
              ok: true,
              boardId: board.id,
              ...updated,
              maxPins: BOARD_LINE_MAX_PINS,
            };
          } else {
            const tree = await lineStore.readTree(workspace.id, board.id);
            const node = tree.byId.get(nodeId);
            if (!node) throw new Error(`BOARD_LINE_NODE_NOT_FOUND:Node "${nodeId}" does not exist`);
            if (node.meta.kind === 'fold') {
              result = {
                boardId: board.id,
                node: node.meta,
                summary: node.summary,
                pinned: tree.pins.includes(node.meta.id),
                children: node.meta.covers.map((childId) => {
                  const child = tree.byId.get(childId);
                  if (!child) return { id: childId, missing: true };
                  return {
                    id: child.meta.id,
                    kind: child.meta.kind,
                    seq: child.meta.seq,
                    level: child.meta.level,
                    coversFrom: child.meta.coversFrom,
                    coversTo: child.meta.coversTo,
                    title: child.meta.title,
                    tags: child.meta.tags,
                    summaryQuality: child.meta.summaryQuality,
                    pinned: tree.pins.includes(child.meta.id),
                    summary: child.summary,
                  };
                }),
              };
            } else {
              const offset = 'offset' in input && input.offset !== undefined ? input.offset : 0;
              const limit =
                'limit' in input && input.limit !== undefined
                  ? input.limit
                  : BOARD_LINE_EXPAND_DEFAULT_LIMIT;
              const coordinatorDoc = await manager.getOrCreateSessionDoc(
                board.coordinatorSessionId
              );
              const backend = await createSessionBackend(coordinatorDoc, coordinatorMeta);
              const history = await backend.readHistory();
              const allTurns = sliceSegmentHistoryTurns(history, node.meta.turnRange);
              const page = allTurns.slice(offset, offset + limit);
              const turns: ExpandedSegmentTurn[] = [];
              let truncatedByBytes = false;
              const makePayload = (candidateTurns: ExpandedSegmentTurn[], truncated: boolean) => {
                const hasMore = offset + candidateTurns.length < allTurns.length;
                return {
                  boardId: board.id,
                  sessionId: board.coordinatorSessionId,
                  node: node.meta,
                  summary: node.summary,
                  pinned: tree.pins.includes(node.meta.id),
                  offset,
                  limit,
                  totalTurns: allTurns.length,
                  turns: candidateTurns,
                  hasMore,
                  ...(hasMore ? { nextOffset: offset + candidateTurns.length } : {}),
                  ...(truncated ? { truncatedByBytes: true } : {}),
                };
              };
              for (const turn of page) {
                const candidate = [...turns, turn];
                if (
                  Buffer.byteLength(JSON.stringify(makePayload(candidate, false))) <=
                  BOARD_LINE_EXPAND_MAX_BYTES
                ) {
                  turns.push(turn);
                  continue;
                }
                truncatedByBytes = true;
                if (turns.length === 0) {
                  turns.push(
                    fitTurnTextToByteBudget(
                      (fitted) => makePayload([fitted], true),
                      turn,
                      BOARD_LINE_EXPAND_MAX_BYTES
                    )
                  );
                }
                break;
              }
              result = makePayload(turns, truncatedByBytes);
            }
          }
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
            {
              type: 'text' as const,
              text: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
    });
  }
}
