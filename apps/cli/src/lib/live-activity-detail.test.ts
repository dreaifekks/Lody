import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpSessionNotification, SessionId } from '@lody/shared';
import { LiveActivityDetailTracker, tailOfProse } from './live-activity-detail';

const sessionId = 's-1' as SessionId;
const update = (value: Record<string, unknown>) =>
  ({ sessionId: 'acp', update: value }) as unknown as AcpSessionNotification;
const thought = (text: string) =>
  update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } });
const toolCall = (title: string) =>
  update({ sessionUpdate: 'tool_call', toolCallId: title, title, status: 'in_progress' });

describe('tailOfProse', () => {
  it('keeps short prose and the end of long prose', () => {
    expect(tailOfProse('  Reading   the file. ')).toBe('Reading the file.');
    expect(tailOfProse('')).toBeNull();
    const long = `${'start '.repeat(40)}the actual last thought`;
    const tail = tailOfProse(long, 40);
    expect(tail?.startsWith('…')).toBe(true);
    expect(tail?.endsWith('the actual last thought')).toBe(true);
    expect(tail!.length).toBeLessThanOrEqual(40);
  });
});

describe('LiveActivityDetailTracker', () => {
  let sent: unknown[];
  let tracker: LiveActivityDetailTracker;
  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    tracker = new LiveActivityDetailTracker((_, detail) => sent.push(detail), {
      intervalMs: 10_000,
    });
  });
  afterEach(() => {
    tracker.dispose();
    vi.useRealTimers();
  });

  it('reports the latest step and reasoning at most once per interval', async () => {
    tracker.observe(sessionId, thought('Looking at '));
    tracker.observe(sessionId, thought('the build log.'));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([{ activity: null, thought: 'Looking at the build log.' }]);

    tracker.observe(sessionId, toolCall('Run pnpm test'));
    tracker.observe(sessionId, thought('Tests pass.'));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    // A new step starts its reasoning afresh.
    expect(sent[1]).toEqual({ activity: 'Run pnpm test', thought: 'Tests pass.' });
  });

  it('sends a permission request and its answer at once', () => {
    tracker.permission(sessionId, {
      requestId: 'r1',
      command: 'git push',
      options: [{ id: 'a', label: 'Allow', kind: 'allow_once' }],
    });
    tracker.permission(sessionId, null);
    expect(sent).toEqual([
      expect.objectContaining({ permission: expect.objectContaining({ requestId: 'r1' }) }),
      expect.objectContaining({ permission: null }),
    ]);
  });

  it('stops reporting a session once its turn ends', async () => {
    tracker.observe(sessionId, thought('Almost done.'));
    tracker.clear(sessionId);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sent).toEqual([]);
  });
});
