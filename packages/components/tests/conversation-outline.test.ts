import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionHistoryParsed } from '@lody/shared';
import {
  OUTLINE_MIN_USER_ROUNDS,
  buildConversationOutline,
  countUserDrivenRounds,
  type ConversationOutlineSource,
} from '../src/lib/conversation-outline';
import type { TurnIndexRow } from '../src/lib/conversation-view/types';
import { summarizeTurn } from '../src/lib/conversation-view/turn-summary';

let nextId = 0;

const message = (
  role: 'user' | 'assistant' | 'system',
  items: unknown[],
  overrides: Partial<SessionHistoryParsed> = {}
): ConversationOutlineSource => {
  nextId += 1;
  return {
    type: 'message',
    message: {
      id: `msg-${nextId}`,
      role,
      items,
      timestamp: '2026-08-19T00:00:00.000Z',
      ...overrides,
    } as unknown as SessionHistoryParsed,
  };
};

const text = (value: string) => ({ type: 'text', text: value });
const thought = (value: string) => ({ type: 'thought', text: value });

beforeEach(() => {
  nextId = 0;
});

describe('buildConversationOutline', () => {
  it('makes one entry per round and takes the preview from the round’s first agent prose', () => {
    const outline = buildConversationOutline([
      message('user', [text('Add a rail to the session view')]),
      message('assistant', [text('Here is the plan for the rail.')]),
      message('assistant', [text('And here is the follow-up.')]),
      message('user', [text('Ship it')]),
      message('assistant', [text('Shipped.')]),
    ]);

    expect(outline).toHaveLength(2);
    expect(outline[0]).toMatchObject({
      title: 'Add a rail to the session view',
      preview: 'Here is the plan for the rail.',
    });
    expect(outline[1]).toMatchObject({ title: 'Ship it', preview: 'Shipped.' });
  });

  it('keeps a Continue turn inside the round it picks back up', () => {
    const outline = buildConversationOutline([
      message('user', [text('Refactor the parser')]),
      message('assistant', [text('Starting on the parser.')]),
      message('user', [text('Continue.')], {
        inputConfig: { _lodyDeliveryKind: 'continue' },
      } as Partial<SessionHistoryParsed>),
      message('assistant', [text('Picking up where I stopped.')]),
    ]);

    expect(outline).toHaveLength(1);
    expect(outline[0]).toMatchObject({
      title: 'Refactor the parser',
      preview: 'Starting on the parser.',
    });
  });

  it('preserves literal identifiers in summaries and refreshes only changed turns', () => {
    const user = message('user', [text('Find QA_RESUMED_OK')]);
    const assistant = message('assistant', [text('**QA_RESUMED_OK** `foo_bar`')]);
    const first = buildConversationOutline([user, assistant]);
    expect(first[0]).toMatchObject({
      title: 'Find QA_RESUMED_OK',
      preview: 'QA_RESUMED_OK foo_bar',
    });
    expect(buildConversationOutline([user, assistant])).toEqual(first);
    const updated = {
      ...assistant,
      message: { ...assistant.message!, items: [text('QA_RESUMED_OK — updated')] },
    };
    expect(buildConversationOutline([user, updated])[0]?.preview).toBe('QA_RESUMED_OK — updated');
    expect(buildConversationOutline([user, assistant])).toEqual(first);
    const long = message('assistant', [
      text('QA_RESUMED_OK ' + 'x'.repeat(960) + ' OUTSIDE_WINDOW'),
    ]);
    expect(buildConversationOutline([user, long])[0]?.preview).toContain('QA_RESUMED_OK');
    expect(buildConversationOutline([user, long])[0]?.preview).not.toContain('OUTSIDE_WINDOW');
  });

  it('leaves the preview empty while a round has produced no agent prose yet', () => {
    const outline = buildConversationOutline([
      message('user', [text('Start working')]),
      message('assistant', [thought('planning…')]),
    ]);

    expect(outline[0]?.preview).toBe('');
  });

  it('opens a round for content that precedes the first user message', () => {
    const outline = buildConversationOutline([
      message('assistant', [text('Scheduled run starting.')]),
      message('user', [text('Thanks')]),
    ]);

    expect(outline).toHaveLength(2);
    expect(outline[0]).toMatchObject({
      startsWithAgent: true,
      title: 'Scheduled run starting.',
      preview: 'Scheduled run starting.',
    });
    expect(outline[1]?.startsWithAgent).toBe(false);
  });

  describe('weight', () => {
    it('accumulates across every message in the round, not just the first', () => {
      // Stated as a comparison rather than a fixed bucket, so recalibrating the
      // thresholds against real sessions cannot silently invalidate the claim.
      const half = 'y'.repeat(600);
      const oneReply = buildConversationOutline([
        message('user', [text('hi')]),
        message('assistant', [text(half)]),
      ]);
      const twoReplies = buildConversationOutline([
        message('user', [text('hi')]),
        message('assistant', [text(half)]),
        message('assistant', [text(half)]),
      ]);

      expect(twoReplies[0]?.weight).toBeGreaterThan(oneReply[0]?.weight ?? 0);
    });

    it('ignores non-prose items so a tool-heavy turn is not maxed out', () => {
      const outline = buildConversationOutline([
        message('user', [text('hi')]),
        message('assistant', [
          { type: 'tool_call', toolCallId: 't1', title: 'z'.repeat(50_000) },
          text('done'),
        ]),
      ]);

      expect(outline[0]?.weight).toBe(0);
    });
  });
});

