import { z } from 'zod';
import {
  leastPermissionModeRank,
  reasoningEffortRank,
  type AcpConfigOptionSummary,
  type AcpConfigOptionValue,
  type AcpConfigOptionValueSummary,
  type AgentConfigCliType,
  type AgentType,
} from './ai';

export const SESSION_BTW_MAX_PATH_CHARS = 512;
export const SESSION_BTW_MAX_SELECTION_CHARS = 4_000;
export const SESSION_BTW_MAX_EXCERPT_CHARS = 12_000;
export const SESSION_BTW_MAX_QUESTION_CHARS = 8_000;
export const SESSION_BTW_MAX_PRIOR_TURNS = 12;
export const SESSION_BTW_MAX_PRIOR_TURN_TEXT_CHARS = 4_000;

export const SessionBtwArticleContextSchema = z
  .object({
    path: z.string().trim().min(1).max(SESSION_BTW_MAX_PATH_CHARS),
    selection: z.string().max(SESSION_BTW_MAX_SELECTION_CHARS).optional(),
    excerpt: z.string().max(SESSION_BTW_MAX_EXCERPT_CHARS).optional(),
    truncated: z.boolean().optional(),
  })
  .strict();

export type SessionBtwArticleContext = z.infer<typeof SessionBtwArticleContextSchema>;

export const SessionBtwPriorTurnSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    text: z.string().max(SESSION_BTW_MAX_PRIOR_TURN_TEXT_CHARS),
  })
  .strict();

export type SessionBtwPriorTurn = z.infer<typeof SessionBtwPriorTurnSchema>;

export const SessionBtwActionSchema = z.enum(['ask', 'cancel', 'close']);

export type SessionBtwAction = z.infer<typeof SessionBtwActionSchema>;

export const SessionBtwRequestSchema = z
  .object({
    action: SessionBtwActionSchema,
    sessionId: z.string().trim().min(1).max(512),
    btwId: z.string().trim().min(1).max(512),
    question: z.string().max(SESSION_BTW_MAX_QUESTION_CHARS).optional(),
    articleContext: SessionBtwArticleContextSchema.optional(),
    readOnlyTools: z.boolean().optional(),
    priorTurns: z.array(SessionBtwPriorTurnSchema).max(SESSION_BTW_MAX_PRIOR_TURNS).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.action === 'ask' && (!value.question || value.question.trim().length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['question'],
        message: 'question is required when action is "ask"',
      });
    }
  });

export type SessionBtwRequest = z.infer<typeof SessionBtwRequestSchema>;

export const SessionBtwProgressSchema = z
  .object({
    btwId: z.string().trim().min(1).max(512),
    kind: z.enum(['status', 'delta']),
    status: z.enum(['starting', 'streaming']).optional(),
    delta: z.string().optional(),
    modelId: z.string().optional(),
    modelLabel: z.string().optional(),
  })
  .strict();

export type SessionBtwProgress = z.infer<typeof SessionBtwProgressSchema>;

export const SessionBtwResponseSchema = z
  .object({
    btwId: z.string().trim().min(1).max(512),
    text: z.string(),
    cancelled: z.boolean().optional(),
    modelId: z.string().optional(),
    modelLabel: z.string().optional(),
    readOnlyTools: z.boolean().optional(),
    error: z.string().optional(),
  })
  .strict();

export type SessionBtwResponse = z.infer<typeof SessionBtwResponseSchema>;

export type BtwLegacyModelOption = {
  readonly modelId: string;
  readonly name?: string | null;
  readonly description?: string | null;
};

export type PickBtwFastConfigOptionsInput = {
  readonly cliType: AgentConfigCliType;
  readonly agentType: AgentType;
  readonly configOptions?: readonly AcpConfigOptionSummary[] | null;
  readonly legacyModels?: {
    readonly currentModelId?: string | null;
    readonly availableModels: readonly BtwLegacyModelOption[];
  } | null;
};

