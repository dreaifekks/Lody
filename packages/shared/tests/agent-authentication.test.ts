import { describe, expect, it } from 'vitest';
import {
  hasBuiltinEnvAuthentication,
  hasBuiltinEnvAuthRouting,
  supportsAuthenticationWhenRequired,
  supportsBuiltinAuthentication,
  usesAcpProtocolAuthentication,
} from '../src/agent-authentication';
import { assertManagedCodexProfileConfig } from '../src/codex-auth-profile';

describe('hasBuiltinEnvAuthRouting', () => {
  it.each(['claude', 'codex', 'grok', 'kimi'])(
    'ignores unrelated and empty %s env',
    (agentType) => {
      expect(hasBuiltinEnvAuthRouting(agentType, undefined)).toBe(false);
      expect(hasBuiltinEnvAuthRouting(agentType, {})).toBe(false);
      expect(
        hasBuiltinEnvAuthRouting(agentType, {
          NMEM_AGENT_ID: 'lody',
          HTTP_PROXY: 'http://localhost:7890',
          HTTPS_PROXY: 'http://localhost:7890',
          ALL_PROXY: 'socks5://localhost:7890',
          NO_PROXY: 'localhost',
          NODE_OPTIONS: '--max-old-space-size=4096',
          TOOL_CONFIG: '/tmp/tools.json',
          ANTHROPIC_API_KEY: ' \t\n',
          OPENAI_API_KEY: '',
          CODEX_HOME: undefined,
          XAI_API_KEY: '  ',
          KIMI_API_KEY: '',
          MOONSHOT_BASE_URL: '\t',
        })
      ).toBe(false);
    }
  );

  it.each([
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_CUSTOM_HEADERS',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_BEDROCK_BASE_URL',
    'ANTHROPIC_VERTEX_BASE_URL',
    'ANTHROPIC_FOUNDRY_BASE_URL',
    'ANTHROPIC_FOUNDRY_RESOURCE',
    'ANTHROPIC_FOUNDRY_API_KEY',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'AWS_BEARER_TOKEN_BEDROCK',
    'ANTHROPIC_VERTEX_PROJECT_ID',
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
    'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
    'CLAUDE_CODE_SKIP_VERTEX_AUTH',
    'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  ])('detects Claude account/provider override %s only with a nonblank value', (key) => {
    expect(hasBuiltinEnvAuthRouting('claude', { [key]: 'override' })).toBe(true);
    expect(hasBuiltinEnvAuthRouting('claude', { [key]: ' \t' })).toBe(false);
  });

  it('keeps Claude model and cloud region settings eligible', () => {
    expect(
      hasBuiltinEnvAuthRouting('claude', {
        ANTHROPIC_MODEL: 'claude-sonnet',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku',
        ANTHROPIC_SMALL_FAST_MODEL: 'claude-haiku',
        CLAUDE_CODE_SUBAGENT_MODEL: 'claude-sonnet',
        CLOUD_ML_REGION: 'us-central1',
      })
    ).toBe(false);
  });

  it.each([
    'CODEX_HOME',
    'CODEX_CONFIG',
    'CODEX_ACCESS_TOKEN',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_IDENTITY_TOKEN_FILE',
    'LODY_CODEX_API_KEY',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'XDG_CONFIG_HOME',
    'MODEL_PROVIDER',
    'DEFAULT_AUTH_REQUEST',
    'openai_api_key',
  ])('detects Codex account/config override %s', (key) => {
    expect(hasBuiltinEnvAuthRouting('codex', { [key]: 'override' })).toBe(true);
    expect(hasBuiltinEnvAuthRouting('codex', { [key]: '' })).toBe(false);
  });

  it.each(['XAI_API_KEY', 'XAI_BASE_URL', 'GROK_HOME', 'GROK_API_KEY', 'GROK_BASE_URL'])(
    'detects Grok provider/store override %s',
    (key) => {
      expect(hasBuiltinEnvAuthRouting('grok', { [key]: 'override' })).toBe(true);
      expect(hasBuiltinEnvAuthRouting('grok', { [key]: '  ' })).toBe(false);
    }
  );

  it.each([
    'KIMI_API_KEY',
    'KIMI_BASE_URL',
    'KIMI_CODE_HOME',
    'KIMI_MODEL_API_KEY',
    'KIMI_MODEL_BASE_URL',
    'KIMI_MODEL_PROVIDER_TYPE',
    'MOONSHOT_API_KEY',
    'MOONSHOT_BASE_URL',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'GOOGLE_API_KEY',
    'GOOGLE_GEMINI_BASE_URL',
    'VERTEXAI_API_KEY',
    'GOOGLE_VERTEX_BASE_URL',
  ])('detects Kimi provider/store override %s', (key) => {
    expect(hasBuiltinEnvAuthRouting('kimi', { [key]: 'override' })).toBe(true);
    expect(hasBuiltinEnvAuthRouting('kimi', { [key]: ' \n' })).toBe(false);
  });

  it('ignores runtime maintenance and model tuning settings for Grok and Kimi', () => {
    expect(
      hasBuiltinEnvAuthRouting('grok', {
        GROK_PATH: '/tmp/grok',
        GROK_DISABLE_AUTOUPDATER: '1',
      })
    ).toBe(false);
    expect(
      hasBuiltinEnvAuthRouting('kimi', {
        KIMI_CODE_NO_AUTO_UPDATE: '1',
        KIMI_DISABLE_TELEMETRY: '1',
        KIMI_MODEL_TEMPERATURE: '0.5',
        KIMI_CODE_CACHE_DIR: '/tmp/kimi-cache',
      })
    ).toBe(false);
  });

  it('uses only the selected agent rules', () => {
    expect(hasBuiltinEnvAuthRouting('claude', { OPENAI_API_KEY: 'override' })).toBe(false);
    expect(hasBuiltinEnvAuthRouting('codex', { ANTHROPIC_API_KEY: 'override' })).toBe(false);
    expect(hasBuiltinEnvAuthRouting('grok', { KIMI_API_KEY: 'override' })).toBe(false);
    expect(hasBuiltinEnvAuthRouting('unknown', { OPENAI_API_KEY: 'override' })).toBe(false);
  });

  it('preserves the stricter Codex account-profile env boundary', () => {
    const config = {
      cliType: 'builtin',
      agentType: 'codex',
      codexAuth: { mode: 'chatgpt' as const, profileId: '00000000-0000-4000-8000-000000000001' },
    };
    for (const key of [
      'OPENAI_API_KEY',
      'CODEX_HOME',
      'HOME',
      'HTTP_PROXY',
      'NODE_OPTIONS',
      'DYLD_INSERT_LIBRARIES',
    ]) {
      expect(() => assertManagedCodexProfileConfig({ ...config, env: { [key]: '' } })).toThrow(
        'Additional environment variables cannot override a Codex account connection'
      );
    }
    expect(() =>
      assertManagedCodexProfileConfig({ ...config, env: { NMEM_AGENT_ID: 'lody' } })
    ).not.toThrow();
  });
});

