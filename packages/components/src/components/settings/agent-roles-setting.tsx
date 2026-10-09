import { useMemo, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useAtomValue } from 'jotai';
import { Plus, Trash2 } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import { useTranslation } from 'react-i18next';
import {
  buildAgentRoleFormValueFromRunConfig,
  canManageAgentRole,
  EMPTY_AGENT_ROLE_FORM_VALUE,
  getAgentRoleEmoji,
  listEnabledAgentRolePlacements,
  type AgentConfigMeta,
  type AgentRole,
  type AgentRoleAvailability,
} from '@lody/shared';
import { userAtom, settingsSelectedMachineIdAtom } from '@/atoms';
import { getAllAgentConfigAtom } from '@/atoms/agents';
import { onlineMachineIdsAtom } from '@/atoms/presence';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';
import {
  useAgentRoleAvailability,
  useWorkspaceAgentRoleActions,
  useWorkspaceAgentRoles,
} from '@/hooks/use-workspace-agent-roles';
import { AgentIcon } from '@/components/icons/agent-icon';
import { AGENT_ROLE_UNAVAILABLE_REASON_KEYS } from '@/lib/composer-agent-roles';
import { AlertDialog } from '@/ui/dialog';
import { Badge } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { SettingsPageActions, SettingsPageLead } from './settings-page-header';
import { SettingsEmptyList, settingsRecordsCard } from './compact-layout';
import { settingsCatalog as catalog, settingsSurface as surface } from './surface';
import { space } from '@lody/ui/tokens/scales.stylex';
import {
  AgentRoleEditorDialog,
  openAgentRoleEditorForCreate,
  openAgentRoleEditorForEdit,
  type AgentRoleEditorState,
} from './agent-role-editor-dialog';

const styles = stylex.create({
  machine: { display: 'inline-flex', alignItems: 'center', gap: space[1], minWidth: 0 },
});

/**
 * Settings → Agent Roles.
 *
 * Deliberately its own page beside Agents rather than a tab inside the provider
 * dialog: a provider says how an agent starts, a Role says how one is used, and
 * merging the two surfaces is what makes people expect a Role to carry
 * credentials.
 */
export function AgentRolesSetting() {
  const { t } = useTranslation();
  const currentUserId = useAtomValue(userAtom)?.id ?? null;
  const onlineMachineIds = useAtomValue(onlineMachineIdsAtom);
  const agentConfigs = useAtomValue(getAllAgentConfigAtom);
  const { machines } = useVisibleMachineMetas();
  const { roles, synced } = useWorkspaceAgentRoles();
  const selectedMachineId = useAtomValue(settingsSelectedMachineIdAtom);
  const { resolve } = useAgentRoleAvailability(roles);
  const { remove } = useWorkspaceAgentRoleActions();

  const [editor, setEditor] = useState<AgentRoleEditorState | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<AgentRole | null>(null);
  const [removing, setRemoving] = useState(false);

  // One list: a Role is one entry however many machines it runs on.
  const sortedRoles = useMemo(
    () =>
      [...roles].sort(
        (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
      ),
    [roles]
  );

  // Opened from a machine's memory page, a new Role starts on that machine.
  const openAdd = () =>
    setEditor(
      openAgentRoleEditorForCreate(
        selectedMachineId && machines.has(selectedMachineId)
          ? buildAgentRoleFormValueFromRunConfig({
              machineId: selectedMachineId,
              agentConfigId: null,
            })
          : EMPTY_AGENT_ROLE_FORM_VALUE
      )
    );
  const openEdit = (role: AgentRole) => setEditor(openAgentRoleEditorForEdit(role));

  const confirmRemoval = async () => {
    if (!pendingRemoval) return;
    setRemoving(true);
    try {
      await remove(pendingRemoval.id);
    } catch (cause) {
      console.error('Failed to delete agent role', cause);
    } finally {
      setRemoving(false);
      setPendingRemoval(null);
    }
  };

  const addLabel = t('settings.agentRoles.add');

  return (
    <div {...stylex.props(surface.container)}>
      <SettingsPageLead>{t('settings.agentRoles.description')}</SettingsPageLead>

      <SettingsPageActions>
        {!synced ? (
          <span {...stylex.props(catalog.syncing)}>
            <Spinner size="small" aria-hidden="true" />
            {t('settings.agentRoles.syncing')}
          </span>
        ) : null}
        <Button size="small" variant="secondary" onClick={openAdd}>
          <Plus {...stylex.props(catalog.icon)} />
          {addLabel}
        </Button>
      </SettingsPageActions>

      {sortedRoles.length === 0 ? (
        <SettingsEmptyList>{t('settings.agentRoles.empty')}</SettingsEmptyList>
      ) : (
        <div {...stylex.props(settingsRecordsCard)}>
          {sortedRoles.map((role, index) => (
            <div key={role.id} {...stylex.props(surface.line, index > 0 && surface.lineRuled)}>
              <AgentRoleRow
                role={role}
                availability={resolve(role)}
                machines={listEnabledAgentRolePlacements(role).map((placement) => ({
                  label:
                    machines.get(placement.machineId)?.name ??
                    t('settings.agentRoles.unknownMachine'),
                  online: onlineMachineIds.has(placement.machineId),
                  agentConfig: agentConfigs.find((entry) => entry.id === placement.agentConfigId),
                }))}
                canManage={canManageAgentRole(role, currentUserId)}
                onEdit={() => openEdit(role)}
                onRemove={() => setPendingRemoval(role)}
              />
            </div>
          ))}
        </div>
      )}

      <AgentRoleEditorDialog
        editor={editor}
        accessibleRoles={roles}
        onChange={setEditor}
        onClose={() => setEditor(null)}
        source="settings"
      />

      <AlertDialog.Root
        open={pendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open && !removing) setPendingRemoval(null);
        }}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>{t('settings.agentRoles.removeTitle')}</AlertDialog.Title>
            <AlertDialog.Description>
              {t('settings.agentRoles.confirmRemove', { name: pendingRemoval?.name ?? '' })}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel disabled={removing}>{t('common.cancel')}</AlertDialog.Cancel>
            <Button
              disabled={removing}
              variant="destructive"
              onClick={() => {
                void confirmRemoval();
              }}
            >
              {removing ? <Spinner size="small" /> : null}
              {t('common.remove')}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </div>
  );
}

