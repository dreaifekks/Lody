import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';
import type { WorkspaceId } from '@lody/shared';

import {
  localProjectOrderAtom,
  moveLocalProjectOrder,
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

  it('lists pinned projects first and keeps the saved order inside each half', () => {
    const projects = [
      { id: 'older', name: 'Older', createdAtMs: 1 },
      { id: 'newer', name: 'Newer', createdAtMs: 2 },
      { id: 'dragged-first', name: 'Dragged first', createdAtMs: 3 },
      { id: 'unranked', name: 'Unranked', createdAtMs: 0 },
    ];
    const savedOrder = ['machine-a:dragged-first', 'machine-a:older', 'machine-a:newer'];

    const unpinned = sortLocalProjectsForSidebar(projects, 'machine-a', savedOrder, new Set());
    expect(unpinned.map((project) => project.id)).toEqual([
      'dragged-first',
      'older',
      'newer',
      'unranked',
    ]);

    const pinned = sortLocalProjectsForSidebar(
      projects,
      'machine-a',
      savedOrder,
      new Set(['machine-a:newer', 'machine-a:unranked', 'machine-b:older'])
    );
    expect(pinned.map((project) => project.id)).toEqual([
      'newer',
      'unranked',
      'dragged-first',
      'older',
    ]);
    // Pinning is not a drag: the saved order is untouched and the input is not mutated.
    expect(savedOrder).toEqual(['machine-a:dragged-first', 'machine-a:older', 'machine-a:newer']);
    expect(projects.map((project) => project.id)).toEqual([
      'older',
      'newer',
      'dragged-first',
      'unranked',
    ]);
  });

  it('ignores pins for a section without a machine id', () => {
    const projects = [
      { id: 'b', name: 'B', createdAtMs: 2 },
      { id: 'a', name: 'A', createdAtMs: 1 },
    ];
    expect(
      sortLocalProjectsForSidebar(projects, null, [], new Set(['null:b', 'b'])).map(
        (project) => project.id
      )
    ).toEqual(['a', 'b']);
  });

  it('does not persist an order before a workspace is resolved', () => {
    const store = createStore();

    store.set(localProjectOrderAtom, ['machine-a:project-1']);

    expect(store.get(localProjectOrderAtom)).toEqual([]);
  });
});
