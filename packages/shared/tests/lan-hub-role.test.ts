import { describe, expect, it } from 'vitest';
import {
  chooseLanHubStandby,
  parseLanHubRole,
  type LanHubCandidate,
  type LanHubRole,
} from '../src/lan-hub-role';

const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const server = (
  machineId: string,
  role: Partial<LanHubRole> = {},
  online = true
): LanHubCandidate => ({
  machineId,
  online,
  role: { capable: true, hosting: false, hubRttMs: 5, ...role },
});

describe('chooseLanHubStandby', () => {
  it('chooses the capable member closest to the hub, never the host or a desktop', () => {
    expect(
      chooseLanHubStandby(
        [
          server('devnuc', { hosting: true, hubRttMs: 0 }),
          server('n100', { hubRttMs: 4 }),
          server('far', { hubRttMs: 40 }),
          { machineId: 'mac', online: true, role: null },
        ],
        NOW
      )
    ).toBe('n100');
  });

  it('chooses nobody when no member could host the hub', () => {
    expect(
      chooseLanHubStandby(
        [
          server('devnuc', { hosting: true }),
          server('n100', {}, false),
          {
            machineId: 'mac',
            online: true,
            role: { capable: false, hosting: false, hubRttMs: 300 },
          },
        ],
        NOW
      )
    ).toBeNull();
  });

  it('keeps a standby with a fresh copy until another is clearly closer', () => {
    const keeper = server('keeper', { hubRttMs: 10, snapshotAt: minutesAgo(5) });
    expect(chooseLanHubStandby([keeper, server('a', { hubRttMs: 8 })], NOW)).toBe('keeper');
    expect(chooseLanHubStandby([keeper, server('a', { hubRttMs: 6 })], NOW)).toBe('a');
  });

  it('lets a copy that went stale stop deciding', () => {
    const stale = server('keeper', { hubRttMs: 10, snapshotAt: minutesAgo(45) });
    expect(chooseLanHubStandby([stale, server('a', { hubRttMs: 8 })], NOW)).toBe('a');
  });

  it('settles a tie by machine id, so every member chooses the same one', () => {
    const tied = [server('b', { hubRttMs: null }), server('a', { hubRttMs: null })];
    expect(chooseLanHubStandby(tied, NOW)).toBe('a');
    expect(chooseLanHubStandby([...tied].reverse(), NOW)).toBe('a');
  });
});

describe('parseLanHubRole', () => {
  it('reads what a member said and nothing it could not have said', () => {
    expect(
      parseLanHubRole({ capable: true, hosting: false, hubRttMs: 3, snapshotAt: 'later' })
    ).toEqual({
      capable: true,
      hosting: false,
      hubRttMs: 3,
    });
    expect(parseLanHubRole({ capable: true, hosting: false, hubRttMs: 'fast' })).toBeNull();
    expect(parseLanHubRole(null)).toBeNull();
  });
});
