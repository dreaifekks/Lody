import { z } from 'zod';
import { SessionFileRootIdSchema } from './project-path';

/**
 * Code Navigation v1 — single multiplexed read-only RPC (`code-nav/query`)
 * for worktree code review symbol outlines, enclosing ranges, go-to-definition,
 * and 1–2 hop upward caller tracing.
 *
 * Completely independent from Code Collab: queries are pure reads and must
 * never activate workspace watchers or Flock publication.
 *
 * Line numbers (`line`, `startLine`, `endLine`) are 1-based inclusive.
 * Columns (`character`, `endCharacter`) are 0-based UTF-16 code-unit offsets.
 */
export const CODE_NAV_PROTOCOL_VERSION = 1;

export const CODE_NAV_LIMITS = {
  /** Safe wire ceiling (256 KiB) so responses fit both LAN direct and Hub fallback. */
  maxResponseBytes: 256 * 1024,
  defaultDefinitionLimit: 20,
  maxDefinitionLimit: 50,
  defaultCallersLimit: 40,
  maxCallersLimit: 100,
  maxDiffOutlineFiles: 200,
  maxSymbolsPerFile: 200,
  maxHunksPerFile: 200,
  maxEnclosingDepth: 16,
  maxPreviewLineChars: 240,
  maxSymbolHintChars: 200,
  maxPathChars: 4096,
  maxBaseRefChars: 256,
  defaultTimeoutMs: 8_000,
} as const;
export type CodeNavLimits = typeof CODE_NAV_LIMITS;

export const CodeNavProviderKindSchema = z.enum(['ast-grep', 'ts-ls', 'grep-fallback']);
export type CodeNavProviderKind = z.infer<typeof CodeNavProviderKindSchema>;

export const CodeNavConfidenceSchema = z.enum(['exact', 'heuristic']);
export type CodeNavConfidence = z.infer<typeof CodeNavConfidenceSchema>;

export const CodeNavSymbolKindSchema = z.enum([
  'function',
  'method',
  'class',
  'interface',
  'type',
  'enum',
  'component',
  'variable',
  'property',
  'namespace',
  'module',
]);
export type CodeNavSymbolKind = z.infer<typeof CodeNavSymbolKindSchema>;

export const CodeNavSymbolSchema = z
  .object({
    name: z.string().min(1).max(CODE_NAV_LIMITS.maxSymbolHintChars),
    kind: CodeNavSymbolKindSchema,
    containerName: z.string().min(1).max(CODE_NAV_LIMITS.maxSymbolHintChars).optional(),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  })
  .strict();
export type CodeNavSymbol = z.infer<typeof CodeNavSymbolSchema>;

export const CodeNavDiffOutlineSymbolSchema = CodeNavSymbolSchema.extend({
  hunkCount: z.number().int().nonnegative(),
}).strict();
export type CodeNavDiffOutlineSymbol = z.infer<typeof CodeNavDiffOutlineSymbolSchema>;

export const CodeNavDiffOutlineHunkSchema = z
  .object({
    startLine: z.number().int().nonnegative(),
    endLine: z.number().int().nonnegative(),
    enclosing: CodeNavSymbolSchema.optional(),
  })
  .strict();
export type CodeNavDiffOutlineHunk = z.infer<typeof CodeNavDiffOutlineHunkSchema>;

export const CodeNavDiffOutlineFileSchema = z
  .object({
    path: z.string().min(1).max(CODE_NAV_LIMITS.maxPathChars),
    symbols: z.array(CodeNavDiffOutlineSymbolSchema).max(CODE_NAV_LIMITS.maxSymbolsPerFile),
    hunks: z.array(CodeNavDiffOutlineHunkSchema).max(CODE_NAV_LIMITS.maxHunksPerFile),
  })
  .strict();
export type CodeNavDiffOutlineFile = z.infer<typeof CodeNavDiffOutlineFileSchema>;

export const CodeNavLocationSchema = z
  .object({
    path: z.string().min(1).max(CODE_NAV_LIMITS.maxPathChars),
    line: z.number().int().positive(),
    character: z.number().int().nonnegative(),
    endLine: z.number().int().positive().optional(),
    endCharacter: z.number().int().nonnegative().optional(),
    name: z.string().min(1).max(CODE_NAV_LIMITS.maxSymbolHintChars),
    kind: CodeNavSymbolKindSchema,
    containerName: z.string().min(1).max(CODE_NAV_LIMITS.maxSymbolHintChars).optional(),
    previewLine: z.string().max(CODE_NAV_LIMITS.maxPreviewLineChars),
  })
  .strict();
