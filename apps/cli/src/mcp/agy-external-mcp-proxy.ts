import { randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { ResolvedMcpServer } from '@lody/shared';
import type { McpAuthenticationIO, McpRelayRequest } from './authentication/io';

/** Internal loopback header sent only by `AgentClient` for `agy` sessions; never forwarded upstream. */
export const AGY_MCP_PROXY_HEADER = 'x-lody-mcp-proxy';
export const AGY_EXTERNAL_MCP_BUDGET_ENV = 'LODY_AGY_MCP_EXTERNAL_BUDGET_TOKENS';

/**
 * Target total token budget allocated across selected external HTTP MCP servers under `agy`
 * (measured with agy's own `ceil(utf8Bytes / 3)` estimator against its shared 20,000-token pool).
 * With Lody's 56 compact commands (~5.1k tok), 5,500 tok keeps worst-case MCP usage under
 * ~10.6k tok on skill-heavy machines (~11.7k MCP headroom).
 *
 * Each server still has a minimum floor of one 2-tool `lazy` facade (~360 tok).
 */
export const DEFAULT_AGY_EXTERNAL_MCP_BUDGET_TOKENS = 5_500;
export const AGY_LAZY_FACADE_FLOOR_TOKENS = 360;
const MIN_TOTAL_BUDGET_TOKENS = 800;
const MAX_TOTAL_BUDGET_TOKENS = 18_000;
const MIN_SERVER_SHARE_TOKENS = AGY_LAZY_FACADE_FLOOR_TOKENS;
const MAX_SERVER_SHARE_TOKENS = 4_000;

const MAX_RAW_TOOLS = 12;
const MAX_COMPACT_TOOLS = 25;
const MAX_PINNED_ALLOW_TOOLS = 12;
const COMPACT_SUMMARY_MAX_CHARS = 100;
const HELP_INDEX_SUMMARY_MAX_CHARS = 120;
const HELP_PREVIEW_MAX_CHARS = 240;
const HELP_BATCH_MAX_TOOLS = 15;
const HELP_RESPONSE_MAX_CHARS = 96 * 1024;
const SEARCH_MAX_RESULTS = 30;
const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;
const MAX_LIST_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_LIST_PAGES = 50;
const MAX_CACHED_TOOLS = 2_000;
const MAX_SESSIONS_PER_LEASE = 32;
const MAX_SSE_RESUME_HOPS = 3;
const MAX_SSE_RETRY_WAIT_MS = 15_000;
const MAX_HEADER_VALUE_LENGTH = 8_192;
const MAX_PROXY_HEADER_LENGTH = 256;
const MAX_SERVER_LABEL_LENGTH = 64;
const MAX_PERMISSION_FILE_BYTES = 512 * 1024;

const PASSTHROUGH_REQUEST_HEADERS = [
  'accept',
  'content-type',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
] as const;

const PASSTHROUGH_RESPONSE_HEADERS = ['mcp-session-id', 'mcp-protocol-version'] as const;

const CORE_TOOL_HINT_PATTERN = /(fetch|search|query|read|get|list|create|update|delete|send)/i;

let nextProxyRpcSeq = 0;
function allocateProxyRpcId(tag: string): string {
  nextProxyRpcSeq += 1;
  return `lody-proxy-${tag}-${randomBytes(4).toString('hex')}-${nextProxyRpcSeq}`;
}

export type AgyMcpProxyMode = 'raw' | 'compact' | 'lazy';

export type AgyMcpProxyDirective = {
  readonly share: number;
  readonly serverName: string;
};

export type AgyConfigContext = {
  readonly geminiDir: string;
  readonly appDataDir: string;
};

export type AgyProxySessionContext = {
  readonly workdir?: string;
  readonly agyConfigContext?: AgyConfigContext;
};

export type AgyMcpPermissionRules = {
  readonly allow: readonly string[];
  readonly ask: readonly string[];
  readonly deny: readonly string[];
};

export type AgyMcpPermissionLoadResult =
  | { readonly status: 'ok'; readonly rules: AgyMcpPermissionRules }
  | { readonly status: 'unreadable'; readonly reason: string };

const EMPTY_PERMISSION_RULES: AgyMcpPermissionRules = { allow: [], ask: [], deny: [] };
const OK_EMPTY_PERMISSION_LOAD: AgyMcpPermissionLoadResult = {
  status: 'ok',
  rules: EMPTY_PERMISSION_RULES,
};

export type UpstreamMcpTool = {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly annotations?: Record<string, unknown>;
  readonly execution?: Record<string, unknown>;
  readonly _meta?: Record<string, unknown>;
  /** Exact upstream JSON object preserved verbatim for `raw` pass-through. */
  readonly raw?: Record<string, unknown>;
};

export type AgyMcpProxyOptions = {
  readonly loadPermissionRules?: (context?: AgyProxySessionContext) => AgyMcpPermissionLoadResult;
  readonly delay?: (ms: number, signal: AbortSignal) => Promise<void>;
};

type JsonRpcId = string | number;

type JsonRpcRequest = {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
};

type ParsedMcpRule = {
  readonly serverPattern: string;
  readonly toolPattern: string;
};

type ProxyCatalogSnapshot = {
  readonly mode: AgyMcpProxyMode;
  readonly serverName: string;
  readonly helpToolName: string;
  readonly callToolName: string;
  readonly toolsByName: ReadonlyMap<string, UpstreamMcpTool>;
  readonly toolOrder: readonly string[];
  readonly pinnedAskNames: ReadonlySet<string>;
};

type ProxyLeaseState = {
  endpointUrl: string;
  readonly snapshots: Map<string, ProxyCatalogSnapshot>;
  getSnapshot(sessionKey: string): ProxyCatalogSnapshot | undefined;
  setSnapshot(sessionKey: string, snapshot: ProxyCatalogSnapshot): void;
  deleteSnapshot(sessionKey: string): void;
  clear(): void;
};

/**
 * In-process registries tying active loopback relay URLs to session contexts (workdir and
 * resolved agy config dirs) without placing filesystem paths into HTTP headers.
 */
const activeRelayUrls = new Set<string>();
const relayContexts = new Map<string, AgyProxySessionContext>();

const permissionFileCache = new Map<
  string,
  { readonly mtimeMs: number; readonly size: number; readonly rules: AgyMcpPermissionRules }
>();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sanitizeServerLabel(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '').slice(0, MAX_SERVER_LABEL_LENGTH);
  return cleaned || 'mcp';
}

function isLoopbackHttpUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return (
      parsed.protocol === 'http:' &&
      (parsed.hostname === '127.0.0.1' ||
        parsed.hostname === '[::1]' ||
        parsed.hostname === '::1' ||
        parsed.hostname === 'localhost')
    );
  } catch {
    return false;
  }
}

/** Linear-time glob matcher supporting `*` and `?` without regex backtracking. */
function globMatch(pattern: string, value: string): boolean {
  let p = 0;
  let v = 0;
  let starIdx = -1;
  let matchIdx = 0;
  while (v < value.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === value[v])) {
      p += 1;
      v += 1;
    } else if (p < pattern.length && pattern[p] === '*') {
      starIdx = p;
      matchIdx = v;
      p += 1;
    } else if (starIdx !== -1) {
      p = starIdx + 1;
      matchIdx += 1;
      v = matchIdx;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p += 1;
  return p === pattern.length;
}

export function parseAgyMcpPermissionRule(rawRule: string): ParsedMcpRule | null {
  const trimmed = rawRule.trim();
  if (!trimmed.startsWith('mcp(') || !trimmed.endsWith(')')) return null;
  const inner = trimmed.slice(4, -1).trim();
  if (!inner) return null;
  if (inner === '*') return { serverPattern: '*', toolPattern: '*' };
  const slash = inner.indexOf('/');
  if (slash < 0) return { serverPattern: inner, toolPattern: '*' };
  const serverPattern = inner.slice(0, slash).trim();
  const toolPattern = inner.slice(slash + 1).trim();
  if (!serverPattern || !toolPattern) return null;
  return { serverPattern, toolPattern };
}

function matchesParsedMcpRule(rule: ParsedMcpRule, serverName: string, toolName: string): boolean {
  return globMatch(rule.serverPattern, serverName) && globMatch(rule.toolPattern, toolName);
}

function parseMcpRuleList(rules: readonly string[]): ParsedMcpRule[] {
  const parsed: ParsedMcpRule[] = [];
  for (const rule of rules) {
    const entry = parseAgyMcpPermissionRule(rule);
    if (entry) parsed.push(entry);
  }
  return parsed;
}

function extractMcpStrings(value: unknown, out: string[]): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (typeof item === 'string' && item.trim().startsWith('mcp(')) {
      out.push(item.trim());
    }
  }
}

