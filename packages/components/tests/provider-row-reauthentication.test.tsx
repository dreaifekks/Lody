// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANTIGRAVITY_AGENT_TYPE,
  ANTIGRAVITY_THIRD_PARTY_LIMIT_ID,
  ANTIGRAVITY_THIRD_PARTY_MODELS_ENV,
  getRateLimitEntryKey,
  type AgentConfigId,
  type AgentConfigMeta,
  type MachineId,
  type MachineViewMeta,
} from '@lody/shared';

import { ProviderRow } from '../src/components/settings/provider-row';
import { initI18n } from '../src/i18n';

const machineId = 'machine-test' as MachineId;
const machine: MachineViewMeta = {
  id: machineId,
  name: 'Workstation',
  cliVersion: '0.76.0',
  os: 'macOS',
  sessions: [],
  raceLimits: {},
};

const makeConfig = (
  overrides: Pick<AgentConfigMeta, 'cliType' | 'agentType'>
): AgentConfigMeta => ({
  id: `config-${overrides.agentType}` as AgentConfigId,
  machineId,
  name: overrides.agentType,
  env: {},
  ...overrides,
});

describe('ProviderRow reauthentication', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  const renderConfig = async (config: AgentConfigMeta) => {
    await act(async () => {
      root.render(
        <ProviderRow config={config} machine={machine} onEdit={vi.fn()} onRefresh={vi.fn()} />
      );
    });
  };

  // Asserts on rendered text rather than a mocked panel: the row must not grow a
  // sign-in affordance again, whichever component would provide it.
  const hasSignInAction = () =>
    Array.from(container.querySelectorAll('button')).some((button) =>
      button.textContent?.includes('Sign in')
    );

  // Signing in again lives in the provider detail dialog, so no list row shows it.
  it.each([
    { cliType: 'builtin', agentType: 'claude' },
    { cliType: 'builtin', agentType: 'codex' },
    { cliType: 'builtin', agentType: 'kimi' },
    { cliType: 'registry', agentType: 'auggie' },
  ] as const)('does not offer Sign in again for the $agentType provider row', async (overrides) => {
    await renderConfig(makeConfig(overrides));

    expect(hasSignInAction()).toBe(false);
  });

  it('still opens the provider detail when the row is clicked', async () => {
    const config = makeConfig({ cliType: 'builtin', agentType: 'claude' });
    const onEdit = vi.fn();
    await act(async () => {
      root.render(<ProviderRow config={config} machine={machine} onEdit={onEdit} />);
    });

    const row = container.querySelector<HTMLButtonElement>('button[aria-label="Edit Config"]');
    await act(async () => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onEdit).toHaveBeenCalledWith(config);
  });
});

describe('ProviderRow meta line', () => {
  let container: HTMLDivElement;
  let root: Root;
  const now = new Date('2026-09-26T08:00:00.000Z');

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    await initI18n('en');
  });

  const renderCustom = async () => {
    const config = { ...makeConfig({ cliType: 'custom', agentType: 'e2e' }), name: 'E2E Agent' };
    await act(async () => {
      root.render(
        <ProviderRow
          config={config}
          machine={machine}
          onEdit={vi.fn()}
          usage={{ conversations: 1, lastUsedAt: now.getTime() - 2 * 60_000 }}
        />
      );
    });
  };

  // The kind is a fact of the meta line, in the reader's language, not an
  // English pill beside the name; the time reads as a sentence of that language.
  it('names a custom provider and when it was used in Chinese', async () => {
    await initI18n('zh_CN');
    await renderCustom();

    expect(container.textContent).toContain('自定义 · 1 个对话 · 2 分钟前用过');
    expect(container.textContent).not.toContain('Custom');
    expect(container.textContent).not.toContain('2m');
  });

  it('keeps the compact units in English', async () => {
    await initI18n('en');
    await renderCustom();

    expect(container.textContent).toContain('Custom · 1 conversation · Used 2m ago');
  });
});

describe('ProviderRow Antigravity quota', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const config = makeConfig({ cliType: 'registry', agentType: ANTIGRAVITY_AGENT_TYPE });
  const group = (limitId: string, limitName: string, usedPercent: number) => ({
    limitId,
    limitName,
    scope: { providerId: ANTIGRAVITY_AGENT_TYPE },
    windows: [
      {
        label: limitName,
        usedPercent,
        windowDurationSeconds: 5 * 60 * 60,
        resetsAtEpochSeconds: null,
      },
    ],
  });
  const quotaMachine: MachineViewMeta = {
    ...machine,
    raceLimits: {
      [getRateLimitEntryKey(ANTIGRAVITY_AGENT_TYPE, 'gemini', config.id)]: group(
        'gemini',
        'Gemini',
        10
      ),
      [getRateLimitEntryKey(ANTIGRAVITY_AGENT_TYPE, ANTIGRAVITY_THIRD_PARTY_LIMIT_ID, config.id)]:
        group(ANTIGRAVITY_THIRD_PARTY_LIMIT_ID, 'Claude / GPT', 60),
    },
  };
  const meterTitles = () =>
    Array.from(container.querySelectorAll('[title]')).map((node) => node.getAttribute('title'));

  const render = async (env: Record<string, string>) => {
    await act(async () => {
      root.render(
        <ProviderRow
          config={{ ...config, env }}
          machine={quotaMachine}
          onEdit={vi.fn()}
          variant="card"
        />
      );
    });
  };

  // Google never counts ACP use against the Claude/GPT group, so even a
  // provider that offers those models shows only its Gemini quota.
  it.each([
    { offersClaude: false, env: {} },
    { offersClaude: true, env: { [ANTIGRAVITY_THIRD_PARTY_MODELS_ENV]: '1' } },
  ])('shows only the Gemini quota (offers Claude: $offersClaude)', async ({ env }) => {
    await render(env);

    expect(meterTitles()).toContain('5h: 90%');
    expect(meterTitles()).not.toContain('5h: 40%');
    expect(meterTitles().some((title) => title?.includes('Claude / GPT'))).toBe(false);
  });
});
