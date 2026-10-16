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
 * Creating a Board asks for a name and who coordinates; the goal is optional.
 * Nothing is sent: the Board opens on an empty coordinator conversation and the
 * user speaks first. Rules start from defaults and change in Board settings.
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
  /** "All projects" until narrowed; joins the dialog with the project-scope step. */
  projectScope?: ReactNode;
  saving?: boolean;
  error?: string;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
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
            <span {...stylex.props(styles.label)}>{t('boards.name', 'Name')}</span>
            <Input
              autoFocus
              required
              value={name}
              onChange={(event) => onNameChange(event.target.value)}
            />
          </label>
          <label {...stylex.props(boardStyles.field)}>
            <span {...stylex.props(styles.label)}>
              {t('boards.purposeOptional', 'Goal (optional)')}
            </span>
            <Textarea
              rows={3}
              value={goal}
              placeholder={t(
                'boards.createForm.goalPlaceholder',
                'What this Board is for. Members read it when they start.'
              )}
              onChange={(event) => onGoalChange(event.target.value)}
            />
          </label>
          <div {...stylex.props(styles.row)}>
            {coordinator}
            {projectScope}
          </div>
          <p {...stylex.props(styles.note)}>
            {t(
              'boards.createForm.later',
              'Nothing is sent yet: the Board opens on the coordinator, and you speak first. Rules start from defaults.'
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
            <Button type="submit" disabled={saving || name.trim().length === 0}>
              {saving ? t('boards.creating', 'Creating…') : t('boards.createForm.submit', 'Create')}
            </Button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}
