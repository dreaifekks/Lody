import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { Button } from '@lody/ui/button';
import { Checkbox } from '@lody/ui/checkbox';
import { Input } from '@lody/ui/input';
import { Switch } from '@lody/ui/switch';
import { Textarea } from '@lody/ui/textarea';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { CompactRow, CompactSection } from '../settings/compact-layout';

/** A project the Board may put in its context: a machine's folder or a GitHub repository. */
export interface BoardProjectOption {
  key: string;
  name: string;
  /** Machine name, or the repository owner for GitHub. */
  source: string;
}

export interface BoardSettingsDraft {
  name: string;
  purpose: string;
  /** `null` = every project the user can see; otherwise the chosen keys. */
  projectKeys: readonly string[] | null;
  memoryEnabled: boolean;
  memoryText: string;
  /** Mirror the Board memory into a Nowledge Mem space shared by all members. */
  memorySpaceEnabled: boolean;
  memorySpaceLabel?: string;
  maxRoundsPerThread: number;
  reportHumanTurns: boolean;
  executorConstraints: string;
  digestEnabled: boolean;
  digestTime: string;
}

const styles = stylex.create({
  root: { display: 'flex', flexDirection: 'column', gap: space[6], padding: space[4] },
  projects: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    paddingInline: space[4],
    paddingBlock: space[2],
  },
  stacked: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    paddingInline: space[4],
    paddingBlock: space[2],
  },
  stackedLabel: { margin: 0, color: colors.label },
  stackedHelper: { margin: 0, fontSize: text.footnoteSize, color: colors.secondaryLabel },
  project: { display: 'flex', alignItems: 'center', gap: space[2], fontSize: text.bodySize },
  source: { color: colors.secondaryLabel, fontSize: text.footnoteSize },
  memory: {
    margin: 0,
    paddingInline: space[4],
    paddingBlock: space[2],
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    maxHeight: '160px',
    overflow: 'auto',
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
  },
});

/** A row whose control is a paragraph of text: the field takes the full width under its name. */
function StackedRow({
  label,
  helper,
  children,
}: {
  label: string;
  helper?: string;
  children: ReactNode;
}) {
  return (
    <label {...stylex.props(styles.stacked)}>
      <span {...stylex.props(styles.stackedLabel)}>{label}</span>
      {helper !== undefined ? <span {...stylex.props(styles.stackedHelper)}>{helper}</span> : null}
      {children}
    </label>
  );
}

/**
 * Everything about a Board that is set once and rarely revisited. Nothing here
 * is needed to talk to the coordinator or to steer a thread, which is why it
 * lives behind the gear rather than on the page.
 */