export type BtwFastConfigSelection = {
  /** Config option values to apply (sorted by callers so model switches land first). */
  readonly configOptionValues: Record<string, AcpConfigOptionValue>;
  /** Effective model id after applying the fast selection (or current model if kept). */
  readonly modelId?: string;
  /** Compact UI pill label, e.g. `Hydrogen · Low`, `Haiku · Low`, `Luna · Low`. */
  readonly modelLabel?: string;
  /** Selected thought/reasoning effort value, if any. */
  readonly effortValue?: string;
  /** Selected permission/plan mode value, if any. */
  readonly modeValue?: string;
};

type BtwProviderFamily = 'antigravity' | 'claude' | 'codex' | 'other';

const resolveBtwProviderFamily = (agentType: string): BtwProviderFamily => {
  const normalized = agentType.trim().toLowerCase();
  if (normalized === 'antigravity' || normalized === 'antigravity-acp') {
    return 'antigravity';
  }
  if (normalized === 'claude' || /^claude(?:[-_]|$)/.test(normalized)) {
    return 'claude';
  }
  if (normalized === 'codex' || /^codex(?:[-_]|$)/.test(normalized)) {
    return 'codex';
  }
  return 'other';
};

const isLegacyCandidate = (option: AcpConfigOptionValueSummary): boolean =>
  /\b(?:legacy|deprecated)\b/i.test(
    `${option.group ?? ''} ${option.name} ${option.description ?? ''}`
  );

const antigravityModelRank = (option: AcpConfigOptionValueSummary): number => {
  const value = option.value.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  const legacy = isLegacyCandidate(option);
  if (!legacy && value === 'gemini-4-hydrogen') return 0;
  if (!legacy && value.startsWith('gemini-4-hydrogen')) return 1;
  if (!legacy && value === 'gemini-3.8-flash') return 2;
  if (!legacy && value.startsWith('gemini-3.8-flash')) return 3;
  if (!legacy && (value.includes('hydrogen') || name.includes('hydrogen'))) return 4;
  if (!legacy && (value.includes('flash') || name.includes('flash'))) return 5;
  if (value.includes('hydrogen') || name.includes('hydrogen')) return 6;
  if (value.includes('flash') || name.includes('flash')) return 7;
  return Number.POSITIVE_INFINITY;
};