/**
 * One catalog row. It is a line of the list's card, not a card of its own:
 * the list draws the card and the rule between rows.
 *
 * Names the machines the Role runs on, in dispatch order, each with its agent's
 * icon, and says exactly why it cannot run when it cannot. A row whose
 * machines are all gone stays listed and editable.
 */
export function AgentRoleRow({
  role,
  availability,
  machines,
  canManage,
  onEdit,
  onRemove,
}: {
  role: AgentRole;
  availability: AgentRoleAvailability;
  /** The enabled placements, in order; a config that still exists stands as its icon. */
  machines: readonly {
    label: string;
    online: boolean;
    agentConfig?: Pick<AgentConfigMeta, 'cliType' | 'agentType' | 'brandId' | 'env'>;
  }[];
  canManage: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div {...stylex.props(catalog.row, surface.pressableLine)}>
      <button
        type="button"
        onClick={onEdit}
        aria-label={canManage ? t('common.edit') : t('common.view')}
        {...stylex.props(catalog.rowMain)}
      >
        <span {...stylex.props(catalog.glyph)}>
          <span aria-hidden="true">{getAgentRoleEmoji(role)}</span>
        </span>
        <span {...stylex.props(catalog.body)}>
          <span {...stylex.props(catalog.titleLine)}>
            {/* No `@token` here: it is derived from this very name, so printing
                both says one thing twice. */}
            <span {...stylex.props(catalog.name)}>{role.name}</span>
            {/* Private is the default and says nothing on every row; only a Role
                the whole workspace can use is marked. */}
            {role.visibility === 'workspace' ? (
              <Badge>{t('settings.agentRoles.visibility.workspace')}</Badge>
            ) : null}
            {role.promptPrefix ? <Badge>{t('settings.agentRoles.hasPrompt')}</Badge> : null}
          </span>
          <span {...stylex.props(catalog.meta)}>
            {machines.map((machine, index) => (
              <span key={index} {...stylex.props(styles.machine)}>
                {machine.agentConfig ? (
                  <AgentIcon
                    cliType={machine.agentConfig.cliType}
                    agentType={machine.agentConfig.agentType}
                    brandId={machine.agentConfig.brandId}
                    env={machine.agentConfig.env}
                    className={stylex.props(catalog.iconSmall).className}
                  />
                ) : null}
                <span {...stylex.props(catalog.truncate, !machine.online && catalog.metaHint)}>
                  {machine.label}
                </span>
              </span>
            ))}
          </span>
          <AgentRoleAvailabilityText availability={availability} />
        </span>
      </button>
      <div {...stylex.props(catalog.actions)}>
        {canManage ? (
          <Button
            type="button"
            variant="ghost"
            aria-label={t('common.remove')}
            size="small"
            icon
            tone="destructive"
            onClick={onRemove}
          >
            <Trash2 {...stylex.props(catalog.icon)} />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Why a Role cannot run, when the list does not already say so.
 *
 * `machine_offline` says nothing new: the row's machine names are already
 * dimmed when offline. The reasons that stay are about the Role's placements
 * rather than the machines' state.
 */
function AgentRoleAvailabilityText({ availability }: { availability: AgentRoleAvailability }) {
  const { t } = useTranslation();
  if (availability.kind === 'available') return null;
  if (availability.kind === 'unknown') {
    return (
      <span {...stylex.props(catalog.meta, catalog.metaHint)}>
        <span {...stylex.props(catalog.truncate)}>{t('settings.agentRoles.status.checking')}</span>
      </span>
    );
  }
  if (availability.reason === 'machine_offline') return null;
  const reason = t(AGENT_ROLE_UNAVAILABLE_REASON_KEYS[availability.reason]);
  return (
    <span {...stylex.props(catalog.meta, catalog.metaWarning)}>
      <span {...stylex.props(catalog.truncate)}>
        {t('settings.agentRoles.unavailable.label', { reason })}
      </span>
    </span>
  );
}