export function BoardSettingsPanelView({
  value,
  onChange,
  projects,
  coordinator,
  onEditMemory,
  onArchive,
}: {
  value: BoardSettingsDraft;
  onChange: (patch: Partial<BoardSettingsDraft>) => void;
  projects: readonly BoardProjectOption[];
  /** The coordinator's agent picker; the same control the create dialog uses. */
  coordinator: ReactNode;
  onEditMemory: () => void;
  onArchive: () => void;
}) {
  const { t } = useTranslation();
  const allProjects = value.projectKeys === null;
  const chosen = new Set(value.projectKeys ?? []);
  return (
    <div {...stylex.props(styles.root)}>
      <CompactSection title={t('boards.settings.board', 'Board')}>
        <CompactRow label={t('boards.name', 'Name')}>
          <Input
            aria-label={t('boards.name', 'Name')}
            value={value.name}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </CompactRow>
        <StackedRow
          label={t('boards.purpose', 'Goal')}
          helper={t('boards.settings.purposeHelper', 'The coordinator reads it at every start.')}
        >
          <Textarea
            rows={4}
            value={value.purpose}
            onChange={(event) => onChange({ purpose: event.target.value })}
          />
        </StackedRow>
      </CompactSection>

      <CompactSection
        title={t('boards.settings.context', 'Context')}
        description={t(
          'boards.settings.contextHelper',
          'What every conversation on this Board starts from.'
        )}
      >
        <CompactRow
          label={t('boards.settings.allProjects', 'All projects')}
          helper={
            allProjects
              ? t('boards.settings.allProjectsOn', 'Threads may work in any project you can see.')
              : t(
                  'boards.settings.allProjectsOff',
                  'Threads work only in the projects chosen below.'
                )
          }
        >
          <Switch
            checked={allProjects}
            aria-label={t('boards.settings.allProjects', 'All projects')}
            onCheckedChange={(on) => onChange({ projectKeys: on ? null : [] })}
          />
        </CompactRow>
        {allProjects ? null : (
          <div {...stylex.props(styles.projects)}>
            {projects.map((project) => (
              <label key={project.key} {...stylex.props(styles.project)}>
                <Checkbox
                  checked={chosen.has(project.key)}
                  onCheckedChange={(checked) =>
                    onChange({
                      projectKeys: checked
                        ? [...chosen, project.key]
                        : [...chosen].filter((key) => key !== project.key),
                    })
                  }
                />
                <span>{project.name}</span>
                <span {...stylex.props(styles.source)}>{project.source}</span>
              </label>
            ))}
          </div>
        )}
      </CompactSection>

      <CompactSection
        title={t('boards.settings.memory', 'Board memory')}
        description={t(
          'boards.settings.memoryHelper',
          'Shared by every conversation on this Board. The coordinator keeps it current.'
        )}
      >
        <CompactRow label={t('boards.settings.memoryEnabled', 'Use Board memory')}>
          <Switch
            checked={value.memoryEnabled}
            aria-label={t('boards.settings.memoryEnabled', 'Use Board memory')}
            onCheckedChange={(on) => onChange({ memoryEnabled: on })}
          />
        </CompactRow>
        {value.memoryEnabled ? (
          <>
            <p {...stylex.props(styles.memory)}>
              {value.memoryText || t('boards.settings.memoryEmpty', 'Nothing remembered yet.')}
            </p>
            <CompactRow
              label={t('boards.settings.memoryEdit', 'Edit memory')}
              helper={t(
                'boards.settings.memoryEditHelper',
                'New conversations read the version saved when they start.'
              )}
            >
              <Button variant="secondary" size="small" onClick={onEditMemory}>
                {t('boards.editNotes', 'Edit')}
              </Button>
            </CompactRow>
            <CompactRow
              label={t('boards.settings.memorySpace', 'Also use a Nowledge Mem space')}
              helper={
                value.memorySpaceEnabled && value.memorySpaceLabel !== undefined
                  ? value.memorySpaceLabel
                  : t(
                      'boards.settings.memorySpaceHelper',
                      'Agents with nmem recall from and save to one space for this Board.'
                    )
              }
            >
              <Switch
                checked={value.memorySpaceEnabled}
                aria-label={t('boards.settings.memorySpace', 'Also use a Nowledge Mem space')}
                onCheckedChange={(on) => onChange({ memorySpaceEnabled: on })}
              />
            </CompactRow>
          </>
        ) : null}
      </CompactSection>

      <CompactSection title={t('boards.coordinator', 'Coordinator')}>
        <CompactRow label={t('boards.settings.coordinatorAgent', 'Agent')}>
          {coordinator}
        </CompactRow>
      </CompactSection>

      <CompactSection title={t('boards.settings.threads', 'Threads')}>
        <CompactRow label={t('boards.maxRounds', 'Rounds per thread')}>
          <Input
            type="number"
            min={1}
            aria-label={t('boards.maxRounds', 'Rounds per thread')}
            value={value.maxRoundsPerThread}
            onChange={(event) => onChange({ maxRoundsPerThread: Number(event.target.value) })}
          />
        </CompactRow>
        <CompactRow
          label={t('boards.reportHumanTurns', 'Report completed human turns')}
          helper={t(
            'boards.settings.reportHumanTurnsHelper',
            'Off: a reply you steer yourself does not wake the coordinator.'
          )}
        >
          <Switch
            checked={value.reportHumanTurns}
            aria-label={t('boards.reportHumanTurns', 'Report completed human turns')}
            onCheckedChange={(on) => onChange({ reportHumanTurns: on })}
          />
        </CompactRow>
        <StackedRow
          label={t('boards.constraints', 'Executor instructions')}
          helper={t(
            'boards.settings.constraintsHelper',
            'Added to the first message of every thread.'
          )}
        >
          <Textarea
            rows={3}
            value={value.executorConstraints}
            onChange={(event) => onChange({ executorConstraints: event.target.value })}
          />
        </StackedRow>
      </CompactSection>

      <CompactSection title={t('boards.settings.digest', 'Daily digest')}>
        <CompactRow
          label={t('boards.settings.digestEnabled', 'Write a daily digest')}
          helper={t(
            'boards.settings.digestHelper',
            'The coordinator adds the day’s progress to the notes and the Board memory.'
          )}
        >
          <Switch
            checked={value.digestEnabled}
            aria-label={t('boards.settings.digestEnabled', 'Write a daily digest')}
            onCheckedChange={(on) => onChange({ digestEnabled: on })}
          />
        </CompactRow>
        {value.digestEnabled ? (
          <CompactRow label={t('boards.settings.digestTime', 'Time')}>
            <Input
              type="time"
              aria-label={t('boards.settings.digestTime', 'Time')}
              value={value.digestTime}
              onChange={(event) => onChange({ digestTime: event.target.value })}
            />
          </CompactRow>
        ) : null}
      </CompactSection>

      <CompactSection tone="danger" title={t('boards.settings.danger', 'Archive')}>
        <CompactRow
          label={t('boards.settings.archive', 'Archive Board')}
          helper={t(
            'boards.settings.archiveHelper',
            'Archives the coordinator and every thread. Restore them from Archive.'
          )}
        >
          <Button variant="secondary" tone="destructive" size="small" onClick={onArchive}>
            {t('boards.settings.archive', 'Archive Board')}
          </Button>
        </CompactRow>
      </CompactSection>
    </div>
  );
}
