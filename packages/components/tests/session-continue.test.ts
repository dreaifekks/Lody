import { describe, expect, it } from 'vitest';
import { findContinuableInterruption } from '../src/components/sessions/session-continue';

const failure = (id: string, reason: string) => ({
  id,
  role: 'system',
  items: [{ type: 'system_notice', name: 'chat_failed', meta: { reason } }],
});

describe('findContinuableInterruption', () => {
  it('names how the latest round was interrupted', () => {
    expect(
      findContinuableInterruption([
        { id: 'u1', role: 'user', status: 'canceled' },
        { id: 'a1', role: 'assistant', items: [{ type: 'text' }] },
      ])
    ).toBe('stopped');
    expect(
      findContinuableInterruption([
        { id: 'u1', role: 'user', status: 'failed' },
        { id: 'a1', role: 'assistant', items: [] },
        failure('n1', 'daemon_restart'),
      ])
    ).toBe('restart');
    expect(
      findContinuableInterruption([
        { id: 'u1', role: 'user', status: 'failed' },
        failure('n1', 'agent_disconnected'),
      ])
    ).toBe('disconnected');
  });

  it('offers nothing for a finished round, another failure, or a newer message', () => {
    expect(
      findContinuableInterruption([
        { id: 'u1', role: 'user', status: 'handled' },
        { id: 'a1', role: 'assistant', items: [] },
      ])
    ).toBeNull();
    expect(
      findContinuableInterruption([
        { id: 'u1', role: 'user', status: 'failed' },
        failure('n1', 'acp_auth_required'),
      ])
    ).toBeNull();
    expect(
      findContinuableInterruption([
        { id: 'u1', role: 'user', status: 'failed' },
        failure('n1', 'daemon_restart'),
        { id: 'u2', role: 'user', status: 'handled' },
      ])
    ).toBeNull();
    expect(findContinuableInterruption([])).toBeNull();
  });
});
