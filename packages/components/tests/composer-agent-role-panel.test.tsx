// @vitest-environment jsdom

import { act, createElement, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import {
  AGENT_ROLE_VERSION,
  DEFAULT_AGENT_ROLE_EMOJI,
  type AgentConfigId,
  type AgentRole,
  type CatalogAgentRole,
  type AgentRoleId,
  type AgentRoleInstanceId,
  type MachineId,
} from '@lody/shared';

import { ComposerAgentRolePanel } from '../src/components/sessions/composer-agent-role-panel';
import type { ComposerAgentRoleItem } from '../src/lib/composer-agent-roles';
import { Menu } from '../src/ui/menu';
import { initI18n } from '../src/i18n';
import { composerItemsOf, singleMachineRole } from './agent-role-fixture';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const makeRole = (
  overrides: Partial<AgentRole> & Pick<AgentRole, 'id' | 'name'>
): CatalogAgentRole =>
  singleMachineRole({
    v: AGENT_ROLE_VERSION,
    ownerUserId: 'user-1',
    visibility: 'private',
    machineId: 'machine-1' as MachineId,
    agentConfigId: 'config-1' as AgentConfigId,
    runConfig: {},
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  });

const reviewerRole = makeRole({
  id: 'r-1' as AgentRoleId,
  name: 'Code Reviewer',
  emoji: '🔍',
  promptPrefix: 'Review the diff for correctness before style.',
  runConfig: {
    modelId: 'gpt-5.6-sol',
    modeId: 'plan',
    configOptionValues: { thought_level: 'high', fast_mode: false },
  },
});
const reviewer: ComposerAgentRoleItem = composerItemsOf(reviewerRole)[0]!;
const reviewerInstanceId = reviewerRole.instances[0]!.id;

type PanelProps = ComponentProps<typeof ComposerAgentRolePanel>;

describe('ComposerAgentRolePanel', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = undefined;
    }
    container?.remove();
    container = undefined;
  });

  /* The panel lives inside the run-config dropdown, and its rows are menu items,
     so it is rendered in an open menu rather than bare. */
  const render = async (props: Partial<PanelProps> = {}): Promise<HTMLElement> => {
    await act(async () => {
      root?.render(
        createElement(
          Menu.Root,
          { open: true },
          createElement(
            Menu.Content,
            null,
            createElement(ComposerAgentRolePanel, {
              items: [reviewer],
              selectedInstanceId: null,
              onSelect: () => undefined,
              compact: false,
              ...props,
            })
          )
        )
      );
    });
    return document.body;
  };

  it('leaves the agent off a compact row whose title already names it', async () => {
    const pairRole = singleMachineRole({
      ...reviewerRole,
      instances: [
        { ...reviewerRole.instances[0]! },
        { ...reviewerRole.instances[0]!, id: 'strict' as AgentRoleInstanceId, alias: 'Strict' },
      ],
    });
    const rows = composerItemsOf(pairRole);
    const view = await render({ items: rows, compact: true });
    const rowText = [...view.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')].map(
      (row) => row.textContent ?? ''
    );
    // Titled by its agent: the second line is the model alone.
    expect(rowText.find((text) => text.includes('Code Reviewer · Codex'))).not.toContain('Codex ·');
    // Titled by its alias: the second line still says which agent.
    expect(rowText.find((text) => text.includes('Code Reviewer · Strict'))).toContain('Codex ·');
  });

  it('states the whole binding a Role would run, not just its name', async () => {
    const view = await render();
    expect(view.textContent).toContain('Code Reviewer');
    expect(view.textContent).toContain('🔍');
    // The agent, then the machine it runs on: this one, by its machine name.
    expect(view.textContent).toContain('Codex ・ machine-1');
    // Resolved against the bound agent's own capabilities: the Role stores the
    // id, the pane shows the label that agent publishes for it.
    expect(view.textContent).toContain('5.6-Sol');
    expect(view.textContent).toContain('plan');
    expect(view.textContent).toContain('high');
    // Nothing the Role did not pin: this agent publishes a reasoning selector,
    // but a Role that stored no value for it must not show that agent's own.
    expect(view.textContent).not.toContain('Medium');
    // The instruction itself, because what it SAYS is what decides whether this
    // is the Role you meant.
    expect(view.textContent).toContain('Review the diff for correctness before style.');
  });

  it('shows a stored id as it stands when the agent has no label for it', async () => {
    const view = await render({
      items: [
        {
          ...reviewer,
          instance: { ...reviewer.instance, runConfig: { modelId: 'model-the-agent-dropped' } },
        },
      ],
    });
    expect(view.textContent).toContain('model-the-agent-dropped');
  });

  it('falls back to the shared glyph so every row reads the same', async () => {
    const view = await render({
      items: [{ ...reviewer, role: { ...reviewer.role, emoji: undefined } }],
    });
    expect(view.textContent).toContain(DEFAULT_AGENT_ROLE_EMOJI);
  });

  it('picks a Role by its stable id', async () => {
    const onSelect = vi.fn();
    const view = await render({ onSelect });
    const row = [...view.querySelectorAll('[role="menuitemradio"]')].find((node) =>
      node.textContent?.includes('Code Reviewer')
    );
    await act(async () => {
      (row as HTMLElement).click();
    });
    expect(onSelect).toHaveBeenCalledWith(reviewerInstanceId);
  });

  it('offers leaving the Role as its own row', async () => {
    const onSelect = vi.fn();
    const view = await render({ selectedInstanceId: reviewerInstanceId, onSelect });
    const none = [...view.querySelectorAll('[role="menuitemradio"]')].find(
      (node) => node.textContent === 'None'
    );
    await act(async () => {
      (none as HTMLElement).click();
    });
    // null, not "some other Role": it clears the name, not the configuration.
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  // The Role row turns into a create action instead of opening this submenu
  // when the machine has no Roles, so this list is never empty in production.
  it('renders nothing rather than an empty two-pane shell', async () => {
    const view = await render({ items: [] });
    expect(view.querySelector('[role="menuitemradio"]')).toBeNull();
  });

  it('offers making another Role from the list', async () => {
    const onCreate = vi.fn();
    const view = await render({ onCreate });
    const create = view.querySelector(
      '[aria-label="Create role from current settings"]'
    ) as HTMLElement | null;
    await act(async () => {
      (create as HTMLElement).click();
    });
    expect(onCreate).toHaveBeenCalled();
  });

  it('offers editing the Role whose configuration it is showing', async () => {
    const onEdit = vi.fn();
    const view = await render({ onEdit });
    const edit = [...view.querySelectorAll('button')].find((node) =>
      node.textContent?.includes('Edit role')
    );
    await act(async () => {
      (edit as HTMLElement).click();
    });
    expect(onEdit).toHaveBeenCalledWith('r-1');
  });

  it('keeps an unavailable Role listed, disabled, and says why', async () => {
    const onSelect = vi.fn();
    const view = await render({
      items: [
        {
          ...reviewer,
          availability: { kind: 'unavailable', reason: 'machine_offline' },
        },
      ],
      onSelect,
    });
    const row = [...view.querySelectorAll('[role="menuitemradio"]')].find((node) =>
      node.textContent?.includes('Code Reviewer')
    );
    expect(row).not.toBeUndefined();
    expect(row?.getAttribute('data-disabled')).not.toBeNull();
    // Unlike the Settings list there is no machine heading above these rows to
    // carry that status, so the reason has to be stated here.
    expect(view.textContent).toContain('its machine is offline');
    await act(async () => {
      (row as HTMLElement).click();
    });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('says it is still checking rather than claiming a Role is broken', async () => {
    const view = await render({
      items: [{ ...reviewer, availability: { kind: 'unknown' } }],
    });
    expect(view.textContent).toContain('Checking availability');
    expect(view.textContent).not.toContain('Unavailable');
  });

  it('puts agent and model on the Role row when the detail pane cannot fit', async () => {
    const view = await render({ compact: true, onEdit: () => undefined });
    const row = [...view.querySelectorAll('[role="menuitemradio"]')].find((node) =>
      node.textContent?.includes('Code Reviewer')
    );
    expect(row?.textContent).toContain('Code Reviewer');
    expect(row?.textContent).toContain('Codex');
    expect(row?.textContent).toContain('5.6-Sol');
    expect(view.textContent).not.toContain('Edit role');
    expect(view.textContent).not.toContain('Review the diff for correctness before style.');
  });

  it('detects a too-narrow popper and drops the detail pane without a compact prop', async () => {
    const innerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400 });
    try {
      const view = await render({ compact: undefined, onEdit: () => undefined });
      const row = [...view.querySelectorAll('[role="menuitemradio"]')].find((node) =>
        node.textContent?.includes('Code Reviewer')
      );
      expect(row?.textContent).toContain('Codex');
      expect(row?.textContent).toContain('5.6-Sol');
      expect(view.textContent).not.toContain('Edit role');
    } finally {
      if (innerWidth) Object.defineProperty(window, 'innerWidth', innerWidth);
      else delete (window as { innerWidth?: number }).innerWidth;
    }
  });

  it('still picks a Role from the compact two-line list', async () => {
    const onSelect = vi.fn();
    const view = await render({ compact: true, onSelect });
    const row = [...view.querySelectorAll('[role="menuitemradio"]')].find((node) =>
      node.textContent?.includes('Code Reviewer')
    );
    await act(async () => {
      (row as HTMLElement).click();
    });
    expect(onSelect).toHaveBeenCalledWith(reviewerInstanceId);
  });
});
