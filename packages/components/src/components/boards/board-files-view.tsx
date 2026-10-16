import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { Button } from '@lody/ui/button';
import { ArrowLeft, FileText, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';

export interface BoardFileItem {
  id: string;
  name: string;
  /** "Coordinator · 2 h ago": who wrote it last, and when. */
  detail: string;
}

const styles = stylex.create({
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
  footer: { paddingInline: space[2], paddingTop: space[1] },
  editor: { display: 'flex', flexDirection: 'column', gap: space[2], padding: space[3] },
  editorHeader: { display: 'flex', alignItems: 'center', gap: space[1] },
  editorName: { fontSize: text.bodySize, fontWeight: 600 },
});

/**
 * The Board's shared files: text every member reads and writes. The existing
 * shared notes are the first file; "New file" adds another beside it.
 */
export function BoardFilesView({
  files,
  onOpen,
  onCreate,
}: {
  files: readonly BoardFileItem[];
  onOpen: (id: string) => void;
  onCreate: () => void;
}) {
  const { t } = useTranslation();
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
      <div {...stylex.props(styles.footer)}>
        <Button variant="ghost" size="small" onClick={onCreate}>
          <Plus size={14} aria-hidden />
          {t('boards.files.create', 'New file')}
        </Button>
      </div>
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
