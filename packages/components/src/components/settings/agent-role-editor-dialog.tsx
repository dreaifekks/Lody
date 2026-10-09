import { useEffect, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { usePostHog } from '@posthog/react';
import { useTranslation } from 'react-i18next';
import {
  buildAgentRoleFormValue,
  buildAgentRoleFromForm,
  buildAgentRoleRunConfig,
  getServerNow,
  buildEmptyAgentRoleFormInstance,
  validateAgentRoleForm,
  type AgentRole,
  type AgentRoleFormInstance,
  type AgentRoleInstanceId,
  type CatalogAgentRole,
  type AgentRoleFormValue,
  type AgentRoleId,
} from '@lody/shared';

import { userAtom } from '@/atoms';
import { getAllAgentConfigAtom } from '@/atoms/agents';
import { onlineMachineIdsAtom } from '@/atoms/presence';
import { buildAcpSelectorOptions } from '@/components/shared/acp-selector-options';
import { resolveAcpSelectorOptions } from '@/hooks/use-acp-selector-options';
import { useDialogExitSnapshot } from '@/hooks/use-dialog-exit-snapshot';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';
import { useWorkspaceAgentRoleActions } from '@/hooks/use-workspace-agent-roles';
import {
  applyAgentRoleRunConfigDefaults,
  carryAgentRoleOptionsToModel,
  findAgentRoleRunConfigIssues,
} from '@/lib/agent-role-form';
import { capturePostHogEvent } from '@/lib/posthog-analytics';
import { Dialog } from '@/ui/dialog';
import { AgentRoleForm } from './agent-role-form';
import { RoleMemoryPicker } from './memory-setting';
import { useSettingsPane } from './settings-page-header';
import { SETTINGS_EDITOR_DIALOG_LAYOUT, SETTINGS_EDITOR_DIALOG_WIDTH } from './surface';

/**
 * A `create` carries its id from the moment the form opens.
 *
 * The id is what the name check must ignore, and a `create` becomes a catalog
 * row the instant its local write lands — while the dialog is still open. An id
 * allocated at save time would leave a window where the form finds the row it
 * just wrote and reports its own name as taken.
 */
export type AgentRoleEditorState =
  | { mode: 'add'; roleId: AgentRoleId; value: AgentRoleFormValue }
  | { mode: 'edit'; role: CatalogAgentRole; value: AgentRoleFormValue };

export const openAgentRoleEditorForCreate = (value: AgentRoleFormValue): AgentRoleEditorState => ({
  mode: 'add',
  roleId: crypto.randomUUID() as AgentRoleId,
  value,
});

/**
 * Edit the catalog row, the only Role value the type admits: a Role assembled
 * anywhere else could miss instances, and saving it would drop them.
 */
export const openAgentRoleEditorForEdit = (role: CatalogAgentRole): AgentRoleEditorState => ({
  mode: 'edit',
  role,
  value: buildAgentRoleFormValue(role),
});

/** Edit a Role a composer picked one instance of, by id, from the catalog. */
export const openAgentRoleEditorById = (
  catalog: readonly CatalogAgentRole[],
  roleId: AgentRoleId
): AgentRoleEditorState | null => {
  const role = catalog.find((entry) => entry.id === roleId);
  return role ? openAgentRoleEditorForEdit(role) : null;
};

/**
 * The one Role editor.
 *
 * Settings and the composer's Role picker both create and edit Roles, and the
 * rules that must not be got wrong — when `revision` moves, which option keys a
 * Role may store, whether a saved value is still supported — live in
 * `lib/agent-role-form.ts` behind this single dialog rather than being wired up
 * twice.
 */
export function AgentRoleEditorDialog({
  editor: openEditor,
  accessibleRoles,
  onChange,
  onClose,
  onSaved,
  source,
}: {
  editor: AgentRoleEditorState | null;
  /** Roles this user can see, for the mention-token uniqueness check. */
  accessibleRoles: readonly AgentRole[];
  onChange: (editor: AgentRoleEditorState) => void;
  onClose: () => void;
  /**
   * The Role that was just written, once it is durable. `created` separates a
   * new Role from an edit, because a surface that OPENED the create — the
   * composer — means to start using what it just made, while an edit is only an
   * edit.
   */
  onSaved?: (role: AgentRole, meta: { created: boolean }) => void;
  /** Entry point that opened the editor; used only for product analytics. */
  source: 'settings' | 'chat_landing' | 'session_composer';
}) {
  const { t } = useTranslation();
  const postHog = usePostHog();
  const currentUserId = useAtomValue(userAtom)?.id ?? null;
  const onlineMachineIds = useAtomValue(onlineMachineIdsAtom);
  const agentConfigs = useAtomValue(getAllAgentConfigAtom);
  const { machines } = useVisibleMachineMetas();
  const { upsert } = useWorkspaceAgentRoleActions();
  const settingsPane = useSettingsPane();
  // Everything below renders the editor the dialog was open with, so a closing
  // panel fades out with its form rather than emptying first.
  const { shown: editor, onOpenChangeComplete } = useDialogExitSnapshot(openEditor);

  const [expandedInstanceId, setExpandedInstanceId] = useState<AgentRoleInstanceId | null>(null);
  const editorId = openEditor?.mode === 'edit' ? openEditor.role.id : openEditor?.roleId;
  useEffect(() => {
    // A new Role opens on its first instance, an existing one closed.
    setExpandedInstanceId(
      openEditor?.mode === 'add' ? (openEditor.value.instances[0]?.id ?? null) : null
    );
    // Reset per opened Role only, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorId]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const machineOptions = useMemo(
    () =>
      [...machines.values()]
        .map((machine) => ({
          machineId: machine.id,
          label: machine.name || machine.id,
          online: onlineMachineIds.has(machine.id),
        }))
        .sort((left, right) => left.label.localeCompare(right.label)),
    [machines, onlineMachineIds]
  );

  const configFor = (instance: AgentRoleFormInstance) =>
    instance.agentConfigId && instance.machineId
      ? agentConfigs.find(
          (entry) => entry.id === instance.agentConfigId && entry.machineId === instance.machineId
        )
      : undefined;
  const selectorTargetFor = (instance: AgentRoleFormInstance) => {
    const config = configFor(instance);
    return config && instance.machineId
      ? {
          configId: config.id,
          cliType: config.cliType,
          agentType: config.agentType,
          runtimeOverrides: config.runtimeOverrides,
          machine: machines.get(instance.machineId) ?? null,
          // A Role pins its model: the effort ladder must follow the model
          // being edited, not the probe-time current one, so the picker and
          // the compatibility check agree on the same ladder.
          selectedModelId: instance.modelId,
        }
      : undefined;
  };
  const selectorOptionsByInstance = useMemo(
    () =>
      new Map(
        (editor?.value.instances ?? []).flatMap((instance) => {
          const target = selectorTargetFor(instance);
          return target ? [[instance.id, resolveAcpSelectorOptions(target, t)] as const] : [];
        })
      ),
    // `selectorTargetFor` reads only the inputs listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agentConfigs, editor?.value.instances, machines, t]
  );

  // A Role pins concrete values, so as soon as an agent config's capabilities
  // are known its own defaults fill the unset fields. The user then adjusts a
  // real selection instead of accepting an "Agent default" that says nothing
  // about what would run. A stored value is never overwritten — that is what
  // keeps an incompatible one visible. Derived rather than written back: the
  // defaults are a function of the value and the capabilities, and the helper
  // returns the instance itself when it changes nothing.
  const editorValue = useMemo(
    () =>
      editor
        ? {
            ...editor.value,
            instances: editor.value.instances.map((instance) =>
              applyAgentRoleRunConfigDefaults(
                instance,
                selectorOptionsByInstance.get(instance.id) ?? null
              )
            ),
          }
        : null,
    [editor, selectorOptionsByInstance]
  );

  const formErrors = useMemo(
    () =>
      editorValue
        ? validateAgentRoleForm(editorValue, {
            accessibleRoles,
            editingRoleId: editor
              ? editor.mode === 'edit'
                ? editor.role.id
                : editor.roleId
              : null,
          })
        : [],
    [accessibleRoles, editor, editorValue]
  );
  const instanceRows = useMemo(
    () =>
      new Map(
        (editorValue?.instances ?? []).map((instance) => {
          const selectorOptions = selectorOptionsByInstance.get(instance.id) ?? null;
          const model = instance.modelId
            ? (selectorOptions?.modelOptions.find((option) => option.value === instance.modelId)
                ?.label ?? instance.modelId)
            : null;
          return [
            instance.id,
            {
              agentConfigs: agentConfigs
                .filter((config) => config.machineId === instance.machineId)
                .map((config) => ({ agentConfigId: config.id, label: config.name })),
              selectorOptions,
              issues: selectorOptions
                ? findAgentRoleRunConfigIssues(buildAgentRoleRunConfig(instance), selectorOptions)
                : [],
              summary: [configFor(instance)?.name, model].filter(Boolean).join(' · '),
            },
          ] as const;
        })
      ),
    // `configFor` reads only the inputs listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agentConfigs, editorValue, selectorOptionsByInstance]
  );

  const close = () => {
    setError(undefined);
    onClose();
  };

  const save = async () => {
    if (!openEditor || !editor || !editorValue || formErrors.length > 0 || !currentUserId) return;
    const role = buildAgentRoleFromForm(editorValue, {
      existing: editor.mode === 'edit' ? editor.role : undefined,
      ownerUserId: currentUserId,
      now: getServerNow(),
      createId: () => (editor.mode === 'add' ? editor.roleId : editor.role.id),
    });

    setSubmitting(true);
    setError(undefined);
    try {
      // Resolves on durability: the row exists, so the editor is done. The
      // upload runs on its own and is deliberately not reported — a deferred
      // upload is not a failed save and there is nothing to act on.
      await upsert(role);
      if (editor.mode === 'add') {
        capturePostHogEvent(postHog, 'settings/agent_role_created', {
          source,
          visibility: role.visibility,
          has_prompt_prefix: Boolean(role.promptPrefix),
          run_config_option_count: Object.keys(role.runConfig.configOptionValues ?? {}).length,
          instance_count: role.instances.length,
        });
      }
      onSaved?.(role, { created: editor.mode === 'add' });
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root
      open={openEditor !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      onOpenChangeComplete={onOpenChangeComplete}
    >
      <Dialog.Content
        width={SETTINGS_EDITOR_DIALOG_WIDTH}
        centerOn={settingsPane}
        className={SETTINGS_EDITOR_DIALOG_LAYOUT}
        style={{ height: 'min(680px, 88dvh)' }}
      >
        <Dialog.Header>
          <Dialog.Title>
            {editor?.mode === 'edit'
              ? t('settings.agentRoles.editTitle')
              : t('settings.agentRoles.addTitle')}
          </Dialog.Title>
          <Dialog.Description>{t('settings.agentRoles.dialogDescription')}</Dialog.Description>
        </Dialog.Header>
        {editor && editorValue ? (
          <AgentRoleForm
            value={editorValue}
            // A panel fading out is not edited: a change there would reopen it.
            onChange={(value) => {
              if (!openEditor) return;
              const instances = value.instances.map((instance) => {
                const previous = editorValue.instances.find((entry) => entry.id === instance.id);
                const modelChanged =
                  previous !== undefined &&
                  instance.agentConfigId === previous.agentConfigId &&
                  instance.modelId !== previous.modelId;
                const target = selectorTargetFor(instance);
                return modelChanged && target
                  ? {
                      ...instance,
                      configOptionValues: carryAgentRoleOptionsToModel(
                        instance.configOptionValues,
                        selectorOptionsByInstance.get(instance.id)?.configOptionSelectors ?? [],
                        buildAcpSelectorOptions(target).configOptionSelectors
                      ),
                    }
                  : instance;
              });
              onChange({ ...openEditor, value: { ...value, instances } });
            }}
            machines={machineOptions}
            instanceRows={instanceRows}
            expandedInstanceId={expandedInstanceId}
            onExpandedInstanceChange={setExpandedInstanceId}
            onAddInstance={() => {
              if (!openEditor) return;
              const instance = buildEmptyAgentRoleFormInstance(
                crypto.randomUUID() as AgentRoleInstanceId
              );
              onChange({
                ...openEditor,
                value: { ...editorValue, instances: [...editorValue.instances, instance] },
              });
              setExpandedInstanceId(instance.id);
            }}
            renderMemory={(instance) =>
              instance.machineId ? (
                <RoleMemoryPicker
                  key={instance.machineId}
                  machineId={instance.machineId}
                  value={instance.memory}
                  onChange={(memory) => {
                    if (!openEditor) return;
                    onChange({
                      ...openEditor,
                      value: {
                        ...editorValue,
                        instances: editorValue.instances.map((entry) =>
                          entry.id === instance.id ? { ...entry, memory } : entry
                        ),
                      },
                    });
                  }}
                />
              ) : null
            }
            errors={formErrors}
            submitting={submitting}
            error={error}
            isEditing={editor.mode === 'edit'}
            onSubmit={() => void save()}
            onCancel={close}
          />
        ) : null}
      </Dialog.Content>
    </Dialog.Root>
  );
}
