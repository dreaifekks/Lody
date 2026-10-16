import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Switch } from '@lody/ui/switch';
import { Textarea } from '@lody/ui/textarea';
import { Brain, Settings2, X } from 'lucide-react';
import { useAtomValue } from 'jotai';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BOARD_MEMORY_INDEX,
  MAX_BOARD_INSTRUCTIONS,
  normalizeBoardMeta,
  type BoardFileEntry,
  type BoardMeta,
} from '@lody/shared';
import { currentWorkspaceIdAtom } from '@/atoms';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { writeWorkspaceBoard } from '@/lib/workspace-catalog-write';
import { useSessionActions } from '@/hooks/use-session-actions';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
import { Dialog } from '@/ui/dialog';
import { CompactRow, CompactSection } from '../settings/compact-layout';
import { settingsSurface as surface } from '../settings/surface';
import {
  BoardDirectoryNote,
  BoardFilePreview,
  BoardFileRowsView,
  useBoardDirectory,
} from './board-directory';
import { useBoardActions } from './board-lifecycle';
import { boardStyles } from './board-view';

export interface BoardSettingsDraft {
  name: string;
  purpose: string;
  instructions: string;
  maxRoundsPerThread: number;
  reportHumanTurns: boolean;
  executorConstraints: string;
}

export function boardSettingsDraft(board: BoardMeta): BoardSettingsDraft {
  return {
    name: board.name,
    purpose: board.purpose,
    instructions: board.instructions,
    ...board.rules,
  };
}

export type BoardSettingsPage = 'general' | 'memory';

const NARROW = '@media (max-width: 640px)';

const styles = stylex.create({
  body: {
    display: 'flex',
    flexDirection: { default: 'row', [NARROW]: 'column' },
    height: '100%',
    minHeight: 0,
  },
  nav: {
    display: 'flex',
    flexDirection: { default: 'column', [NARROW]: 'row' },
    gap: '2px',
    flexShrink: 0,
    width: { default: '200px', [NARROW]: 'auto' },
    padding: space[3],
  },
  navHeading: {
    margin: 0,
    paddingInline: space[2],
    paddingBlock: space[1],
    fontSize: text.footnoteSize,
    color: colors.secondaryLabel,
    display: { default: 'block', [NARROW]: 'none' },
  },
  content: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    minWidth: 0,
    minHeight: 0,
  },
  scroll: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[6],
    flexGrow: 1,
    minHeight: 0,
    overflowY: 'auto',
    paddingInline: { default: space[8], [NARROW]: space[4] },
    paddingBlock: space[6],
  },
  close: { position: 'absolute', top: space[3], insetInlineEnd: space[3], zIndex: 1 },
  srOnly: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    overflow: 'hidden',
    clip: 'rect(0 0 0 0)',
    whiteSpace: 'nowrap',
  },
  pageTitle: { margin: 0, fontSize: text.titleSize, fontWeight: 600 },
  block: { display: 'flex', flexDirection: 'column', gap: space[2] },
  blockTitle: { margin: 0, fontSize: text.bodySize, fontWeight: 600, color: colors.label },
  blockHelper: { margin: 0, fontSize: text.footnoteSize, color: colors.secondaryLabel },
  counter: {
    alignSelf: 'flex-end',
    fontSize: text.footnoteSize,
    color: colors.secondaryLabel,
    fontVariantNumeric: 'tabular-nums',
  },
  counterOver: { color: colors.destructive },
  stacked: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    paddingInline: space[4],
    paddingBlock: space[2],
  },
  stackedLabel: { margin: 0, color: colors.label },
  stackedHelper: { margin: 0, fontSize: text.footnoteSize, color: colors.secondaryLabel },
  footer: {
    display: 'flex',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: space[2],
    flexShrink: 0,
    paddingInline: { default: space[8], [NARROW]: space[4] },
    paddingBlock: space[3],
    boxShadow: `inset 0 1px 0 ${colors.separator}`,
  },
  error: { flexGrow: 1, margin: 0, color: colors.destructive, fontSize: text.footnoteSize },
});

