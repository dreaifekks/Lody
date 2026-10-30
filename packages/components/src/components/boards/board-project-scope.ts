import type { BoardProjectRef, LocalProjectId, MachineId } from '@lody/shared';

/** One local project on one machine, as the scope picker sees it. */
export type BoardScopeLocalProject = {
  machineId: MachineId;
  machineName: string;
  localProjectId: LocalProjectId;
  name: string;
};

/**
 * One row of the picker. The same repository has a different local project id
 * on each machine, so local projects of one name share a row.
 */
export type BoardScopeOption =
  | { kind: 'local'; key: string; name: string; projects: BoardScopeLocalProject[] }
  | { kind: 'github'; key: string; repoFullName: string };

export type BoardScopeOptionState = 'checked' | 'partial' | 'unchecked';

const localPairKey = (project: { machineId: string; localProjectId: string }) =>
  `${project.machineId}\u0000${project.localProjectId}`;

/**
 * The picker's rows: the visible local projects merged by name, then GitHub
 * repositories. Projects the scope still names but nobody sees any more stay,
 * so they can be removed.
 */
export function buildBoardScopeOptions(input: {
  localProjects: readonly BoardScopeLocalProject[];
  repositories: readonly string[];
  scope: readonly BoardProjectRef[];
}): BoardScopeOption[] {
  const byName = new Map<string, Map<string, BoardScopeLocalProject>>();
  const add = (project: BoardScopeLocalProject) => {
    const group = byName.get(project.name) ?? new Map<string, BoardScopeLocalProject>();
    if (!group.has(localPairKey(project))) group.set(localPairKey(project), project);
    byName.set(project.name, group);
  };
  for (const project of input.localProjects) add(project);
  const repositories = new Set(input.repositories);
  for (const entry of input.scope) {
    if (entry.kind === 'local') add({ ...entry, machineName: entry.machineId });
    else repositories.add(entry.repoFullName);
  }
  const collator = new Intl.Collator(undefined, { sensitivity: 'base' });
  return [
    ...[...byName.entries()]
      .toSorted(([a], [b]) => collator.compare(a, b))
      .map(([name, group]): BoardScopeOption => ({
        kind: 'local',
        key: `local:${name}`,
        name,
        projects: [...group.values()].toSorted((a, b) =>
          collator.compare(a.machineName, b.machineName)
        ),
      })),
    ...[...repositories].toSorted(collator.compare).map((repoFullName): BoardScopeOption => ({
      kind: 'github',
      key: `github:${repoFullName}`,
      repoFullName,
    })),
  ];
}

const optionRefs = (option: BoardScopeOption): BoardProjectRef[] =>
  option.kind === 'local'
    ? option.projects.map(({ machineId, localProjectId, name }) => ({
        kind: 'local',
        machineId,
        localProjectId,
        name,
      }))
    : [{ kind: 'github', repoFullName: option.repoFullName }];

const refKey = (ref: BoardProjectRef) =>
  ref.kind === 'local' ? `local:${localPairKey(ref)}` : `github:${ref.repoFullName}`;

/** Partial: the scope holds this name on some machines, not on all of them. */
export function boardScopeOptionState(
  option: BoardScopeOption,
  scope: readonly BoardProjectRef[]
): BoardScopeOptionState {
  const held = new Set(scope.map(refKey));
  const refs = optionRefs(option);
  const count = refs.filter((ref) => held.has(refKey(ref))).length;
  return count === 0 ? 'unchecked' : count === refs.length ? 'checked' : 'partial';
}

/** Ticking a row adds every machine's pair it lacks; unticking a full row removes them all. */
export function toggleBoardScopeOption(
  scope: readonly BoardProjectRef[],
  option: BoardScopeOption
): BoardProjectRef[] {
  const refs = optionRefs(option);
  if (boardScopeOptionState(option, scope) === 'checked') {
    const removed = new Set(refs.map(refKey));
    return scope.filter((ref) => !removed.has(refKey(ref)));
  }
  const held = new Set(scope.map(refKey));
  return [...scope, ...refs.filter((ref) => !held.has(refKey(ref)))];
}

/** The names the trigger lists, each once, in scope order. */
export function boardScopeNames(scope: readonly BoardProjectRef[]): string[] {
  return [...new Set(scope.map((ref) => (ref.kind === 'local' ? ref.name : ref.repoFullName)))];
}
