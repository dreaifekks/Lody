/**
 * Which provider configs can use a built-in agent's interactive sign-in flow.
 *
 * Only the managed built-in agents (Claude Code / Codex / Kimi Code / Grok) have one.
 * A config that carries its own credentials in `env` — every preset such as
 * DeepSeek, MiniMax, MiMo, or GLM, plus hand-rolled configs pointed at an
 * OpenRouter/Ollama-style endpoint — authenticates through those variables
 * instead, so the provider's login flow can neither be started usefully nor
 * change anything about that config.
 */
import { isManagedBuiltinAgentType, type AgentConfigCliType } from './ai';
import { isAgentBrandId, type AgentBrandId } from './agent-brand';
import { isCodexAuthRoutingEnvKey } from './codex-auth-profile';

/**
 * Env vars that supply credentials directly or route Claude through a
 * separately authenticated provider. Claude's native credential-store status
 * command does not reliably represent those paths, so the ACP adapter stays the
 * source of truth whenever one of them is configured.
 *
 * Codex, Kimi, and Grok have no equivalent list: their authentication requirement
 * is reported by the agent itself (Codex custom model providers may set
 * `requires_openai_auth = false`), never inferred from environment variables.
 */
const CLAUDE_ENV_AUTH_KEYS = [
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
] as const;

/** True when `env` already authenticates the built-in agent by itself. */
export const hasBuiltinEnvAuthentication = (
  agentType: string,
  env: Record<string, string | undefined> | undefined
): boolean =>
  agentType === 'claude' && CLAUDE_ENV_AUTH_KEYS.some((key) => Boolean(env?.[key]?.trim()));

// These can change Claude's account/provider without supplying API credentials.
// Model selectors and cloud region settings alone do not change account identity.
const CLAUDE_ACCOUNT_ROUTING_ENV_KEYS = new Set([
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
]);

// Kimi's provider endpoint definitions and env-model configuration, plus its
// credential-store location. Do not match every KIMI_ tool/update setting.
const KIMI_AUTH_ROUTING_ENV_KEYS = new Set([
  'KIMI_API_KEY',
  'KIMI_BASE_URL',
  'KIMI_CODE_HOME',
  'KIMI_MODEL_API_KEY',
  'KIMI_MODEL_BASE_URL',
  'KIMI_MODEL_PROVIDER_TYPE',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'GOOGLE_API_KEY',
  'GOOGLE_GEMINI_BASE_URL',
  'VERTEXAI_API_KEY',
  'GOOGLE_VERTEX_BASE_URL',
]);

/**
 * Whether explicit env overrides make a built-in subscription quota unsuitable
 * for display. This is not a sign-in requirement probe; agents still report that.
 * Empty values and unrelated transport/tool settings do not change eligibility.
 */
export function hasBuiltinEnvAuthRouting(
  agentType: string,
  env: Record<string, string | undefined> | undefined
): boolean {
  if (hasBuiltinEnvAuthentication(agentType, env)) return true;
  return Object.entries(env ?? {}).some(([key, value]) => {
    if (value === undefined || value.trim() === '') return false;
    switch (agentType) {
      case 'claude':
        return CLAUDE_ACCOUNT_ROUTING_ENV_KEYS.has(key);
      case 'codex':
        return isCodexAuthRoutingEnvKey(key);
      case 'grok':
        // The adapter delegates auth to the official runtime. XAI_ is a
        // conservative provider namespace; GROK_HOME selects its local store.
        return /^XAI_/i.test(key) || ['GROK_HOME', 'GROK_API_KEY', 'GROK_BASE_URL'].includes(key);
      case 'kimi':
        // MOONSHOT_ is a conservative legacy-provider namespace: the pinned
        // Kimi runtime exposes the explicit keys above rather than that prefix.
        return KIMI_AUTH_ROUTING_ENV_KEYS.has(key) || /^MOONSHOT_/i.test(key);
      default:
        return false;
    }
  });
}

/**
 * True when the provider config can run (and re-run) the built-in interactive
 * sign-in flow. Callers use it to decide whether to offer a sign-in action at
 * all; a live probe reporting `authRequired` is a separate, stronger signal.
 */
export const supportsBuiltinAuthentication = (input: {
  cliType: AgentConfigCliType | null | undefined;
  agentType: string | null | undefined;
  brandId?: AgentBrandId | undefined;
  env?: Record<string, string | undefined> | undefined;
}): boolean => {
  if (input.cliType !== 'builtin') return false;
  const agentType = input.agentType;
  if (agentType === 'pi' || agentType === 'devin') return false;
  if (!agentType || !isManagedBuiltinAgentType(agentType)) return false;
  if (hasBuiltinEnvAuthentication(agentType, input.env)) return false;
  // A persisted brand marks a preset routed through a third-party provider even
  // when its env vars have since been edited away. Only the persisted marker is
  // consulted: a brand inferred from `ANTHROPIC_BASE_URL` is already covered by
  // the env check above for Claude, and means nothing on Codex, Kimi, or Grok.
  return !isAgentBrandId(input.brandId);
};

/**
 * True when the config uses agent-driven authentication (registry, custom, or
 * builtin Devin), which authenticates
 * through the standard ACP `initialize` → `authenticate` exchange. The methods
 * are advertised by the agent itself, so support cannot be known for certain
 * until it is asked — callers pair this with a live `authRequired` signal rather
 * than offering a sign-in nothing asked for.
 */
export const usesAcpProtocolAuthentication = (
  cliType: AgentConfigCliType | null | undefined,
  agentType?: string | null
): boolean =>
  cliType === 'registry' ||
  cliType === 'custom' ||
  (cliType === 'builtin' && agentType === 'devin');

/**
 * True when Lody has any sign-in flow to offer for this config after the agent
 * reported that authentication is required.
 */
export const supportsAuthenticationWhenRequired = (input: {
  cliType: AgentConfigCliType | null | undefined;
  agentType: string | null | undefined;
}): boolean =>
  usesAcpProtocolAuthentication(input.cliType, input.agentType) ||
  (input.cliType === 'builtin' &&
    !!input.agentType &&
    input.agentType !== 'pi' &&
    isManagedBuiltinAgentType(input.agentType));
