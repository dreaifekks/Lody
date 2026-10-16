import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Switch } from '@lody/ui/switch';
import { Textarea } from '@lody/ui/textarea';
import { useAtomValue } from 'jotai';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { normalizeBoardMeta, type BoardMeta } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { writeWorkspaceBoard } from '@/lib/workspace-catalog-write';
import { useSessionActions } from '@/hooks/use-session-actions';
import { Dialog } from '@/ui/dialog';
import { CompactRow, CompactSection } from '../settings/compact-layout';
import { boardStyles } from './board-view';

export interface BoardSettingsDraft {
  name: string;
  purpose: string;
  maxRoundsPerThread: number;
  reportHumanTurns: boolean;
  executorConstraints: string;
}

export function boardSettingsDraft(board: BoardMeta): BoardSettingsDraft {
  return { name: board.name, purpose: board.purpose, ...board.rules };
}

const styles = stylex.create({
  root: { display: 'flex', flexDirection: 'column', gap: space[6] },
  stacked: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    paddingInline: space[4],
    paddingBlock: space[2],
  },
  stackedLabel: { margin: 0, color: colors.label },
  stackedHelper: { margin: 0, fontSize: text.footnoteSize, color: colors.secondaryLabel },
  footer: { display: 'flex', justifyContent: 'flex-end', gap: space[2] },
});

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
 * What a Board sets once and rarely revisits. Nothing here is needed to talk to
 * the coordinator or steer a thread, which is why it opens from the gear
 * instead of standing on the page. The coordinator's model stays in its
 * composer, the one place it is chosen.
 */
export function BoardSettingsPanelView({
  value,
  onChange,
  onArchive,
}: {
  value: BoardSettingsDraft;
  onChange: (patch: Partial<BoardSettingsDraft>) => void;
  /** Absent for an archived Board. */
  onArchive?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div {...stylex.props(styles.root)}>
      <CompactSection title={t('boards.settings.board', 'Board')}>
        <CompactRow label={t('boards.name', 'Name')}>
          <Input
            aria-label={t('boards.name', 'Name')}
            value={value.name}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </CompactRow>
        <StackedRow
          label={t('boards.purpose', 'Goal')}
          helper={t('boards.settings.purposeHelper', 'The coordinator reads it at every start.')}
        >
          <Textarea
            rows={4}
            value={value.purpose}
            onChange={(event) => onChange({ purpose: event.target.value })}
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
    </div>
  );
}

/** Board settings as a dialog over the Board; saving writes the catalog row. */
export function BoardSettingsDialog({
  board,
  onArchive,
  onClose,
}: {
  board: BoardMeta;
  onArchive?: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const { updateSessionTitle } = useSessionActions();
  const [draft, setDraft] = useState(() => boardSettingsDraft(board));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    const { name, purpose, ...rules } = draft;
    const next = normalizeBoardMeta({
      ...board,
      name: name.trim(),
      purpose: purpose.trim(),
      rules,
    });
    if (!next) {
      setError(t('boards.settings.invalid', 'Enter a name and goal within the limits.'));
      return;
    }
    if (!runtime) return;
    setSaving(true);
    setError('');
    try {
      await writeWorkspaceBoard(runtime, next);
      // The coordinator conversation is the Board, so its tab carries the Board's name.
      if (next.name !== board.name) await updateSessionTitle(board.coordinatorSessionId, next.name);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <Dialog.Content>
        <Dialog.Header>
          <Dialog.Title>{t('boards.settings.title', 'Board settings')}</Dialog.Title>
        </Dialog.Header>
        <form
          {...stylex.props(boardStyles.form)}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <BoardSettingsPanelView
            value={draft}
            onChange={(patch) => setDraft({ ...draft, ...patch })}
            onArchive={onArchive}
          />
          {error !== '' ? (
            <p role="alert" {...stylex.props(boardStyles.error)}>
              {error}
            </p>
          ) : null}
          <div {...stylex.props(styles.footer)}>
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button type="submit" disabled={saving}>
              {t('common.save', 'Save')}
            </Button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}
