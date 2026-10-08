import { describe, expect, it } from 'vitest';
import {
  getStaticBuiltinAcpCapabilities,
  isPermissionTierWithin,
  permissionOptionIdsOf,
  resolvePermissionTier,
  type PermissionTierRunConfig,
} from '../src';

const builtin = (agentType: string) => ({ cliType: 'builtin' as const, agentType });
const tierOf = (
  agentType: string,
  runConfig: PermissionTierRunConfig,
  permissionOptionIds: readonly string[] | undefined = []
) => resolvePermissionTier({ runConfig, agent: builtin(agentType), permissionOptionIds });

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

  it('takes the highest of the mode and every permission option', () => {
    const grok = getStaticBuiltinAcpCapabilities('builtin', 'grok')!;
    const ids = permissionOptionIdsOf(grok.configOptions);
    expect(ids).toContain('permission_mode');
    expect(
      tierOf('grok', { modeId: 'default', configOptionValues: { permission_mode: 'ask' } }, ids)
    ).toBe('ask');
    expect(
      tierOf(
        'grok',
        { modeId: 'default', configOptionValues: { permission_mode: 'always-approve' } },
        ids
      )
    ).toBe('full');
    // A capability may name its own permission option.
    expect(
      tierOf('custom', { modeId: 'default', configOptionValues: { approvals: 'yolo' } }, [
        'approvals',
      ])
    ).toBe('full');
  });

  it('falls back to what dispatch would run, and to unknown where Lody cannot tell', () => {
    expect(tierOf('claude', {})).toBe('auto');
    expect(tierOf('codex', {})).toBe('auto');
    expect(tierOf('deepseek', {})).toBe('edit');
    // Pi has no permission control: every tool call runs without asking.
    expect(tierOf('pi', {})).toBe('full');
    expect(tierOf('antigravity-acp', {})).toBe('unknown');
    expect(tierOf('claude', { modeId: 'constructor' })).toBe('unknown');
    // Without a capability, any other option could be a permission control.
    expect(
      resolvePermissionTier({
        runConfig: { modeId: 'default', configOptionValues: { effort: 'high' } },
        agent: builtin('claude'),
        permissionOptionIds: undefined,
      })
    ).toBe('unknown');
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
  });
});
