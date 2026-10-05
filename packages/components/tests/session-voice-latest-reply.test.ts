import { describe, expect, it } from 'vitest';
import type { SessionHistory } from '@lody/shared';
import { resolveVoiceLatestReply } from '../src/components/sessions/session-voice-controls';

const turn = (fields: Partial<SessionHistory> & Pick<SessionHistory, 'id' | 'role'>) =>
  ({ items: [], ...fields }) as unknown as SessionHistory;

describe('resolveVoiceLatestReply', () => {
  it('reads the final message after the last tool call of the last finished reply', () => {
    const reply = resolveVoiceLatestReply([
      turn({ id: 'u1', role: 'user', items: [{ type: 'text', text: 'list files' }] as never }),
      turn({
        id: 'a1',
        role: 'assistant',
        finished: true,
        items: [
          { type: 'text', text: 'Let me look.' },
          { type: 'tool_call', toolCallId: 't1' },
          { type: 'thought', text: 'three files' },
          { type: 'text', text: 'There are ' },
          { type: 'text', text: 'three files.' },
        ] as never,
      }),
    ]);

    expect(reply).toEqual({ key: 'a1', text: 'There are three files.' });
  });

  it('skips a reply that is still running', () => {
    const reply = resolveVoiceLatestReply([
      turn({ id: 'a1', role: 'assistant', finished: true, items: [{ type: 'text', text: 'Old.' }] as never }),
      turn({ id: 'u2', role: 'user' }),
      turn({ id: 'a2', role: 'assistant', items: [{ type: 'text', text: 'Partial' }] as never }),
    ]);

    expect(reply).toEqual({ key: 'a1', text: 'Old.' });
  });

  it('reports a finished reply that ends in a tool call as having no text', () => {
    const reply = resolveVoiceLatestReply([
      turn({
        id: 'a1',
        role: 'assistant',
        finished: true,
        items: [{ type: 'text', text: 'Running it.' }, { type: 'tool_call', toolCallId: 't1' }] as never,
      }),
    ]);

    expect(reply).toEqual({ key: 'a1', text: '' });
  });
});
