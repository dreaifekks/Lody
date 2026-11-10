import { atom, useAtomValue } from 'jotai';
import { useMemo } from 'react';
import { MACHINE_DOC_PREFIX } from '@lody/shared';
import { machineMetaCacheAtom } from '@/atoms/doc-meta';
import {
  resolveMachineFileLink,
  type MachineFileLink,
  type MachineNames,
} from '@/lib/machine-file-link';

/** The workspace's machines, by the names a `<machine>:<path>` link may carry. */
export const linkedMachinesAtom = atom((get): readonly MachineNames[] =>
  Object.entries(get(machineMetaCacheAtom)).map(([roomId, meta]) => ({
    id: meta.id ?? roomId.slice(MACHINE_DOC_PREFIX.length),
    ...(meta.name === undefined ? {} : { name: meta.name }),
    lanAlias: meta.lanAlias,
  }))
);

/** The file a `<machine>:<path>` href names, once the workspace knows that machine. */
export function useMachineFileLink(href: string): MachineFileLink | null {
  const machines = useAtomValue(linkedMachinesAtom);
  return useMemo(() => resolveMachineFileLink(href, machines), [href, machines]);
}
