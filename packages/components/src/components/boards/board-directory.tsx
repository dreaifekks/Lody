import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { Button } from '@lody/ui/button';
import { ArrowLeft, Download } from 'lucide-react';
import { useAtomValue } from 'jotai';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BoardFileListSchema,
  boardFilesMachineId,
  getSessionRoomId,
  type BoardFileArea,
  type BoardFileEntry,
  type BoardFileList,
  type BoardMeta,
} from '@lody/shared';
import { currentWorkspaceIdAtom } from '@/atoms';
import { sessionMetaCacheAtom } from '@/atoms/doc-meta';
import { localMachineIdAtom } from '@/atoms/local-probe';
import { MarkdownRenderer } from '@/components/ai-gui/markdown-renderer';
import { useStableNow } from '@/hooks/use-stable-now';
import {
  BoardDirectoryFileProvider,
  type BoardFileLinkTarget,
} from '@/lib/board-directory-file-provider';
import { getIpcServices } from '@/lib/electron-ipc-client';
import { formatCompactRelativeTime } from '@/lib/format-relative-time';
import { toast } from '@/lib/toast';

export type BoardDirectoryState =
  | { status: 'loading' }
  | { status: 'ready'; list: BoardFileList }
  | { status: 'unavailable'; reason: string };

/**
 * One area of the Board's shared directory, as this machine's agent service
 * lists it: from its own disk, or over the LAN from the machine that keeps it.
 * The coordinator is the member the desktop asks as. Rejects with the reason.
 */
async function listBoardDirectory(
  target: { workspaceId: string; machineId: string },
  scope: { boardId: string; sessionId: string; area: BoardFileArea }
): Promise<BoardFileList> {
  const send = getIpcServices()?.machineRpc.send;
  if (!send) throw new Error('no_local_agent');
  const response = await send({ ...target, method: 'board/files-list', params: scope });
  if (!response.ok) throw new Error(response.error);
  const list = BoardFileListSchema.safeParse(response.result);
  if (!list.success) throw new Error('invalid_answer');
  return list.data;
}

export function useBoardDirectory(board: BoardMeta, area: BoardFileArea) {
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const machineId = useAtomValue(localMachineIdAtom);
  const [state, setState] = useState<BoardDirectoryState>({ status: 'loading' });
  const [generation, setGeneration] = useState(0);
  const boardId = board.id;
  const sessionId = board.coordinatorSessionId;
  useEffect(() => {
    if (!workspaceId || !machineId) {
      setState({ status: 'unavailable', reason: 'no_local_agent' });
      return undefined;
    }
    let cancelled = false;
    setState({ status: 'loading' });
    void listBoardDirectory({ workspaceId, machineId }, { boardId, sessionId, area }).then(
      (list) => {
        if (!cancelled) setState({ status: 'ready', list });
      },
      (error: unknown) => {
        if (!cancelled)
          setState({
            status: 'unavailable',
            reason: error instanceof Error ? error.message : String(error),
          });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [area, boardId, generation, machineId, sessionId, workspaceId]);
  return { state, reload: () => setGeneration((value) => value + 1) };
}

/** The message for a directory that cannot be read. */
export function useBoardDirectoryUnavailable() {
  const { t } = useTranslation();
  return (reason: string) =>
    t(
      'boards.files.unavailable',
      'The shared directory cannot be read now: {{reason}}. The machine that keeps it may be offline.',
      { reason }
    );
}

/**
 * The `files/` area for the session file tree: a provider per Board and agent
 * service, so reopening the tab lists it afresh, and whether the listing
 * stopped at its 500-file limit.
 */
export function useBoardDirectoryFileProvider(board: BoardMeta) {
  const { t } = useTranslation();
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const machineId = useAtomValue(localMachineIdAtom);
  const boardId = board.id;
  const sessionId = board.coordinatorSessionId;
  const [truncated, setTruncated] = useState(false);
  const provider = useMemo(
    () =>
      workspaceId && machineId && getIpcServices()
        ? new BoardDirectoryFileProvider(() =>
            listBoardDirectory(
              { workspaceId, machineId },
              { boardId, sessionId, area: 'files' }
            ).then(
              (list) => {
                setTruncated(list.truncated);
                return list;
              },
              (error: unknown) => {
                throw new Error(
                  t(
                    'boards.files.unavailable',
                    'The shared directory cannot be read now: {{reason}}. The machine that keeps it may be offline.',
                    { reason: error instanceof Error ? error.message : String(error) }
                  )
                );
              }
            )
          )
        : null,
    [boardId, machineId, sessionId, t, workspaceId]
  );
  return { provider, truncated };
}

/**
 * Saves a file of the directory where the user chooses, whatever its size,
 * from the machine that keeps it. `null` where no agent service is reachable.
 */
export function useBoardFileDownload(
  board: BoardMeta,
  area: BoardFileArea,
  sessionId = board.coordinatorSessionId
) {
  const { t } = useTranslation();
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const metas = useAtomValue(sessionMetaCacheAtom);
  const host = boardFilesMachineId(board, metas[getSessionRoomId(board.coordinatorSessionId)]);
  const boardId = board.id;
  return useMemo(() => {
    const ipc = getIpcServices();
    if (!ipc || !workspaceId || !host) return null;
    return (filePath: string) => {
      const name = filePath.split('/').pop() ?? filePath;
      void ipc.machineRpc
        .saveMemberFile({
          workspaceId,
          machineId: host,
          sessionId,
          boardId,
          path: `${area}/${filePath}`,
          fileName: name,
        })
        .then((result) => {
          if (!result.ok)
            toast.error(t('boards.files.downloadFailed', 'Could not download that file.'), {
              description: result.error,
            });
          else if (result.saved)
            toast.success(t('boards.files.downloaded', 'Saved {{name}}', { name }));
        });
    };
  }, [area, boardId, host, sessionId, t, workspaceId]);
}

const styles = stylex.create({
  rows: { display: 'flex', flexDirection: 'column' },
  row: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    columnGap: space[3],
    alignItems: 'center',
    width: '100%',
    paddingBlock: space[2],
    paddingInline: space[2],
    borderWidth: 0,
    borderRadius: radius.medium,
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    color: colors.label,
    textAlign: 'start',
    cursor: 'pointer',
  },
  name: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.bodySize,
    textDecorationLine: 'underline',
    textDecorationColor: colors.separator,
    textUnderlineOffset: '3px',
  },
  updated: { fontSize: text.footnoteSize, color: colors.secondaryLabel, whiteSpace: 'nowrap' },
  note: {
    margin: 0,
    paddingInline: space[2],
    paddingBlock: space[2],
    fontSize: text.footnoteSize,
    color: colors.secondaryLabel,
  },
  preview: { display: 'flex', flexDirection: 'column', gap: space[2], minWidth: 0 },
  noPreview: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: space[1],
    paddingInline: space[2],
  },
  previewHeader: { display: 'flex', alignItems: 'center', gap: space[1], minWidth: 0 },
  previewName: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.bodySize,
    fontWeight: 600,
  },
  text: {
    margin: 0,
    padding: space[3],
    borderRadius: radius.medium,
    backgroundColor: colors.secondaryBackground,
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: text.footnoteSize,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  image: { maxWidth: '100%', borderRadius: radius.medium },
});

