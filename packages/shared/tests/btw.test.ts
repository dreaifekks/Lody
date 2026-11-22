import { describe, expect, it } from 'vitest';
import {
  pickBtwFastConfigOptions,
  SessionBtwArticleContextSchema,
  SessionBtwProgressSchema,
  SessionBtwRequestSchema,
  SessionBtwResponseSchema,
  type AcpConfigOptionSummary,
} from '../src/index';

describe('session/btw schemas', () => {
  it('validates ask, cancel, and close requests and enforces bounds', () => {
    expect(
      SessionBtwRequestSchema.parse({
        action: 'ask',
        sessionId: 'sess-1',
        btwId: 'btw-1',
        question: 'What does this helper do?',
        articleContext: {
          path: 'docs/design.md',
          selection: 'selected snippet',
          excerpt: 'full excerpt',
          truncated: false,
        },
        readOnlyTools: false,
        priorTurns: [
          { role: 'user', text: 'prev q' },
          { role: 'assistant', text: 'prev a' },
        ],
      })
    ).toMatchObject({
      action: 'ask',
      btwId: 'btw-1',
      readOnlyTools: false,
    });

    // cancel and close do not require question
    expect(
      SessionBtwRequestSchema.safeParse({
        action: 'cancel',
        sessionId: 'sess-1',
        btwId: 'btw-1',
      }).success
    ).toBe(true);
    expect(
      SessionBtwRequestSchema.safeParse({
        action: 'close',
        sessionId: 'sess-1',
        btwId: 'btw-1',
      }).success
    ).toBe(true);

    // ask requires non-empty question
    expect(
      SessionBtwRequestSchema.safeParse({
        action: 'ask',
        sessionId: 'sess-1',
        btwId: 'btw-1',
        question: '   ',
      }).success
    ).toBe(false);

    // question max length (8000)
    expect(
      SessionBtwRequestSchema.safeParse({
        action: 'ask',
        sessionId: 'sess-1',
        btwId: 'btw-1',
        question: 'a'.repeat(8001),
      }).success
    ).toBe(false);

    // priorTurns max count (12)
    expect(
      SessionBtwRequestSchema.safeParse({
        action: 'ask',
        sessionId: 'sess-1',
        btwId: 'btw-1',
        question: 'hi',
        priorTurns: Array.from({ length: 13 }, (_, idx) => ({
          role: idx % 2 === 0 ? 'user' : 'assistant',
          text: `turn ${idx}`,
        })),
      }).success
    ).toBe(false);

    // articleContext max lengths
    expect(
      SessionBtwArticleContextSchema.safeParse({
        path: 'a'.repeat(513),
      }).success
    ).toBe(false);
    expect(
      SessionBtwArticleContextSchema.safeParse({
        path: 'a.md',
        selection: 'x'.repeat(4001),
      }).success
    ).toBe(false);
    expect(
      SessionBtwArticleContextSchema.safeParse({
        path: 'a.md',
        excerpt: 'x'.repeat(12001),
      }).success
    ).toBe(false);
  });

  it('keeps progress and response schemas mutually disjoint', () => {
    const progress = {
      btwId: 'btw-1',
      kind: 'delta' as const,
      delta: 'hello',
      modelId: 'gemini-4-hydrogen',
      modelLabel: 'Hydrogen · Low',
    };
    const response = {
      btwId: 'btw-1',
      text: 'hello world',
      modelId: 'gemini-4-hydrogen',
      modelLabel: 'Hydrogen · Low',
      readOnlyTools: false,
    };

    expect(SessionBtwProgressSchema.safeParse(progress).success).toBe(true);
    expect(SessionBtwResponseSchema.safeParse(progress).success).toBe(false);
    expect(SessionBtwResponseSchema.safeParse(response).success).toBe(true);
    expect(SessionBtwProgressSchema.safeParse(response).success).toBe(false);
  });
});