describe('hasBuiltinEnvAuthentication', () => {
  it('detects Claude credentials and provider routing supplied by env', () => {
    expect(hasBuiltinEnvAuthentication('claude', { ANTHROPIC_API_KEY: 'sk-test' })).toBe(true);
    expect(hasBuiltinEnvAuthentication('claude', { ANTHROPIC_AUTH_TOKEN: 'sk-test' })).toBe(true);
    expect(
      hasBuiltinEnvAuthentication('claude', {
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      })
    ).toBe(true);
    expect(hasBuiltinEnvAuthentication('claude', { CLAUDE_CODE_USE_BEDROCK: '1' })).toBe(true);
  });

  it('ignores unrelated or blank variables', () => {
    expect(hasBuiltinEnvAuthentication('claude', undefined)).toBe(false);
    expect(hasBuiltinEnvAuthentication('claude', {})).toBe(false);
    expect(hasBuiltinEnvAuthentication('claude', { HTTPS_PROXY: 'http://127.0.0.1:7890' })).toBe(
      false
    );
    expect(hasBuiltinEnvAuthentication('claude', { ANTHROPIC_API_KEY: '  ' })).toBe(false);
    expect(hasBuiltinEnvAuthentication('claude', { ANTHROPIC_API_KEY: undefined })).toBe(false);
  });

  it('does not infer env authentication for agents that report it themselves', () => {
    // Codex custom model providers may set `requires_openai_auth = false`, so the
    // agent — not an env heuristic — decides whether sign-in is required.
    expect(hasBuiltinEnvAuthentication('codex', { OPENAI_API_KEY: 'sk-test' })).toBe(false);
    expect(hasBuiltinEnvAuthentication('kimi', { MOONSHOT_API_KEY: 'sk-test' })).toBe(false);
    expect(hasBuiltinEnvAuthentication('grok', { XAI_API_KEY: 'xai-test' })).toBe(false);
    expect(hasBuiltinEnvAuthentication('auggie', { ANTHROPIC_API_KEY: 'sk-test' })).toBe(false);
  });
});

