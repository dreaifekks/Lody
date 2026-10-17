import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';
import type { WorkspaceId } from '@lody/shared';

import {
  localProjectOrderAtom,
  moveLocalProjectOrder,
  partitionPinnedLocalProjects,
  sortLocalProjectsForSidebar,
} from '../src/atoms/sidebar-state';
import { currentWorkspaceIdAtom } from '../src/atoms/workspace-context';

const workspaceId = (value: string) => value as WorkspaceId;

describe('sidebar local project order', () => {
  it('moves visible peers while retaining temporarily hidden and other-machine entries', () => {
    expect(
      moveLocalProjectOrder(
        ['machine-a:project-1', 'machine-a:hidden', 'machine-a:project-2', 'machine-b:project-1'],
        ['machine-a:project-1', 'machine-a:project-2'],
        'machine-a:project-2',
        'machine-a:project-1'
      )
    ).toEqual([
      'machine-a:project-2',
      'machine-a:project-1',
      'machine-a:hidden',
      'machine-b:project-1',
    ]);
  });

  it('keeps an independent machine-qualified order for each workspace', () => {
    const store = createStore();

    store.set(currentWorkspaceIdAtom, workspaceId('workspace-a'));
    store.set(localProjectOrderAtom, ['machine-a:project-2', 'machine-a:project-1']);

    store.set(currentWorkspaceIdAtom, workspaceId('workspace-b'));
    expect(store.get(localProjectOrderAtom)).toEqual([]);
    store.set(localProjectOrderAtom, ['machine-b:project-1']);

    store.set(currentWorkspaceIdAtom, workspaceId('workspace-a'));
    expect(store.get(localProjectOrderAtom)).toEqual([
      'machine-a:project-2',
      'machine-a:project-1',
    ]);

    store.set(currentWorkspaceIdAtom, workspaceId('workspace-b'));
    expect(store.get(localProjectOrderAtom)).toEqual(['machine-b:project-1']);
  });

  it('orders a machine group by the saved drag order, then creation time and name', () => {
    const projects = [
      { id: 'older', name: 'Older', createdAtMs: 1 },
      { id: 'newer', name: 'Newer', createdAtMs: 2 },
      { id: 'dragged-first', name: 'Dragged first', createdAtMs: 3 },
      { id: 'unranked', name: 'Unranked', createdAtMs: 0 },
    ];
    const savedOrder = ['machine-a:dragged-first', 'machine-a:older', 'machine-a:newer'];
    expect(
      sortLocalProjectsForSidebar(projects, 'machine-a', savedOrder).map((project) => project.id)
    ).toEqual(['dragged-first', 'older', 'newer', 'unranked']);
    // Another machine's saved order says nothing about this group.
    expect(
      sortLocalProjectsForSidebar(projects, 'machine-b', savedOrder).map((project) => project.id)
    ).toEqual(['unranked', 'older', 'newer', 'dragged-first']);
    expect(projects.map((project) => project.id)).toEqual([
      'older',
      'newer',
      'dragged-first',
      'unranked',
    ]);
  });

  it('lifts pinned projects out of their machine groups in pin order', () => {
    const sections = [
      {
        machineId: 'machine-a',
        label: 'This Mac',
        projects: [{ id: 'lody' }, { id: 'loro' }, { id: 'docs' }],
      },
      { machineId: 'machine-b', label: 'MacBook', projects: [{ id: 'lody' }] },
      { machineId: null, label: 'No machine', projects: [{ id: 'lody' }] },
    ];
    const { sections: remaining, pinned } = partitionPinnedLocalProjects(sections, [
      'machine-b:lody',
      'machine-a:gone',
      'machine-a:docs',
      'nope',
    ]);

    // Pin order wins over group order; unknown keys leave no gap.
    expect(pinned.map(({ section, project }) => `${section.label}/${project.id}`)).toEqual([
      'MacBook/lody',
      'This Mac/docs',
    ]);
    expect(pinned[0]?.section.machineId).toBe('machine-b');
    // A pinned project appears once; a group emptied by pinning is gone, a
    // section without a machine id cannot hold pins and stays as it is.
    expect(remaining.map((section) => [section.label, section.projects.map((p) => p.id)])).toEqual([
      ['This Mac', ['lody', 'loro']],
      ['No machine', ['lody']],
    ]);
    expect(remaining[1]).toBe(sections[2]);
    expect(sections[0]?.projects).toHaveLength(3);
  });

  it('returns the groups untouched when nothing is pinned', () => {
    const sections = [{ machineId: 'machine-a', projects: [{ id: 'lody' }] }];
    const result = partitionPinnedLocalProjects(sections, []);
    expect(result.pinned).toEqual([]);
    expect(result.sections[0]).toBe(sections[0]);
  });

  it('does not persist an order before a workspace is resolved', () => {
    const store = createStore();

    store.set(localProjectOrderAtom, ['machine-a:project-1']);

    expect(store.get(localProjectOrderAtom)).toEqual([]);
  });
});
