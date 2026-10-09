import { useEffect, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { usePostHog } from '@posthog/react';
import { useTranslation } from 'react-i18next';
import {
  buildAgentRoleFormValue,
  buildAgentRoleFromForm,
  buildAgentRoleRunConfig,
  getServerNow,
  listEnabledAgentRolePlacements,
  validateAgentRoleForm,
  type AgentRole,
  type AgentRoleFormPlacement,
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
import { AgentRoleForm, type AgentRoleFormTab } from './agent-role-form';
import { RoleMemoryPanel } from './memory-setting';
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
  | { mode: 'edit'; role: AgentRole; value: AgentRoleFormValue };

export const openAgentRoleEditorForCreate = (value: AgentRoleFormValue): AgentRoleEditorState => ({
  mode: 'add',
  roleId: crypto.randomUUID() as AgentRoleId,
  value,
});

export const openAgentRoleEditorForEdit = (role: AgentRole): AgentRoleEditorState => ({
  mode: 'edit',
  role,
  value: buildAgentRoleFormValue(role),
});

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

  const [tab, setTab] = useState<AgentRoleFormTab>('machines');
  const editorId = openEditor?.mode === 'edit' ? openEditor.role.id : openEditor?.roleId;
  useEffect(() => {
    setTab('machines');
  }, [editorId]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  // One row per machine: the Role's placements first, in their dispatch order
  // (a machine the user can no longer see keeps its row so it can be switched
  // off), then every other visible machine by name.
  const machineOrder = useMemo(() => {
    const placed = editor?.value.placements.map((placement) => placement.machineId) ?? [];
    const rest = [...machines.values()]
      .filter((machine) => !placed.includes(machine.id))
      .sort((left, right) => (left.name || left.id).localeCompare(right.name || right.id))
      .map((machine) => machine.id);
    return [...placed, ...rest];
  }, [editor?.value.placements, machines]);

  const selectorTargetFor = (placement: AgentRoleFormPlacement | undefined) => {
    const config = placement?.agentConfigId
      ? agentConfigs.find(
          (entry) => entry.id === placement.agentConfigId && entry.machineId === placement.machineId
        )
      : undefined;
    return config && placement
      ? {
          configId: config.id,
          cliType: config.cliType,
          agentType: config.agentType,
          runtimeOverrides: config.runtimeOverrides,
          machine: machines.get(placement.machineId) ?? null,
          // A Role pins its model: the effort ladder must follow the model
          // being edited, not the probe-time current one, so the picker and
          // the compatibility check agree on the same ladder.
          selectedModelId: placement.modelId,
        }
      : undefined;
  };
  const selectorOptionsByMachine = useMemo(
    () =>
      new Map(
        (editor?.value.placements ?? []).flatMap((placement) => {
          const target = selectorTargetFor(placement);
          return target
            ? [[placement.machineId, resolveAcpSelectorOptions(target, t)] as const]
            : [];
        })
      ),
    // `selectorTargetFor` reads only the inputs listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agentConfigs, editor?.value.placements, machines, t]
  );

  // A Role pins concrete values, so as soon as an agent config's capabilities
  // are known its own defaults fill the unset fields. The user then adjusts a
  // real selection instead of accepting an "Agent default" that says nothing
  // about what would run. A stored value is never overwritten — that is what
  // keeps an incompatible one visible. Derived rather than written back: the
  // defaults are a function of the value and the capabilities, and the helper
  // returns the placement itself when it changes nothing.
  const editorValue = useMemo(
    () =>
      editor
        ? {
            ...editor.value,
            placements: editor.value.placements.map((placement) =>
              applyAgentRoleRunConfigDefaults(
                placement,
                selectorOptionsByMachine.get(placement.machineId) ?? null
              )
            ),
          }
        : null,
    [editor, selectorOptionsByMachine]
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
  const machineRows = useMemo(
    () =>
      machineOrder.map((machineId) => {
        const placement = editorValue?.placements.find((entry) => entry.machineId === machineId);
        const selectorOptions = selectorOptionsByMachine.get(machineId) ?? null;
        return {
          machineId,
          label: machines.get(machineId)?.name || t('settings.agentRoles.unknownMachine'),
          online: onlineMachineIds.has(machineId),
          agentConfigs: agentConfigs
            .filter((config) => config.machineId === machineId)
            .map((config) => ({ agentConfigId: config.id, label: config.name })),
          selectorOptions,
          issues:
            placement && selectorOptions
              ? findAgentRoleRunConfigIssues(buildAgentRoleRunConfig(placement), selectorOptions)
              : [],
        };
      }),
    [
      agentConfigs,
      editorValue,
      machineOrder,
      machines,
      onlineMachineIds,
      selectorOptionsByMachine,
      t,
    ]
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
          machine_count: listEnabledAgentRolePlacements(role).length,
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
            tab={tab}
            onTabChange={setTab}
            value={editorValue}
            memoryPanel={
              <RoleMemoryPanel
                placements={editorValue.placements.filter((placement) => placement.enabled)}
                machineLabel={(machineId) =>
                  machines.get(machineId)?.name || t('settings.agentRoles.unknownMachine')
                }
                onChange={(machineId, memory) => {
                  if (!openEditor) return;
                  onChange({
                    ...openEditor,
                    value: {
                      ...editorValue,
                      placements: editorValue.placements.map((placement) =>
                        placement.machineId === machineId ? { ...placement, memory } : placement
                      ),
                    },
                  });
                }}
              />
            }
            // A panel fading out is not edited: a change there would reopen it.
            onChange={(value) => {
              if (!openEditor) return;
              const placements = value.placements.map((placement) => {
                const previous = editorValue.placements.find(
                  (entry) => entry.machineId === placement.machineId
                );
                const modelChanged =
                  previous !== undefined &&
                  placement.agentConfigId === previous.agentConfigId &&
                  placement.modelId !== previous.modelId;
                const target = selectorTargetFor(placement);
                return modelChanged && target
                  ? {
                      ...placement,
                      configOptionValues: carryAgentRoleOptionsToModel(
                        placement.configOptionValues,
                        selectorOptionsByMachine.get(placement.machineId)?.configOptionSelectors ??
                          [],
                        buildAcpSelectorOptions(target).configOptionSelectors
                      ),
                    }
                  : placement;
              });
              onChange({ ...openEditor, value: { ...value, placements } });
            }}
            machines={machineRows}
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