const PANEL_STYLE = {
  width: '84vw',
  maxWidth: '960px',
  height: 'min(86vh, 760px)',
  padding: 0,
  gap: 0,
  overflow: 'hidden',
} as const;

/** A row whose control is a paragraph of text: the field takes the full width under its name. */
function StackedRow({
  label,
  helper,
  children,
}: {
  label: string;
  helper?: string;
  children: ReactNode;
}) {
  return (
    <label {...stylex.props(styles.stacked)}>
      <span {...stylex.props(styles.stackedLabel)}>{label}</span>
      {helper !== undefined ? <span {...stylex.props(styles.stackedHelper)}>{helper}</span> : null}
      {children}
    </label>
  );
}

/**
 * What a Board sets once and rarely revisits: name, goal, the instructions its
 * members read, thread rules, and archiving it.
 */
export function BoardSettingsGeneralView({
  value,
  onChange,
  onArchive,
}: {
  value: BoardSettingsDraft;
  onChange: (patch: Partial<BoardSettingsDraft>) => void;
  /** Absent for an archived Board. */
  onArchive?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const instructionsLength = Array.from(value.instructions).length;
  const number = new Intl.NumberFormat(toIntlLocaleOrEn(i18n.language));
  return (
    <>
      <CompactSection title={t('boards.settings.board', 'Board')}>
        <CompactRow label={t('boards.name', 'Name')}>
          <Input
            aria-label={t('boards.name', 'Name')}
            value={value.name}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </CompactRow>
        <StackedRow
          label={t('boards.purposeOptional', 'Goal (optional)')}
          helper={t(
            'boards.settings.purposeHelper',
            'Members read it when they start. Leave it empty and simply talk to the coordinator.'
          )}
        >
          <Textarea
            aria-label={t('boards.purpose', 'Goal')}
            rows={3}
            value={value.purpose}
            onChange={(event) => onChange({ purpose: event.target.value })}
          />
        </StackedRow>
      </CompactSection>

      <CompactSection title={t('boards.settings.rules', 'Rules')}>
        <StackedRow
          label={t('boards.settings.instructions', 'Instructions')}
          helper={t(
            'boards.settings.instructionsHelper',
            'Like CLAUDE.md: rules you write. Every new conversation of this Board reads and follows them.'
          )}
        >
          <Textarea
            aria-label={t('boards.settings.instructions', 'Instructions')}
            rows={7}
            value={value.instructions}
            onChange={(event) => onChange({ instructions: event.target.value })}
          />
          <span
            {...stylex.props(
              styles.counter,
              instructionsLength > MAX_BOARD_INSTRUCTIONS && styles.counterOver
            )}
          >
            {`${number.format(instructionsLength)} / ${number.format(MAX_BOARD_INSTRUCTIONS)}`}
          </span>
        </StackedRow>
        <StackedRow
          label={t('boards.constraints', 'Executor instructions')}
          helper={t(
            'boards.settings.constraintsHelper',
            'Added to the first message of every thread.'
          )}
        >
          <Textarea
            rows={3}
            value={value.executorConstraints}
            onChange={(event) => onChange({ executorConstraints: event.target.value })}
          />
        </StackedRow>
      </CompactSection>

      <CompactSection title={t('boards.settings.threads', 'Threads')}>
        <CompactRow label={t('boards.maxRounds', 'Rounds per thread')}>
          <Input
            type="number"
            min={1}
            aria-label={t('boards.maxRounds', 'Rounds per thread')}
            value={value.maxRoundsPerThread}
            onChange={(event) => onChange({ maxRoundsPerThread: Number(event.target.value) })}
          />
        </CompactRow>
        <CompactRow
          label={t('boards.reportHumanTurns', 'Report completed human turns')}
          helper={t(
            'boards.settings.reportHumanTurnsHelper',
            'Off: a reply you steer yourself does not wake the coordinator.'
          )}
        >
          <Switch
            checked={value.reportHumanTurns}
            aria-label={t('boards.reportHumanTurns', 'Report completed human turns')}
            onCheckedChange={(on) => onChange({ reportHumanTurns: on })}
          />
        </CompactRow>
      </CompactSection>

      {onArchive ? (
        <CompactSection tone="danger" title={t('boards.settings.danger', 'Archive')}>
          <CompactRow
            label={t('boards.settings.archive', 'Archive Board')}
            helper={t(
              'boards.settings.archiveHelper',
              'Archives the coordinator and every thread. Restore them from Archive.'
            )}
          >
            <Button variant="secondary" tone="destructive" size="small" onClick={onArchive}>
              {t('boards.settings.archive', 'Archive Board')}
            </Button>
          </CompactRow>
        </CompactSection>
      ) : null}
    </>
  );
}

/** The notes agents keep in the Board directory's `memory/`. */
export function BoardMemoryView({ autoMemory }: { autoMemory: ReactNode }) {
  const { t } = useTranslation();
  return (
    <section {...stylex.props(styles.block)}>
      <h3 {...stylex.props(styles.blockTitle)}>{t('boards.memory.auto', 'Automatic memory')}</h3>
      <p {...stylex.props(styles.blockHelper)}>
        {t(
          'boards.memory.autoHelper',
          'Notes the agents keep while they work on this Board. The coordinator keeps MEMORY.md as their index.'
        )}
      </p>
      {autoMemory}
    </section>
  );
}

/** MEMORY.md first, then the memory files it indexes. */
function BoardAutoMemory({ board }: { board: BoardMeta }) {
  const { t } = useTranslation();
  const memory = useBoardDirectory(board, 'memory');
  const [open, setOpen] = useState<BoardFileEntry | null>(null);
  if (open)
    return (
      <BoardFilePreview
        board={board}
        area="memory"
        entry={open}
        backLabel={t('boards.memory.back', 'Back to memory')}
        onBack={() => setOpen(null)}
      />
    );
  const entries =
    memory.state.status === 'ready'
      ? memory.state.list.entries.toSorted(
          (a, b) =>
            Number(b.path === BOARD_MEMORY_INDEX) - Number(a.path === BOARD_MEMORY_INDEX) ||
            a.path.localeCompare(b.path)
        )
      : [];
  return (
    <>
      <BoardFileRowsView entries={entries} onOpen={setOpen} />
      <BoardDirectoryNote
        state={memory.state}
        empty={t('boards.memory.empty', 'No memory yet. Agents add it as they work.')}
      />
    </>
  );
}

/**
 * Board settings: a navigation of pages on the start, the page on the end, one
 * Save for everything the pages edit.
 */
export function BoardSettingsDialogView({
  page,
  onPageChange,
  draft,
  onDraftChange,
  onArchive,
  autoMemory,
  saving = false,
  error = '',
  onSave,
  onClose,
}: {
  page: BoardSettingsPage;
  onPageChange: (page: BoardSettingsPage) => void;
  draft: BoardSettingsDraft;
  onDraftChange: (patch: Partial<BoardSettingsDraft>) => void;
  /** Absent for an archived Board. */
  onArchive?: () => void;
  /** The memory files, as the directory lists them. */
  autoMemory: ReactNode;
  saving?: boolean;
  error?: string;
  onSave: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const pages: { id: BoardSettingsPage; label: string; icon: typeof Brain }[] = [
    { id: 'general', label: t('boards.settings.general', 'General'), icon: Settings2 },
    { id: 'memory', label: t('boards.settings.memory', 'Memory'), icon: Brain },
  ];
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <Dialog.Content closeButton={false} style={PANEL_STYLE}>
        <Dialog.Title {...stylex.props(styles.srOnly)}>
          {t('boards.settings.title', 'Board settings')}
        </Dialog.Title>
        <form
          {...stylex.props(styles.body)}
          onSubmit={(event) => {
            event.preventDefault();
            onSave();
          }}
        >
          <nav {...stylex.props(styles.nav, surface.nav)}>
            <p {...stylex.props(styles.navHeading)}>{t('boards.settings.heading', 'Settings')}</p>
            {pages.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                aria-current={page === id ? 'page' : undefined}
                onClick={() => onPageChange(id)}
                {...stylex.props(
                  surface.listRow,
                  surface.navRow,
                  page === id && surface.listRowSelected
                )}
              >
                <Icon
                  {...stylex.props(surface.listRowIcon, page === id && surface.listRowIconSelected)}
                  strokeWidth={1.75}
                  aria-hidden
                />
                <span {...stylex.props(surface.listRowLabel)}>{label}</span>
              </button>
            ))}
          </nav>
          <div {...stylex.props(styles.content, surface.canvas)}>
            <div {...stylex.props(styles.close)}>
              <Button
                variant="ghost"
                size="small"
                icon
                aria-label={t('common.close', 'Close')}
                onClick={onClose}
                disabled={saving}
              >
                <X size={16} />
              </Button>
            </div>
            <div {...stylex.props(styles.scroll)}>
              <h2 {...stylex.props(styles.pageTitle)}>
                {pages.find((entry) => entry.id === page)?.label}
              </h2>
              {page === 'general' ? (
                <BoardSettingsGeneralView
                  value={draft}
                  onChange={onDraftChange}
                  onArchive={onArchive}
                />
              ) : (
                <BoardMemoryView autoMemory={autoMemory} />
              )}
            </div>
            <div {...stylex.props(styles.footer)}>
              {error !== '' ? (
                <p role="alert" {...stylex.props(styles.error, boardStyles.error)}>
                  {error}
                </p>
              ) : null}
              <Button variant="ghost" onClick={onClose} disabled={saving}>
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button type="submit" disabled={saving}>
                {t('common.save', 'Save')}
              </Button>
            </div>
          </div>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}

