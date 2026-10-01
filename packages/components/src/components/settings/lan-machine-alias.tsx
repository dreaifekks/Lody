import { useId, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import {
  LAN_MACHINE_ALIAS_MAX,
  normalizeLanMachineAlias,
  type LanMachine,
} from '@lody/shared/lan-control';
import { withClassName } from '@/lib/stylex';
import { Dialog } from '@/ui/dialog';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Field } from './form-primitives';
import { useSettingsPane } from './settings-page-header';
import {
  SETTINGS_EDITOR_DIALOG_LAYOUT,
  SETTINGS_EDITOR_DIALOG_WIDTH,
  settingsCatalog as catalog,
} from './surface';

export type LanMachineAliasProps = {
  /** The machine a short name is given; `null` closes the dialog. */
  machine: LanMachine | null;
  onClose: () => void;
  /** `null` takes the short name back. */
  onChange: (machine: LanMachine, alias: string | null) => void;
};

/**
 * The short name of a machine, which every member of its LANs sees before the
 * machine's own name and which alerts use where room is short.
 */
export function LanMachineAlias({ machine, onClose, onChange }: LanMachineAliasProps) {
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
            {t('settings.lan.machines.alias.title', { name: shown?.name ?? '' })}
          </Dialog.Title>
          <Dialog.Description>{t('settings.lan.machines.alias.description')}</Dialog.Description>
        </Dialog.Header>
        {shown ? (
          <AliasForm
            key={shown.machineId}
            alias={shown.alias}
            placeholder={shown.name}
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

function AliasForm({
  alias,
  placeholder,
  onCancel,
  onSubmit,
}: {
  alias: string | null;
  placeholder: string;
  onCancel: () => void;
  onSubmit: (alias: string | null) => void;
}) {
  const { t } = useTranslation();
  const fieldId = useId();
  const [written, setWritten] = useState(alias ?? '');
  const next = normalizeLanMachineAlias(written);

  return (
    <form
      {...withClassName(stylex.props(catalog.editorForm))}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(next);
      }}
    >
      <div {...withClassName(stylex.props(catalog.editorBody), 'scrollbar-pro')}>
        <Field
          htmlFor={`${fieldId}-alias`}
          label={t('settings.lan.machines.alias.label')}
          hint={t('settings.lan.machines.alias.hint', { max: LAN_MACHINE_ALIAS_MAX })}
        >
          <Input
            id={`${fieldId}-alias`}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            maxLength={LAN_MACHINE_ALIAS_MAX}
            placeholder={placeholder}
            value={written}
            onChange={(event) => setWritten(event.target.value)}
          />
        </Field>
      </div>
      <Dialog.Footer>
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" disabled={next === alias}>
          {t('common.save')}
        </Button>
      </Dialog.Footer>
    </form>
  );
}
