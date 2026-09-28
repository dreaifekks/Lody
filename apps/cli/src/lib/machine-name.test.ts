import { describe, expect, it } from 'vitest';
import { resolveRegisteredMachineName } from './machine-name';

describe('resolveRegisteredMachineName', () => {
  it('registers a machine under the name it starts with', () => {
    for (const storedName of [undefined, null, '', '   ']) {
      expect(
        resolveRegisteredMachineName({ machineName: 'macbook', explicit: false, storedName })
      ).toBe('macbook');
    }
  });

  it('keeps a rename made in the app', () => {
    expect(
      resolveRegisteredMachineName({
        machineName: 'macbook',
        explicit: false,
        storedName: 'Studio Mac',
      })
    ).toBe('Studio Mac');
  });

  it('replaces a stored host name that carries the domain of a network', () => {
    for (const storedName of ['macbook.tail1234.ts.net', 'MacBook.local', 'macbook.lan']) {
      expect(
        resolveRegisteredMachineName({ machineName: 'macbook', explicit: false, storedName })
      ).toBe('macbook');
    }
  });

  it('does not mistake a longer name for the same host', () => {
    expect(
      resolveRegisteredMachineName({
        machineName: 'mac',
        explicit: false,
        storedName: 'macbook.local',
      })
    ).toBe('macbook.local');
  });

  it('lets a name chosen for the machine replace the stored one', () => {
    expect(
      resolveRegisteredMachineName({
        machineName: 'devnuc',
        explicit: true,
        storedName: 'Studio Mac',
      })
    ).toBe('devnuc');
  });
});
