import { useId, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import { colors } from '@lody/ui/tokens/colors.stylex';
import {
  LAN_MACHINE_ALIAS_MAX,
  LAN_MACHINE_COLORS,
  normalizeLanMachineAlias,
  type LanMachine,
  type LanMachineColor,
} from '@lody/shared/lan-control';
import { lanMachineColorValue } from '@/lib/lan-machine-color';
import { withClassName } from '@/lib/stylex';
import { Dialog } from '@/ui/dialog';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Toggle } from '@lody/ui/toggle';
import { ToggleGroup } from '@lody/ui/toggle-group';
import { Field } from './form-primitives';
import { useSettingsPane } from './settings-page-header';
import {
  SETTINGS_EDITOR_DIALOG_LAYOUT,
  SETTINGS_EDITOR_DIALOG_WIDTH,
  settingsCatalog as catalog,
} from './surface';

const styles = stylex.create({
  swatch: { width: '12px', height: '12px', borderRadius: '50%' },
  /** No color: the name keeps the color of the text around it. */
  swatchNone: { boxShadow: `inset 0 0 0 1.5px ${colors.tertiaryLabel}` },
  swatchColor: (color: string) => ({ backgroundColor: color }),
});

const NO_COLOR = 'none';
type ColorChoice = LanMachineColor | typeof NO_COLOR;

export type LanMachineAliasProps = {
  /** The machine a short name is given; `null` closes the dialog. */
  machine: LanMachine | null;
  onClose: () => void;
  /** `null` takes the short name or the color back. */
  onChange: (machine: LanMachine, alias: string | null, color: LanMachineColor | null) => void;
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
            color={shown.color ?? null}
            placeholder={shown.name}
            onCancel={onClose}
            onSubmit={(next, color) => {
              onChange(shown, next, color);
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
  color,
  placeholder,
  onCancel,
  onSubmit,
}: {
  alias: string | null;
  color: LanMachineColor | null;
  placeholder: string;
  onCancel: () => void;
  onSubmit: (alias: string | null, color: LanMachineColor | null) => void;
}) {
  const { t } = useTranslation();
  const fieldId = useId();
  const [written, setWritten] = useState(alias ?? '');
  const [chosen, setChosen] = useState<LanMachineColor | null>(color);
  const next = normalizeLanMachineAlias(written);

  return (
    <form
      {...withClassName(stylex.props(catalog.editorForm))}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(next, chosen);
      }}
    >
      <div {...withClassName(stylex.props(catalog.editorBody), 'scrollbar-pro')}>
        <Field htmlFor={`${fieldId}-alias`} label={t('settings.lan.machines.alias.label')}>
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
        <Field label={t('settings.lan.machines.alias.colorLabel')}>
          <ToggleGroup<ColorChoice>
            size="small"
            wrap
            aria-label={t('settings.lan.machines.alias.colorLabel')}
            value={[chosen ?? NO_COLOR]}
            onValueChange={(values) => {
              // Pressing the chosen color again leaves it chosen.
              const value = values[0];
              if (value) setChosen(value === NO_COLOR ? null : value);
            }}
          >
            {([NO_COLOR, ...LAN_MACHINE_COLORS] as const).map((value) => (
              <Toggle
                key={value}
                value={value}
                icon
                aria-label={t(`settings.lan.machines.alias.colors.${value}`)}
                title={t(`settings.lan.machines.alias.colors.${value}`)}
              >
                <span
                  aria-hidden="true"
                  {...stylex.props(
                    styles.swatch,
                    value === NO_COLOR
                      ? styles.swatchNone
                      : styles.swatchColor(lanMachineColorValue(value))
                  )}
                />
              </Toggle>
            ))}
          </ToggleGroup>
        </Field>
      </div>
      <Dialog.Footer>
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" disabled={next === alias && chosen === color}>
          {t('common.save')}
        </Button>
      </Dialog.Footer>
    </form>
  );
}