describe('supportsBuiltinAuthentication', () => {
  it('allows sign-in for managed built-in agents without env credentials', () => {
    for (const agentType of ['claude', 'codex', 'kimi', 'grok']) {
      expect(supportsBuiltinAuthentication({ cliType: 'builtin', agentType, env: {} })).toBe(true);
    }
  });

  it('keeps sign-in available when env only carries unrelated variables', () => {
    expect(
      supportsBuiltinAuthentication({
        cliType: 'builtin',
        agentType: 'claude',
        env: { HTTPS_PROXY: 'http://127.0.0.1:7890' },
      })
    ).toBe(true);
  });

  it('refuses sign-in for preset providers configured through env variables', () => {
    // DeepSeek / MiniMax / MiMo / GLM presets all run as builtin Claude Code.
    expect(
      supportsBuiltinAuthentication({
        cliType: 'builtin',
        agentType: 'claude',
        brandId: 'deepseek',
        env: {
          ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
          ANTHROPIC_AUTH_TOKEN: 'sk-test',
        },
      })
    ).toBe(false);
    expect(
      supportsBuiltinAuthentication({
        cliType: 'builtin',
        agentType: 'claude',
        env: { ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic' },
      })
    ).toBe(false);
  });

  it('refuses sign-in when only the brand survives an env edit', () => {
    expect(
      supportsBuiltinAuthentication({ cliType: 'builtin', agentType: 'claude', brandId: 'mimo' })
    ).toBe(false);
  });

  it('refuses sign-in for hand-rolled endpoint overrides', () => {
    expect(
      supportsBuiltinAuthentication({
        cliType: 'builtin',
        agentType: 'claude',
        env: {
          ANTHROPIC_BASE_URL: 'http://localhost:11434',
          ANTHROPIC_AUTH_TOKEN: 'ollama',
        },
      })
    ).toBe(false);
  });

  it('refuses the builtin login flow for registry and custom providers', () => {
    expect(supportsBuiltinAuthentication({ cliType: 'registry', agentType: 'gemini' })).toBe(false);
    expect(supportsBuiltinAuthentication({ cliType: 'custom', agentType: 'my-agent' })).toBe(false);
    expect(supportsBuiltinAuthentication({ cliType: 'builtin', agentType: 'bub' })).toBe(false);
    expect(supportsBuiltinAuthentication({ cliType: 'builtin', agentType: 'auggie' })).toBe(false);
    expect(supportsBuiltinAuthentication({ cliType: undefined, agentType: undefined })).toBe(false);
  });
});

describe('usesAcpProtocolAuthentication', () => {
  it('covers exactly the third-party ACP providers', () => {
    expect(usesAcpProtocolAuthentication('registry')).toBe(true);
    expect(usesAcpProtocolAuthentication('custom')).toBe(true);
    expect(usesAcpProtocolAuthentication('builtin')).toBe(false);
    expect(usesAcpProtocolAuthentication('builtin', 'devin')).toBe(true);
    expect(supportsBuiltinAuthentication({ cliType: 'builtin', agentType: 'devin' })).toBe(false);
    expect(usesAcpProtocolAuthentication(undefined)).toBe(false);
  });
});

describe('supportsAuthenticationWhenRequired', () => {
  it('offers the ACP exchange to registry and custom agents', () => {
    // The whole point: a registry agent reporting auth-required used to have no
    // way to sign in at all.
    expect(
      supportsAuthenticationWhenRequired({ cliType: 'registry', agentType: 'antigravity-acp' })
    ).toBe(true);
    expect(supportsAuthenticationWhenRequired({ cliType: 'custom', agentType: 'my-agent' })).toBe(
      true
    );
  });

  it('keeps the managed builtin login flow and excludes providers with neither', () => {
    expect(supportsAuthenticationWhenRequired({ cliType: 'builtin', agentType: 'codex' })).toBe(
      true
    );
    // DeepSeek Harness authenticates purely through env vars.
    expect(supportsAuthenticationWhenRequired({ cliType: 'builtin', agentType: 'deepseek' })).toBe(
      false
    );
    expect(supportsAuthenticationWhenRequired({ cliType: undefined, agentType: undefined })).toBe(
      false
    );
  });
});
