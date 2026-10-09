import { useId, type FormEvent, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import { useTranslation } from 'react-i18next';
import {
  AGENT_ROLE_INSTANCE_ALIAS_MAX_LENGTH,
  AGENT_ROLE_NAME_MAX_LENGTH,
  normalizeAgentRoleDescription,
  DEFAULT_AGENT_ROLE_EMOJI,
  validateAgentRoleFormInstance,
  type AgentConfigId,
  type AgentRoleAgentFamily,
  type AgentRoleFormError,
  type AgentRoleFormInstance,
  type AgentRoleFormValue,
  type AgentRoleInstanceId,
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
import { Textarea } from '@lody/ui/textarea';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { settingsRecordsCard } from './compact-layout';
import { EmojiField } from './emoji-field';
import { Field, FormMessage, Section } from './form-primitives';
import { settingsCatalog as catalog, settingsSurface as surface } from './surface';

const styles = stylex.create({
  offline: { fontSize: '10px', color: colors.secondaryLabel },
  option: { display: 'flex', alignItems: 'center', gap: space[1.5] },
  instanceEditor: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[3],
    paddingBlockEnd: space[3],
    paddingInline: space[4],
  },
  addRow: { alignSelf: 'flex-start' },
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
};

export type AgentRoleMachineOption = {
  machineId: MachineId;
  label: string;
  online: boolean;
};

/** What an instance's row needs beyond its form value. */
export type AgentRoleInstanceRowModel = {
  /** Configs on the instance's machine. */
  agentConfigs: readonly AgentRoleAgentConfigOption[];
  /** Capability-derived controls for its agent, or null when none is chosen. */
  selectorOptions: AcpSelectorOptions | null;
  /** Parts of its saved run config the agent no longer supports. */
  issues: readonly AgentRoleRunConfigIssue[];
  /** `Claude · Opus`: the agent and model, for the collapsed row. */
  summary: string;
};

export type AgentRoleFormProps = {
  value: AgentRoleFormValue;
  onChange: (value: AgentRoleFormValue) => void;
  machines: readonly AgentRoleMachineOption[];
  /** An agent's family, which groups the instances without an alias. */
  agentFamilyOf: (agentConfigId: AgentConfigId) => AgentRoleAgentFamily | undefined;
  /** Keyed by instance id. */
  instanceRows: ReadonlyMap<AgentRoleInstanceId, AgentRoleInstanceRowModel>;
  expandedInstanceId: AgentRoleInstanceId | null;
  onExpandedInstanceChange: (instanceId: AgentRoleInstanceId | null) => void;
  onAddInstance: () => void;
  /** The memory picker for an instance: identities imported on its machine. */
  renderMemory?: (instance: AgentRoleFormInstance) => ReactNode;
  errors: readonly AgentRoleFormError[];
  submitting?: boolean;
  /** A write that failed, or one that is saved locally but not yet synced. */
  error?: string;
  isEditing?: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  className?: string;
};

/**
 * The Role editor body.
 *
 * Presentational on purpose: the surface that owns the catalog passes machines,
 * configs, and capability-derived selectors in, so this renders the same in
 * Storybook as it does in Settings.
 *
 * What the Role does (name, description, instruction, sharing) sits on top;
 * its instances are listed below, one row each — name (alias, else agent),
 * machine, agent and model — and open in place to be edited. Every run-config control is
 * generated from that agent's published capabilities. There is no free-text
 * model or reasoning field, and no control appears for an agent whose
 * capabilities are unknown — offering one would let a user author a Role that
 * can only fail at Session creation.
 */
export function AgentRoleForm({
  value,
  onChange,
  machines,
  agentFamilyOf,
  instanceRows,
  expandedInstanceId,
  onExpandedInstanceChange,
  onAddInstance,
  renderMemory,
  errors,
  submitting = false,
  error,
  isEditing = false,
  onSubmit,
  onCancel,
  className,
}: AgentRoleFormProps) {
  const { t } = useTranslation();
  const fieldId = useId();
  const update = (patch: Partial<AgentRoleFormValue>) => onChange({ ...value, ...patch });
  const updateInstance = (instanceId: AgentRoleInstanceId, patch: Partial<AgentRoleFormInstance>) =>
    update({
      instances: value.instances.map((instance) =>
        instance.id === instanceId ? { ...instance, ...patch } : instance
      ),
    });
  const removeInstance = (instanceId: AgentRoleInstanceId) =>
    update({ instances: value.instances.filter((instance) => instance.id !== instanceId) });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };
  const hasError = (code: AgentRoleFormError) => errors.includes(code);
  const machineLabel = (machineId: MachineId | null) =>
    machines.find((machine) => machine.machineId === machineId)?.label ??
    t('settings.agentRoles.unknownMachine');

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

        <Section
          title={t('settings.agentRoles.form.instances')}
          hint={t('settings.agentRoles.form.instancesHint')}
        >
          {value.instances.length > 0 ? (
            <div {...stylex.props(settingsRecordsCard)}>
              {value.instances.map((instance, index) => {
                const row = instanceRows.get(instance.id);
                const expanded = instance.id === expandedInstanceId;
                const invalid =
                  validateAgentRoleFormInstance(instance, value.instances, agentFamilyOf).length >
                  0;
                return (
                  <div
                    key={instance.id}
                    {...stylex.props(surface.line, index > 0 && surface.lineRuled)}
                  >
                    <div {...stylex.props(catalog.row, surface.pressableLine)}>
                      <button
                        type="button"
                        aria-expanded={expanded}
                        onClick={() => onExpandedInstanceChange(expanded ? null : instance.id)}
                        {...stylex.props(catalog.rowMain)}
                      >
                        {expanded ? (
                          <ChevronDown {...stylex.props(catalog.icon)} aria-hidden="true" />
                        ) : (
                          <ChevronRight {...stylex.props(catalog.icon)} aria-hidden="true" />
                        )}
                        <span {...stylex.props(catalog.body)}>
                          <span {...stylex.props(catalog.titleLine)}>
                            <span {...stylex.props(catalog.name)}>
                              {instance.alias.trim() ||
                                (instance.agentConfigId
                                  ? agentFamilyOf(instance.agentConfigId)?.name
                                  : undefined) ||
                                t('settings.agentRoles.form.newInstance')}
                            </span>
                          </span>
                          <span
                            {...stylex.props(
                              catalog.meta,
                              invalid && !expanded && catalog.metaWarning
                            )}
                          >
                            <span {...stylex.props(catalog.truncate)}>
                              {[
                                instance.machineId ? machineLabel(instance.machineId) : null,
                                row?.summary || null,
                              ]
                                .filter(Boolean)
                                .join(' · ') || t('settings.agentRoles.form.instanceIncomplete')}
                            </span>
                          </span>
                        </span>
                      </button>
                      <div {...stylex.props(catalog.actions)}>
                        <Button
                          type="button"
                          variant="ghost"
                          aria-label={t('common.remove')}
                          size="small"
                          icon
                          tone="destructive"
                          onClick={() => removeInstance(instance.id)}
                        >
                          <Trash2 {...stylex.props(catalog.icon)} />
                        </Button>
                      </div>
                    </div>
                    {expanded ? (
                      <InstanceEditor
                        instance={instance}
                        siblings={value.instances}
                        agentFamilyOf={agentFamilyOf}
                        row={row}
                        machines={machines}
                        onChange={(patch) => updateInstance(instance.id, patch)}
                        memory={renderMemory?.(instance)}
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}
          <Button
            type="button"
            size="small"
            variant="secondary"
            onClick={onAddInstance}
            {...stylex.props(styles.addRow)}
          >
            <Plus {...stylex.props(catalog.icon)} />
            {t('settings.agentRoles.form.addInstance')}
          </Button>
        </Section>
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
 * One instance, opened: where it runs, which agent, that agent's options and
 * the memory it uses there. Changing the machine or the agent clears what
 * belonged to the old one.
 */
function InstanceEditor({
  instance,
  siblings,
  agentFamilyOf,
  row,
  machines,
  onChange,
  memory,
}: {
  instance: AgentRoleFormInstance;
  siblings: readonly AgentRoleFormInstance[];
  agentFamilyOf: AgentRoleFormProps['agentFamilyOf'];
  row: AgentRoleInstanceRowModel | undefined;
  machines: readonly AgentRoleMachineOption[];
  onChange: (patch: Partial<AgentRoleFormInstance>) => void;
  memory: ReactNode;
}) {
  const { t } = useTranslation();
  const fieldId = useId();
  const errors = validateAgentRoleFormInstance(instance, siblings, agentFamilyOf);
  const familyName = instance.agentConfigId
    ? agentFamilyOf(instance.agentConfigId)?.name
    : undefined;
  const agentConfigs = row?.agentConfigs ?? [];
  const selectorOptions = row?.selectorOptions ?? null;
  const issues = row?.issues ?? [];
  const configOptionSelectors = selectorOptions
    ? selectAuthorableAgentRoleConfigOptions(selectorOptions.configOptionSelectors)
    : [];

  return (
    <div {...stylex.props(styles.instanceEditor)}>
      <div {...stylex.props(catalog.fieldPair)}>
        <Field label={t('settings.agentRoles.form.machine')}>
          <Select.Root
            items={machines.map((machine) => ({ value: machine.machineId, label: machine.label }))}
            value={instance.machineId}
            onValueChange={(machineId) => {
              if (machineId == null || machineId === instance.machineId) return;
              // An agent config, its options and a memory identity all belong
              // to one machine; carrying them over would point at nothing.
              onChange({
                machineId: machineId as MachineId,
                agentConfigId: null,
                modeId: null,
                modelId: null,
                configOptionValues: {},
                memory: undefined,
              });
            }}
          >
            <Select.Trigger
              aria-label={t('settings.agentRoles.form.machine')}
              aria-invalid={errors.includes('machine_required') || undefined}
            >
              <Select.Value placeholder={t('settings.agentRoles.form.machinePlaceholder')} />
            </Select.Trigger>
            <Select.Content>
              {machines.map((machine) => (
                <Select.Item key={machine.machineId} value={machine.machineId}>
                  <span {...stylex.props(styles.option)}>
                    {machine.label}
                    {machine.online ? null : (
                      <span {...stylex.props(styles.offline)}>
                        {t('settings.agentRoles.status.offline')}
                      </span>
                    )}
                  </span>
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        </Field>
        <Field label={t('settings.agentRoles.form.agentConfig')}>
          <Select.Root
            items={agentConfigs.map((config) => ({
              value: config.agentConfigId,
              label: config.label,
            }))}
            value={instance.agentConfigId}
            disabled={!instance.machineId || agentConfigs.length === 0}
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
              aria-invalid={errors.includes('agent_config_required') || undefined}
            >
              <Select.Value placeholder={t('settings.agentRoles.form.agentConfigPlaceholder')} />
            </Select.Trigger>
            <Select.Content>
              {agentConfigs.map((config) => (
                <Select.Item key={config.agentConfigId} value={config.agentConfigId}>
                  {config.label}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        </Field>
      </div>
      {instance.machineId && agentConfigs.length === 0 ? (
        <FormMessage tone="warning">{t('settings.agentRoles.form.noAgentConfigs')}</FormMessage>
      ) : null}
      <Field
        label={t('settings.agentRoles.form.alias')}
        hint={t('settings.agentRoles.form.aliasHint')}
        htmlFor={`${fieldId}-alias`}
      >
        <Input
          id={`${fieldId}-alias`}
          autoComplete="off"
          maxLength={AGENT_ROLE_INSTANCE_ALIAS_MAX_LENGTH}
          placeholder={familyName}
          aria-invalid={errors.includes('group_taken') || undefined}
          value={instance.alias}
          onChange={(event) => onChange({ alias: event.target.value })}
        />
      </Field>
      {errors.includes('group_taken') ? (
        <FormMessage tone="error">
          {t('settings.agentRoles.errors.groupTaken', {
            name: instance.alias.trim() || familyName,
          })}
        </FormMessage>
      ) : null}
      {instance.agentConfigId ? (
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
                  value={instance.modelId}
                  options={selectorOptions.modelOptions}
                  onChange={(modelId) => onChange({ modelId })}
                />
              </Field>
            ) : null}
            {selectorOptions.modeOptions.length > 0 ? (
              <Field label={t('settings.agentRoles.form.mode')}>
                <ValueSelect
                  label={t('settings.agentRoles.form.mode')}
                  value={instance.modeId}
                  options={selectorOptions.modeOptions}
                  onChange={(modeId) => onChange({ modeId })}
                />
              </Field>
            ) : null}
            {configOptionSelectors.map((selector) => (
              <ConfigOptionField
                key={selector.configId}
                selector={selector}
                value={instance.configOptionValues[selector.configId]}
                onChange={(next) =>
                  onChange({
                    configOptionValues: {
                      ...instance.configOptionValues,
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
      {instance.machineId ? (
        <Field label={t('settings.agentRoles.form.memory')}>{memory}</Field>
      ) : null}
    </div>
  );
}

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
