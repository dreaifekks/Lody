import { describe, expect, it } from 'vitest';
import { buildSessionLink, parseSessionLink, resolveSessionLinkId } from '../src/session-link';
import { normalizeSessionLinksForExport } from '../src/session-link-export';

describe('session resource links', () => {
  it.each([
    ['See session://abc.', 'See lody://session/abc?workspace=ws.'],
    ['**session://abc**', '**lody://session/abc?workspace=ws**'],
    ['_session://abc_', '_lody://session/abc?workspace=ws_'],
    ['session://abc，后续', 'lody://session/abc?workspace=ws，后续'],
    ['https://example.test/session://abc', 'https://example.test/session://abc'],
    ['No links or only https://example.test', 'No links or only https://example.test'],
  ])('normalizes prose without absorbing Markdown delimiters: %s', (source, expected) => {
    expect(normalizeSessionLinksForExport(source, 'ws')).toBe(expected);
  });
  it('exports portable links without rebinding explicit workspaces or changing code', () => {
    const source = [
      '[@Old](session://Child_A)',
      '[Other](lody-oss://session/B?workspace=foreign)',
      '`session://inline` and ``session://double``',
      '`multiline\nsession://example`',
      '> ```md\n> [Example](session://quoted)\n> ```',
      '<!-- session://comment -->',
      '[External](https://example.test/?next=session://keep)',
      '```md',
      '[Example](session://example)',
      '```',
      '    session://indented',
      'session://invalid/path',
    ].join('\n');
    expect(normalizeSessionLinksForExport(source, 'ws_1')).toBe(
      source
        .replace('session://Child_A', 'lody://session/Child_A?workspace=ws_1')
        .replace('lody-oss://', 'lody://')
    );
    expect(normalizeSessionLinksForExport('[Old](session://A)')).toBe('[Old](lody://session/A)');
  });
  it('emits only the exact conversation ID, including when normalizing a legacy selector', () => {
    const target = { sessionId: 'Root_A', workspaceId: 'lw_One', tabSessionId: 'Child_B' };
    const canonical = 'lody://session/Child_B?workspace=lw_One';
    expect(buildSessionLink(target)).toBe(canonical);
    expect(parseSessionLink(canonical)).toEqual({ sessionId: 'Child_B', workspaceId: 'lw_One' });
    expect(resolveSessionLinkId(canonical, 'lw_One')).toBe('Child_B');
    const legacy = 'lody://session/Root_A?workspace=lw_One&tab=Child_B';
    expect(parseSessionLink(legacy)).toEqual(target);
    expect(buildSessionLink(parseSessionLink(legacy)!)).toBe(canonical);
    expect(normalizeSessionLinksForExport(`[Conversation](${legacy})`)).toBe(
      `[Conversation](${canonical})`
    );
    expect(buildSessionLink({ sessionId: 'Root_A', workspaceId: 'lw_One' })).toBe(
      'lody://session/Root_A?workspace=lw_One'
    );
  });

  it.each(['lody', 'lody-oss', 'ai.lody.nightly'])(
    'reads %s resources and emits the common scheme',
    (scheme) => {
      const target = parseSessionLink(`${scheme}://session/Ab_c?workspace=ws_1`);
      expect(target).toEqual({ sessionId: 'Ab_c', workspaceId: 'ws_1' });
      expect(buildSessionLink(target!)).toBe('lody://session/Ab_c?workspace=ws_1');
    }
  );

  it('carries a turn of the conversation, colons and all, and tools ignore it', () => {
    const turnId = 'assistant:inbox:completion:12';
    const link = buildSessionLink({ sessionId: 'Ab_c', turnId });
    expect(link).toBe('lody://session/Ab_c?turn=assistant:inbox:completion:12');
    expect(parseSessionLink(link)).toEqual({ sessionId: 'Ab_c', turnId });
    expect(parseSessionLink(`lody://session/Ab_c?workspace=ws_1&turn=${turnId}`)).toEqual({
      sessionId: 'Ab_c',
      workspaceId: 'ws_1',
      turnId,
    });
    expect(resolveSessionLinkId(link, 'ws_1')).toBe('Ab_c');
    expect(normalizeSessionLinksForExport(`See [the review](${link}).`, 'ws_1')).toBe(
      `See [the review](lody://session/Ab_c?workspace=ws_1&turn=${turnId}).`
    );
    for (const rejected of [
      'lody://session/Ab_c?turn=assistant%3Ainbox',
      'lody://session/Ab_c?turn=a&turn=b',
      'lody://session/Ab_c?turn=a/b',
      'lody://session/Ab_c?turn=',
    ])
      expect(parseSessionLink(rejected)).toBeNull();
    expect(() => buildSessionLink({ sessionId: 'Ab_c', turnId: 'a b' })).toThrow();
  });

  it('retains legacy references and enforces the MCP workspace boundary', () => {
    expect(parseSessionLink('session://Ab_c/')).toEqual({ sessionId: 'Ab_c' });
    expect(resolveSessionLinkId('session://Ab_c', 'ws_1')).toBe('Ab_c');
    expect(resolveSessionLinkId('lody://session/Ab_c?workspace=ws_1', 'ws_1')).toBe('Ab_c');
    expect(() => resolveSessionLinkId('lody://session/Ab_c?workspace=ws_2', 'ws_1')).toThrow(
      'different workspace'
    );
    expect(() => resolveSessionLinkId('lody://session/root?tab=child', 'ws_1')).toThrow(
      'child session ID'
    );
  });
});
