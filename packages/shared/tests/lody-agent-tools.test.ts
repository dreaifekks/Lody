import { describe, expect, it } from 'vitest';
import {
  matchAgentSurfaceToolCall,
  parseLodyAgentToolIds,
  splitAgentTextWidgets,
} from '../src/lody-agent-tools';
import {
  LODY_WIDGET_SHELL_CONTENT_SECURITY_POLICY,
  buildLodyWidgetShellHtml,
  parseLodyWidgetFrameMessage,
} from '../src/lody-widget-shell';

const widgetInput = { title: 'Water heater', widget_code: '<svg viewBox="0 0 680 200"></svg>' };

describe('matchAgentSurfaceToolCall', () => {
  it('recognizes Lody tools under each agent spelling', () => {
    // Claude Code: canonical name in `toolName`, arguments as raw input.
    expect(
      matchAgentSurfaceToolCall({ toolName: 'mcp__lody__lody_show_widget', rawInput: widgetInput })
    ).toEqual({ kind: 'widget', source: 'lody', input: widgetInput });
    // Codex: `mcp.lody.x` title with the `{ server, tool, arguments }` envelope.
    expect(
      matchAgentSurfaceToolCall({
        title: 'mcp.lody.lody_request_review',
        rawInput: {
          server: 'lody',
          tool: 'lody_request_review',
          arguments: { title: 'Plan', markdown: '# Plan\n\n1. Do it' },
        },
      })
    ).toEqual({ kind: 'review', input: { title: 'Plan', markdown: '# Plan\n\n1. Do it' } });
    // Bare names (agents that title calls by tool name only).
    expect(
      matchAgentSurfaceToolCall({ title: 'lody_notify_user', rawInput: { body: 'Done' } })
    ).toEqual({ kind: 'notify', input: { body: 'Done' } });
  });

  it('recognizes Claude Desktop widgets and drops their loading messages', () => {
    expect(
      matchAgentSurfaceToolCall({
        toolName: 'mcp__visualize__show_widget',
        rawInput: { ...widgetInput, loading_messages: ['Drawing'] },
      })
    ).toEqual({ kind: 'widget', source: 'visualize', input: widgetInput });
  });

  it('keeps the kind but no input while arguments stream or are malformed', () => {
    expect(
      matchAgentSurfaceToolCall({ toolName: 'mcp__lody__lody_show_widget', rawInput: {} })
    ).toEqual({ kind: 'widget', source: 'lody', input: null });
    expect(
      matchAgentSurfaceToolCall({
        title: 'mcp.lody.lody_request_review',
        rawInput: { server: 'lody', tool: 'lody_request_review', arguments: '{"title":' },
      })
    ).toEqual({ kind: 'review', input: null });
  });

  it('ignores other tools and the same names served by other servers', () => {
    expect(matchAgentSurfaceToolCall({ title: 'Read file', rawInput: { path: '/a' } })).toBeNull();
    expect(
      matchAgentSurfaceToolCall({ toolName: 'mcp__other__lody_show_widget', rawInput: widgetInput })
    ).toBeNull();
    expect(
      matchAgentSurfaceToolCall({ toolName: 'mcp__lody__show_widget', rawInput: widgetInput })
    ).toBeNull();
    expect(matchAgentSurfaceToolCall({ title: 'lody_session_create' })).toBeNull();
  });
});

describe('splitAgentTextWidgets', () => {
  it('splits a Codex visualize line out of the reply', () => {
    const text =
      'Here is the flow.\n\nvisualize{"path":"/work/flow.html","mode":"wide","title":"Flow"}\n\nClick a step.';
    expect(splitAgentTextWidgets(text)).toEqual([
      { type: 'text', text: 'Here is the flow.\n' },
      {
        type: 'widget',
        embed: { format: 'codex', path: '/work/flow.html', title: 'Flow', mode: 'wide' },
        source: 'visualize{"path":"/work/flow.html","mode":"wide","title":"Flow"}',
      },
      { type: 'text', text: '\nClick a step.' },
    ]);
  });

  it('splits an Antigravity agent-embed tag and decodes its file URL', () => {
    const segments = splitAgentTextWidgets(
      'Intro\n<agent-embed src="file:///home/me/my%20app/widget.html"></agent-embed>'
    );
    expect(segments).toEqual([
      { type: 'text', text: 'Intro' },
      {
        type: 'widget',
        embed: { format: 'antigravity', path: '/home/me/my app/widget.html' },
        source: '<agent-embed src="file:///home/me/my%20app/widget.html"></agent-embed>',
      },
    ]);
  });

  it('leaves code blocks, inline mentions and invalid references as text', () => {
    const fenced = '```\nvisualize{"path":"/work/flow.html"}\n```';
    expect(splitAgentTextWidgets(fenced)).toEqual([{ type: 'text', text: fenced }]);
    const tagInFence = '~~~html\n<agent-embed src="file:///a.html"></agent-embed>\n~~~';
    expect(splitAgentTextWidgets(tagInFence)).toEqual([{ type: 'text', text: tagInFence }]);
    const inline = 'Write `visualize{"path":"/x.html"}` on its own line.';
    expect(splitAgentTextWidgets(inline)).toEqual([{ type: 'text', text: inline }]);
    const relative = 'visualize{"path":"flow.html"}';
    expect(splitAgentTextWidgets(relative)).toEqual([{ type: 'text', text: relative }]);
    const remote = '<agent-embed src="https://example.com/w.html"></agent-embed>';
    expect(splitAgentTextWidgets(remote)).toEqual([{ type: 'text', text: remote }]);
    const brokenJson = 'visualize{"path":"/x.html"';
    expect(splitAgentTextWidgets(brokenJson)).toEqual([{ type: 'text', text: brokenJson }]);
  });
});

describe('parseLodyAgentToolIds', () => {
  it('keeps known ids in canonical order', () => {
    expect(parseLodyAgentToolIds('widget, notify,unknown')).toEqual(['notify', 'widget']);
    expect(parseLodyAgentToolIds(undefined)).toEqual([]);
  });
});

describe('widget page messages', () => {
  it('accepts only well-formed messages', () => {
    expect(parseLodyWidgetFrameMessage({ type: 'lody-widget:prompt', text: '  Why?  ' })).toEqual({
      type: 'lody-widget:prompt',
      text: 'Why?',
    });
    expect(parseLodyWidgetFrameMessage({ type: 'lody-widget:prompt', text: '   ' })).toBeNull();
    expect(
      parseLodyWidgetFrameMessage({ type: 'lody-widget:prompt', text: 'x'.repeat(4_001) })
    ).toBeNull();
    expect(parseLodyWidgetFrameMessage({ type: 'lody-widget:height', height: -1 })).toBeNull();
    expect(parseLodyWidgetFrameMessage({ type: 'lody-widget:link', url: 42 })).toBeNull();
    expect(parseLodyWidgetFrameMessage('lody-widget:ready')).toBeNull();
  });

  it('ships a policy that only reaches the allowed CDNs', () => {
    const html = buildLodyWidgetShellHtml();
    expect(html).toContain(`content="${LODY_WIDGET_SHELL_CONTENT_SECURITY_POLICY}"`);
    expect(LODY_WIDGET_SHELL_CONTENT_SECURITY_POLICY).toContain("default-src 'none'");
    expect(LODY_WIDGET_SHELL_CONTENT_SECURITY_POLICY).not.toMatch(/127\.0\.0\.1|localhost|\*/);
  });
});