/** Files of one area: name, and when it last changed. */
export function BoardFileRowsView({
  entries,
  onOpen,
}: {
  entries: readonly BoardFileEntry[];
  onOpen: (entry: BoardFileEntry) => void;
}) {
  const { t } = useTranslation();
  const now = useStableNow();
  return (
    <div {...stylex.props(styles.rows)}>
      {entries.map((entry) => (
        <button
          key={entry.path}
          type="button"
          data-scope-item="row"
          data-id={entry.path}
          onClick={() => onOpen(entry)}
          {...stylex.props(styles.row)}
        >
          <span {...stylex.props(styles.name)}>{entry.path}</span>
          <span {...stylex.props(styles.updated)}>
            {t('boards.files.updated', 'Updated {{time}}', {
              time: formatCompactRelativeTime(entry.modifiedAtMs, now),
            })}
          </span>
        </button>
      ))}
    </div>
  );
}

/** What a directory listing says when it has no rows to show. */
export function BoardDirectoryNote({
  state,
  empty,
}: {
  state: BoardDirectoryState;
  empty: string;
}) {
  const { t } = useTranslation();
  const unavailable = useBoardDirectoryUnavailable();
  const message =
    state.status === 'loading'
      ? t('boards.loading', 'Loading…')
      : state.status === 'unavailable'
        ? unavailable(state.reason)
        : state.list.entries.length === 0
          ? empty
          : state.list.truncated
            ? t('boards.files.truncated', 'Only the first 500 files are listed.')
            : null;
  return message ? <p {...stylex.props(styles.note)}>{message}</p> : null;
}

const TEXT_PREVIEW_BYTES = 256 * 1024;
const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;
const TEXT = /\.(md|markdown|txt|json|ya?ml|toml|csv|log|ts|tsx|js|jsx|py|go|rs|sh|html|css)$/i;

type Preview =
  | { status: 'loading' }
  | { status: 'text'; text: string; cut: boolean }
  | { status: 'image'; url: string }
  | { status: 'none'; reason?: string };

