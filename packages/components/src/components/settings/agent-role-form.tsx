import { useId, type FormEvent, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Spinner } from '@lody/ui/spinner';
import { useTranslation } from 'react-i18next';
import {
  AGENT_ROLE_NAME_MAX_LENGTH,
  buildEmptyAgentRoleFormPlacement,
  normalizeAgentRoleDescription,
  DEFAULT_AGENT_ROLE_EMOJI,
  type AgentConfigId,
  type AgentRoleFormError,
  type AgentRoleFormPlacement,
  type AgentRoleFormValue,
  type MachineId,
} from '@lody/shared';
import type {
  AcpConfigOptionSelector,
  AcpSelectorOptions,
} from '@/components/shared/acp-selector-options';
import {
  selectAuthorableAgentRoleConfigOptions,
  type AgentRoleRunConfigIssue,
} from '@/lib/agent-role-form';
import { withClassName } from '@/lib/stylex';
import { Button } from '@lody/ui/button';
import { Dialog } from '@lody/ui/dialog';
import { Input } from '@lody/ui/input';
import { Field as UiField } from '@lody/ui/field';
import { Select } from '@lody/ui/select';
import { Switch } from '@lody/ui/switch';
import { Tabs } from '@lody/ui/tabs';
import { Textarea } from '@lody/ui/textarea';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { settingsRecordsCard } from './compact-layout';
import { EmojiField } from './emoji-field';
import { Field, FormMessage, Section } from './form-primitives';
import { settingsCatalog as catalog, settingsSurface as surface } from './surface';

const styles = stylex.create({
  offline: { fontSize: '10px', color: colors.secondaryLabel },
  machineLabel: { display: 'flex', alignItems: 'center', gap: space[1.5], minWidth: 0 },
  placement: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[3],
    paddingBlock: space[2],
    paddingInline: space[4],
  },
  issuesTitle: { display: 'block' },
  issues: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    margin: 0,
    marginTop: space[1],
    paddingInlineStart: space[4],
    listStyleType: 'disc',
  },
});

export type AgentRoleAgentConfigOption = {
  agentConfigId: AgentConfigId;
  label: string;
  agentLabel?: string;
};

/** One machine the editor lists, with what its row needs to render. */
export type AgentRoleMachineRow = {
  machineId: MachineId;
  label: string;
  online: boolean;
  /** Configs on this machine. */
  agentConfigs: readonly AgentRoleAgentConfigOption[];
  /** Capability-derived controls for the row's selected config, or null when none is selected. */
  selectorOptions: AcpSelectorOptions | null;
  /** Parts of the row's saved run config its agent no longer supports. */
  issues: readonly AgentRoleRunConfigIssue[];
};

export type AgentRoleFormTab = 'machines' | 'memory';

export type AgentRoleFormProps = {
  value: AgentRoleFormValue;
  onChange: (value: AgentRoleFormValue) => void;
  /** In list order: the Role's placements first (their order is the dispatch order), then the rest. */
  machines: readonly AgentRoleMachineRow[];
  errors: readonly AgentRoleFormError[];
  submitting?: boolean;
  /** A write that failed, or one that is saved locally but not yet synced. */
  error?: string;
  isEditing?: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  className?: string;
  memoryPanel?: ReactNode;
  tab?: AgentRoleFormTab;
  onTabChange?: (tab: AgentRoleFormTab) => void;
};

/**
 * The Role editor body.
 *
 * Presentational on purpose: the surface that owns the catalog passes machines,
 * configs, and capability-derived selectors in, so this renders the same in
 * Storybook as it does in Settings.
 *
 * What the Role does (name, description, instruction, sharing) sits on top;
 * where it runs is one row per machine below, each with its own agent and run
 * options. Every run-config control is generated from that agent's published
 * capabilities. There is no free-text model or reasoning field, and no control
 * appears for an agent whose capabilities are unknown — offering one would let
 * a user author a Role that can only fail at Session creation.
 */
