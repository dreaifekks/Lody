import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Textarea } from '@lody/ui/textarea';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { Dialog } from '@/ui/dialog';
import { boardStyles } from './board-view';

const styles = stylex.create({
  label: { fontSize: text.subheadlineSize, color: colors.secondaryLabel },
  row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space[2] },
  footer: { display: 'flex', justifyContent: 'flex-end', gap: space[2] },
  note: { margin: 0, fontSize: text.footnoteSize, color: colors.secondaryLabel },
});

/**
 * Creating a Board asks only what the first message needs: the goal, and who
 * coordinates. The name defaults to the goal's first line; the project scope
 * defaults to every project; rules, memory and the digest start from defaults
 * and change later in Board settings.
 */
export function BoardCreateDialogView({
  goal,
  name,
  onGoalChange,
  onNameChange,
  coordinator,
  projectScope,
  saving = false,
  error = '',
  onSubmit,
  onClose,
}: {
  goal: string;
  name: string;
  onGoalChange: (value: string) => void;
  onNameChange: (value: string) => void;
  /** Machine + agent (or Agent Role) picker, as in the current dialog. */
  coordinator: ReactNode;
  /** "All projects" until narrowed; opens the same chooser the settings use. */
  projectScope: ReactNode;
  saving?: boolean;
  error?: string;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const firstLine = goal.trim().split('\n')[0] ?? '';
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <Dialog.Content>
        <Dialog.Header>
          <Dialog.Title>{t('boards.create', 'New board')}</Dialog.Title>
        </Dialog.Header>
        <form
          {...stylex.props(boardStyles.form)}
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <label {...stylex.props(boardStyles.field)}>
            <span {...stylex.props(styles.label)}>{t('boards.purpose', 'Goal')}</span>
            <Textarea
              autoFocus
              required
              rows={4}
              value={goal}
              placeholder={t(
                'boards.createForm.goalPlaceholder',
                'What should this Board get done? It becomes the coordinator’s first message.'
              )}
              onChange={(event) => onGoalChange(event.target.value)}
            />
          </label>
          <label {...stylex.props(boardStyles.field)}>
            <span {...stylex.props(styles.label)}>{t('boards.name', 'Name')}</span>
            <Input
              value={name}
              placeholder={
                firstLine ||
                t('boards.createForm.namePlaceholder', 'Defaults to the goal’s first line')
              }
              onChange={(event) => onNameChange(event.target.value)}
            />
          </label>
          <div {...stylex.props(styles.row)}>
            {coordinator}
            {projectScope}
          </div>
          <p {...stylex.props(styles.note)}>
            {t(
              'boards.createForm.later',
              'Rules, memory and the daily digest start from defaults. Change them in Board settings.'
            )}
          </p>
          {error !== '' ? (
            <p role="alert" {...stylex.props(boardStyles.error)}>
              {error}
            </p>
          ) : null}
          <div {...stylex.props(styles.footer)}>
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button type="submit" disabled={saving || goal.trim().length === 0}>
              {saving ? t('boards.creating', 'Creating…') : t('boards.createForm.submit', 'Create')}
            </Button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}
