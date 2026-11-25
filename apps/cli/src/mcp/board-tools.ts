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
  getSharedBoardLineStore,
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
/** Target ceiling for node summary on page 0 so children/turns retain room within the 32 KiB cap. */
const BOARD_LINE_EXPAND_SUMMARY_MAX_BYTES = 10 * 1024;
const BOARD_LINE_EXPAND_CONTINUATION_HINT =
  'Call lody_board_line_expand with the returned nextCharOffset (same offset) to read the remainder of this turn, or increment offset / call lody_session_history.';

type ExpandedSegmentTurn = {
  id: string;
  role: SessionHistoryInput['role'];
  timestamp: string;
  userTurnId?: string;
  text: string;
  truncated?: true;
  charOffset?: number;
  nextCharOffset?: number;
  totalChars?: number;
  hint?: string;
};

type ExpandedFoldChild =
  | { id: string; missing: true }
  | {
      id: string;
      kind: 'segment' | 'fold';
      seq: number;
      level: number;
      coversFrom: string;
      coversTo: string;
      title: string;
      tags: string[];
      summaryQuality: 'written' | 'fallback';
      pinned: boolean;
      summary: string;
      summaryTruncated?: true;
    };

function fitStringToJsonByteBudget(
  build: (candidate: string, consumedChars: number) => unknown,
  text: string,
  maxBytes: number,
  appendEllipsis: boolean
): { text: string; truncated: boolean; consumedChars: number } {
  const chars = Array.from(text);
  if (Buffer.byteLength(JSON.stringify(build(text, chars.length)), 'utf8') <= maxBytes) {
    return { text, truncated: false, consumedChars: chars.length };
  }
  let low = 0;
  let high = chars.length;
  let bestMid = 0;
  let bestText = '';
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const prefix = chars.slice(0, mid).join('');
    const candidate = appendEllipsis ? (mid === 0 ? '…' : `${prefix}…`) : prefix;
    if (Buffer.byteLength(JSON.stringify(build(candidate, mid)), 'utf8') <= maxBytes) {
      bestMid = mid;
      bestText = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (
    !bestText &&
    appendEllipsis &&
    Buffer.byteLength(JSON.stringify(build('', 0)), 'utf8') <= maxBytes
  ) {
    return { text: '', truncated: true, consumedChars: 0 };
  }
  return { text: bestText, truncated: true, consumedChars: bestMid };
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
      'Expand a Board fold-rollover history node (strictly <= 32 KiB UTF-8 per response). For a fold node, returns its covered lower-level nodes paginated by offset/limit; for a segment node, reads coordinator Loro turns paginated by offset/limit (pass charOffset to continue an oversized turn).',
      z
        .object({
          nodeId: z.string().min(1).max(64),
          offset: z.number().int().min(0).optional(),
          limit: z.number().int().min(1).max(100).optional(),
          charOffset: z.number().int().min(0).optional(),
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
          if (!keeper || keeper !== localMachineId) {
            throw new Error('BOARD_LINE_LOCAL_ONLY');
          }
          const lineStore =
            environment.host.boardLineStore ?? getSharedBoardLineStore(getLodyDataDir);
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
            const offset = 'offset' in input && input.offset !== undefined ? input.offset : 0;
            const limit =
              'limit' in input && input.limit !== undefined
                ? input.limit
                : BOARD_LINE_EXPAND_DEFAULT_LIMIT;
            if (node.meta.kind === 'fold') {
              const totalChildren = node.meta.covers.length;
              const pageCoverIds = node.meta.covers.slice(offset, offset + limit);
              const includeSummary = offset === 0;
              const makeFoldPayload = (
                candidateChildren: ExpandedFoldChild[],
                summaryValue: string | undefined,
                summaryTrimmed: boolean,
                truncated: boolean
              ) => {
                const hasMore = offset + candidateChildren.length < totalChildren;
                return {
                  boardId: board.id,
                  node: node.meta,
                  ...(summaryValue !== undefined ? { summary: summaryValue } : {}),
                  ...(summaryTrimmed ? { summaryTruncated: true as const } : {}),
                  pinned: tree.pins.includes(node.meta.id),
                  offset,
                  limit,
                  totalChildren,
                  children: candidateChildren,
                  hasMore,
                  ...(hasMore ? { nextOffset: offset + candidateChildren.length } : {}),
                  ...(truncated ? { truncatedByBytes: true as const } : {}),
                };
              };
              let summaryText: string | undefined;
              let summaryTruncated = false;
              if (includeSummary) {
                const emptyEnvelopeBytes = Buffer.byteLength(
                  JSON.stringify(makeFoldPayload([], '', true, true)),
                  'utf8'
                );
                const summaryBudget =
                  pageCoverIds.length > 0
                    ? Math.min(
                        BOARD_LINE_EXPAND_MAX_BYTES - 6 * 1024,
                        emptyEnvelopeBytes + BOARD_LINE_EXPAND_SUMMARY_MAX_BYTES
                      )
                    : BOARD_LINE_EXPAND_MAX_BYTES;
                const fittedSummary = fitStringToJsonByteBudget(
                  (candidate) => makeFoldPayload([], candidate, true, true),
                  node.summary,
                  Math.max(emptyEnvelopeBytes, summaryBudget),
                  true
                );
                summaryText = fittedSummary.text;
                summaryTruncated = fittedSummary.truncated;
              }
              const children: ExpandedFoldChild[] = [];
              let truncatedByBytes = false;
              for (const childId of pageCoverIds) {
                const child = tree.byId.get(childId);
                const childObj: ExpandedFoldChild = !child
                  ? { id: childId, missing: true }
                  : {
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
                const candidate = [...children, childObj];
                const reserveTruncated =
                  truncatedByBytes || offset + candidate.length < totalChildren;
                if (
                  Buffer.byteLength(
                    JSON.stringify(
                      makeFoldPayload(candidate, summaryText, summaryTruncated, reserveTruncated)
                    ),
                    'utf8'
                  ) <= BOARD_LINE_EXPAND_MAX_BYTES
                ) {
                  children.push(childObj);
                  continue;
                }
                truncatedByBytes = true;
                if (children.length === 0 && !('missing' in childObj)) {
                  const fittedChild = fitStringToJsonByteBudget(
                    (candidateSummary) =>
                      makeFoldPayload(
                        [{ ...childObj, summary: candidateSummary, summaryTruncated: true }],
                        summaryText,
                        summaryTruncated,
                        true
                      ),
                    childObj.summary,
                    BOARD_LINE_EXPAND_MAX_BYTES,
                    true
                  );
                  children.push({
                    ...childObj,
                    summary: fittedChild.text,
                    summaryTruncated: true,
                  });
                }
                break;
              }
              result = makeFoldPayload(children, summaryText, summaryTruncated, truncatedByBytes);
            } else {
              const charOffset =
                'charOffset' in input && input.charOffset !== undefined ? input.charOffset : 0;
              const coordinatorDoc = await manager.getOrCreateSessionDoc(
                board.coordinatorSessionId
              );
              const backend = await createSessionBackend(coordinatorDoc, coordinatorMeta);
              const historyCount = await backend.readHistoryCount();
              const rangeIds: string[] = [];
              if (node.meta.turnRange.turnCount > 0 && historyCount > 0) {
                const directory = await backend.readHistoryDirectory(0, historyCount);
                let startIdx = -1;
                let endIdx = -1;
                for (let idx = 0; idx < directory.length; idx++) {
                  const rowId = directory[idx]!.scalars?.id ?? directory[idx]!.turnId;
                  if (rowId === node.meta.turnRange.startTurnId && startIdx === -1) {
                    startIdx = idx;
                  }
                  if (rowId === node.meta.turnRange.endTurnId) {
                    endIdx = idx;
                  }
                }
                if (startIdx !== -1 && endIdx !== -1 && endIdx >= startIdx) {
                  for (let idx = startIdx; idx <= endIdx; idx++) {
                    const row = directory[idx]!;
                    const rowId = row.scalars?.id ?? row.turnId;
                    if (!rowId || row.state !== 'ready') continue;
                    if (isBoardMaintenanceTurnId(rowId)) continue;
                    if (
                      row.scalars?.role === 'assistant' &&
                      isBoardMaintenanceTurnId(row.scalars.userTurnId)
                    ) {
                      continue;
                    }
                    rangeIds.push(rowId);
                  }
                }
              }
              const totalTurns = rangeIds.length;
              const includeSummary = offset === 0 && charOffset === 0;
              const makeSegmentPayload = (
                candidateTurns: ExpandedSegmentTurn[],
                summaryValue: string | undefined,
                summaryTrimmed: boolean,
                paging: {
                  hasMore: boolean;
                  nextOffset?: number;
                  nextCharOffset?: number;
                  truncatedByBytes: boolean;
                }
              ) => ({
                boardId: board.id,
                sessionId: board.coordinatorSessionId,
                node: node.meta,
                ...(summaryValue !== undefined ? { summary: summaryValue } : {}),
                ...(summaryTrimmed ? { summaryTruncated: true as const } : {}),
                pinned: tree.pins.includes(node.meta.id),
                offset,
                limit,
                totalTurns,
                turns: candidateTurns,
                hasMore: paging.hasMore,
                ...(paging.hasMore && paging.nextOffset !== undefined
                  ? { nextOffset: paging.nextOffset }
                  : {}),
                ...(paging.nextCharOffset !== undefined
                  ? { nextCharOffset: paging.nextCharOffset }
                  : {}),
                ...(paging.truncatedByBytes ? { truncatedByBytes: true as const } : {}),
              });

              let summaryText: string | undefined;
              let summaryTruncated = false;
              if (includeSummary) {
                const emptyEnvelopeBytes = Buffer.byteLength(
                  JSON.stringify(
                    makeSegmentPayload([], '', true, {
                      hasMore: true,
                      nextOffset: totalTurns,
                      nextCharOffset: 999_999,
                      truncatedByBytes: true,
                    })
                  ),
                  'utf8'
                );
                const summaryBudget =
                  totalTurns > 0
                    ? Math.min(
                        BOARD_LINE_EXPAND_MAX_BYTES - 6 * 1024,
                        emptyEnvelopeBytes + BOARD_LINE_EXPAND_SUMMARY_MAX_BYTES
                      )
                    : BOARD_LINE_EXPAND_MAX_BYTES;
                const fittedSummary = fitStringToJsonByteBudget(
                  (candidate) =>
                    makeSegmentPayload([], candidate, true, {
                      hasMore: true,
                      nextOffset: totalTurns,
                      nextCharOffset: 999_999,
                      truncatedByBytes: true,
                    }),
                  node.summary,
                  Math.max(emptyEnvelopeBytes, summaryBudget),
                  true
                );
                summaryText = fittedSummary.text;
                summaryTruncated = fittedSummary.truncated;
              }

              const turns: ExpandedSegmentTurn[] = [];
              let truncatedByBytes = false;
              let nextIndex = offset;
              let nextCharOffset: number | undefined;

              for (let idx = offset; idx < rangeIds.length && turns.length < limit; idx++) {
                const read = await backend.readTurn(rangeIds[idx]!);
                if (read.state !== 'ready') {
                  nextIndex = idx + 1;
                  continue;
                }
                const entry = read.turn as SessionHistoryInput;
                if (isBoardMaintenanceEntry(entry)) {
                  nextIndex = idx + 1;
                  continue;
                }
                const fullText = extractVisibleTurnText(entry);
                if (!fullText) {
                  nextIndex = idx + 1;
                  continue;
                }
                const fullChars = Array.from(fullText);
                const startChar = idx === offset && turns.length === 0 ? charOffset : 0;
                if (startChar >= fullChars.length) {
                  nextIndex = idx + 1;
                  continue;
                }
                const sliceChars = startChar > 0 ? fullChars.slice(startChar) : fullChars;
                const sliceText = sliceChars.join('');
                const turnObj: ExpandedSegmentTurn = {
                  id: entry.id,
                  role: entry.role,
                  timestamp: entry.timestamp,
                  ...(entry.userTurnId ? { userTurnId: entry.userTurnId } : {}),
                  text: sliceText,
                  ...(startChar > 0 ? { charOffset: startChar, totalChars: fullChars.length } : {}),
                };
                const candidate = [...turns, turnObj];
                const hasMoreAfterThis = idx + 1 < rangeIds.length;
                const reserveTruncated = truncatedByBytes || hasMoreAfterThis;
                if (
                  Buffer.byteLength(
                    JSON.stringify(
                      makeSegmentPayload(candidate, summaryText, summaryTruncated, {
                        hasMore: hasMoreAfterThis,
                        nextOffset: hasMoreAfterThis ? idx + 1 : undefined,
                        truncatedByBytes: reserveTruncated,
                      })
                    ),
                    'utf8'
                  ) <= BOARD_LINE_EXPAND_MAX_BYTES
                ) {
                  turns.push(turnObj);
                  nextIndex = idx + 1;
                  continue;
                }
                truncatedByBytes = true;
                if (turns.length === 0) {
                  const fitted = fitStringToJsonByteBudget(
                    (chunkText, consumedChars) => {
                      const nextChar = startChar + consumedChars;
                      return makeSegmentPayload(
                        [
                          {
                            id: entry.id,
                            role: entry.role,
                            timestamp: entry.timestamp,
                            ...(entry.userTurnId ? { userTurnId: entry.userTurnId } : {}),
                            text: chunkText,
                            truncated: true,
                            charOffset: startChar,
                            nextCharOffset: nextChar,
                            totalChars: fullChars.length,
                            hint: BOARD_LINE_EXPAND_CONTINUATION_HINT,
                          },
                        ],
                        summaryText,
                        summaryTruncated,
                        {
                          hasMore: true,
                          nextOffset: idx,
                          nextCharOffset: nextChar,
                          truncatedByBytes: true,
                        }
                      );
                    },
                    sliceText,
                    BOARD_LINE_EXPAND_MAX_BYTES,
                    false
                  );
                  const nextChar = startChar + fitted.consumedChars;
                  turns.push({
                    id: entry.id,
                    role: entry.role,
                    timestamp: entry.timestamp,
                    ...(entry.userTurnId ? { userTurnId: entry.userTurnId } : {}),
                    text: fitted.text,
                    truncated: true,
                    charOffset: startChar,
                    nextCharOffset: nextChar,
                    totalChars: fullChars.length,
                    hint: BOARD_LINE_EXPAND_CONTINUATION_HINT,
                  });
                  nextIndex = idx;
                  nextCharOffset = nextChar;
                } else {
                  nextIndex = idx;
                }
                break;
              }
              const hasMore = nextCharOffset !== undefined || nextIndex < totalTurns;
              result = makeSegmentPayload(turns, summaryText, summaryTruncated, {
                hasMore,
                nextOffset: hasMore ? nextIndex : undefined,
                nextCharOffset,
                truncatedByBytes,
              });
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