function extractPermissionRulesFromJson(parsed: unknown): AgyMcpPermissionRules {
  if (!isPlainObject(parsed)) return EMPTY_PERMISSION_RULES;
  const allow: string[] = [];
  const ask: string[] = [];
  const deny: string[] = [];

  const containers: unknown[] = [
    parsed.permissions,
    parsed.permissionGrants,
    isPlainObject(parsed.userSettings) ? parsed.userSettings.globalPermissionGrants : undefined,
  ];
  for (const container of containers) {
    if (!isPlainObject(container)) continue;
    extractMcpStrings(container.allow, allow);
    extractMcpStrings(container.ask, ask);
    extractMcpStrings(container.deny, deny);
  }
  return { allow, ask, deny };
}

/**
 * Resolves the exact Antigravity CLI config directories from the spawned ACP process's
 * effective `args` (`--gemini-dir`, `--app-data-dir`) and merged `env` (`GEMINI_DIR`, `HOME`).
 */
export function resolveAgyConfigContext(
  args: readonly string[] = [],
  env: Readonly<Record<string, string | undefined>> = process.env
): AgyConfigContext {
  let flagGeminiDir: string | undefined;
  let flagAppDataDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === '--gemini-dir' && args[i + 1]) {
      flagGeminiDir = args[i + 1]!.trim();
      i += 1;
    } else if (arg.startsWith('--gemini-dir=')) {
      flagGeminiDir = arg.slice('--gemini-dir='.length).trim();
    } else if (arg === '--app-data-dir' && args[i + 1]) {
      flagAppDataDir = args[i + 1]!.trim();
      i += 1;
    } else if (arg.startsWith('--app-data-dir=')) {
      flagAppDataDir = arg.slice('--app-data-dir='.length).trim();
    }
  }
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
  const geminiDir = flagGeminiDir || env.GEMINI_DIR?.trim() || path.join(home, '.gemini');
  const appDataDir = flagAppDataDir || path.join(geminiDir, 'antigravity-cli');
  return { geminiDir, appDataDir };
}

function readPermissionFile(
  filePath: string
):
  | { readonly ok: true; readonly rules: AgyMcpPermissionRules }
  | { readonly ok: false; readonly reason: string } {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      permissionFileCache.delete(filePath);
      return { ok: true, rules: EMPTY_PERMISSION_RULES };
    }
    return { ok: false, reason: `Unable to stat agy permission file ${path.basename(filePath)}` };
  }
  if (!stat.isFile()) return { ok: true, rules: EMPTY_PERMISSION_RULES };
  if (stat.size > MAX_PERMISSION_FILE_BYTES) {
    return { ok: false, reason: `agy permission file ${path.basename(filePath)} exceeds size cap` };
  }
  const cached = permissionFileCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return { ok: true, rules: cached.rules };
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!isPlainObject(parsed)) {
      return { ok: false, reason: `Invalid JSON root in ${path.basename(filePath)}` };
    }
    const rules = extractPermissionRulesFromJson(parsed);
    if (permissionFileCache.size >= 64) {
      const oldest = permissionFileCache.keys().next().value;
      if (oldest !== undefined) permissionFileCache.delete(oldest);
    }
    permissionFileCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, rules });
    return { ok: true, rules };
  } catch {
    return { ok: false, reason: `Unable to parse agy permission file ${path.basename(filePath)}` };
  }
}

/**
 * Loads `mcp(...)` permission rules from agy's effective global and (when known)
 * project-scoped settings files. Missing files yield empty rules; existing files that
 * cannot be read or parsed return `{ status: 'unreadable' }` so callers fail safe by
 * preserving original tool names for agy's own permission engine.
 */
export function loadAgyMcpPermissionRules(
  context?: AgyProxySessionContext,
  env: Readonly<Record<string, string | undefined>> = process.env
): AgyMcpPermissionLoadResult {
  const config = context?.agyConfigContext ?? resolveAgyConfigContext([], env);
  const candidatePaths = [
    path.join(config.geminiDir, 'config', 'config.json'),
    path.join(config.appDataDir, 'settings.json'),
  ];
  if (context?.workdir) {
    candidatePaths.push(
      path.join(context.workdir, '.gemini', 'settings.json'),
      path.join(context.workdir, '.gemini', 'settings.local.json'),
      path.join(context.workdir, '.agents', 'settings.json'),
      path.join(context.workdir, '.agents', 'settings.local.json')
    );
  }

  const allow: string[] = [];
  const ask: string[] = [];
  const deny: string[] = [];
  for (const filePath of candidatePaths) {
    const loaded = readPermissionFile(filePath);
    if (!loaded.ok) return { status: 'unreadable', reason: loaded.reason };
    allow.push(...loaded.rules.allow);
    ask.push(...loaded.rules.ask);
    deny.push(...loaded.rules.deny);
  }
  return { status: 'ok', rules: { allow, ask, deny } };
}

function isToolDeniedByRules(
  rules: AgyMcpPermissionRules,
  serverName: string,
  toolName: string
): boolean {
  const denyRules = parseMcpRuleList(rules.deny);
  return denyRules.some((rule) => matchesParsedMcpRule(rule, serverName, toolName));
}

function isToolAllowedByRules(
  rules: AgyMcpPermissionRules,
  serverName: string,
  toolName: string
): boolean {
  const allowRules = parseMcpRuleList(rules.allow);
  return allowRules.some((rule) => matchesParsedMcpRule(rule, serverName, toolName));
}

function hasNarrowAskRuleForTool(
  rules: AgyMcpPermissionRules,
  serverName: string,
  toolName: string,
  callToolName: string
): boolean {
  const askRules = parseMcpRuleList(rules.ask);
  return askRules.some(
    (rule) =>
      matchesParsedMcpRule(rule, serverName, toolName) &&
      !matchesParsedMcpRule(rule, serverName, callToolName)
  );
}

function hasNarrowAllowRuleForTool(
  rules: AgyMcpPermissionRules,
  serverName: string,
  toolName: string,
  callToolName: string
): boolean {
  const allowRules = parseMcpRuleList(rules.allow);
  return allowRules.some(
    (rule) =>
      matchesParsedMcpRule(rule, serverName, toolName) &&
      !matchesParsedMcpRule(rule, serverName, callToolName)
  );
}

function requiresTaskExecution(tool: UpstreamMcpTool): boolean {
  return isPlainObject(tool.execution) && tool.execution.taskSupport === 'required';
}

export function resolveAgyExternalMcpBudgetTokens(
  env: Readonly<Record<string, string | undefined>> = process.env
): number {
  const raw = env[AGY_EXTERNAL_MCP_BUDGET_ENV]?.trim();
  if (!raw) return DEFAULT_AGY_EXTERNAL_MCP_BUDGET_TOKENS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_AGY_EXTERNAL_MCP_BUDGET_TOKENS;
  return clamp(parsed, MIN_TOTAL_BUDGET_TOKENS, MAX_TOTAL_BUDGET_TOKENS);
}

export function computeAgyServerTokenShare(
  externalHttpServerCount: number,
  totalBudgetTokens = resolveAgyExternalMcpBudgetTokens()
): number {
  const count = Math.max(1, Math.floor(externalHttpServerCount));
  return clamp(
    Math.floor(totalBudgetTokens / count),
    MIN_SERVER_SHARE_TOKENS,
    MAX_SERVER_SHARE_TOKENS
  );
}

/**
 * Returns an actionable warning when the number of selected external HTTP MCP servers
 * exceeds what `totalBudgetTokens` can hold even when every server folds to its minimum
 * 2-tool `lazy` facade (`~360 tok` each).
 */
export function describeAgyExternalBudgetOverflow(
  servers: readonly ResolvedMcpServer[],
  totalBudgetTokens = resolveAgyExternalMcpBudgetTokens()
): string | null {
  const loopbackHttpCount = servers.filter(
    (server) => 'type' in server && server.type === 'http' && isLoopbackHttpUrl(server.url)
  ).length;
  const minimumTokens = loopbackHttpCount * AGY_LAZY_FACADE_FLOOR_TOKENS;
  if (loopbackHttpCount === 0 || minimumTokens <= totalBudgetTokens) return null;
  return `Selected ${loopbackHttpCount} external HTTP MCP servers require at least ~${minimumTokens} tokens in lazy facade mode, exceeding ${AGY_EXTERNAL_MCP_BUDGET_ENV}=${totalBudgetTokens}.`;
}

/**
 * Attaches the internal loopback proxy header to external loopback HTTP MCP servers
 * for `agy` sessions. Non-loopback HTTP servers and stdio servers are left untouched.
 */
