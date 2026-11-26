// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  sessionRolloverStepId,
  sessionRolloverTurn,
  type SessionHistory,
  type SessionId,
} from '@lody/shared';
import { SessionRolloverDivider } from '../src/components/ai-gui/session-rollover-divider';
import { buildChatStreamItems } from '../src/components/ai-gui/build-chat-stream-items';
import { createConversationViewFromHistory } from '../src/lib/conversation-view/create-conversation-view-from-history';
import {
  ROLLOVER_SLASH_COMMAND,
  mergeRolloverAvailableCommands,
} from '../src/components/sessions/session-rollover-slash-command';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (_key: string, defaultValue?: string, options?: Record<string, unknown>) => {
      let text = typeof defaultValue === 'string' ? defaultValue : _key;
      if (options) {
        for (const [k, v] of Object.entries(options)) {
          text = text.replaceAll(`{{${k}}}`, String(v));
        }
      }
      return text;
    },
  }),
}));

const roots: Array<{ unmount: () => void; container: HTMLElement }> = [];

async function mount(element: React.ReactNode) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  const handle = {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
  roots.push(handle);
  return handle;
}

afterEach(() => {
  while (roots.length > 0) roots.pop()!.unmount();
});

describe('SessionRolloverDivider', () => {
  it('renders sealing, sealed, switching, done (with and without tokens), failed, and manual interrupted states', async () => {
    const view = await mount(
      <div>
        <SessionRolloverDivider
          meta={{
            kind: 'linear_rollover',
            trigger: 'manual',
            status: 'sealing',
            generation: 2,
          }}
        />
        <SessionRolloverDivider
          meta={{
            kind: 'linear_rollover',
            trigger: 'manual',
            status: 'sealed',
            generation: 2,
          }}
        />
        <SessionRolloverDivider
          meta={{
            kind: 'linear_rollover',
            trigger: 'auto',
            status: 'switching',
            generation: 2,
          }}
        />
        <SessionRolloverDivider
          meta={{
            kind: 'linear_rollover',
            trigger: 'auto',
            status: 'done',
            generation: 2,
            usedBefore: 352_000,
            usedAfter: 26_000,
          }}
        />
        <SessionRolloverDivider
          meta={{
            kind: 'linear_rollover',
            trigger: 'manual',
            status: 'done',
            generation: 3,
          }}
        />
        <SessionRolloverDivider
          meta={{
            kind: 'linear_rollover',
            trigger: 'manual',
            status: 'failed',
            generation: 4,
          }}
        />
        <SessionRolloverDivider
          meta={{
            kind: 'linear_rollover',
            trigger: 'manual',
            status: 'interrupted',
            generation: 4,
          }}
        />
      </div>
    );

    const labels = [...view.container.querySelectorAll('[role="status"]')].map((el) =>
      el.textContent?.trim()
    );
    expect(labels).toEqual([
      'Preparing node handoff…',
      'Handoff ready · next message starts node #2',
      'Switching to node #2…',
      'Switched to node #2 · 352K → 26K',
      'Switched to node #3',
      'Node handoff failed',
      'Node handoff stopped',
    ]);
  });

  it('returns null for silent auto-interrupted rollover dividers', async () => {
    const view = await mount(
      <SessionRolloverDivider
        meta={{
          kind: 'linear_rollover',
          trigger: 'auto',
          status: 'interrupted',
          generation: 2,
        }}
      />
    );
    expect(view.container.querySelector('[role="status"]')).toBeNull();
  });
});

describe('session rollover stream filtering', () => {
  it('hides :seal/:renew assistant turns and silent auto-interrupted dividers while keeping visible dividers', () => {
    const sessionId = 'session-stream-test' as SessionId;
    const history: SessionHistory[] = [
      {
        id: 'u1',
        role: 'user',
        timestamp: '2026-11-27T01:00:00Z',
        items: [{ type: 'text', text: 'hello' }],
      },
      {
        id: 'assistant:u1',
        role: 'assistant',
        userTurnId: 'u1',
        timestamp: '2026-11-27T01:00:05Z',
        finished: true,
        items: [{ type: 'text', text: 'world' }],
      },
      sessionRolloverTurn(
        'silent-auto',
        { kind: 'linear_rollover', trigger: 'auto', status: 'interrupted', generation: 1 },
        '2026-11-27T01:00:10Z'
      ) as unknown as SessionHistory,
      sessionRolloverTurn(
        'r1',
        {
          kind: 'linear_rollover',
          trigger: 'manual',
          status: 'done',
          generation: 1,
          usedBefore: 352_000,
          usedAfter: 26_000,
        },
        '2026-11-27T01:01:00Z'
      ) as unknown as SessionHistory,
      {
        id: `assistant:${sessionRolloverStepId('r1', 'seal')}`,
        role: 'assistant',
        userTurnId: sessionRolloverStepId('r1', 'seal'),
        timestamp: '2026-11-27T01:01:01Z',
        finished: true,
        items: [{ type: 'text', text: '{"stateCard":{}}' }],
      },
      {
        id: `assistant:${sessionRolloverStepId('r1', 'renew')}`,
        role: 'assistant',
        userTurnId: sessionRolloverStepId('r1', 'renew'),
        timestamp: '2026-11-27T01:01:02Z',
        finished: true,
        items: [{ type: 'text', text: 'Ready.' }],
      },
    ];

    const view = createConversationViewFromHistory({
      sessionId,
      getHistory: () => history,
      subscribe: () => () => {},
    });
    try {
      const result = buildChatStreamItems(view, sessionId);
      const ids = result.items
        .filter((item): item is Extract<typeof item, { type: 'message' }> => item.type === 'message')
        .map((item) => item.message.id);
      expect(ids).toEqual(['u1', 'assistant:u1', 'session-rollover:r1']);
      expect(result.lastAssistantMessageId).toBe('assistant:u1');
    } finally {
      view.dispose();
    }
  });
});

describe('mergeRolloverAvailableCommands', () => {
  it('adds /rollover for ordinary sessions while preserving /compact, and skips coordinators', () => {
    const base = [{ name: 'compact', description: 'Compact context' }];
    const merged = mergeRolloverAvailableCommands(base);
    expect(merged).toEqual([...base, ROLLOVER_SLASH_COMMAND]);
    expect(mergeRolloverAvailableCommands(merged)).toEqual(merged);
    expect(mergeRolloverAvailableCommands(base, { isBoardCoordinator: true })).toEqual(base);
  });
});
