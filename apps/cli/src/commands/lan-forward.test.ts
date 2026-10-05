import { describe, expect, it } from 'vitest';
import { parsePortMapping } from './lan-forward';

describe('parsePortMapping', () => {
  it('reads a port, a local port, and a host the machine reaches', () => {
    expect(parsePortMapping('3000')).toEqual({ local: 3000, remote: 3000 });
    expect(parsePortMapping('8080:3000')).toEqual({ local: 8080, remote: 3000 });
    expect(parsePortMapping('8080:nas.lan:80')).toEqual({
      local: 8080,
      host: 'nas.lan',
      remote: 80,
    });
    expect(parsePortMapping('8080:[::1]:80')).toEqual({ local: 8080, host: '::1', remote: 80 });
  });

  it('refuses what is no port', () => {
    for (const spec of ['', 'web', '0', '70000', '8080:', 'a:b:c:d']) {
      expect(() => parsePortMapping(spec)).toThrow(/is no port/);
    }
  });
});