export function applyAgyExternalMcpProxyHeaders(
  servers: readonly ResolvedMcpServer[],
  optionsOrBudget?:
    | number
    | {
        readonly totalBudgetTokens?: number;
        readonly workdir?: string;
        readonly agyConfigContext?: AgyConfigContext;
      }
): ResolvedMcpServer[] {
  const totalBudgetTokens =
    typeof optionsOrBudget === 'number'
      ? optionsOrBudget
      : (optionsOrBudget?.totalBudgetTokens ?? resolveAgyExternalMcpBudgetTokens());
  const sessionContext: AgyProxySessionContext | undefined =
    typeof optionsOrBudget === 'object' &&
    (optionsOrBudget.workdir || optionsOrBudget.agyConfigContext)
      ? {
          ...(optionsOrBudget.workdir ? { workdir: optionsOrBudget.workdir } : {}),
          ...(optionsOrBudget.agyConfigContext
            ? { agyConfigContext: optionsOrBudget.agyConfigContext }
            : {}),
        }
      : undefined;

  const loopbackHttpCount = servers.filter(
    (server) => 'type' in server && server.type === 'http' && isLoopbackHttpUrl(server.url)
  ).length;
  if (loopbackHttpCount === 0) return [...servers];

  const share = computeAgyServerTokenShare(loopbackHttpCount, totalBudgetTokens);
  return servers.map((server) => {
    if (!('type' in server) || server.type !== 'http' || !isLoopbackHttpUrl(server.url)) {
      return server;
    }
    if (sessionContext && activeRelayUrls.has(server.url)) {
      relayContexts.set(server.url, sessionContext);
    }
    const headers = server.headers.filter(
      (header) => header.name.toLowerCase() !== AGY_MCP_PROXY_HEADER
    );
    headers.push({
      name: AGY_MCP_PROXY_HEADER,
      value: formatAgyMcpProxyHeader({ share, serverName: server.name }),
    });
    return { ...server, headers };
  });
}

export function formatAgyMcpProxyHeader(directive: AgyMcpProxyDirective): string {
  const share = clamp(
    Math.floor(directive.share),
    MIN_SERVER_SHARE_TOKENS,
    MAX_TOTAL_BUDGET_TOKENS
  );
  const server = encodeURIComponent(sanitizeServerLabel(directive.serverName));
  return `auto;share=${share};server=${server}`;
}

export function parseAgyMcpProxyHeader(
  value: string | string[] | undefined
): AgyMcpProxyDirective | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_PROXY_HEADER_LENGTH) return null;
  const parts = trimmed.split(';').map((part) => part.trim());
  if (parts[0] !== 'auto') return null;
  let share = MAX_SERVER_SHARE_TOKENS;
  let serverName = 'mcp';
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (key === 'share') {
      const parsed = Number.parseInt(val, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        share = clamp(parsed, MIN_SERVER_SHARE_TOKENS, MAX_TOTAL_BUDGET_TOKENS);
      }
    } else if (key === 'server' && val.length > 0) {
      try {
        serverName = sanitizeServerLabel(decodeURIComponent(val));
      } catch {
        serverName = sanitizeServerLabel(val);
      }
    }
  }
  return { share, serverName };
}

/**
 * Matches agy 1.5.14's exact `GetToolTokenGroups` + `EstimateTokenCounter` calculation:
 * `ceil(len(fmt.Sprintf("%s.%s.%s", name, description, inputSchemaJson)) / 3.0)` where Go's
 * `len(string)` counts UTF-8 bytes.
 */
export function estimateAgyToolTokens(tool: {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}): number {
  const schemaJson = JSON.stringify(tool.inputSchema ?? { type: 'object' });
  const totalBytes =
    Buffer.byteLength(tool.name, 'utf8') +
    1 +
    Buffer.byteLength(tool.description ?? '', 'utf8') +
    1 +
    Buffer.byteLength(schemaJson, 'utf8');
  return Math.ceil(totalBytes / 3);
}

function summarizeDescription(description: string | undefined, maxChars: number): string {
  if (!description) return '';
  const collapsed = description.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function hasSchemaParameters(schema: unknown): boolean {
  if (!isPlainObject(schema)) return false;
  if (isPlainObject(schema.properties) && Object.keys(schema.properties).length > 0) return true;
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) return true;
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) return true;
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) return true;
  return false;
}