/** A link keeps Board scope even before its catalog row is available. */
export function BoardFileLinkPreview({
  target,
  memberSessionId,
  onClose,
}: {
  target: BoardFileLinkTarget;
  memberSessionId: import('@lody/shared').SessionId;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return target.board ? (
    <BoardFilePreview
      board={target.board}
      area={target.area}
      entry={{ path: target.path }}
      memberSessionId={memberSessionId}
      onBack={onClose}
      backLabel={t('sessions.tabs.closeTab', 'Close tab')}
    />
  ) : (
    <p {...stylex.props(styles.note)}>{t('boards.notFound', 'Board not found.')}</p>
  );
}

/**
 * One file of the directory, read through this machine's agent service like
 * any file of another LAN member. Text and pictures show; anything else is
 * saved to disk, whatever its size.
 */
export function BoardFilePreview({
  board,
  area,
  entry,
  onBack,
  backLabel,
  memberSessionId = board.coordinatorSessionId,
}: {
  board: BoardMeta;
  area: BoardFileArea;
  entry: Pick<BoardFileEntry, 'path'> & Partial<Pick<BoardFileEntry, 'modifiedAtMs'>>;
  memberSessionId?: import('@lody/shared').SessionId;
  onBack: () => void;
  backLabel: string;
}) {
  const { t } = useTranslation();
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const metas = useAtomValue(sessionMetaCacheAtom);
  const host = boardFilesMachineId(board, metas[getSessionRoomId(board.coordinatorSessionId)]);
  const [preview, setPreview] = useState<Preview>({ status: 'loading' });
  useEffect(() => {
    const ipc = getIpcServices();
    const kind = IMAGE.test(entry.path) ? 'image' : TEXT.test(entry.path) ? 'text' : null;
    if (!kind || !ipc || !workspaceId || !host) {
      setPreview({ status: 'none' });
      return undefined;
    }
    let cancelled = false;
    setPreview({ status: 'loading' });
    void (async () => {
      const resource = await ipc.machineRpc.openMemberFile({
        workspaceId,
        machineId: host,
        sessionId: memberSessionId,
        boardId: board.id,
        path: `${area}/${entry.path}`,
      });
      if (!resource.ok) throw new Error(resource.error);
      if (kind === 'image') return { status: 'image', url: resource.url } as const;
      const cut = resource.sizeBytes > TEXT_PREVIEW_BYTES;
      const response = await fetch(resource.url, {
        headers: { Range: `bytes=0-${Math.min(resource.sizeBytes, TEXT_PREVIEW_BYTES) - 1}` },
      });
      return {
        status: 'text',
        text: new TextDecoder().decode(await response.arrayBuffer()),
        cut,
      } as const;
    })().then(
      (next) => {
        if (!cancelled) setPreview(next);
      },
      (error: unknown) => {
        if (!cancelled) setPreview({ status: 'none', reason: String(error) });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [area, memberSessionId, board.id, entry.modifiedAtMs, entry.path, host, workspaceId]);

  const download = useBoardFileDownload(board, area, memberSessionId);

  let body: ReactNode;
  if (preview.status === 'loading')
    body = <p {...stylex.props(styles.note)}>{t('boards.loading', 'Loading…')}</p>;
  else if (preview.status === 'image')
    body = <img src={preview.url} alt={entry.path} {...stylex.props(styles.image)} />;
  else if (preview.status === 'text')
    body = (
      <>
        {/\.(md|markdown)$/i.test(entry.path) ? (
          <MarkdownRenderer text={preview.text} headingAnchors />
        ) : (
          <pre {...stylex.props(styles.text)}>{preview.text}</pre>
        )}
        {preview.cut ? (
          <p {...stylex.props(styles.note)}>
            {t('boards.files.previewCut', 'Only the first 256 KiB are shown.')}
          </p>
        ) : null}
      </>
    );
  else if (preview.reason)
    body = (
      <p {...stylex.props(styles.note)}>
        {t('boards.files.previewFailed', 'Could not read this file: {{reason}}', {
          reason: preview.reason,
        })}
      </p>
    );
  else
    body = (
      <div {...stylex.props(styles.noPreview)}>
        <p {...stylex.props(styles.note)}>
          {t('boards.files.noPreview', 'No preview for this kind of file.')}
        </p>
        {download ? (
          <Button variant="secondary" size="small" onClick={() => download(entry.path)}>
            <Download size={14} />
            {t('boards.files.download', 'Download')}
          </Button>
        ) : null}
      </div>
    );
  return (
    <div {...stylex.props(styles.preview)}>
      <div {...stylex.props(styles.previewHeader)}>
        <Button variant="ghost" size="small" icon aria-label={backLabel} onClick={onBack}>
          <ArrowLeft size={16} />
        </Button>
        <span {...stylex.props(styles.previewName)}>{entry.path}</span>
      </div>
      {body}
    </div>
  );
}
