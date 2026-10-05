import { describe, expect, it } from 'vitest';
import type { MessageContent } from '@lody/shared';
import {
  buildAssistantTurnRenderLayout,
  segmentHasVisibleFinalContent,
} from '../src/components/ai-gui/assistant-turn-render-blocks';

// Guards the load-bearing invariant behind view.tsx `shouldUseWorkedGroup`: a finished
// turn is folded into a "Worked for …" summary ONLY when it has a genuine visible final
// answer, i.e. at least one render block is NOT in `workBlockKeys`. Activity groups are
// folded unconditionally, so an interrupted/cancelled turn that ends mid-tool with no
// final text must have NO visible tail and therefore must stay expanded. See
// packages/components/src/components/ai-gui/AGENTS.md ("Worked for …" collapse gate).
const text = (value: string): MessageContent => ({ type: 'text', text: value }) as MessageContent;

let toolSeq = 0;
const toolCall = (): MessageContent =>
  ({
    type: 'tool_call',
    toolCallId: `tool-${(toolSeq += 1)}`,
    status: 'completed',
    title: 'ran a tool',
  }) as unknown as MessageContent;

// The notice the stream folds onto the turn it interrupted.
const chatFailed = (reason: string): MessageContent =>
  ({
    type: 'system_notice',
    name: 'chat_failed',
    meta: { reason },
  }) as unknown as MessageContent;

const hasVisibleFinalContent = (items: MessageContent[], isTurnFinished: boolean): boolean => {
  const { blocks, segments } = buildAssistantTurnRenderLayout('m1', items, isTurnFinished);
  return segments.some((segment) => segmentHasVisibleFinalContent(blocks, segment));
};

describe('Worked for … collapse gate (buildAssistantTurnRenderLayout)', () => {
  it('interrupted turn with only tool work and no final text has no visible tail → do not collapse', () => {
    // e.g. cancelled/agent-disconnected mid-tool: CLI still marks finished=true.
    expect(hasVisibleFinalContent([toolCall(), toolCall()], true)).toBe(false);
  });

  it('normal turn ending with a text answer keeps that answer as a visible tail → collapse', () => {
    expect(hasVisibleFinalContent([toolCall(), toolCall(), text('all done')], true)).toBe(true);
  });

  it('trailing tool after the text answer (no closing text) leaves no visible tail → do not collapse', () => {
    // Intended edge behavior: erring toward showing more, never an empty "Worked for …".
    expect(hasVisibleFinalContent([text('working on it'), toolCall()], true)).toBe(false);
  });

  it('a failure notice folded onto a turn cut off mid-step is not an answer → do not collapse', () => {
    expect(
      hasVisibleFinalContent([text('checking'), toolCall(), chatFailed('daemon_restart')], true)
    ).toBe(false);
  });

  it('an answer followed by a notice still collapses the work before it', () => {
    expect(
      hasVisibleFinalContent([toolCall(), text('all done'), chatFailed('agent_disconnected')], true)
    ).toBe(true);
  });

  it('streaming turn folds nothing (workBlockKeys empty), so it never collapses', () => {
    const { workBlockKeys } = buildAssistantTurnRenderLayout('m1', [toolCall(), toolCall()], false);
    expect(workBlockKeys.size).toBe(0);
  });
});
