import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { Button } from '@lody/ui/button';
import { ArrowLeft, FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { FileTreeProviderView } from '@/components/sessions/components/file-tree-view';
import type { SessionFileMenuItem } from '@/hooks/use-session-file-actions';
import type { FileWorkspaceProvider } from '@/lib/file-workspace-provider';

export interface BoardFileItem {
  id: string;
  name: string;
  /** "Coordinator · 2 h ago": who wrote it last, and when. */
  detail: string;
}

const styles = stylex.create({
  directory: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
  notes: { flexShrink: 0 },
  tree: { flexGrow: 1, minHeight: 0 },
  truncated: {
    flexShrink: 0,
    margin: 0,
    paddingInline: space[4],
    paddingBottom: space[1],
    fontSize: text.footnoteSize,
    color: colors.secondaryLabel,
  },
  list: { display: 'flex', flexDirection: 'column', gap: '1px', padding: space[2] },
  row: {
    display: 'grid',
    gridTemplateColumns: '16px minmax(0, 1fr)',
    columnGap: space[2],
    alignItems: 'center',
    width: '100%',
    padding: space[2],
    borderWidth: 0,
    borderRadius: radius.medium,
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    color: colors.label,
    textAlign: 'start',
    cursor: 'pointer',
  },
  icon: { color: colors.secondaryLabel },
  name: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.bodySize,
  },
  detail: {
    gridColumn: '2',
    fontSize: text.footnoteSize,
    color: colors.secondaryLabel,
  },
  editor: { display: 'flex', flexDirection: 'column', gap: space[2], padding: space[3] },
  editorHeader: { display: 'flex', alignItems: 'center', gap: space[1] },
  editorName: { fontSize: text.bodySize, fontWeight: 600 },
  note: {
    margin: 0,
    paddingInline: space[2],
    paddingBlock: space[3],
    fontSize: text.footnoteSize,
    color: colors.secondaryLabel,
  },
});

/**
 * The Board's shared files. The shared notes lead the list; the Board's shared
 * directory follows (until it lands, `note` says where it will live).
 */
export function BoardFilesView({
  files,
  onOpen,
  note,
}: {
  files: readonly BoardFileItem[];
  onOpen: (id: string) => void;
  note?: string;
}) {
  return (
    <div {...stylex.props(styles.list)}>
      {files.map((file) => (
        <button
          key={file.id}
          type="button"
          data-scope-item="row"
          data-id={file.id}
          onClick={() => onOpen(file.id)}
          {...stylex.props(styles.row)}
        >
          <FileText size={14} aria-hidden {...stylex.props(styles.icon)} />
          <span {...stylex.props(styles.name)}>{file.name}</span>
          <span {...stylex.props(styles.detail)}>{file.detail}</span>
        </button>
      ))}
      {note !== undefined ? <p {...stylex.props(styles.note)}>{note}</p> : null}
    </div>
  );
}

/** One file open in the panel; the editor is the shared notes editor. */
export function BoardFileEditorView({
  name,
  onBack,
  children,
}: {
  name: string;
  onBack: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div {...stylex.props(styles.editor)}>
      <div {...stylex.props(styles.editorHeader)}>
        <Button
          variant="ghost"
          size="small"
          icon
          aria-label={t('boards.files.back', 'Back to files')}
          onClick={onBack}
        >
          <ArrowLeft size={16} />
        </Button>
        <span {...stylex.props(styles.editorName)}>{name}</span>
      </div>
      {children}
    </div>
  );
}

/**
 * The Board files tab: the shared notes, one Loro document merged across
 * machines, above the directory's `files/` as the session file tree.
 */
export function BoardDirectoryTreeView({
  notesName,
  onOpenNotes,
  provider,
  truncated,
  onOpenFile,
  viewStateKey,
  menuItems,
}: {
  notesName: string;
  onOpenNotes: () => void;
  provider: FileWorkspaceProvider | null;
  /** The listing stopped at its 500-file limit. */
  truncated: boolean;
  onOpenFile: (path: string) => void;
  viewStateKey: string;
  menuItems?: readonly SessionFileMenuItem[];
}) {
  const { t } = useTranslation();
  return (
    <div {...stylex.props(styles.directory)}>
      <div {...stylex.props(styles.notes)}>
        <BoardFilesView
          files={[
            {
              id: 'notes',
              name: notesName,
              detail: t('boards.files.notesDetail', 'Every member reads and appends to it.'),
            },
          ]}
          onOpen={onOpenNotes}
        />
      </div>
      {truncated ? (
        <p {...stylex.props(styles.truncated)}>
          {t('boards.files.truncated', 'Only the first 500 files are listed.')}
        </p>
      ) : null}
      <div {...stylex.props(styles.tree)}>
        <FileTreeProviderView
          fileProvider={provider}
          fileProviderMessage={
            provider
              ? t(
                  'boards.files.empty',
                  'No shared files yet. Members put the files everyone should see here.'
                )
              : t('boards.files.noAgent', 'Board files are read through the desktop app.')
          }
          handleOpenFile={onOpenFile}
          viewStateKey={viewStateKey}
          {...(menuItems ? { fileMenuItems: menuItems } : {})}
        />
      </div>
    </div>
  );
}
