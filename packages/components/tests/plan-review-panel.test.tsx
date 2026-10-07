// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionHistory } from '@lody/shared';
import { PlanReviewPanelView } from '../src/components/agent-surfaces/plan-review-panel';
import {
  buildPlanReviewIndex,
  derivePlanReviewTurnFact,
} from '../src/components/agent-surfaces/plan-review-model';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string, params?: Record<string, string>) =>
      (fallback ?? _key).replace(/\{\{(\w+)\}\}/g, (_, name: string) => params?.[name] ?? ''),
  }),
}));

// Markdown rendering is not under test; plain paragraphs keep the DOM selectable.
vi.mock('../src/components/ai-gui/markdown-renderer', () => ({
  MarkdownRenderer: ({ text }: { text: string }) =>
    React.createElement(
      'div',
      null,
      text
        .split('\n\n')
        .map((paragraph, index) => React.createElement('p', { key: index }, paragraph))
    ),
}));

const reviewCall = (toolCallId: string, title: string) => ({
  type: 'tool_call' as const,
  toolCallId,
  status: 'completed' as const,
  toolName: 'mcp__lody__lody_request_review',
  rawInput: { title, markdown: `# ${title}` },
});

const turn = (id: string, role: 'user' | 'assistant', items: unknown[] = []) =>
  ({ id, role, items, timestamp: '' }) as unknown as SessionHistory;

describe('plan review statuses', () => {
  it('keeps only the newest plan open and closes it once the user answers', () => {
    const facts = [
      turn('a1', 'assistant', [reviewCall('r1', 'First')]),
      turn('u1', 'user', [{ type: 'text', text: 'Change step 2' }]),
      turn('a2', 'assistant', [reviewCall('r2', 'Second')]),
    ].map(derivePlanReviewTurnFact);
    const open = buildPlanReviewIndex(facts);
    expect(open.latestId).toBe('r2');
    expect(open.byId.get('r1')?.status).toBe('superseded');
    expect(open.byId.get('r2')?.status).toBe('pending');

    const answered = buildPlanReviewIndex([
      ...facts,
      derivePlanReviewTurnFact(turn('u2', 'user', [{ type: 'text', text: 'Approved' }])),
    ]);
    expect(answered.byId.get('r2')?.status).toBe('answered');
  });

  it('ignores calls that never carried a complete plan', () => {
    const fact = derivePlanReviewTurnFact(
      turn('a1', 'assistant', [{ ...reviewCall('r1', 'x'), rawInput: { title: 'x' } }])
    );
    expect(fact.reviews).toEqual([]);
  });
});

describe('PlanReviewPanelView', () => {
  let container: HTMLDivElement;
  let root: Root;
  const sent: string[] = [];

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    // jsdom has no layout; the panel only positions its button from this.
    Range.prototype.getBoundingClientRect ??= () => new DOMRect();
    sent.length = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (props: Partial<React.ComponentProps<typeof PlanReviewPanelView>> = {}) =>
    act(() =>
      root.render(
        React.createElement(PlanReviewPanelView, {
          input: {
            title: 'Cache the index',
            markdown: 'Step one: read the index.\n\nStep two: write it to disk.',
          },
          status: 'pending',
          canAct: true,
          onSubmit: async (text: string) => {
            sent.push(text);
            return true;
          },
          ...props,
        })
      )
    );

  const button = (label: string) =>
    [...container.querySelectorAll('button')].find((element) => element.textContent === label);

  const type = (element: HTMLTextAreaElement, value: string) =>
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });

  it('sends the decision with each commented passage quoted', async () => {
    await render();
    const paragraph = container.querySelector('p:last-of-type');
    if (!paragraph?.firstChild) throw new Error('missing plan text');
    const range = document.createRange();
    range.setStart(paragraph.firstChild, 10);
    range.setEnd(paragraph.firstChild, 27);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    act(() => {
      paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    act(() => button('Comment')?.click());
    const draft = container.querySelector('textarea');
    if (!draft) throw new Error('missing comment box');
    await type(draft, 'Use the cache directory instead.');
    act(() => button('Add comment')?.click());

    const note = container.querySelector('textarea');
    if (!note) throw new Error('missing note box');
    await type(note, 'Also add a test.');
    await act(async () => {
      button('Request changes')?.click();
    });

    expect(sent).toEqual([
      [
        'Please revise the plan "Cache the index" and submit it for review again:',
        '> write it to disk.',
        'Use the cache directory instead.',
        'Also add a test.',
      ].join('\n\n'),
    ]);
    // Sent: the comments are cleared for the next round.
    expect(container.querySelectorAll('[data-plan-review-comment]')).toHaveLength(0);
  });

  it('approves in one click', async () => {
    await render();
    await act(async () => {
      button('Approve')?.click();
    });
    expect(sent).toEqual(['I approve the plan "Cache the index". Go ahead and implement it.']);
  });

  it('shows no buttons on an answered plan or someone else’s conversation', async () => {
    await render({ status: 'answered' });
    expect(button('Approve')).toBeUndefined();
    expect(container.textContent).toContain('Answered');

    await render({ canAct: false });
    expect(button('Approve')).toBeUndefined();
    expect(button('Request changes')).toBeUndefined();
  });
});
