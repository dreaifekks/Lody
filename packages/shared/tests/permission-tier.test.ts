import { describe, expect, it } from 'vitest';
import {
  getStaticBuiltinAcpCapabilities,
  higherPermissionTier,
  isPermissionTierWithin,
  lowerPermissionTier,
  resolvePermissionTier,
  type PermissionTierCapability,
  type PermissionTierRunConfig,
} from '../src';

const builtin = (agentType: string) => ({ cliType: 'builtin' as const, agentType });
/** A capability with only a mode option: no permission control beside it. */
const modeOnly: PermissionTierCapability = { configOptions: [{ id: 'mode', category: 'mode' }] };
const tierOf = (
  agentType: string,
  runConfig: PermissionTierRunConfig,
  capability: PermissionTierCapability | undefined = modeOnly
) => resolvePermissionTier({ runConfig, agent: builtin(agentType), capability });

describe('permission tiers', () => {
  it('ranks every advertised mode of the built-in and registry providers', () => {
    const expected = {
      claude: {
        default: 'ask',
        plan: 'ask',
        dontAsk: 'ask',
        acceptEdits: 'edit',
        auto: 'auto',
        bypassPermissions: 'full',
      },
      codex: {
        'read-only': 'ask',
        agent: 'edit',
        'agent-auto-review': 'auto',
        'agent-full-access': 'full',
      },
      deepseek: { 'read-only': 'ask', 'workspace-write': 'edit', 'danger-full-access': 'full' },
      kimi: { default: 'ask', plan: 'ask', auto: 'auto', yolo: 'full' },
      'antigravity-acp': { default: 'ask', auto_edit: 'edit', yolo: 'full' },
    };
    for (const [agentType, modes] of Object.entries(expected))
      for (const [modeId, tier] of Object.entries(modes))
        expect([agentType, modeId, tierOf(agentType, { modeId })]).toEqual([
          agentType,
          modeId,
          tier,
        ]);
    // Every mode the static catalogs list is classified.
    for (const agentType of ['claude', 'codex', 'deepseek', 'kimi', 'grok'])
      for (const mode of getStaticBuiltinAcpCapabilities('builtin', agentType)?.modes ?? [])
        expect(tierOf(agentType, { modeId: mode.id })).not.toBe('unknown');
  });

  it('takes the highest selection and needs every permission option beside the mode set', () => {
    const grok = getStaticBuiltinAcpCapabilities('builtin', 'grok')!;
    // A reused session keeps the permission option a run leaves unset.
    expect(tierOf('grok', { modeId: 'default' }, grok)).toBe('unknown');
    expect(
      tierOf('grok', { modeId: 'default', configOptionValues: { permission_mode: 'ask' } }, grok)
    ).toBe('ask');
    expect(
      tierOf(
        'grok',
        { modeId: 'default', configOptionValues: { permission_mode: 'always-approve' } },
        grok
      )
    ).toBe('full');
    // A capability may name its own permission option.
    expect(
      tierOf(
        'custom',
        { modeId: 'default', configOptionValues: { approvals: 'yolo' } },
        { configOptions: [{ id: 'approvals', category: '_permission' }] }
      )
    ).toBe('full');
  });

  it('is unknown where Lody cannot tell what runs', () => {
    // No selection: the provider's own default (callers apply Lody's builtin default first).
    expect(tierOf('claude', {})).toBe('unknown');
    // No capability: nothing is known about the Agent's controls.
    expect(
      resolvePermissionTier({
        runConfig: { modeId: 'default' },
        agent: builtin('claude'),
        capability: undefined,
      })
    ).toBe('unknown');
    expect(tierOf('claude', { modeId: 'constructor' })).toBe('unknown');
    // Pi has no permission control: every tool call runs without asking.
    expect(
      resolvePermissionTier({ runConfig: {}, agent: builtin('pi'), capability: undefined })
    ).toBe('full');
    expect(tierOf('claude', { modeId: 'default', configOptionValues: { effort: 'high' } })).toBe(
      'ask'
    );
  });

  it('keeps unknown targets out and treats an unknown ceiling as the lowest', () => {
    expect(isPermissionTierWithin('edit', 'auto')).toBe(true);
    expect(isPermissionTierWithin('auto', 'auto')).toBe(true);
    expect(isPermissionTierWithin('full', 'auto')).toBe(false);
    expect(isPermissionTierWithin('unknown', 'full')).toBe(false);
    expect(isPermissionTierWithin('ask', 'unknown')).toBe(true);
    expect(isPermissionTierWithin('edit', 'unknown')).toBe(false);
    expect(lowerPermissionTier('auto', 'ask')).toBe('ask');
    expect(lowerPermissionTier('auto', 'unknown')).toBe('unknown');
    expect(higherPermissionTier('edit', 'full')).toBe('full');
    expect(higherPermissionTier('edit', 'unknown')).toBe('unknown');
  });
});
