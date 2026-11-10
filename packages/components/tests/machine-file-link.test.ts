import { describe, expect, it } from 'vitest';
import { splitTextIntoFilePathSegments } from '../src/lib/linkify-file-paths';
import {
  attachMachinePrefixes,
  findLinkedMachine,
  parseMachineFileHref,
  resolveMachineFileLink,
} from '../src/lib/machine-file-link';

const machines = [
  { id: '5f3e0c2a-1111-4222-8333-944455556666', name: 'Mac-mini.local', lanAlias: 'mini' },
  { id: 'm-nuc', name: 'devnuc' },
  { id: 'm-one', name: 'twin' },
  { id: 'm-two', name: 'Twin' },
];

describe('machine file links', () => {
  it('reads `<machine>:<path>` as `lody-lan lan cp` does, by shape alone', () => {
    expect(parseMachineFileHref('mini:~/out/report.md')).toEqual({
      machine: 'mini',
      path: '~/out/report.md',
    });
    expect(parseMachineFileHref('win:C:\\Users\\me\\a.md')).toEqual({
      machine: 'win',
      path: 'C:\\Users\\me\\a.md',
    });
    for (const href of [
      'C:\\Users\\me\\a.md',
      'http://example.com/a.md',
      'host:8080/a.md',
      '12:30',
      'mailto:me@example.com',
      'src/a.ts:32',
    ])
      expect(parseMachineFileHref(href)).toBeNull();
  });

  it('finds the machine by id, its own name, then its LAN name, only when one machine has it', () => {
    expect(findLinkedMachine(machines, 'MINI')).toBe(machines[0]?.id);
    expect(findLinkedMachine(machines, 'mac-mini.local')).toBe(machines[0]?.id);
    expect(findLinkedMachine(machines, 'm-nuc')).toBe('m-nuc');
    expect(findLinkedMachine(machines, 'twin')).toBeNull();
    expect(resolveMachineFileLink('devnuc:/var/log/a.log', machines)).toEqual({
      machineId: 'm-nuc',
      path: '/var/log/a.log',
    });
    expect(resolveMachineFileLink('nobody:/var/log/a.log', machines)).toBeNull();
  });

  it('takes the prefix in front of a bare path along, and nothing else', () => {
    const split = (text: string) => attachMachinePrefixes(splitTextIntoFilePathSegments(text));
    expect(split('见 mini:~/out/report.md 和 devnuc:/tmp/a.log。')).toEqual([
      { type: 'text', value: '见 ' },
      { type: 'machine-path', value: 'mini:~/out/report.md', prefix: 'mini:' },
      { type: 'text', value: ' 和 ' },
      { type: 'machine-path', value: 'devnuc:/tmp/a.log', prefix: 'devnuc:' },
      { type: 'text', value: '。' },
    ]);
    // A port, a mail host, a path segment: the path alone is the candidate, as before.
    for (const text of ['host:8080/x/a.md', 'me@mini:/x/a.md', 'src/mini:/x/a.md'])
      expect(split(text).some((segment) => segment.type === 'machine-path')).toBe(false);
  });
});
