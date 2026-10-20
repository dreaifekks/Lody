import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { Menu } from '@lody/ui/menu';
import { FolderGit2, Minus } from 'lucide-react';
import { useAtomValue } from 'jotai';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { BoardProjectRef } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { composerSurface as surface } from '@/components/shared/composer-surface';
import { useVisibleLocalProjects } from '@/hooks/use-visible-local-projects';
import { useWorkspaceGitHubRepositories } from '@/hooks/use-workspace-github-repositories';
import {
  boardScopeNames,
  boardScopeOptionState,
  buildBoardScopeOptions,
  toggleBoardScopeOption,
  type BoardScopeOption,
} from './board-project-scope';

const styles = stylex.create({ label: { maxWidth: '240px' } });

/**
 * Which projects a Board's members may open sessions in. Nothing ticked means
 * every project. A row ticks a project on every machine that has it.
 */
export function BoardProjectScopePickerView({
  options,
  value,
  onChange,
  disabled = false,
}: {
  options: readonly BoardScopeOption[];
  value: readonly BoardProjectRef[];
  onChange: (next: BoardProjectRef[]) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const names = boardScopeNames(value);
  const label =
    names.length === 0
      ? t('boards.scope.all', 'Projects: All')
      : t('boards.scope.some', 'Projects: {{names}}', {
          names: names.join(t('boards.scope.separator', ', ')),
        });
  const local = options.filter((option) => option.kind === 'local');
  const github = options.filter((option) => option.kind === 'github');
  const row = (option: BoardScopeOption) => {
    const state = boardScopeOptionState(option, value);
    return (
      <Menu.CheckboxItem
        key={option.key}
        checked={state === 'checked'}
        onCheckedChange={() => onChange(toggleBoardScopeOption(value, option))}
        shortcut={
          option.kind === 'local'
            ? option.projects
                .map((project) => project.machineName)
                .join(t('boards.scope.separator', ', '))
            : undefined
        }
        endContent={
          state === 'partial' ? (
            <Minus
              {...stylex.props(surface.glyph14)}
              aria-label={t('boards.scope.partial', 'Not on every machine yet')}
            />
          ) : null
        }
      >
        {option.kind === 'local' ? option.name : option.repoFullName}
      </Menu.CheckboxItem>
    );
  };
  return (
    <Menu.Root>
      <Menu.Trigger
        disabled={disabled}
        aria-label={t('boards.scope.title', 'Project scope')}
        render={<Button type="button" variant="secondary" size="mini" />}
      >
        <FolderGit2 {...stylex.props(surface.glyph14)} aria-hidden="true" />
        <span {...stylex.props(surface.truncate, styles.label)}>{label}</span>
      </Menu.Trigger>
      <Menu.Content align="start" className="min-w-56 max-w-80">
        <Menu.CheckboxItem checked={value.length === 0} onCheckedChange={() => onChange([])}>
          {t('boards.scope.allProjects', 'All projects')}
        </Menu.CheckboxItem>
        {local.length > 0 ? (
          <Menu.Group>
            <Menu.Separator />
            <Menu.GroupLabel>{t('boards.scope.local', 'Local projects')}</Menu.GroupLabel>
            {local.map(row)}
          </Menu.Group>
        ) : null}
        {github.length > 0 ? (
          <Menu.Group>
            <Menu.Separator />
            <Menu.GroupLabel>{t('boards.scope.github', 'GitHub')}</Menu.GroupLabel>
            {github.map(row)}
          </Menu.Group>
        ) : null}
      </Menu.Content>
    </Menu.Root>
  );
}

/** The picker over the workspace's visible local projects and GitHub repositories. */
export function BoardProjectScopePicker({
  value,
  onChange,
  disabled,
}: {
  value: readonly BoardProjectRef[];
  onChange: (next: BoardProjectRef[]) => void;
  disabled?: boolean;
}) {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const local = useVisibleLocalProjects({ includeMachineFlock: true });
  const repositories = useWorkspaceGitHubRepositories(runtime?.workspaceId);
  const options = useMemo(
    () =>
      buildBoardScopeOptions({
        localProjects: [...local.projects.values()].map((entry) => ({
          machineId: entry.machineId,
          machineName: entry.machine.name,
          localProjectId: entry.project.id,
          name: entry.project.name,
        })),
        repositories: (repositories ?? []).map((repository) => repository.fullName),
        scope: value,
      }),
    [local.projects, repositories, value]
  );
  return (
    <BoardProjectScopePickerView
      options={options}
      value={value}
      onChange={onChange}
      disabled={disabled}
    />
  );
}