describe('pickBtwFastConfigOptions', () => {
  it('picks gemini-4-hydrogen + low + plan for antigravity and formats Hydrogen · Low', () => {
    const configOptions: AcpConfigOptionSummary[] = [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'gemini-4-neon',
        options: [
          { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
          { value: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' },
          { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
        ],
      },
      {
        id: 'thought_level',
        name: 'Thought Level',
        category: 'thought_level',
        type: 'select',
        currentValue: 'high',
        options: [
          { value: 'minimal', name: 'Minimal' },
          { value: 'low', name: 'Low' },
          { value: 'medium', name: 'Medium' },
          { value: 'high', name: 'High' },
        ],
      },
      {
        id: 'mode',
        name: 'Mode',
        category: 'mode',
        type: 'select',
        currentValue: 'default',
        options: [
          { value: 'default', name: 'Default' },
          { value: 'plan', name: 'Plan' },
          { value: 'auto', name: 'Auto' },
          { value: 'yolo', name: 'YOLO' },
        ],
      },
    ];

    const picked = pickBtwFastConfigOptions({
      cliType: 'builtin',
      agentType: 'antigravity',
      configOptions,
    });

    expect(picked.configOptionValues).toEqual({
      model: 'gemini-4-hydrogen',
      thought_level: 'low',
      mode: 'plan',
    });
    expect(picked.modelId).toBe('gemini-4-hydrogen');
    expect(picked.modelLabel).toBe('Hydrogen · Low');
  });

  it('falls back to gemini-3.8-flash for antigravity-acp and supports legacyModels', () => {
    const picked = pickBtwFastConfigOptions({
      cliType: 'registry',
      agentType: 'antigravity-acp',
      configOptions: [
        {
          id: 'thought_level',
          name: 'Thought Level',
          category: 'thought_level',
          type: 'select',
          currentValue: 'high',
          options: [
            { value: 'minimal', name: 'Minimal' },
            { value: 'high', name: 'High' },
          ],
        },
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: 'default',
          options: [
            { value: 'default', name: 'Default' },
            { value: 'ask', name: 'Ask' },
          ],
        },
      ],
      legacyModels: {
        currentModelId: 'gemini-4-neon',
        availableModels: [
          { modelId: 'gemini-4-neon', name: 'Gemini 4 Neon' },
          { modelId: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
        ],
      },
    });

    expect(picked.configOptionValues).toEqual({
      model: 'gemini-3.8-flash',
      thought_level: 'minimal',
      mode: 'ask',
    });
    expect(picked.modelId).toBe('gemini-3.8-flash');
    expect(picked.modelLabel).toBe('Flash · Minimal');
  });

  it('picks haiku -> claude-haiku-* -> sonnet, low effort, and plan -> dontAsk for claude', () => {
    const baseOptions: AcpConfigOptionSummary[] = [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'default',
        options: [
          { value: 'default', name: 'Default' },
          { value: 'opus[1m]', name: 'Opus' },
          { value: 'sonnet', name: 'Sonnet' },
          { value: 'haiku', name: 'Haiku' },
        ],
      },
      {
        id: 'effort',
        name: 'Effort',
        category: 'thought_level',
        type: 'select',
        currentValue: 'default',
        options: [
          { value: 'default', name: 'Default' },
          { value: 'low', name: 'Low' },
          { value: 'high', name: 'High' },
        ],
      },
      {
        id: 'mode',
        name: 'Mode',
        category: 'mode',
        type: 'select',
        currentValue: 'default',
        options: [
          { value: 'default', name: 'Default' },
          { value: 'plan', name: 'Plan' },
          { value: 'dontAsk', name: "Don't Ask" },
        ],
      },
    ];

    const haikuPick = pickBtwFastConfigOptions({
      cliType: 'builtin',
      agentType: 'claude',
      configOptions: baseOptions,
    });
    expect(haikuPick.configOptionValues).toEqual({
      model: 'haiku',
      effort: 'low',
      mode: 'plan',
    });
    expect(haikuPick.modelLabel).toBe('Haiku · Low');

    const fallbackPick = pickBtwFastConfigOptions({
      cliType: 'builtin',
      agentType: 'claude',
      configOptions: [
        {
          ...baseOptions[0]!,
          options: [
            { value: 'default', name: 'Default' },
            { value: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
            { value: 'sonnet', name: 'Sonnet' },
          ],
        },
        baseOptions[1]!,
        {
          ...baseOptions[2]!,
          options: [
            { value: 'default', name: 'Default' },
            { value: 'dontAsk', name: "Don't Ask" },
          ],
        },
      ],
    });
    expect(fallbackPick.configOptionValues).toEqual({
      model: 'claude-haiku-4-5',
      effort: 'low',
      mode: 'dontAsk',
    });

    const sonnetFallback = pickBtwFastConfigOptions({
      cliType: 'builtin',
      agentType: 'claude',
      configOptions: [
        {
          ...baseOptions[0]!,
          options: [
            { value: 'default', name: 'Default' },
            { value: 'sonnet', name: 'Sonnet' },
          ],
        },
        baseOptions[1]!,
        baseOptions[2]!,
      ],
    });
    expect(sonnetFallback.configOptionValues.model).toBe('sonnet');
    expect(sonnetFallback.modelLabel).toBe('Sonnet · Low');
  });

  it('picks latest non-legacy codex fast model (gpt-6-luna -> non-5.6 luna -> gpt-6.2-sol -> mini)', () => {
    const modeAndEffort: AcpConfigOptionSummary[] = [
      {
        id: 'reasoning_effort',
        name: 'Reasoning Effort',
        category: 'thought_level',
        type: 'select',
        currentValue: 'high',
        options: [
          { value: 'none', name: 'None' },
          { value: 'low', name: 'Low' },
          { value: 'high', name: 'High' },
        ],
      },
      {
        id: 'mode',
        name: 'Mode',
        category: 'mode',
        type: 'select',
        currentValue: 'agent',
        options: [
          { value: 'read-only', name: 'Read Only' },
          { value: 'agent', name: 'Agent' },
          { value: 'agent-full-access', name: 'Full Access' },
        ],
      },
    ];

    const lunaPick = pickBtwFastConfigOptions({
      cliType: 'builtin',
      agentType: 'codex',
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'gpt-6.2-astra',
          options: [
            { value: 'gpt-6.2-astra', name: 'GPT-6.2 Astra' },
            { value: 'gpt-6.2-sol', name: 'GPT-6.2 Sol' },
            { value: 'gpt-6-luna', name: 'GPT-6 Luna' },
            { value: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', group: 'Legacy' },
          ],
        },
        ...modeAndEffort,
      ],
    });
    expect(lunaPick.configOptionValues).toEqual({
      model: 'gpt-6-luna',
      reasoning_effort: 'low',
      mode: 'read-only',
    });
    expect(lunaPick.modelLabel).toBe('Luna · Low');

    // When gpt-6-luna is absent, prefers gpt-6.2-sol over legacy gpt-5.6-luna
    const solPick = pickBtwFastConfigOptions({
      cliType: 'builtin',
      agentType: 'codex',
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'gpt-6.2-astra',
          options: [
            { value: 'gpt-6.2-astra', name: 'GPT-6.2 Astra' },
            { value: 'gpt-6.2-sol', name: 'GPT-6.2 Sol' },
            { value: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', group: 'Legacy' },
          ],
        },
        ...modeAndEffort,
      ],
    });
    expect(solPick.configOptionValues.model).toBe('gpt-6.2-sol');
    expect(solPick.modelLabel).toBe('Sol · Low');

    // Non-5.6 luna variant beats gpt-6.2-sol
    const nextLunaPick = pickBtwFastConfigOptions({
      cliType: 'builtin',
      agentType: 'codex',
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'gpt-6.2-astra',
          options: [
            { value: 'gpt-6.2-sol', name: 'GPT-6.2 Sol' },
            { value: 'gpt-6.4-luna', name: 'GPT-6.4 Luna' },
            { value: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', group: 'Legacy' },
          ],
        },
        ...modeAndEffort,
      ],
    });
    expect(nextLunaPick.configOptionValues.model).toBe('gpt-6.4-luna');

    // Falls back to mini before legacy 5.6-luna
    const miniPick = pickBtwFastConfigOptions({
      cliType: 'builtin',
      agentType: 'codex',
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'gpt-6.2-astra',
          options: [
            { value: 'gpt-6.2-astra', name: 'GPT-6.2 Astra' },
            { value: 'gpt-5-mini', name: 'GPT-5 Mini' },
            { value: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', group: 'Legacy' },
          ],
        },
        ...modeAndEffort,
      ],
    });
    expect(miniPick.configOptionValues.model).toBe('gpt-5-mini');
    expect(miniPick.modelLabel).toBe('GPT-5 Mini · Low');
  });

  it('uses leastPermissionModeRank, boolean plan_mode, and lowest thought level for other providers', () => {
    const picked = pickBtwFastConfigOptions({
      cliType: 'builtin',
      agentType: 'grok',
      configOptions: [
        {
          id: 'plan_mode',
          name: 'Plan',
          type: 'boolean',
          currentValue: false,
          options: [],
        },
        {
          id: 'permission_mode',
          name: 'Permission Mode',
          category: '_permission',
          type: 'select',
          currentValue: 'always-approve',
          options: [
            { value: 'ask', name: 'Ask Every Time' },
            { value: 'always-approve', name: 'Always Approve' },
          ],
        },
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'grok-4.6',
          options: [
            { value: 'grok-4.6', name: 'Grok 4.6' },
            { value: 'grok-4.5', name: 'Grok 4.5' },
          ],
        },
        {
          id: 'reasoning_effort',
          name: 'Reasoning Effort',
          category: 'thought_level',
          type: 'select',
          currentValue: 'high',
          options: [
            { value: 'high', name: 'High' },
            { value: 'low', name: 'Low' },
            { value: 'minimal', name: 'Minimal' },
          ],
        },
      ],
    });

    expect(picked.configOptionValues).toEqual({
      plan_mode: true,
      permission_mode: 'ask',
      reasoning_effort: 'minimal',
    });
    expect(picked.modelId).toBe('grok-4.6');
    expect(picked.modelLabel).toBe('Grok 4.6 · Minimal');
  });
});