export function AgentRoleForm({
  value,
  onChange,
  machines,
  errors,
  submitting = false,
  error,
  isEditing = false,
  onSubmit,
  onCancel,
  className,
  memoryPanel,
  tab = 'machines',
  onTabChange,
}: AgentRoleFormProps) {
  const { t } = useTranslation();
  const fieldId = useId();
  const update = (patch: Partial<AgentRoleFormValue>) => onChange({ ...value, ...patch });
  const updatePlacement = (machineId: MachineId, patch: Partial<AgentRoleFormPlacement>) => {
    const exists = value.placements.some((placement) => placement.machineId === machineId);
    // A machine switched on for the first time joins the end of the list, so
    // it becomes the last machine dispatch falls back to.
    const placements = exists
      ? value.placements
      : [...value.placements, buildEmptyAgentRoleFormPlacement(machineId)];
    update({
      placements: placements.map((placement) =>
        placement.machineId === machineId ? { ...placement, ...patch } : placement
      ),
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };
  const hasError = (code: AgentRoleFormError) => errors.includes(code);

  return (
    <form {...withClassName(stylex.props(catalog.editorForm), className)} onSubmit={submit}>
      <div {...withClassName(stylex.props(catalog.editorBody), 'scrollbar-pro')}>
        {/* The Role's own label, shown as itself rather than inside a titled
            card: an emoji and a name need no section heading to be read. */}
        <div {...stylex.props(catalog.stack)}>
          <Input
            id={`${fieldId}-name`}
            autoComplete="off"
            aria-label={t('settings.agentRoles.form.name')}
            leading={
              <EmojiField
                value={value.emoji}
                defaultEmoji={DEFAULT_AGENT_ROLE_EMOJI}
                onChange={(emoji) => update({ emoji })}
              />
            }
            maxLength={AGENT_ROLE_NAME_MAX_LENGTH}
            placeholder={t('settings.agentRoles.form.name')}
            aria-invalid={hasError('name_required') || undefined}
            value={value.name}
            onChange={(event) => update({ name: event.target.value })}
          />
          {hasError('name_taken') ? (
            <FormMessage tone="error">{t('settings.agentRoles.errors.nameTaken')}</FormMessage>
          ) : null}
        </div>

        <Section
          title={t('settings.agentRoles.form.description')}
          hint={t('settings.agentRoles.form.descriptionHint')}
        >
          <Textarea
            id={`${fieldId}-description`}
            rows={2}
            resize="none"
            aria-label={t('settings.agentRoles.form.description')}
            value={value.description}
            onChange={(event) =>
              update({ description: normalizeAgentRoleDescription(event.target.value) })
            }
          />
        </Section>

        <Section
          title={t('settings.agentRoles.form.sectionPrompt')}
          hint={t('settings.agentRoles.form.sectionPromptHint')}
        >
          <Textarea
            id={`${fieldId}-prompt`}
            rows={4}
            resize="none"
            aria-label={t('settings.agentRoles.form.promptPrefix')}
            placeholder={t('settings.agentRoles.form.promptPrefixPlaceholder')}
            value={value.promptPrefix}
            onChange={(event) => update({ promptPrefix: event.target.value })}
          />
        </Section>

        <div {...stylex.props(surface.formBlock, catalog.blockRow)}>
          <div {...stylex.props(catalog.blockText)}>
            <UiField.Label htmlFor={`${fieldId}-share`}>
              {t('settings.agentRoles.form.share')}
            </UiField.Label>
            <p {...stylex.props(catalog.blockHint)}>{t('settings.agentRoles.form.shareHint')}</p>
          </div>
          <Switch
            id={`${fieldId}-share`}
            checked={value.shareWithWorkspace}
            onCheckedChange={(shareWithWorkspace) => update({ shareWithWorkspace })}
          />
        </div>

        <Tabs.Root value={tab} onValueChange={(next) => onTabChange?.(next as AgentRoleFormTab)}>
          <Tabs.List>
            <Tabs.Tab value="machines">{t('settings.agentRoles.machinesTab')}</Tabs.Tab>
            <Tabs.Tab value="memory">{t('settings.agentRoles.form.memory')}</Tabs.Tab>
          </Tabs.List>
        </Tabs.Root>

        {tab === 'machines' ? (
          <div {...stylex.props(catalog.stack)}>
            <p {...stylex.props(catalog.blockHint)}>{t('settings.agentRoles.form.machinesHint')}</p>
            <div {...stylex.props(settingsRecordsCard)}>
              {machines.map((machine, index) => (
                <div
                  key={machine.machineId}
                  {...stylex.props(surface.line, index > 0 && surface.lineRuled)}
                >
                  <PlacementRow
                    machine={machine}
                    placement={value.placements.find(
                      (placement) => placement.machineId === machine.machineId
                    )}
                    onChange={(patch) => updatePlacement(machine.machineId, patch)}
                  />
                </div>
              ))}
            </div>
          </div>
        ) : (
          memoryPanel
        )}
        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
      </div>

      <Dialog.Footer>
        <Button type="button" variant="secondary" disabled={submitting} onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" disabled={submitting || errors.length > 0}>
          {submitting ? <Spinner size="small" aria-hidden="true" /> : null}
          {isEditing ? t('common.save') : t('settings.agentRoles.form.create')}
        </Button>
      </Dialog.Footer>
    </form>
  );
}

/**
 * One machine: a switch, and while it is on, the agent and run options the
 * Role uses there. Switching off keeps the row's settings for when it comes back.
 */
function PlacementRow({
  machine,
  placement,
  onChange,
}: {
  machine: AgentRoleMachineRow;
  placement: AgentRoleFormPlacement | undefined;
  onChange: (patch: Partial<AgentRoleFormPlacement>) => void;
}) {
  const { t } = useTranslation();
  const fieldId = useId();
  const enabled = placement?.enabled === true;
  const { selectorOptions, issues } = machine;
  const configOptionSelectors = selectorOptions
    ? selectAuthorableAgentRoleConfigOptions(selectorOptions.configOptionSelectors)
    : [];

  return (
    <div {...stylex.props(styles.placement)}>
      <div {...stylex.props(catalog.blockRow)}>
        <UiField.Label htmlFor={fieldId}>
          <span {...stylex.props(styles.machineLabel)}>
            {machine.label}
            {machine.online ? null : (
              <span {...stylex.props(styles.offline)}>
                {t('settings.agentRoles.status.offline')}
              </span>
            )}
          </span>
        </UiField.Label>
        <Switch
          id={fieldId}
          checked={enabled}
          onCheckedChange={(checked) => onChange({ enabled: checked })}
        />
      </div>
      {enabled && placement ? (
        machine.agentConfigs.length === 0 ? (
          <FormMessage tone="warning">{t('settings.agentRoles.form.noAgentConfigs')}</FormMessage>
        ) : (
          <>
            <Field label={t('settings.agentRoles.form.agentConfig')}>
              <Select.Root
                items={machine.agentConfigs.map((config) => ({
                  value: config.agentConfigId,
                  label: config.label,
                }))}
                value={placement.agentConfigId ?? null}
                onValueChange={(agentConfigId) => {
                  if (agentConfigId == null) return;
                  onChange({
                    agentConfigId: agentConfigId as AgentConfigId,
                    // Capabilities belong to the config; keeping the old model
                    // would carry a selection the new agent may not publish.
                    modeId: null,
                    modelId: null,
                    configOptionValues: {},
                  });
                }}
              >
                <Select.Trigger
                  aria-label={t('settings.agentRoles.form.agentConfig')}
                  aria-invalid={!placement.agentConfigId || undefined}
                >
                  <Select.Value
                    placeholder={t('settings.agentRoles.form.agentConfigPlaceholder')}
                  />
                </Select.Trigger>
                <Select.Content>
                  {machine.agentConfigs.map((config) => (
                    <Select.Item key={config.agentConfigId} value={config.agentConfigId}>
                      {config.label}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </Field>
            {placement.agentConfigId ? (
              selectorOptions?.capabilityAuthority === 'unavailable' || !selectorOptions ? (
                <FormMessage tone="warning">
                  {t('settings.agentRoles.form.capabilitiesUnavailable')}
                </FormMessage>
              ) : (
                <>
                  {selectorOptions.modelOptions.length > 0 ? (
                    <Field label={t('settings.agentRoles.form.model')}>
                      <ValueSelect
                        label={t('settings.agentRoles.form.model')}
                        value={placement.modelId}
                        options={selectorOptions.modelOptions}
                        onChange={(modelId) => onChange({ modelId })}
                      />
                    </Field>
                  ) : null}
                  {selectorOptions.modeOptions.length > 0 ? (
                    <Field label={t('settings.agentRoles.form.mode')}>
                      <ValueSelect
                        label={t('settings.agentRoles.form.mode')}
                        value={placement.modeId}
                        options={selectorOptions.modeOptions}
                        onChange={(modeId) => onChange({ modeId })}
                      />
                    </Field>
                  ) : null}
                  {configOptionSelectors.map((selector) => (
                    <ConfigOptionField
                      key={selector.configId}
                      selector={selector}
                      value={placement.configOptionValues[selector.configId]}
                      onChange={(next) =>
                        onChange({
                          configOptionValues: {
                            ...placement.configOptionValues,
                            [selector.configId]: next,
                          },
                        })
                      }
                    />
                  ))}
                </>
              )
            ) : null}
            {issues.length > 0 ? (
              <FormMessage tone="warning">
                <span {...stylex.props(styles.issuesTitle)}>
                  {t('settings.agentRoles.form.incompatibleTitle')}
                </span>
                <ul {...stylex.props(styles.issues)}>
                  {issues.map((issue, index) => (
                    <li key={`${issue.kind}-${index}`}>
                      <RunConfigIssueText issue={issue} />
                    </li>
                  ))}
                </ul>
              </FormMessage>
            ) : null}
          </>
        )
      ) : null}
    </div>
  );
}

/**
 * The Role's glyph: the current emoji, and a picker behind it.
 *
 * An always-filled button rather than a text field. Typing an emoji means
 * knowing the OS shortcut, and an empty slot makes "no emoji" look like an
 * unfinished form — so the button shows the default glyph and clicking it is a
 * change, the way a Notion page icon works.
 */
function RunConfigIssueText({ issue }: { issue: AgentRoleRunConfigIssue }) {
  const { t } = useTranslation();
  const describe = (): string => {
    switch (issue.kind) {
      case 'capabilities_unknown':
        return t('settings.agentRoles.issues.capabilitiesUnknown');
      case 'mode_unsupported':
        return t('settings.agentRoles.issues.modeUnsupported', { value: issue.value });
      case 'model_unsupported':
        return t('settings.agentRoles.issues.modelUnsupported', { value: issue.value });
      case 'option_unsupported':
        return t('settings.agentRoles.issues.optionUnsupported', { option: issue.configId });
      case 'option_value_unsupported':
        return t('settings.agentRoles.issues.optionValueUnsupported', {
          option: issue.configId,
          value: issue.value,
        });
      default: {
        const exhaustive: never = issue;
        return String(exhaustive);
      }
    }
  };
  return <>{describe()}</>;
}

/**
 * A capability selector over the values the agent publishes.
 *
 * There is no "agent default" entry: a Role that stores nothing tells its owner
 * nothing about what will run, so the form seeds the agent's own default and the
 * control always shows a concrete choice.
 */
function ValueSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | null;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <Select.Root
      items={options}
      value={value}
      onValueChange={(next) => {
        if (next != null) onChange(next);
      }}
    >
      <Select.Trigger aria-label={label}>
        <Select.Value />
      </Select.Trigger>
      <Select.Content>
        {options.map((option) => (
          <Select.Item key={option.value} value={option.value}>
            {option.label}
          </Select.Item>
        ))}
      </Select.Content>
    </Select.Root>
  );
}

function ConfigOptionField({
  selector,
  value,
  onChange,
}: {
  selector: AcpConfigOptionSelector;
  value: string | boolean | undefined;
  onChange: (value: string | boolean) => void;
}) {
  const fieldId = useId();
  if (selector.type === 'boolean') {
    return (
      <div {...stylex.props(catalog.blockRow)}>
        <div {...stylex.props(catalog.blockText)}>
          <UiField.Label htmlFor={fieldId}>{selector.label}</UiField.Label>
          {selector.description ? (
            <p {...stylex.props(catalog.blockHint)}>{selector.description}</p>
          ) : null}
        </div>
        <Switch
          id={fieldId}
          checked={value === true}
          onCheckedChange={(checked) => onChange(checked)}
        />
      </div>
    );
  }

  return (
    <Field label={selector.label} hint={selector.description}>
      <ValueSelect
        label={selector.label}
        value={typeof value === 'string' ? value : null}
        options={selector.options}
        onChange={onChange}
      />
    </Field>
  );
}