const claudeModelRank = (option: AcpConfigOptionValueSummary): number => {
  const value = option.value.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  const legacy = isLegacyCandidate(option);
  if (!legacy && value === 'haiku') return 0;
  if (!legacy && /^haiku(?:$|[\s[._-])/.test(value)) return 1;
  if (!legacy && value.startsWith('claude-haiku-')) return 2;
  if (!legacy && (value.includes('haiku') || name.includes('haiku'))) return 3;
  if (!legacy && (value === 'sonnet' || /^sonnet(?:$|[\s[._-])/.test(value))) return 4;
  if (!legacy && (value.includes('sonnet') || name.includes('sonnet'))) return 5;
  if (value.includes('haiku') || name.includes('haiku')) return 6;
  if (value.includes('sonnet') || name.includes('sonnet')) return 7;
  return Number.POSITIVE_INFINITY;
};

const codexModelRank = (option: AcpConfigOptionValueSummary): number => {
  const value = option.value.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  const legacy = isLegacyCandidate(option);
  const has56 = value.includes('5.6') || name.includes('5.6');
  const hasLuna = value.includes('luna') || name.includes('luna');
  const hasMini = value.includes('mini') || name.includes('mini');
  if (!legacy && value === 'gpt-6-luna') return 0;
  if (!legacy && /^gpt-6-luna(?:$|[\s[._-])/.test(value)) return 1;
  if (!legacy && hasLuna && !has56) return 2;
  if (!legacy && value === 'gpt-6.2-sol') return 3;
  if (!legacy && /^gpt-6\.2-sol(?:$|[\s[._-])/.test(value)) return 4;
  if (!legacy && hasMini) return 5;
  if (!legacy && /\b(?:fast|flash|nano|spark)\b/i.test(`${value} ${name}`)) return 6;
  if (hasLuna && !has56) return 7;
  if (hasMini) return 8;
  if (hasLuna) return 9;
  return Number.POSITIVE_INFINITY;
};

const pickLowestRankedOption = (
  options: readonly AcpConfigOptionValueSummary[],
  rank: (option: AcpConfigOptionValueSummary) => number
): AcpConfigOptionValueSummary | undefined => {
  let best: AcpConfigOptionValueSummary | undefined;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const option of options) {
    const score = rank(option);
    if (score < bestRank) {
      best = option;
      bestRank = score;
    }
  }
  return best;
};

const pickBtwModeOption = (
  family: BtwProviderFamily,
  options: readonly AcpConfigOptionValueSummary[]
): AcpConfigOptionValueSummary | undefined => {
  if (family === 'antigravity') {
    const plan = options.find((opt) => opt.value.trim().toLowerCase() === 'plan');
    if (plan) return plan;
    return pickLowestRankedOption(options, (opt) => leastPermissionModeRank(opt.value, opt.name));
  }
  if (family === 'claude') {
    const plan = options.find((opt) => opt.value.trim().toLowerCase() === 'plan');
    if (plan) return plan;
    const dontAsk = options.find((opt) => opt.value.trim().toLowerCase() === 'dontask');
    if (dontAsk) return dontAsk;
    return pickLowestRankedOption(options, (opt) => leastPermissionModeRank(opt.value, opt.name));
  }
  if (family === 'codex') {
    const readOnly = options.find((opt) => {
      const normalized = opt.value
        .trim()
        .toLowerCase()
        .replace(/[\s_]+/g, '-');
      return normalized === 'read-only' || normalized === 'readonly';
    });
    if (readOnly) return readOnly;
    return pickLowestRankedOption(options, (opt) => leastPermissionModeRank(opt.value, opt.name));
  }
  return pickLowestRankedOption(options, (opt) => leastPermissionModeRank(opt.value, opt.name));
};

const isExactLowEffort = (option: AcpConfigOptionValueSummary): boolean => {
  const value = option.value.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return value === 'low' || name === 'low';
};

const pickBtwEffortOption = (
  family: BtwProviderFamily,
  options: readonly AcpConfigOptionValueSummary[]
): AcpConfigOptionValueSummary | undefined => {
  if (family === 'antigravity' || family === 'claude' || family === 'codex') {
    const exactLow = options.find(isExactLowEffort);
    if (exactLow) return exactLow;
  }
  return pickLowestRankedOption(options, (opt) => {
    const rank = reasoningEffortRank(opt.value, opt.name);
    return rank < 50 ? rank : Number.POSITIVE_INFINITY;
  });
};

const isThoughtOption = (opt: AcpConfigOptionSummary): boolean => {
  if (opt.type !== 'select') return false;
  if (opt.category === 'thought_level') return true;
  const id = opt.id.trim().toLowerCase();
  return id === 'thought_level' || id === 'reasoning_effort' || id === 'effort';
};

const isModeOption = (opt: AcpConfigOptionSummary): boolean => {
  if (opt.type !== 'select') return false;
  if (opt.category === 'mode' || opt.category === '_permission') return true;
  return opt.id.trim().toLowerCase() === 'mode';
};

const isModelOption = (opt: AcpConfigOptionSummary): boolean =>
  opt.type === 'select' && (opt.category === 'model' || opt.id.trim().toLowerCase() === 'model');

const formatShortModelName = (modelId: string, modelName?: string): string => {
  const combined = `${modelId} ${modelName ?? ''}`;
  if (/\bhydrogen\b/i.test(combined)) return 'Hydrogen';
  if (/\bflash\b/i.test(combined)) return 'Flash';
  if (/\bhaiku\b/i.test(combined)) return 'Haiku';
  if (/\bsonnet\b/i.test(combined)) return 'Sonnet';
  if (/\bopus\b/i.test(combined)) return 'Opus';
  if (/\bluna\b/i.test(combined)) return 'Luna';
  if (/\bsol\b/i.test(combined)) return 'Sol';
  const raw = (modelName?.trim() || modelId.trim()).replace(/\s*\([^)]*\)\s*$/g, '').trim();
  return raw || modelId.trim();
};

const formatEffortLabel = (option: AcpConfigOptionValueSummary | undefined): string | undefined => {
  if (!option) return undefined;
  const value = option.value.trim().toLowerCase();
  if (!value || value === 'default') return undefined;
  const trimmedName = option.name.trim();
  if (trimmedName && trimmedName.length <= 16) {
    return trimmedName;
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
};

export const formatBtwModelLabel = (
  modelId: string | undefined,
  modelName: string | undefined,
  effortOption?: AcpConfigOptionValueSummary
): string | undefined => {
  if (!modelId) return undefined;
  const shortModel = formatShortModelName(modelId, modelName);
  const effort = formatEffortLabel(effortOption);
  return effort ? `${shortModel} · ${effort}` : shortModel;
};

/**
 * Dynamically selects fast model, low reasoning/thought effort, and least-permission
 * mode for lightweight `/btw` side-questions from live ACP `configOptions` / `legacyModels`.
 */
export function pickBtwFastConfigOptions(
  input: PickBtwFastConfigOptionsInput
): BtwFastConfigSelection {
  const family = resolveBtwProviderFamily(input.agentType);
  const configOptions = input.configOptions ?? [];
  const configOptionValues: Record<string, AcpConfigOptionValue> = {};

  let selectedModel: AcpConfigOptionValueSummary | undefined;
  const modelOpt = configOptions.find(isModelOption);
  const modelCandidates: readonly AcpConfigOptionValueSummary[] = modelOpt
    ? modelOpt.options
    : (input.legacyModels?.availableModels ?? []).map((model) => ({
        value: model.modelId,
        name: model.name?.trim() || model.modelId,
        description: model.description ?? undefined,
      }));
  const currentModelValue = modelOpt
    ? typeof modelOpt.currentValue === 'string'
      ? modelOpt.currentValue
      : undefined
    : (input.legacyModels?.currentModelId ?? undefined);

  if (modelCandidates.length > 0) {
    const rankFn =
      family === 'antigravity'
        ? antigravityModelRank
        : family === 'claude'
          ? claudeModelRank
          : family === 'codex'
            ? codexModelRank
            : undefined;
    if (rankFn) {
      selectedModel = pickLowestRankedOption(modelCandidates, rankFn);
      if (selectedModel) {
        configOptionValues[modelOpt?.id ?? 'model'] = selectedModel.value;
      }
    }
    if (!selectedModel && currentModelValue) {
      selectedModel = modelCandidates.find((opt) => opt.value === currentModelValue) ?? {
        value: currentModelValue,
        name: currentModelValue,
      };
    }
  } else if (currentModelValue) {
    selectedModel = { value: currentModelValue, name: currentModelValue };
  }

  let selectedEffort: AcpConfigOptionValueSummary | undefined;
  let selectedMode: AcpConfigOptionValueSummary | undefined;

  for (const opt of configOptions) {
    if (opt.type === 'boolean' && opt.id === 'plan_mode') {
      configOptionValues[opt.id] = true;
      continue;
    }
    if (isModeOption(opt)) {
      const pickedMode = pickBtwModeOption(family, opt.options);
      if (pickedMode) {
        configOptionValues[opt.id] = pickedMode.value;
        selectedMode ??= pickedMode;
      }
      continue;
    }
    if (isThoughtOption(opt)) {
      const pickedEffort = pickBtwEffortOption(family, opt.options);
      if (pickedEffort) {
        configOptionValues[opt.id] = pickedEffort.value;
        selectedEffort ??= pickedEffort;
      } else if (typeof opt.currentValue === 'string') {
        selectedEffort ??= opt.options.find((entry) => entry.value === opt.currentValue);
      }
    }
  }

  const modelId = selectedModel?.value;
  const modelLabel = formatBtwModelLabel(modelId, selectedModel?.name, selectedEffort);

  return {
    configOptionValues,
    ...(modelId ? { modelId } : {}),
    ...(modelLabel ? { modelLabel } : {}),
    ...(selectedEffort ? { effortValue: selectedEffort.value } : {}),
    ...(selectedMode ? { modeValue: selectedMode.value } : {}),
  };
}
