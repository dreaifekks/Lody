import type { SessionUsageUpdate } from 'acp-extension-core';
import type { BuiltinAgentType } from '@lody/shared';
// https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json

export type Price = {
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheReadInputTokenCost: number;
};

export const PRICE_DATA: { [key: string]: Price } = {
  'gpt-6-astra': {
    inputCostPerToken: 1e-5,
    cacheReadInputTokenCost: 1e-6,
    outputCostPerToken: 5e-5,
  },
  'gpt-6.1-sol': {
    inputCostPerToken: 2e-6,
    cacheReadInputTokenCost: 1e-7,
    outputCostPerToken: 1e-5,
  },
  'gpt-6-sol': {
    inputCostPerToken: 2e-6,
    cacheReadInputTokenCost: 2e-7,
    outputCostPerToken: 1e-5,
  },
  'gpt-6-luna': {
    inputCostPerToken: 1e-7,
    cacheReadInputTokenCost: 1e-8,
    outputCostPerToken: 5e-7,
  },
  'gpt-5.6': {
    inputCostPerToken: 5e-6,
    cacheReadInputTokenCost: 5e-7,
    outputCostPerToken: 3e-5,
  },
  'gpt-5.6-sol': {
    inputCostPerToken: 5e-6,
    cacheReadInputTokenCost: 5e-7,
    outputCostPerToken: 3e-5,
  },
  'gpt-5.6-terra': {
    inputCostPerToken: 2.5e-6,
    cacheReadInputTokenCost: 2.5e-7,
    outputCostPerToken: 1.5e-5,
  },
  'gpt-5.6-luna': {
    inputCostPerToken: 1e-6,
    cacheReadInputTokenCost: 1e-7,
    outputCostPerToken: 6e-6,
  },
  'gpt-5.5': {
    inputCostPerToken: 5e-6,
    cacheReadInputTokenCost: 5e-7,
    outputCostPerToken: 3e-5,
  },
  'gpt-5.4': {
    inputCostPerToken: 2.5e-6,
    cacheReadInputTokenCost: 2.5e-7,
    outputCostPerToken: 1.5e-5,
  },
  'gpt-5.3-codex-spark': {
    inputCostPerToken: 1.75e-6,
    cacheReadInputTokenCost: 1.75e-7,
    outputCostPerToken: 1.4e-5,
  },
  'gpt-5.3-codex': {
    inputCostPerToken: 1.75e-6,
    cacheReadInputTokenCost: 1.75e-7,
    outputCostPerToken: 1.4e-5,
  },
  'gpt-5.2-codex': {
    inputCostPerToken: 1.75e-6,
    cacheReadInputTokenCost: 1.75e-7,
    outputCostPerToken: 1.4e-5,
  },
  'gpt-5.1-codex': {
    inputCostPerToken: 1.25e-6,
    cacheReadInputTokenCost: 1.25e-7,
    outputCostPerToken: 1e-5,
  },
  'gpt-5.1-codex-max': {
    inputCostPerToken: 1.25e-6,
    cacheReadInputTokenCost: 1.25e-7,
    outputCostPerToken: 1e-5,
  },
  'gpt-5.1-codex-mini': {
    inputCostPerToken: 2.5e-7,
    cacheReadInputTokenCost: 2.5e-8,
    outputCostPerToken: 2e-6,
  },
  'gpt-5.2': {
    inputCostPerToken: 1.75e-6,
    cacheReadInputTokenCost: 1.75e-7,
    outputCostPerToken: 1.4e-5,
  },
  // https://www.kimi.com/resources/kimi-k2-7-code-pricing
  'kimi-for-coding': {
    inputCostPerToken: 0.95e-6,
    cacheReadInputTokenCost: 0.19e-6,
    outputCostPerToken: 4e-6,
  },
  'kimi-for-coding-highspeed': {
    inputCostPerToken: 0.95e-6,
    cacheReadInputTokenCost: 0.19e-6,
    outputCostPerToken: 8e-6,
  },
};

const cloneModelUsage = (
  modelUsage: SessionUsageUpdate['modelUsage']
): SessionUsageUpdate['modelUsage'] => {
  if (!modelUsage) return undefined;
  const cloned: NonNullable<SessionUsageUpdate['modelUsage']> = {};
  for (const [model, usage] of Object.entries(modelUsage)) {
    cloned[model] = { ...usage };
  }
  return cloned;
};

export const cloneUsageUpdate = (update: SessionUsageUpdate): SessionUsageUpdate => ({
  sessionId: update.sessionId,
  usage: { ...update.usage },
  ...(update.modelUsage ? { modelUsage: cloneModelUsage(update.modelUsage) } : {}),
  ...(update.delta
    ? {
        delta: {
          usage: { ...update.delta.usage },
          modelUsage: cloneModelUsage(update.delta.modelUsage) ?? {},
        },
      }
    : {}),
});

/**
 * Fills in the cost of the models whose agent reports none, from the price
 * table. Claude reports its own; an unknown tariff stays unknown.
 */
export function priceSessionUsageUpdate(
  update: SessionUsageUpdate,
  cliType: BuiltinAgentType,
  onUnknownModel?: (model: string) => void
): SessionUsageUpdate {
  switch (cliType) {
    case 'claude':
      return update;
    case 'codex':
    case 'kimi':
      if (!update.modelUsage) return update;
      for (const [model, usage] of Object.entries(update.modelUsage)) {
        if (usage.costUSD !== undefined) continue;
        // No cache-write tariff is known in this legacy price table. A read
        // tariff is not a substitute; preserve unknown rather than underprice.
        if ((usage.cacheCreationInputTokens ?? 0) > 0) continue;
        let costUSD = 0;
        const modelName = model.split('/')[0];
        if (!modelName) continue;
        const price = PRICE_DATA[modelName];
        if (!price) {
          onUnknownModel?.(modelName);
          continue;
        }
        costUSD += usage.inputTokens * price.inputCostPerToken;
        costUSD +=
          (usage.outputTokens + (usage.reasoningOutputTokens || 0)) * price.outputCostPerToken;
        costUSD +=
          (usage.cacheReadInputTokens + (usage.cacheCreationInputTokens || 0)) *
          price.cacheReadInputTokenCost;
        usage.costUSD = costUSD;
      }
      return update;
    default:
      return update;
  }
}