function pickUniqueToolName(
  preferred: string,
  fallbackBase: string,
  existing: ReadonlySet<string>
): string {
  if (!existing.has(preferred)) return preferred;
  if (!existing.has(fallbackBase)) return fallbackBase;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${fallbackBase}_${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${fallbackBase}_${Date.now()}`;
}

function buildToolNamePreview(tools: readonly UpstreamMcpTool[]): string {
  if (tools.length === 0) return '';
  const prioritized = [
    ...tools.filter((tool) => CORE_TOOL_HINT_PATTERN.test(tool.name)),
    ...tools.filter((tool) => !CORE_TOOL_HINT_PATTERN.test(tool.name)),
  ];
  const chosen: string[] = [];
  let chars = 0;
  for (const tool of prioritized) {
    const sep = chosen.length === 0 ? 0 : 2;
    if (chars + sep + tool.name.length > HELP_PREVIEW_MAX_CHARS) break;
    chosen.push(tool.name);
    chars += sep + tool.name.length;
  }
  if (chosen.length === 0) return '';
  const suffix = chosen.length < tools.length ? ', …' : '';
  return ` Notable tools: ${chosen.join(', ')}${suffix}.`;
}

function buildCompactToolDefinition(
  tool: UpstreamMcpTool,
  helpToolName: string
): Record<string, unknown> {
  const summary = summarizeDescription(tool.description, COMPACT_SUMMARY_MAX_CHARS);
  const needsParams = hasSchemaParameters(tool.inputSchema);
  const helpHint = needsParams ? `Read ${helpToolName}({tool:"${tool.name}"}) for parameters.` : '';
  const description = [summary, helpHint].filter(Boolean).join(' ');
  return {
    name: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    ...(description ? { description } : {}),
    inputSchema: { type: 'object' },
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
    ...(tool.execution ? { execution: tool.execution } : {}),
  };
}

function buildHelpToolDefinition(options: {
  readonly helpToolName: string;
  readonly callToolName?: string;
  readonly serverName: string;
  readonly tools: readonly UpstreamMcpTool[];
  readonly mode: 'compact' | 'lazy';
}): Record<string, unknown> {
  const { helpToolName, callToolName, serverName, tools, mode } = options;
  const description =
    mode === 'lazy'
      ? `Inspect ${serverName} MCP tools (${tools.length}, read-only). Call {} for index, {query} to search, or {tools:[...]} for full schemas before ${callToolName}.${buildToolNamePreview(tools)}`
      : `Read full parameter schemas for ${serverName} MCP tools (${tools.length}, read-only). Pass {tool} or {tools:[...]} before calling parameterized tools, or {query}/{}.`;
  return {
    name: helpToolName,
    description,
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Exact tool name.' },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exact tool names (batch).',
        },
        query: { type: 'string', description: 'Keyword search.' },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  };
}

function buildCallToolDefinition(options: {
  readonly callToolName: string;
  readonly helpToolName: string;
  readonly serverName: string;
}): Record<string, unknown> {
  return {
    name: options.callToolName,
    description: `Execute a ${options.serverName} MCP tool. Inspect its schema with ${options.helpToolName} first unless already in context.`,
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Upstream tool name.' },
        arguments: {
          type: 'object',
          description: 'Arguments matching tool inputSchema.',
        },
      },
      required: ['tool'],
      additionalProperties: false,
    },
  };
}

function toRawAdvertisedTool(tool: UpstreamMcpTool): Record<string, unknown> {
  if (tool.raw) return tool.raw;
  return {
    name: tool.name,
    ...(tool.title !== undefined ? { title: tool.title } : {}),
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
    ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
    ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
    ...(tool.execution !== undefined ? { execution: tool.execution } : {}),
    ...(tool._meta !== undefined ? { _meta: tool._meta } : {}),
  };
}

function estimateAdvertisedToolTokens(tool: Record<string, unknown>): number {
  return estimateAgyToolTokens({
    name: String(tool.name),
    description: typeof tool.description === 'string' ? tool.description : undefined,
    inputSchema: tool.inputSchema,
  });
}

/**
 * Classifies one upstream server's tool catalog into the adaptive B3 tier (`raw`, `compact`,
 * or `lazy`) against its per-server token share, enforcing agy's `mcp(...)` permission rules:
 * - If permission files are unreadable, fails safe by never entering `lazy` (original tool
 *   names remain visible so agy evaluates its own permission engine directly).
 * - `deny` rules remove matching tools from discovery in all modes.
 * - In `lazy` mode, tools with `execution.taskSupport === "required"` and narrow `ask`-governed
 *   tools under a broad `allow` rule must fit as native compact entries within `directive.share`;
 *   otherwise returns `{ ok: false }` instead of overflowing budget or making tools uncallable.
 */
export function rewriteToolsForAgyBudget(
  upstreamTools: readonly UpstreamMcpTool[],
  directive: AgyMcpProxyDirective,
  permissionLoad: AgyMcpPermissionLoadResult | AgyMcpPermissionRules = OK_EMPTY_PERMISSION_LOAD
):
  | {
      readonly ok: true;
      readonly snapshot: ProxyCatalogSnapshot;
      readonly advertisedTools: Record<string, unknown>[];
    }
  | { readonly ok: false; readonly message: string } {
  const normalizedLoad: AgyMcpPermissionLoadResult =
    'status' in permissionLoad ? permissionLoad : { status: 'ok', rules: permissionLoad };
  const permissionRules =
    normalizedLoad.status === 'ok' ? normalizedLoad.rules : EMPTY_PERMISSION_RULES;

  const toolsByName = new Map<string, UpstreamMcpTool>();
  const toolOrder: string[] = [];
  for (const tool of upstreamTools) {
    if (
      normalizedLoad.status === 'ok' &&
      isToolDeniedByRules(permissionRules, directive.serverName, tool.name)
    ) {
      continue;
    }
    if (!toolsByName.has(tool.name)) toolOrder.push(tool.name);
    toolsByName.set(tool.name, tool);
  }
  const deduplicated = toolOrder.map((name) => toolsByName.get(name)!);
  const existingNames = new Set(toolOrder);
  const helpToolName = pickUniqueToolName('tools_help', 'lody_mcp_help', existingNames);
  const usedForCall = new Set([...existingNames, helpToolName]);
  const callToolName = pickUniqueToolName('tools_call', 'lody_mcp_call', usedForCall);
  const emptyPinned = new Set<string>();

  const rawTokens = deduplicated.reduce((sum, tool) => sum + estimateAgyToolTokens(tool), 0);
  if (deduplicated.length <= MAX_RAW_TOOLS && rawTokens <= directive.share) {
    return {
      ok: true,
      snapshot: {
        mode: 'raw',
        serverName: directive.serverName,
        helpToolName,
        callToolName,
        toolsByName,
        toolOrder,
        pinnedAskNames: emptyPinned,
      },
      advertisedTools: deduplicated.map(toRawAdvertisedTool),
    };
  }

  const buildCompactCatalog = () => {
    const helpTool = buildHelpToolDefinition({
      helpToolName,
      serverName: directive.serverName,
      tools: deduplicated,
      mode: 'compact',
    });
    const compacted: Record<string, unknown>[] = [
      helpTool,
      ...deduplicated.map((tool) => buildCompactToolDefinition(tool, helpToolName)),
    ];
    const compactTokens = compacted.reduce(
      (sum, tool) => sum + estimateAdvertisedToolTokens(tool),
      0
    );
    return { compacted, compactTokens };
  };

  if (normalizedLoad.status === 'unreadable') {
    // Fail safe: preserve original native tool names so agy enforces its own rules.
    const { compacted } = buildCompactCatalog();
    return {
      ok: true,
      snapshot: {
        mode: 'compact',
        serverName: directive.serverName,
        helpToolName,
        callToolName,
        toolsByName,
        toolOrder,
        pinnedAskNames: emptyPinned,
      },
      advertisedTools: compacted,
    };
  }

  if (deduplicated.length <= MAX_COMPACT_TOOLS) {
    const { compacted, compactTokens } = buildCompactCatalog();
    if (compactTokens <= directive.share) {
      return {
        ok: true,
        snapshot: {
          mode: 'compact',
          serverName: directive.serverName,
          helpToolName,
          callToolName,
          toolsByName,
          toolOrder,
          pinnedAskNames: emptyPinned,
        },
        advertisedTools: compacted,
      };
    }
  }

  const helpTool = buildHelpToolDefinition({
    helpToolName,
    callToolName,
    serverName: directive.serverName,
    tools: deduplicated,
    mode: 'lazy',
  });
  const callTool = buildCallToolDefinition({
    callToolName,
    helpToolName,
    serverName: directive.serverName,
  });
  const advertised: Record<string, unknown>[] = [helpTool, callTool];
  let usedTokens = advertised.reduce((sum, tool) => sum + estimateAdvertisedToolTokens(tool), 0);

  const broadAllowCoversCallTool = isToolAllowedByRules(
    permissionRules,
    directive.serverName,
    callToolName
  );
  const pinnedNames = new Set<string>();
  const pinnedAskNames = new Set<string>();

  // Mandatory native pins: tools requiring task execution (`execution.taskSupport: "required"`)
  // and narrow `ask`-governed tools whenever a broad `allow` rule matches `tools_call`.
  const mandatoryTools: Array<{
    readonly tool: UpstreamMcpTool;
    readonly isAsk: boolean;
    readonly compact: Record<string, unknown>;
    readonly cost: number;
  }> = [];
  let mandatoryCost = 0;
  for (const tool of deduplicated) {
    const isNarrowAsk = hasNarrowAskRuleForTool(
      permissionRules,
      directive.serverName,
      tool.name,
      callToolName
    );
    const isRequiredTask = requiresTaskExecution(tool);
    if (!isRequiredTask && !(broadAllowCoversCallTool && isNarrowAsk)) continue;
    const compact = buildCompactToolDefinition(tool, helpToolName);
    const cost = estimateAdvertisedToolTokens(compact);
    mandatoryTools.push({ tool, isAsk: isNarrowAsk, compact, cost });
    mandatoryCost += cost;
  }

  if (mandatoryTools.length > 0 && usedTokens + mandatoryCost > directive.share) {
    return {
      ok: false,
      message: `Cannot fold ${directive.serverName} into lazy mode within its ${directive.share}-token budget: ${mandatoryTools.length} tools require native entries (per-tool ask rules or taskSupport="required"), needing ${usedTokens + mandatoryCost} tokens. Raise ${AGY_EXTERNAL_MCP_BUDGET_ENV} or simplify per-tool rules.`,
    };
  }

  for (const entry of mandatoryTools) {
    advertised.push(entry.compact);
    pinnedNames.add(entry.tool.name);
    if (entry.isAsk) pinnedAskNames.add(entry.tool.name);
    usedTokens += entry.cost;
  }

  // Opportunistically pin narrow `ask` tools when `tools_call` is not broadly allowed
  // (unpinned tools remain safely prompt-gated on `tools_call`).
  if (!broadAllowCoversCallTool) {
    for (const tool of deduplicated) {
      if (pinnedNames.has(tool.name)) continue;
      if (
        !hasNarrowAskRuleForTool(permissionRules, directive.serverName, tool.name, callToolName)
      ) {
        continue;
      }
      const compact = buildCompactToolDefinition(tool, helpToolName);
      const cost = estimateAdvertisedToolTokens(compact);
      if (usedTokens + cost > directive.share) continue;
      advertised.push(compact);
      pinnedNames.add(tool.name);
      pinnedAskNames.add(tool.name);
      usedTokens += cost;
    }
  }

  // Opportunistically pin narrow `allow` tools within budget so agy can auto-approve them.
  let pinnedAllowCount = 0;
  for (const tool of deduplicated) {
    if (pinnedAllowCount >= MAX_PINNED_ALLOW_TOOLS || pinnedNames.has(tool.name)) continue;
    if (
      !hasNarrowAllowRuleForTool(permissionRules, directive.serverName, tool.name, callToolName)
    ) {
      continue;
    }
    const compact = buildCompactToolDefinition(tool, helpToolName);
    const cost = estimateAdvertisedToolTokens(compact);
    if (usedTokens + cost > directive.share) continue;
    advertised.push(compact);
    pinnedNames.add(tool.name);
    pinnedAllowCount += 1;
    usedTokens += cost;
  }

  return {
    ok: true,
    snapshot: {
      mode: 'lazy',
      serverName: directive.serverName,
      helpToolName,
      callToolName,
      toolsByName,
      toolOrder,
      pinnedAskNames,
    },
    advertisedTools: advertised,
  };
}

function tokenizeName(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

function rankToolSuggestions(
  snapshot: ProxyCatalogSnapshot,
  query: string,
  limit: number,
  permissionRules: AgyMcpPermissionRules = EMPTY_PERMISSION_RULES
): Array<{ readonly tool: UpstreamMcpTool; readonly score: number }> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const queryTokens = tokenizeName(needle);
  const scored: Array<{ readonly tool: UpstreamMcpTool; readonly score: number }> = [];

  for (const name of snapshot.toolOrder) {
    if (isToolDeniedByRules(permissionRules, snapshot.serverName, name)) continue;
    const tool = snapshot.toolsByName.get(name)!;
    const lowerName = name.toLowerCase();
    const lowerDesc = (tool.description ?? '').toLowerCase();
    let score = 0;

    if (lowerName === needle) score += 100;
    else if (lowerName.includes(needle)) score += 50;
    else if (needle.includes(lowerName) && lowerName.length >= 4) score += 30;
    if (lowerDesc.includes(needle)) score += 15;

    const nameTokens = new Set(tokenizeName(name));
    for (const token of queryTokens) {
      if (nameTokens.has(token)) score += 20;
      else if (lowerName.includes(token)) score += 12;
      else if (lowerDesc.includes(token)) score += 4;
    }

    if (score > 0) scored.push({ tool, score });
  }

  scored.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
  return scored.slice(0, limit);
}

export function buildHelpToolResponse(
  snapshot: ProxyCatalogSnapshot,
  rawArgs: unknown,
  permissionRules: AgyMcpPermissionRules = EMPTY_PERMISSION_RULES
): {
  readonly content: Array<{ readonly type: 'text'; readonly text: string }>;
  readonly isError?: true;
} {
  const args = isPlainObject(rawArgs) ? rawArgs : {};
  const visibleOrder = snapshot.toolOrder.filter(
    (name) => !isToolDeniedByRules(permissionRules, snapshot.serverName, name)
  );
  const requestedNames: string[] = [];
  if (typeof args.tool === 'string' && args.tool.trim().length > 0) {
    requestedNames.push(args.tool.trim());
  }
  if (Array.isArray(args.tools)) {
    for (const item of args.tools) {
      if (typeof item === 'string' && item.trim().length > 0) {
        requestedNames.push(item.trim());
      }
    }
  }
  const uniqueRequested = [...new Set(requestedNames)];

  if (uniqueRequested.length > 0) {
    const capped = uniqueRequested.slice(0, HELP_BATCH_MAX_TOOLS);
    const results: Array<Record<string, unknown>> = [];
    let chars = 0;
    let truncated = uniqueRequested.length > capped.length;

    for (const name of capped) {
      const denied = isToolDeniedByRules(permissionRules, snapshot.serverName, name);
      const tool = denied ? undefined : snapshot.toolsByName.get(name);
      const entry: Record<string, unknown> = tool
        ? {
            name: tool.name,
            ...(tool.title ? { title: tool.title } : {}),
            description: tool.description ?? '',
            inputSchema: tool.inputSchema ?? { type: 'object' },
            ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
            ...(tool.annotations ? { annotations: tool.annotations } : {}),
            ...(tool.execution ? { execution: tool.execution } : {}),
          }
        : denied
          ? { name, error: 'Denied by agy permission rules' }
          : {
              name,
              error: 'Unknown tool',
              suggestions: rankToolSuggestions(snapshot, name, 5, permissionRules).map(
                (item) => item.tool.name
              ),
            };
      const serializedLen = JSON.stringify(entry).length;
      if (results.length > 0 && chars + serializedLen > HELP_RESPONSE_MAX_CHARS) {
        truncated = true;
        break;
      }
      results.push(entry);
      chars += serializedLen;
    }

    const payload =
      uniqueRequested.length === 1 && results.length === 1
        ? results[0]!
        : {
            server: snapshot.serverName,
            tools: results,
            ...(truncated ? { truncated: true, requestedCount: uniqueRequested.length } : {}),
          };
    const isError =
      uniqueRequested.length === 1 &&
      (isToolDeniedByRules(permissionRules, snapshot.serverName, uniqueRequested[0]!) ||
        !snapshot.toolsByName.has(uniqueRequested[0]!));
    return {
      ...(isError ? { isError: true as const } : {}),
      content: [{ type: 'text', text: JSON.stringify(payload) }],
    };
  }

  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (query.length > 0) {
    const ranked = rankToolSuggestions(snapshot, query, SEARCH_MAX_RESULTS, permissionRules);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            server: snapshot.serverName,
            query,
            totalTools: visibleOrder.length,
            matches: ranked.map(({ tool }) => ({
              name: tool.name,
              summary: summarizeDescription(tool.description, HELP_INDEX_SUMMARY_MAX_CHARS),
            })),
          }),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          server: snapshot.serverName,
          mode: snapshot.mode,
          totalTools: visibleOrder.length,
          tools: visibleOrder.map((name) => {
            const tool = snapshot.toolsByName.get(name)!;
            return {
              name: tool.name,
              summary: summarizeDescription(tool.description, HELP_INDEX_SUMMARY_MAX_CHARS),
            };
          }),
        }),
      },
    ],
  };
}

export function unwrapProxyCallRequest(
  snapshot: ProxyCatalogSnapshot,
  rawArgs: unknown,
  permissionLoad: AgyMcpPermissionLoadResult | AgyMcpPermissionRules = OK_EMPTY_PERMISSION_LOAD
):
  | { readonly ok: true; readonly tool: string; readonly arguments: Record<string, unknown> }
  | { readonly ok: false; readonly message: string } {
  const normalizedLoad: AgyMcpPermissionLoadResult =
    'status' in permissionLoad ? permissionLoad : { status: 'ok', rules: permissionLoad };
  if (normalizedLoad.status === 'unreadable') {
    return {
      ok: false,
      message: `Cannot invoke tools through ${snapshot.callToolName} while agy permission files are unreadable (${normalizedLoad.reason}).`,
    };
  }
  const permissionRules = normalizedLoad.rules;

  if (!isPlainObject(rawArgs) || typeof rawArgs.tool !== 'string' || !rawArgs.tool.trim()) {
    return {
      ok: false,
      message: `Missing required string "tool". Call ${snapshot.helpToolName}({}) to list available tools on ${snapshot.serverName}.`,
    };
  }
  const targetTool = rawArgs.tool.trim();
  if (isToolDeniedByRules(permissionRules, snapshot.serverName, targetTool)) {
    return {
      ok: false,
      message: `Tool "${targetTool}" on ${snapshot.serverName} is denied by agy permission rules.`,
    };
  }
  const narrowAsk = hasNarrowAskRuleForTool(
    permissionRules,
    snapshot.serverName,
    targetTool,
    snapshot.callToolName
  );
  const broadAllow = isToolAllowedByRules(
    permissionRules,
    snapshot.serverName,
    snapshot.callToolName
  );
  if (narrowAsk && (snapshot.pinnedAskNames.has(targetTool) || broadAllow)) {
    return {
      ok: false,
      message: `Tool "${targetTool}" on ${snapshot.serverName} is governed by a per-tool agy ask rule and cannot be called through ${snapshot.callToolName}; invoke "${targetTool}" directly so agy evaluates its permission prompt.`,
    };
  }
  if (!snapshot.toolsByName.has(targetTool)) {
    const suggestions = rankToolSuggestions(snapshot, targetTool, 5, permissionRules).map(
      (item) => item.tool.name
    );
    const hint =
      suggestions.length > 0
        ? ` Closest matches: ${suggestions.join(', ')}.`
        : ` Call ${snapshot.helpToolName}({query: "..."}) to search available tools.`;
    return {
      ok: false,
      message: `Unknown tool "${targetTool}" on ${snapshot.serverName}.${hint}`,
    };
  }

  let forwardedArgs: Record<string, unknown> = {};
  const rawInner = rawArgs.arguments;
  if (rawInner !== undefined && rawInner !== null) {
    if (isPlainObject(rawInner)) {
      forwardedArgs = rawInner;
    } else if (typeof rawInner === 'string') {
      const trimmed = rawInner.trim();
      if (trimmed.length > 0) {
        try {
          const parsed: unknown = JSON.parse(trimmed);
          if (!isPlainObject(parsed)) {
            return {
              ok: false,
              message: `"arguments" for "${targetTool}" must be a JSON object. Read ${snapshot.helpToolName}({tool:"${targetTool}"}) for its schema.`,
            };
          }
          forwardedArgs = parsed;
        } catch {
          return {
            ok: false,
            message: `"arguments" for "${targetTool}" was a malformed JSON string; pass a JSON object. Read ${snapshot.helpToolName}({tool:"${targetTool}"}) for its schema.`,
          };
        }
      }
    } else {
      return {
        ok: false,
        message: `"arguments" for "${targetTool}" must be a JSON object. Read ${snapshot.helpToolName}({tool:"${targetTool}"}) for its schema.`,
      };
    }
  }

  return { ok: true, tool: targetTool, arguments: forwardedArgs };
}

/**
 * Extracts a JSON-RPC response object strictly matching `expectedId` from either a plain
 * `application/json` body or an MCP Streamable HTTP `text/event-stream` body.
 */
export function parseMcpRpcResponseBody(
  bodyText: string,
  contentType: string | null,
  expectedId: JsonRpcId
): Record<string, unknown> | null {
  const lowerType = (contentType ?? '').toLowerCase();
  if (lowerType.includes('text/event-stream')) {
    const lines = bodyText.split(/\r\n|\n|\r/);
    let dataLines: string[] = [];

    const flushEvent = (): Record<string, unknown> | null => {
      if (dataLines.length === 0) return null;
      const payload = dataLines.join('\n').trim();
      dataLines = [];
      if (!payload) return null;
      try {
        const parsed: unknown = JSON.parse(payload);
        if (!isPlainObject(parsed)) return null;
        if (('result' in parsed || 'error' in parsed) && parsed.id === expectedId) {
          return parsed;
        }
      } catch {
        // Ignore non-JSON SSE keepalives/events.
      }
      return null;
    };

    for (const line of lines) {
      if (line === '') {
        const found = flushEvent();
        if (found) return found;
        continue;
      }
      if (line.startsWith(':')) continue;
      if (line.startsWith('data:')) {
        const value = line.slice(5);
        dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
      }
    }
    return flushEvent();
  }

  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (isPlainObject(parsed)) {
      if (('result' in parsed || 'error' in parsed) && parsed.id === expectedId) {
        return parsed;
      }
      return null;
    }
    if (Array.isArray(parsed)) {
      const matched = parsed.find(
        (entry) =>
          isPlainObject(entry) && ('result' in entry || 'error' in entry) && entry.id === expectedId
      );
      if (isPlainObject(matched)) return matched;
    }
  } catch {
    return null;
  }
  return null;
}

function parseUpstreamTool(raw: unknown): UpstreamMcpTool | null {
  if (!isPlainObject(raw) || typeof raw.name !== 'string' || raw.name.length === 0) return null;
  return {
    name: raw.name,
    ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    ...('inputSchema' in raw ? { inputSchema: raw.inputSchema } : {}),
    ...('outputSchema' in raw ? { outputSchema: raw.outputSchema } : {}),
    ...(isPlainObject(raw.annotations) ? { annotations: raw.annotations } : {}),
    ...(isPlainObject(raw.execution) ? { execution: raw.execution } : {}),
    ...(isPlainObject(raw._meta) ? { _meta: raw._meta } : {}),
    raw,
  };
}

async function readBoundedRequestBody(job: McpRelayRequest): Promise<Buffer> {
  if (job.body !== undefined) return job.body;
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of job.request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += part.length;
    if (bytes > MAX_REQUEST_BODY_BYTES) throw new Error('MCP request is too large.');
    chunks.push(part);
  }
  job.body = Buffer.concat(chunks);
  return job.body;
}

type StreamReadOutcome =
  | { readonly kind: 'rpc'; readonly rpc: Record<string, unknown>; readonly bytesRead: number }
  | {
      readonly kind: 'resume';
      readonly lastEventId: string;
      readonly retryMs?: number;
      readonly bytesRead: number;
    }
  | { readonly kind: 'error'; readonly message: string };

async function readRpcFromResponse(
  response: Response,
  expectedId: JsonRpcId,
  maxBytes: number,
  onServerPing?: (pingId: JsonRpcId) => Promise<void>
): Promise<StreamReadOutcome> {
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (!response.body) {
    return { kind: 'error', message: 'Upstream MCP server returned an empty tools/list response.' };
  }

  if (!contentType.includes('text/event-stream')) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytesRead = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        bytesRead += value.byteLength;
        if (bytesRead > maxBytes) {
          await reader.cancel();
          return { kind: 'error', message: 'MCP tools/list response is too large.' };
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const text = Buffer.concat(chunks).toString('utf8');
    const rpc = parseMcpRpcResponseBody(text, contentType, expectedId);
    if (!rpc) {
      return {
        kind: 'error',
        message: 'Upstream MCP server returned an unreadable tools/list response.',
      };
    }
    return { kind: 'rpc', rpc, bytesRead };
  }

  // Streamable HTTP SSE: parse incrementally so open streams finish as soon as our
  // matching JSON-RPC response arrives, standard MCP `ping` requests are answered inline,
  // resumable disconnects carry Last-Event-ID, and unsupported server-to-client requests fail fast.
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let bytesRead = 0;
  let pendingLine = '';
  let lastEndedWithCr = false;
  let dataLines: string[] = [];
  let lastEventId: string | undefined;
  let retryMs: number | undefined;

  const inspectEvent = async (): Promise<StreamReadOutcome | null> => {
    if (dataLines.length === 0) return null;
    const payload = dataLines.join('\n').trim();
    dataLines = [];
    if (!payload) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return null;
    }
    if (!isPlainObject(parsed)) return null;
    if (('result' in parsed || 'error' in parsed) && parsed.id === expectedId) {
      return { kind: 'rpc', rpc: parsed, bytesRead };
    }
    if (typeof parsed.method === 'string' && isJsonRpcId(parsed.id)) {
      if (parsed.method === 'ping' && onServerPing) {
        await onServerPing(parsed.id);
        return null;
      }
      return {
        kind: 'error',
        message: `Upstream MCP server sent interactive request "${parsed.method}" during tools/list.`,
      };
    }
    return null;
  };

  const processLine = async (line: string): Promise<StreamReadOutcome | null> => {
    if (line === '') return await inspectEvent();
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') {
      dataLines.push(value);
    } else if (field === 'id' && !value.includes('\0')) {
      lastEventId = value;
    } else if (field === 'retry' && /^\d+$/.test(value)) {
      retryMs = Number.parseInt(value, 10);
    }
    return null;
  };

  const drainBuffer = async (chunkText: string): Promise<StreamReadOutcome | null> => {
    let text = chunkText;
    if (lastEndedWithCr) {
      lastEndedWithCr = false;
      if (text.startsWith('\n')) text = text.slice(1);
    }
    pendingLine += text;
    let start = 0;
    for (let i = 0; i < pendingLine.length; i++) {
      const ch = pendingLine[i];
      if (ch === '\n' || ch === '\r') {
        const line = pendingLine.slice(start, i);
        if (ch === '\r') {
          if (i + 1 < pendingLine.length && pendingLine[i + 1] === '\n') {
            i += 1;
          } else if (i + 1 === pendingLine.length) {
            lastEndedWithCr = true;
          }
        }
        start = i + 1;
        const outcome = await processLine(line);
        if (outcome) return outcome;
      }
    }
    pendingLine = pendingLine.slice(start);
    return null;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        await reader.cancel();
        return { kind: 'error', message: 'MCP tools/list response is too large.' };
      }
      const outcome = await drainBuffer(decoder.decode(value, { stream: true }));
      if (outcome) {
        await reader.cancel();
        return outcome;
      }
    }
    const tail = decoder.decode();
    if (tail) {
      const outcome = await drainBuffer(tail);
      if (outcome) return outcome;
    }
    if (pendingLine.length > 0) {
      const outcome = await processLine(pendingLine);
      if (outcome) return outcome;
    }
    const finalOutcome = await inspectEvent();
    if (finalOutcome) return finalOutcome;
    if (lastEventId !== undefined) {
      return { kind: 'resume', lastEventId, retryMs, bytesRead };
    }
    return {
      kind: 'error',
      message: 'Upstream MCP server closed tools/list stream without a matching response.',
    };
  } finally {
    reader.releaseLock();
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal.aborted) return Promise.reject(new Error('MCP request cancelled.'));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('MCP request cancelled.'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function buildUpstreamHeaders(
  request: IncomingMessage,
  credentials: Record<string, string>,
  overrides: {
    readonly sessionId?: string;
    readonly lastEventId?: string;
    readonly isGetResume?: boolean;
  } = {}
): Headers {
  const headers = new Headers(credentials);
  for (const name of PASSTHROUGH_REQUEST_HEADERS) {
    if (overrides.isGetResume && name === 'content-type') continue;
    const value = request.headers[name];
    if (typeof value === 'string' && value.length <= MAX_HEADER_VALUE_LENGTH) {
      headers.set(name, value);
    }
  }
  if (overrides.sessionId && overrides.sessionId.length <= MAX_HEADER_VALUE_LENGTH) {
    headers.set('mcp-session-id', overrides.sessionId);
  }
  if (overrides.lastEventId && overrides.lastEventId.length <= MAX_HEADER_VALUE_LENGTH) {
    headers.set('last-event-id', overrides.lastEventId);
  }
  if (overrides.isGetResume) {
    headers.set('accept', 'text/event-stream');
    headers.delete('content-type');
  } else {
    if (!headers.has('accept')) {
      headers.set('accept', 'application/json, text/event-stream');
    }
    headers.set('content-type', 'application/json');
  }
  return headers;
}

function writeJsonRpcResponse(
  job: McpRelayRequest,
  payload: Record<string, unknown>,
  protocolHeaders: Record<string, string>
): void {
  if (job.response.destroyed || job.response.writableEnded) return;
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...protocolHeaders,
  };
  if (!job.response.headersSent) {
    job.response.writeHead(200, headers);
  }
  job.response.end(JSON.stringify(payload));
}

function collectResponseProtocolHeaders(
  request: IncomingMessage,
  upstream?: Response
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of PASSTHROUGH_RESPONSE_HEADERS) {
    const fromUpstream = upstream?.headers.get(name);
    if (fromUpstream && fromUpstream.length <= MAX_HEADER_VALUE_LENGTH) {
      out[name] = fromUpstream;
      continue;
    }
    const fromRequest = request.headers[name];
    if (typeof fromRequest === 'string' && fromRequest.length <= MAX_HEADER_VALUE_LENGTH) {
      out[name] = fromRequest;
    }
  }
  return out;
}

function getRequestSessionKey(request: IncomingMessage): string {
  const value = request.headers['mcp-session-id'];
  if (typeof value === 'string' && value.length <= MAX_HEADER_VALUE_LENGTH) {
    return value;
  }
  return '';
}

async function fetchAllUpstreamTools(options: {
  readonly baseFetch: typeof fetch;
  readonly job: McpRelayRequest;
  readonly url: string;
  readonly credentials: Record<string, string>;
  readonly initialId: JsonRpcId;
  readonly signal: AbortSignal;
  readonly delay: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<
  | {
      readonly kind: 'ok';
      readonly tools: UpstreamMcpTool[];
      readonly protocolHeaders: Record<string, string>;
    }
  | {
      readonly kind: 'rpc_error';
      readonly errorResponse: Record<string, unknown>;
      readonly protocolHeaders: Record<string, string>;
    }
  | {
      readonly kind: 'proxy_error';
      readonly message: string;
      readonly protocolHeaders: Record<string, string>;
    }
  | { readonly kind: 'http_error'; readonly response: Response }
> {
  const disconnected = new AbortController();
  const abort = () => disconnected.abort();
  options.job.response.once('close', abort);
  const fetchSignal = AbortSignal.any([options.signal, disconnected.signal]);
  const tools: UpstreamMcpTool[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let sessionIdOverride: string | undefined;
  let lastProtocolHeaders = collectResponseProtocolHeaders(options.job.request);
  let remainingBytes = MAX_LIST_RESPONSE_BYTES;

  try {
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const rpcId: JsonRpcId = page === 0 ? options.initialId : allocateProxyRpcId('list');
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: rpcId,
        method: 'tools/list',
        ...(cursor ? { params: { cursor } } : {}),
      });
      let upstream = await options.baseFetch(options.url, {
        method: 'POST',
        headers: buildUpstreamHeaders(options.job.request, options.credentials, {
          sessionId: sessionIdOverride,
        }),
        body,
        signal: fetchSignal,
        redirect: 'error',
        credentials: 'omit',
      });
      if (!upstream.ok) {
        await upstream.body?.cancel();
        return { kind: 'http_error', response: upstream };
      }
      lastProtocolHeaders = collectResponseProtocolHeaders(options.job.request, upstream);
      if (lastProtocolHeaders['mcp-session-id']) {
        sessionIdOverride = lastProtocolHeaders['mcp-session-id'];
      }

      const replyPing = async (pingId: JsonRpcId): Promise<void> => {
        const pong = await options.baseFetch(options.url, {
          method: 'POST',
          headers: buildUpstreamHeaders(options.job.request, options.credentials, {
            sessionId: sessionIdOverride,
          }),
          body: JSON.stringify({ jsonrpc: '2.0', id: pingId, result: {} }),
          signal: fetchSignal,
          redirect: 'error',
          credentials: 'omit',
        });
        await pong.body?.cancel();
      };

      let outcome = await readRpcFromResponse(upstream, rpcId, remainingBytes, replyPing);
      let resumeHop = 0;
      while (outcome.kind === 'resume' && resumeHop < MAX_SSE_RESUME_HOPS) {
        remainingBytes -= outcome.bytesRead;
        if (remainingBytes <= 0) {
          return {
            kind: 'proxy_error',
            message: 'MCP tools/list response is too large.',
            protocolHeaders: lastProtocolHeaders,
          };
        }
        const waitMs = outcome.retryMs ?? 0;
        if (waitMs > MAX_SSE_RETRY_WAIT_MS) {
          return {
            kind: 'proxy_error',
            message: `Upstream MCP server requested SSE retry delay (${waitMs}ms) exceeding proxy timeout.`,
            protocolHeaders: lastProtocolHeaders,
          };
        }
        if (waitMs > 0) await options.delay(waitMs, fetchSignal);
        resumeHop += 1;
        upstream = await options.baseFetch(options.url, {
          method: 'GET',
          headers: buildUpstreamHeaders(options.job.request, options.credentials, {
            sessionId: sessionIdOverride,
            lastEventId: outcome.lastEventId,
            isGetResume: true,
          }),
          signal: fetchSignal,
          redirect: 'error',
          credentials: 'omit',
        });
        if (!upstream.ok) {
          await upstream.body?.cancel();
          return { kind: 'http_error', response: upstream };
        }
        lastProtocolHeaders = collectResponseProtocolHeaders(options.job.request, upstream);
        if (lastProtocolHeaders['mcp-session-id']) {
          sessionIdOverride = lastProtocolHeaders['mcp-session-id'];
        }
        outcome = await readRpcFromResponse(upstream, rpcId, remainingBytes, replyPing);
      }

      if (outcome.kind === 'resume') {
        return {
          kind: 'proxy_error',
          message: 'Upstream MCP server exceeded SSE resume limit during tools/list.',
          protocolHeaders: lastProtocolHeaders,
        };
      }
      if (outcome.kind === 'error') {
        return {
          kind: 'proxy_error',
          message: outcome.message,
          protocolHeaders: lastProtocolHeaders,
        };
      }

      remainingBytes -= outcome.bytesRead;
      const rpc = outcome.rpc;
      if ('error' in rpc && rpc.error !== undefined) {
        return {
          kind: 'rpc_error',
          errorResponse: { ...rpc, id: options.initialId },
          protocolHeaders: lastProtocolHeaders,
        };
      }

      const result = isPlainObject(rpc.result) ? rpc.result : undefined;
      if (!result || !Array.isArray(result.tools)) {
        return {
          kind: 'proxy_error',
          message: 'Upstream MCP server returned an invalid tools/list result.',
          protocolHeaders: lastProtocolHeaders,
        };
      }
      if (
        'nextCursor' in result &&
        result.nextCursor !== undefined &&
        typeof result.nextCursor !== 'string'
      ) {
        return {
          kind: 'proxy_error',
          message: 'Upstream MCP server returned an invalid tools/list nextCursor.',
          protocolHeaders: lastProtocolHeaders,
        };
      }

      for (const rawTool of result.tools) {
        const parsed = parseUpstreamTool(rawTool);
        if (!parsed) {
          return {
            kind: 'proxy_error',
            message: 'Upstream MCP server returned an invalid tool definition.',
            protocolHeaders: lastProtocolHeaders,
          };
        }
        tools.push(parsed);
        if (tools.length > MAX_CACHED_TOOLS) {
          return {
            kind: 'proxy_error',
            message: `MCP tools/list exceeded proxy limit of ${MAX_CACHED_TOOLS} tools.`,
            protocolHeaders: lastProtocolHeaders,
          };
        }
      }

      const nextCursor =
        typeof result.nextCursor === 'string' && result.nextCursor.length > 0
          ? result.nextCursor
          : undefined;
      if (!nextCursor) {
        return { kind: 'ok', tools, protocolHeaders: lastProtocolHeaders };
      }
      if (seenCursors.has(nextCursor)) {
        return {
          kind: 'proxy_error',
          message: 'MCP tools/list pagination cursor cycle detected.',
          protocolHeaders: lastProtocolHeaders,
        };
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    return {
      kind: 'proxy_error',
      message: `MCP tools/list exceeded proxy limit of ${MAX_LIST_PAGES} pages.`,
      protocolHeaders: lastProtocolHeaders,
    };
  } finally {
    options.job.response.removeListener('close', abort);
  }
}

/**
 * Wraps `McpAuthenticationIO` so `agy` loopback relay requests carrying `x-lody-mcp-proxy`
 * get adaptive three-tier tool budgeting (`raw` / `compact` / `lazy`) with per-session
 * catalog isolation and agy permission-rule enforcement, while every other agent and
 * non-POST/SSE request passes through `base.forward` unchanged.
 */
export function withAgyMcpBudgetProxy(
  base: McpAuthenticationIO,
  options: AgyMcpProxyOptions = {}
): McpAuthenticationIO {
  const requestLeases = new WeakMap<IncomingMessage, ProxyLeaseState>();
  const loadRules = options.loadPermissionRules ?? loadAgyMcpPermissionRules;
  const delay = options.delay ?? abortableDelay;

  return {
    ...base,
    relay: async (offer) => {
      const state: ProxyLeaseState = {
        endpointUrl: '',
        snapshots: new Map(),
        getSnapshot(sessionKey) {
          return this.snapshots.get(sessionKey);
        },
        setSnapshot(sessionKey, snapshot) {
          if (!this.snapshots.has(sessionKey) && this.snapshots.size >= MAX_SESSIONS_PER_LEASE) {
            const oldest = this.snapshots.keys().next().value;
            if (oldest !== undefined) this.snapshots.delete(oldest);
          }
          this.snapshots.set(sessionKey, snapshot);
        },
        deleteSnapshot(sessionKey) {
          this.snapshots.delete(sessionKey);
        },
        clear() {
          this.snapshots.clear();
        },
      };
      const endpoint = await base.relay((job) => {
        requestLeases.set(job.request, state);
        return offer(job);
      });
      state.endpointUrl = endpoint.url;
      activeRelayUrls.add(endpoint.url);
      return {
        ...endpoint,
        close: async () => {
          state.clear();
          activeRelayUrls.delete(endpoint.url);
          relayContexts.delete(endpoint.url);
          await endpoint.close();
        },
      };
    },
    forward: async (job, url, credentials, signal) => {
      const directive = parseAgyMcpProxyHeader(job.request.headers[AGY_MCP_PROXY_HEADER]);
      const lease = requestLeases.get(job.request);
      const reqSessionKey = getRequestSessionKey(job.request);

      if (job.request.method === 'DELETE' && lease) {
        lease.deleteSnapshot(reqSessionKey);
      }

      if (!directive || job.request.method !== 'POST' || !lease) {
        return base.forward(job, url, credentials, signal);
      }

      const body = await readBoundedRequestBody(job);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        return base.forward(job, url, credentials, signal);
      }
      if (!isPlainObject(parsed)) {
        return base.forward(job, url, credentials, signal);
      }

      const rpc = parsed as JsonRpcRequest;
      if (!isJsonRpcId(rpc.id) || typeof rpc.method !== 'string') {
        return base.forward(job, url, credentials, signal);
      }

      const permissionLoad = loadRules(relayContexts.get(lease.endpointUrl));
      const permissionRules =
        permissionLoad.status === 'ok' ? permissionLoad.rules : EMPTY_PERMISSION_RULES;

      if (rpc.method === 'tools/list') {
        const params = isPlainObject(rpc.params) ? rpc.params : undefined;
        if (typeof params?.cursor === 'string' && params.cursor.length > 0) {
          return base.forward(job, url, credentials, signal);
        }
        const fetched = await fetchAllUpstreamTools({
          baseFetch: base.fetch,
          job,
          url,
          credentials,
          initialId: rpc.id,
          signal,
          delay,
        });
        if (fetched.kind === 'http_error') {
          if (fetched.response.status === 404) lease.deleteSnapshot(reqSessionKey);
          return fetched.response;
        }
        if (fetched.kind === 'rpc_error') {
          writeJsonRpcResponse(job, fetched.errorResponse, fetched.protocolHeaders);
          return undefined;
        }
        if (fetched.kind === 'proxy_error') {
          writeJsonRpcResponse(
            job,
            {
              jsonrpc: '2.0',
              id: rpc.id,
              error: { code: -32603, message: fetched.message },
            },
            fetched.protocolHeaders
          );
          return undefined;
        }
        const rewritten = rewriteToolsForAgyBudget(fetched.tools, directive, permissionLoad);
        if (!rewritten.ok) {
          writeJsonRpcResponse(
            job,
            {
              jsonrpc: '2.0',
              id: rpc.id,
              error: { code: -32603, message: rewritten.message },
            },
            fetched.protocolHeaders
          );
          return undefined;
        }
        const effectiveSessionKey = fetched.protocolHeaders['mcp-session-id'] ?? reqSessionKey;
        lease.setSnapshot(effectiveSessionKey, rewritten.snapshot);
        writeJsonRpcResponse(
          job,
          { jsonrpc: '2.0', id: rpc.id, result: { tools: rewritten.advertisedTools } },
          fetched.protocolHeaders
        );
        return undefined;
      }

      if (rpc.method === 'tools/call') {
        const params = isPlainObject(rpc.params) ? rpc.params : undefined;
        const invokedName = typeof params?.name === 'string' ? params.name : '';
        if (!invokedName) {
          return base.forward(job, url, credentials, signal);
        }

        // Enforce explicit agy deny rules before any upstream forwarding or warmup.
        const isSyntheticProxyCall =
          invokedName === 'tools_call' || invokedName.startsWith('lody_mcp_call');
        if (permissionLoad.status === 'ok') {
          const directDenied =
            !isSyntheticProxyCall &&
            isToolDeniedByRules(permissionRules, directive.serverName, invokedName);
          const wrappedTarget =
            isSyntheticProxyCall &&
            isPlainObject(params?.arguments) &&
            typeof params.arguments.tool === 'string'
              ? params.arguments.tool.trim()
              : '';
          const wrappedDenied =
            wrappedTarget.length > 0 &&
            isToolDeniedByRules(permissionRules, directive.serverName, wrappedTarget);
          if (directDenied || wrappedDenied) {
            const deniedName = directDenied ? invokedName : wrappedTarget;
            writeJsonRpcResponse(
              job,
              {
                jsonrpc: '2.0',
                id: rpc.id,
                result: {
                  isError: true,
                  content: [
                    {
                      type: 'text',
                      text: `Tool "${deniedName}" on ${directive.serverName} is denied by agy permission rules.`,
                    },
                  ],
                },
              },
              collectResponseProtocolHeaders(job.request)
            );
            return undefined;
          }
        }

        let snapshot = lease.getSnapshot(reqSessionKey);
        if (
          !snapshot &&
          (invokedName === 'tools_help' ||
            invokedName === 'tools_call' ||
            invokedName.startsWith('lody_mcp_help') ||
            invokedName.startsWith('lody_mcp_call'))
        ) {
          const fetched = await fetchAllUpstreamTools({
            baseFetch: base.fetch,
            job,
            url,
            credentials,
            initialId: allocateProxyRpcId('warmup'),
            signal,
            delay,
          });
          if (fetched.kind === 'http_error') {
            if (fetched.response.status === 404) lease.deleteSnapshot(reqSessionKey);
            return fetched.response;
          }
          if (fetched.kind === 'rpc_error') {
            writeJsonRpcResponse(
              job,
              { ...fetched.errorResponse, id: rpc.id },
              fetched.protocolHeaders
            );
            return undefined;
          }
          if (fetched.kind === 'proxy_error') {
            writeJsonRpcResponse(
              job,
              {
                jsonrpc: '2.0',
                id: rpc.id,
                error: { code: -32603, message: fetched.message },
              },
              fetched.protocolHeaders
            );
            return undefined;
          }
          const rewritten = rewriteToolsForAgyBudget(fetched.tools, directive, permissionLoad);
          if (!rewritten.ok) {
            writeJsonRpcResponse(
              job,
              {
                jsonrpc: '2.0',
                id: rpc.id,
                error: { code: -32603, message: rewritten.message },
              },
              fetched.protocolHeaders
            );
            return undefined;
          }
          snapshot = rewritten.snapshot;
          const effectiveSessionKey = fetched.protocolHeaders['mcp-session-id'] ?? reqSessionKey;
          lease.setSnapshot(effectiveSessionKey, snapshot);
        }

        if (!snapshot || snapshot.mode === 'raw') {
          const response = await base.forward(job, url, credentials, signal);
          if (response?.status === 404) lease.deleteSnapshot(reqSessionKey);
          return response;
        }

        if (invokedName === snapshot.helpToolName) {
          const result = buildHelpToolResponse(snapshot, params?.arguments, permissionRules);
          writeJsonRpcResponse(
            job,
            { jsonrpc: '2.0', id: rpc.id, result },
            collectResponseProtocolHeaders(job.request)
          );
          return undefined;
        }

        if (snapshot.mode === 'lazy' && invokedName === snapshot.callToolName) {
          const unwrapped = unwrapProxyCallRequest(snapshot, params?.arguments, permissionLoad);
          if (!unwrapped.ok) {
            writeJsonRpcResponse(
              job,
              {
                jsonrpc: '2.0',
                id: rpc.id,
                result: {
                  isError: true,
                  content: [{ type: 'text', text: unwrapped.message }],
                },
              },
              collectResponseProtocolHeaders(job.request)
            );
            return undefined;
          }
          const rewrittenBody = Buffer.from(
            JSON.stringify({
              jsonrpc: '2.0',
              id: rpc.id,
              method: 'tools/call',
              params: {
                ...(isPlainObject(params?._meta) ? { _meta: params._meta } : {}),
                ...(isPlainObject(params?.task) ? { task: params.task } : {}),
                name: unwrapped.tool,
                arguments: unwrapped.arguments,
              },
            }),
            'utf8'
          );
          // Pass a shallow copy with rewritten body so `job.body` stays intact for 401 retry.
          const response = await base.forward(
            { ...job, body: rewrittenBody },
            url,
            credentials,
            signal
          );
          if (response?.status === 404) lease.deleteSnapshot(reqSessionKey);
          return response;
        }

        const response = await base.forward(job, url, credentials, signal);
        if (response?.status === 404) lease.deleteSnapshot(reqSessionKey);
        return response;
      }

      const response = await base.forward(job, url, credentials, signal);
      if (response?.status === 404) lease.deleteSnapshot(reqSessionKey);
      return response;
    },
  };
}