export type CodeNavLocation = z.infer<typeof CodeNavLocationSchema>;

export const CodeNavCallerItemSchema = z
  .object({
    path: z.string().min(1).max(CODE_NAV_LIMITS.maxPathChars),
    line: z.number().int().positive(),
    character: z.number().int().nonnegative(),
    previewLine: z.string().max(CODE_NAV_LIMITS.maxPreviewLineChars),
    receiver: z.string().min(1).max(CODE_NAV_LIMITS.maxSymbolHintChars).optional(),
    depth: z.union([z.literal(1), z.literal(2)]),
    /** For depth 2, the intermediate depth-1 caller symbol traced upward. */
    viaSymbol: z.string().min(1).max(CODE_NAV_LIMITS.maxSymbolHintChars).optional(),
    /** Enclosing callable/component function containing the call site; omitted for top-level calls. */
    caller: CodeNavSymbolSchema.optional(),
  })
  .strict();
export type CodeNavCallerItem = z.infer<typeof CodeNavCallerItemSchema>;

/* ── Request schemas ──────────────────────────────────────────────────────── */

export const CodeNavDiffOutlineRequestSchema = z
  .object({
    action: z.literal('diff-outline'),
    sessionId: z.string().trim().min(1),
    scope: z.enum(['branch', 'uncommitted']),
    baseRef: z.string().trim().min(1).max(CODE_NAV_LIMITS.maxBaseRefChars).optional(),
    rootId: SessionFileRootIdSchema.optional(),
  })
  .strict();
export type CodeNavDiffOutlineRequest = z.infer<typeof CodeNavDiffOutlineRequestSchema>;

export const CodeNavEnclosingRequestSchema = z
  .object({
    action: z.literal('enclosing'),
    sessionId: z.string().trim().min(1),
    path: z.string().min(1).max(CODE_NAV_LIMITS.maxPathChars),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    rootId: SessionFileRootIdSchema.optional(),
  })
  .strict();
export type CodeNavEnclosingRequest = z.infer<typeof CodeNavEnclosingRequestSchema>;

export const CodeNavDefinitionRequestSchema = z
  .object({
    action: z.literal('definition'),
    sessionId: z.string().trim().min(1),
    path: z.string().min(1).max(CODE_NAV_LIMITS.maxPathChars),
    line: z.number().int().positive(),
    character: z.number().int().nonnegative(),
    symbolHint: z.string().trim().min(1).max(CODE_NAV_LIMITS.maxSymbolHintChars).optional(),
    limit: z.number().int().positive().max(CODE_NAV_LIMITS.maxDefinitionLimit).optional(),
    rootId: SessionFileRootIdSchema.optional(),
  })
  .strict();
export type CodeNavDefinitionRequest = z.infer<typeof CodeNavDefinitionRequestSchema>;

export const CodeNavCallersRequestSchema = z
  .object({
    action: z.literal('callers'),
    sessionId: z.string().trim().min(1),
    path: z.string().min(1).max(CODE_NAV_LIMITS.maxPathChars),
    line: z.number().int().positive(),
    character: z.number().int().nonnegative(),
    symbolHint: z.string().trim().min(1).max(CODE_NAV_LIMITS.maxSymbolHintChars).optional(),
    maxDepth: z.union([z.literal(1), z.literal(2)]).optional(),
    limit: z.number().int().positive().max(CODE_NAV_LIMITS.maxCallersLimit).optional(),
    rootId: SessionFileRootIdSchema.optional(),
  })
  .strict();
export type CodeNavCallersRequest = z.infer<typeof CodeNavCallersRequestSchema>;

export const CodeNavQueryRequestSchema = z.discriminatedUnion('action', [
  CodeNavDiffOutlineRequestSchema,
  CodeNavEnclosingRequestSchema,
  CodeNavDefinitionRequestSchema,
  CodeNavCallersRequestSchema,
]);
export type CodeNavQueryRequest = z.infer<typeof CodeNavQueryRequestSchema>;

/* ── Response schemas ─────────────────────────────────────────────────────── */

export const CodeNavErrorCodeSchema = z.enum([
  'unavailable',
  'unsupported_language',
  'invalid_request',
  'invalid_path',
  'path_not_allowed',
  'file_not_found',
  'session_not_found',
  'session_archived',
  'workspace_unavailable',
  'permission_denied',
  'timeout',
  'transient_io',
]);
export type CodeNavErrorCode = z.infer<typeof CodeNavErrorCodeSchema>;

export const CodeNavQueryErrorSchema = z
  .object({
    type: z.literal('code-nav/query'),
    status: z.literal('error'),
    code: CodeNavErrorCodeSchema,
    message: z.string().min(1).optional(),
    retryable: z.boolean().optional(),
  })
  .strict();
