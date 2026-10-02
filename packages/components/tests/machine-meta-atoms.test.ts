import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';
import { getMachineRoomId, type MachineId, type MachineMeta } from '@lody/shared';
import { machineMetaCacheAtom } from '../src/atoms/doc-meta';
import { getMachineMetaByIdAtomFamily, getMachineMetaMapAtom } from '../src/atoms/machines';

const SERVER = 'machine-server' as MachineId;

const meta = (overrides: Partial<MachineMeta> = {}): MachineMeta =>
  ({
    id: SERVER,
    name: 'home-server-ubuntu-2404',
    os: 'linux',
    cliVersion: '0.100.0',
    sessions: [],
    ...overrides,
  }) as MachineMeta;

describe('the name a machine is shown by', () => {
  it('is the short name its LAN gave it, with the name it registered under kept beside', () => {
    const store = createStore();
    store.set(machineMetaCacheAtom, { [getMachineRoomId(SERVER)]: meta() });
    expect(store.get(getMachineMetaByIdAtomFamily(SERVER))).toMatchObject({
      name: 'home-server-ubuntu-2404',
      ownName: undefined,
    });
    const before = store.get(getMachineMetaMapAtom);

    // A short name and a color change the list everything reads from.
    store.set(machineMetaCacheAtom, {
      [getMachineRoomId(SERVER)]: meta({ lanAlias: '  home   ', lanColor: 'teal' }),
    });
    const after = store.get(getMachineMetaMapAtom);
    expect(after).not.toBe(before);
    expect(after.get(SERVER)).toMatchObject({
      name: 'home',
      ownName: 'home-server-ubuntu-2404',
      lanColor: 'teal',
    });

    // A short name of nothing but spaces is none.
    store.set(machineMetaCacheAtom, { [getMachineRoomId(SERVER)]: meta({ lanAlias: '   ' }) });
    expect(store.get(getMachineMetaMapAtom).get(SERVER)).toMatchObject({
      name: 'home-server-ubuntu-2404',
      ownName: undefined,
    });
  });
});