/**
 * Board settings over the catalog row. Saving writes the row; a rename also
 * renames the coordinator, whose tab carries the Board's name.
 */
export function BoardSettingsDialog({
  board,
  onArchive,
  onClose,
  initialPage = 'general',
}: {
  board: BoardMeta;
  onArchive?: () => void;
  onClose: () => void;
  initialPage?: BoardSettingsPage;
}) {
  const { t } = useTranslation();
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const { updateSessionTitle } = useSessionActions();
  const [page, setPage] = useState<BoardSettingsPage>(initialPage);
  const [draft, setDraft] = useState(() => boardSettingsDraft(board));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    const { name, purpose, instructions, ...rules } = draft;
    const next = normalizeBoardMeta({
      ...board,
      name: name.trim(),
      purpose: purpose.trim(),
      instructions,
      rules,
    });
    if (!next) {
      setError(
        t('boards.settings.invalid', 'Enter a name, and keep every field within its limit.')
      );
      return;
    }
    if (!runtime) return;
    setSaving(true);
    setError('');
    try {
      await writeWorkspaceBoard(runtime, next);
      if (next.name !== board.name) await updateSessionTitle(board.coordinatorSessionId, next.name);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  return (
    <BoardSettingsDialogView
      page={page}
      onPageChange={setPage}
      draft={draft}
      onDraftChange={(patch) => setDraft({ ...draft, ...patch })}
      onArchive={onArchive}
      autoMemory={<BoardAutoMemory board={board} />}
      saving={saving}
      error={error}
      onSave={() => void save()}
      onClose={onClose}
    />
  );
}

type BoardSettingsProps = {
  board: BoardMeta;
  onClose: () => void;
  onArchived: () => void;
};

/**
 * Board settings as the coordinator's page opens them, archiving included. The
 * draft belongs to one Board: another Board or workspace starts it afresh, so a
 * draft is never saved into a Board it was not written for.
 */
export function BoardSettings(props: BoardSettingsProps) {
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  return <BoardSettingsContent key={`${workspaceId}:${props.board.id}`} {...props} />;
}

function BoardSettingsContent({ board, onClose, onArchived }: BoardSettingsProps) {
  const { archive } = useBoardActions();
  return (
    <BoardSettingsDialog
      board={board}
      onClose={onClose}
      onArchive={
        board.archivedAtMs === undefined
          ? () => {
              onClose();
              void archive(board).then((archived) => {
                if (archived) onArchived();
              });
            }
          : undefined
      }
    />
  );
}