export type CodeNavQueryError = z.infer<typeof CodeNavQueryErrorSchema>;

export const CodeNavDiffOutlineOkSchema = z
  .object({
    type: z.literal('code-nav/query'),
    status: z.literal('ok'),
    action: z.literal('diff-outline'),
    baseRef: z.string().min(1).max(CODE_NAV_LIMITS.maxBaseRefChars).optional(),
    headSha: z.string().min(1).max(64).optional(),
    files: z.array(CodeNavDiffOutlineFileSchema).max(CODE_NAV_LIMITS.maxDiffOutlineFiles),
    truncated: z.boolean(),
    provider: CodeNavProviderKindSchema,
  })
  .strict();
export type CodeNavDiffOutlineOk = z.infer<typeof CodeNavDiffOutlineOkSchema>;

export const CodeNavEnclosingOkSchema = z
  .object({
    type: z.literal('code-nav/query'),
    status: z.literal('ok'),
    action: z.literal('enclosing'),
    path: z.string().min(1).max(CODE_NAV_LIMITS.maxPathChars),
    /** Outermost to innermost enclosing symbols covering the requested range. */
    chain: z.array(CodeNavSymbolSchema).max(CODE_NAV_LIMITS.maxEnclosingDepth),
    provider: CodeNavProviderKindSchema,
  })
  .strict();
export type CodeNavEnclosingOk = z.infer<typeof CodeNavEnclosingOkSchema>;

export const CodeNavDefinitionOkSchema = z
  .object({
    type: z.literal('code-nav/query'),
    status: z.literal('ok'),
    action: z.literal('definition'),
    symbol: z.string().max(CODE_NAV_LIMITS.maxSymbolHintChars),
    items: z.array(CodeNavLocationSchema).max(CODE_NAV_LIMITS.maxDefinitionLimit),
    confidence: CodeNavConfidenceSchema,
    totalCandidates: z.number().int().nonnegative().optional(),
    truncated: z.boolean(),
    provider: CodeNavProviderKindSchema,
  })
  .strict();
export type CodeNavDefinitionOk = z.infer<typeof CodeNavDefinitionOkSchema>;

export const CodeNavTruncatedReasonSchema = z.enum(['limit', 'fanout', 'budget']);
export type CodeNavTruncatedReason = z.infer<typeof CodeNavTruncatedReasonSchema>;

export const CodeNavCallersOkSchema = z
  .object({
    type: z.literal('code-nav/query'),
    status: z.literal('ok'),
    action: z.literal('callers'),
    symbol: z.string().max(CODE_NAV_LIMITS.maxSymbolHintChars),
    items: z.array(CodeNavCallerItemSchema).max(CODE_NAV_LIMITS.maxCallersLimit),
    totalCandidates: z.number().int().nonnegative().optional(),
    truncated: z.boolean(),
    truncatedReason: CodeNavTruncatedReasonSchema.optional(),
    provider: CodeNavProviderKindSchema,
  })
  .strict();
export type CodeNavCallersOk = z.infer<typeof CodeNavCallersOkSchema>;

export const CodeNavQueryOkSchema = z.discriminatedUnion('action', [
  CodeNavDiffOutlineOkSchema,
  CodeNavEnclosingOkSchema,
  CodeNavDefinitionOkSchema,
  CodeNavCallersOkSchema,
]);
export type CodeNavQueryOk = z.infer<typeof CodeNavQueryOkSchema>;

export const CodeNavQueryResponseSchema = z.union([CodeNavQueryOkSchema, CodeNavQueryErrorSchema]);
export type CodeNavQueryResponse = z.infer<typeof CodeNavQueryResponseSchema>;

export function isCodeNavError(value: unknown): value is CodeNavQueryError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    (value as { readonly type?: unknown }).type === 'code-nav/query' &&
    'status' in value &&
    (value as { readonly status?: unknown }).status === 'error'
  );
}

export function codeNavError(
  code: CodeNavErrorCode,
  options: {
    readonly message?: string;
    readonly retryable?: boolean;
  } = {}
): CodeNavQueryError {
  return {
    type: 'code-nav/query',
    status: 'error',
    code,
    ...(options.message === undefined ? {} : { message: options.message }),
    ...(options.retryable === undefined ? {} : { retryable: options.retryable }),
  };
}

const utf8Encoder = new TextEncoder();

export function estimateCodeNavResponseBytes(response: CodeNavQueryResponse): number {
  return utf8Encoder.encode(JSON.stringify(response)).byteLength;
}
