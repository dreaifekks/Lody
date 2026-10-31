import type { LanMachine } from '@lody/shared';
import { describe, expect, it } from 'vitest';
import { parseCopyOperand, planCopy } from './lan-cp';

function machine(machineId: string, name: string, alias: string | null = null): LanMachine {
  return {
    machineId,
    name,
    alias,
    os: null,
    self: false,
    online: true,
    lans: [],
    version: null,
    build: null,
    update: null,
    controllable: true,
    agents: [],
  };
}

const machines = [
  machine('m-mba', 'MacBook-Air', 'mba'),
  machine('m-win', 'DESKTOP-PFNTFPI'),
  machine('m-n100', 'homeN100'),
];

describe('parseCopyOperand', () => {
  it('reads a machine before the colon and its path after', () => {
    expect(parseCopyOperand('mba:~/x/a.bin')).toEqual({ machine: 'mba', path: '~/x/a.bin' });
    expect(parseCopyOperand('DESKTOP-PFNTFPI:D:\\code\\x')).toEqual({
      machine: 'DESKTOP-PFNTFPI',
      path: 'D:\\code\\x',
    });
    // The home directory there, as with scp.
    expect(parseCopyOperand('mba:')).toEqual({ machine: 'mba', path: '' });
  });

  it('keeps drive letters and colons after a separator on this machine', () => {
    for (const arg of ['C:\\x', 'd:/x', './a:b', 'dir/a:b', 'dir\\a:b', 'a.bin', ':x']) {
      expect(parseCopyOperand(arg)).toEqual({ path: arg });
    }
  });
});

describe('planCopy', () => {
  it('copies to a member, from several sources', () => {
    expect(planCopy(['a.bin', 'b.bin', 'mba:~/x/'], machines)).toMatchObject({
      direction: 'put',
      machine: { machineId: 'm-mba' },
      sources: ['a.bin', 'b.bin'],
      target: '~/x/',
    });
  });

  it('copies from a member, by name or short name', () => {
    expect(
      planCopy(['DESKTOP-PFNTFPI:~/Desktop/a', 'desktop-pfntfpi:b', './'], machines)
    ).toMatchObject({
      direction: 'get',
      machine: { machineId: 'm-win' },
      sources: ['~/Desktop/a', 'b'],
      target: './',
    });
  });

  it('refuses a machine it does not know rather than writing here', () => {
    expect(() => planCopy(['a.bin', 'mbx:~/'], machines)).toThrow(/No machine mbx/);
  });

  it('refuses copies that do not have this machine on one side', () => {
    expect(() => planCopy(['a.bin', 'b.bin'], machines)).toThrow(/Name the machine/);
    expect(() => planCopy(['mba:a', 'homeN100:b'], machines)).toThrow(/two other machines/);
    expect(() => planCopy(['mba:a', 'homeN100:b', '.'], machines)).toThrow(/same machine/);
    expect(() => planCopy(['mba:a', 'b.bin', '.'], machines)).toThrow(/same machine/);
    expect(() => planCopy(['a.bin'], machines)).toThrow(/what to copy and where/);
  });
});
