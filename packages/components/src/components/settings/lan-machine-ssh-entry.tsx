import { useId, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import type { LanMachine } from '@lody/shared/lan-control';
import type { SshDestination } from '@lody/shared/lan-ssh';
import { parseMachineSshEntry } from '@/lib/machine-ssh-entry';
import { withClassName } from '@/lib/stylex';
import { Dialog } from '@/ui/dialog';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Field, FormMessage } from './form-primitives';
import { useSettingsPane } from './settings-page-header';
import {
  SETTINGS_EDITOR_DIALOG_LAYOUT,
  SETTINGS_EDITOR_DIALOG_WIDTH,
  settingsCatalog as catalog,
} from './surface';

export type LanMachineSshEntryProps = {
  /** The machine an entry is named for; `null` closes the dialog. */
  machine: LanMachine | null;
  /** The entry named for it so far, as it is written. */
  entry: string | null;
  onClose: () => void;
  /** `null` leaves the choice to what answers first again. */
  onChange: (machine: LanMachine, entry: SshDestination | null) => void;
};

/**
 * The entry of this computer's SSH configuration that editors reach a machine
 * through. Left empty, the one at which the machine answers first is taken.
 */
export function LanMachineSshEntry({ machine, entry, onClose, onChange }: LanMachineSshEntryProps) {
  const { t } = useTranslation();
  const settingsPane = useSettingsPane();
  const [shown, setShown] = useState<LanMachine | null>(machine);
  // A dialog that closes keeps what it showed until it is gone.
  if (machine && machine !== shown) setShown(machine);

  return (
    <Dialog.Root
      open={machine !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Content
        width={SETTINGS_EDITOR_DIALOG_WIDTH}
        centerOn={settingsPane}
        className={SETTINGS_EDITOR_DIALOG_LAYOUT}
      >
        <Dialog.Header>
          <Dialog.Title>
            {t('settings.lan.machines.sshEntry.title', { name: shown?.name ?? '' })}
          </Dialog.Title>
          <Dialog.Description>{t('settings.lan.machines.sshEntry.description')}</Dialog.Description>
        </Dialog.Header>
        {shown ? (
          <SshEntryForm
            key={shown.machineId}
            entry={entry}
            onCancel={onClose}
            onSubmit={(next) => {
              onChange(shown, next);
              onClose();
            }}
          />
        ) : null}
      </Dialog.Content>
    </Dialog.Root>
  );
}

function SshEntryForm({
  entry,
  onCancel,
  onSubmit,
}: {
  entry: string | null;
  onCancel: () => void;
  onSubmit: (entry: SshDestination | null) => void;
}) {
  const { t } = useTranslation();
  const fieldId = useId();
  const [written, setWritten] = useState(entry ?? '');
  const empty = written.trim() === '';
  const read = empty ? null : parseMachineSshEntry(written);
  const unreadable = !empty && read === null;

  return (
    <form
      {...withClassName(stylex.props(catalog.editorForm))}
      onSubmit={(event) => {
        event.preventDefault();
        if (!unreadable) onSubmit(read);
      }}
    >
      <div {...withClassName(stylex.props(catalog.editorBody), 'scrollbar-pro')}>
        {unreadable ? (
          <FormMessage tone="error">{t('settings.lan.machines.sshEntry.unreadable')}</FormMessage>
        ) : null}
        <Field
          htmlFor={`${fieldId}-ssh-entry`}
          label={t('settings.lan.machines.sshEntry.label')}
          hint={t('settings.lan.machines.sshEntry.hint')}
        >
          <Input
            id={`${fieldId}-ssh-entry`}
            autoComplete="off"
            spellCheck={false}
            value={written}
            onChange={(event) => setWritten(event.target.value)}
          />
        </Field>
      </div>
      <Dialog.Footer>
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" disabled={unreadable || written.trim() === (entry ?? '')}>
          {t('common.save')}
        </Button>
      </Dialog.Footer>
    </form>
  );
}