describe('countUserDrivenRounds', () => {
  const rounds = (count: number): ConversationOutlineSource[] =>
    Array.from({ length: count }, (_unused, index) =>
      message('user', [text(`round ${index + 1}`)])
    );

  it('does not count a leading agent round toward the rail threshold', () => {
    const outline = buildConversationOutline([
      message('assistant', [text('Scheduled run starting.')]),
      ...rounds(OUTLINE_MIN_USER_ROUNDS - 1),
    ]);

    expect(outline).toHaveLength(OUTLINE_MIN_USER_ROUNDS);
    expect(countUserDrivenRounds(outline)).toBe(OUTLINE_MIN_USER_ROUNDS - 1);
  });
});

describe('receipt rounds', () => {
  const boardReport = (sessionId: string, title?: string) => ({
    type: 'operation_completion',
    deliveryId: `delivery-${sessionId}`,
    operationId: `operation-${sessionId}`,
    operationKind: 'board_report',
    completion: {
      type: 'result',
      value: {
        items: [],
        boardReport: {
          boardId: 'board-1',
          events: [
            {
              kind: 'finished',
              sessionId,
              turnId: `turn-${sessionId}`,
              at: 0,
              ...(title ? { title } : {}),
              machineId: 'machine-1',
              origin: 'agent',
            },
          ],
        },
      },
    },
  });
  const chatReply = (sessionId: string, label?: string) => ({
    type: 'operation_completion',
    deliveryId: `delivery-${sessionId}`,
    operationId: `operation-${sessionId}`,
    operationKind: 'session_chat',
    completion: {
      type: 'result',
      value: {
        items: [
          {
            status: 'succeeded',
            target: { sessionId, userTurnId: `user-${sessionId}` },
            assistantTurnId: `assistant-${sessionId}`,
            ...(label ? { label } : {}),
          },
        ],
      },
    },
  });
  const batch = (...members: unknown[]) => ({
    type: 'operation_completion_batch',
    batchId: `batch-${nextId}`,
    memberCount: members.length,
    members,
    deliveryStatus: 'settled',
  });
  // The CLI writes a batch that woke the agent under its Inbox input id.
  const receipt = (sequence: number, ...members: unknown[]) =>
    message('system', [batch(...members)], { id: `inbox:completion:${sequence}` });

  it('opens a round at each batch that woke the agent, titled by the sessions it reports on', () => {
    const outline = buildConversationOutline([
      message('user', [text('Plan the work')]),
      message('assistant', [text('Dispatched two threads.')]),
      receipt(
        1,
        boardReport('session-a', 'Design thread'),
        boardReport('session-b', 'Review thread'),
        boardReport('session-a', 'Design thread')
      ),
      message('assistant', [text('Design is done; the review found two issues.')]),
      receipt(2, chatReply('session-c')),
      message('assistant', [text('Fixed both.')]),
    ]);

    expect(outline).toHaveLength(3);
    expect(outline[1]).toMatchObject({
      title: 'Design thread · Review thread',
      preview: 'Design is done; the review found two issues.',
      startsWithAgent: false,
      receiptSources: [
        { sessionId: 'session-a', title: 'Design thread' },
        { sessionId: 'session-b', title: 'Review thread' },
      ],
    });
    // Without a label the receipt carries no title; the card reads the live one.
    expect(outline[2]).toMatchObject({
      title: '',
      preview: 'Fixed both.',
      receiptSources: [{ sessionId: 'session-c' }],
    });
    expect(outline[0]?.receiptSources).toBeUndefined();
  });

  it('keeps a batch delivered with a user message inside that message’s round', () => {
    const outline = buildConversationOutline([
      message('user', [text('Where are we?')]),
      message('system', [batch(boardReport('session-a', 'Design thread'))], {
        id: 'operation-batch:batch-9',
      }),
      message('assistant', [text('Design is done.')]),
    ]);

    expect(outline).toHaveLength(1);
    expect(outline[0]).toMatchObject({ title: 'Where are we?', preview: 'Design is done.' });
  });

  it('counts receipt rounds toward the rail threshold', () => {
    const outline = buildConversationOutline([
      message('user', [text('Run the plan')]),
      message('assistant', [text('Started.')]),
      ...Array.from({ length: OUTLINE_MIN_USER_ROUNDS - 1 }, (_unused, index) => [
        receipt(index + 1, boardReport(`session-${index}`, `Thread ${index}`)),
        message('assistant', [text(`Result ${index} noted.`)]),
      ]).flat(),
    ]);

    expect(countUserDrivenRounds(outline)).toBe(OUTLINE_MIN_USER_ROUNDS);
  });

  it('titles a receipt round the view has not hydrated from its index summary', () => {
    const hydrated = receipt(4, boardReport('session-a', 'Design thread'));
    const row: TurnIndexRow = {
      id: 'inbox:completion:4',
      role: 'system',
      timestamp: '',
      summary: summarizeTurn(hydrated.message!),
    };
    const reply = message('assistant', [text('Noted.')]);
    const fromRow = buildConversationOutline([
      { type: 'placeholder', row, turnIndex: 0 },
      { ...reply, turnIndex: 1 },
    ]);
    const fromMessage = buildConversationOutline([
      { ...hydrated, turnIndex: 0 },
      { ...reply, turnIndex: 1 },
    ]);

    expect(fromRow[0]).toMatchObject({
      key: 'inbox:completion:4',
      title: 'Design thread',
      receiptSources: [{ sessionId: 'session-a', title: 'Design thread' }],
    });
    expect({ ...fromRow[0], receiptSources: undefined }).toEqual({
      ...fromMessage[0],
      receiptSources: undefined,
    });
    // An unread row still starts its round, so the round count never depends
    // on which turns happen to be hydrated.
    const unread = buildConversationOutline([
      { type: 'placeholder', row: { ...row, summary: undefined }, turnIndex: 0 },
    ]);
    expect(unread[0]).toMatchObject({ title: '', startsWithAgent: false });
  });
});
