import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import { isAskUserQuestionPermissionRequest, type AgentConfigCliType } from '@lody/shared';
import { runCommandTextLegacy } from '@lody/shared/node/process';
import type { CodexProfileExecution } from '@/agent/codex-profile-runtime';
import { toShared } from '@/platform/process-options';
import type { TerminalManager } from '@/session/terminal-manager';
import { formatErrorMessage } from '@/utils/format-error';
import type { Logger } from '@/utils/logger';

const BTW_GIT_INIT_TIMEOUT_MS = 5_000;

/**
 * Layer 3 fail-closed kill-switches for `nowledge-mem` (`nmem`).
 * Pointing `NMEM_API_URL` at `127.0.0.1:1` forces millisecond `ECONNREFUSED`
 * short-circuit instead of waiting on an HTTP timeout if any external hook runs.
 */
export const BTW_NMEM_FAIL_CLOSED_ENV = {
  NMEM_IGNORE_HOST_CONFIG: '1',
  NMEM_API_URL: 'http://127.0.0.1:1',
  NMEM_API_KEY: '',
  NMEM_CONFIG_PATH: '/dev/null',
  NMEM_COMMAND: '/bin/false',
} as const;

export const BTW_CODEX_CONFIG_OVERLAY = {
  project_doc_max_bytes: 0,
  include_environment_context: false,
  skills: {
    include_instructions: false,
    bundled: { enabled: false },
  },
  features: {
    hooks: false,
    plugins: false,
  },
} as const;

export type CodexDisabledTableOverrides = {
  readonly mcpServerNames?: readonly string[];
  readonly pluginNames?: readonly string[];
};

const ANTIGRAVITY_AUTH_FILES = [
  path.join('antigravity-cli', 'antigravity-oauth-token'),
  path.join('antigravity-cli', 'installation_id'),
  'jetski-standalone-oauth-token',
] as const;

const isAntigravityAgent = (agentType: string): boolean => {
  const normalized = agentType.trim().toLowerCase();
  return normalized === 'antigravity' || normalized === 'antigravity-acp';
};

const isCodexAgent = (agentType: string): boolean => {
  const normalized = agentType.trim().toLowerCase();
  return normalized === 'codex' || /^codex(?:[-_]|$)/.test(normalized);
};

const isClaudeAgent = (agentType: string): boolean => {
  const normalized = agentType.trim().toLowerCase();
  return normalized === 'claude' || /^claude(?:[-_]|$)/.test(normalized);
};

/**
 * Only providers that natively enforce a read-only mode (`antigravity` `plan`,
 * `claude` `plan`/`dontAsk`, `codex` `read-only`) may receive the real session
 * worktree `cwd` when `readOnlyTools === true`. Providers whose native editing
 * or shell tools bypass ACP fs/terminal (such as built-in `pi`) or unverified
 * custom providers must stay on an empty temporary workdir in text-only mode.
 */
export function supportsBtwNativeReadOnlyTools(agentType: string): boolean {
  return isAntigravityAgent(agentType) || isClaudeAgent(agentType) || isCodexAgent(agentType);
}

const STRIPPED_CODEX_TOML_ROOTS = new Set(['plugins', 'hooks', 'mcp_servers']);

const parseTomlKeySegments = (rawKeyPath: string): string[] => {
  const segments: string[] = [];
  let i = 0;
  const len = rawKeyPath.length;
  while (i < len) {
    while (i < len && (rawKeyPath[i] === ' ' || rawKeyPath[i] === '\t' || rawKeyPath[i] === '.')) {
      i += 1;
    }
    if (i >= len) break;
    const ch = rawKeyPath[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      let segment = '';
      while (i < len && rawKeyPath[i] !== quote) {
        if (quote === '"' && rawKeyPath[i] === '\\' && i + 1 < len) {
          i += 1;
        }
        segment += rawKeyPath[i]!;
        i += 1;
      }
      if (i < len && rawKeyPath[i] === quote) {
        i += 1;
      }
      segments.push(segment);
    } else {
      const start = i;
      while (i < len && rawKeyPath[i] !== '.' && rawKeyPath[i] !== ' ' && rawKeyPath[i] !== '\t') {
        i += 1;
      }
      const segment = rawKeyPath.slice(start, i).trim();
      if (segment) segments.push(segment);
    }
  }
  return segments;
};

const extractTomlRootSegment = (rawHeader: string): string | null => {
  const first = parseTomlKeySegments(rawHeader)[0];
  return first ? first.toLowerCase() : null;
};

const extractInlineTableTopKeys = (rawValue: string): string[] => {
  const trimmed = rawValue.trim();
  if (!trimmed.startsWith('{')) return [];
  const keys: string[] = [];
  let depth = 0;
  let inQuote: '"' | "'" | null = null;
  let tokenStart = -1;

  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i]!;
    if (inQuote !== null) {
      if (inQuote === '"' && ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === inQuote) {
        inQuote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (depth === 1 && tokenStart === -1) {
        tokenStart = i;
      }
      inQuote = ch;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      if (depth === 1) {
        tokenStart = i + 1;
      }
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth <= 0) break;
      continue;
    }
    if (depth === 1 && ch === '=' && tokenStart !== -1) {
      const keySlice = trimmed.slice(tokenStart, i).trim();
      const firstSegment = parseTomlKeySegments(keySlice)[0];
      if (firstSegment) keys.push(firstSegment);
      tokenStart = -1;
      continue;
    }
    if (depth === 1 && ch === ',') {
      tokenStart = i + 1;
    }
  }
  return keys;
};

/**
 * Extracts configured `[mcp_servers.<name>]` and `[plugins.<name>]` entry names
 * from a Codex `config.toml` so they can be explicitly disabled via `CODEX_CONFIG` /
 * `LODY_CODEX_PROFILE_CONFIG` overrides when `CODEX_HOME` cannot be redirected
 * (e.g. legacy keyring profiles) or when a real repo `.codex/config.toml` exists.
 */
export function extractCodexDisabledTableOverrides(raw: string): {
  readonly mcpServerNames: string[];
  readonly pluginNames: string[];
} {
  const mcpServers = new Set<string>();
  const plugins = new Set<string>();
  const lines = raw.split(/\r?\n/);
  let currentSection: 'root' | 'mcp_servers' | 'plugins' | 'other' = 'root';
  let multilineQuote: '"""' | "'''" | null = null;

  const recordName = (root: string, name: string | undefined) => {
    const trimmed = name?.trim();
    if (!trimmed) return;
    if (root === 'mcp_servers') mcpServers.add(trimmed);
    else if (root === 'plugins') plugins.add(trimmed);
  };

  for (const line of lines) {
    if (multilineQuote !== null) {
      if (countUnescapedDelimiter(line, multilineQuote) % 2 === 1) {
        multilineQuote = null;
      }
      continue;
    }

    const headerMatch = /^\s*\[\[?\s*(.+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
    if (headerMatch) {
      const segments = parseTomlKeySegments(headerMatch[1] ?? '');
      const root = segments[0]?.toLowerCase() ?? '';
      if (root === 'mcp_servers') {
        currentSection = segments.length === 1 ? 'mcp_servers' : 'other';
        recordName('mcp_servers', segments[1]);
      } else if (root === 'plugins') {
        currentSection = segments.length === 1 ? 'plugins' : 'other';
        recordName('plugins', segments[1]);
      } else {
        currentSection = 'other';
      }
      continue;
    }

    const eqIndex = line.indexOf('=');
    if (eqIndex > 0) {
      const lhs = line.slice(0, eqIndex).trim();
      const rhs = line.slice(eqIndex + 1).trim();
      if (lhs && !lhs.startsWith('#')) {
        const segments = parseTomlKeySegments(lhs);
        if (currentSection === 'root') {
          const root = segments[0]?.toLowerCase() ?? '';
          if (root === 'mcp_servers' || root === 'plugins') {
            if (segments[1]) {
              recordName(root, segments[1]);
            } else {
              for (const inlineKey of extractInlineTableTopKeys(rhs)) {
                recordName(root, inlineKey);
              }
            }
          }
        } else if (currentSection === 'mcp_servers' || currentSection === 'plugins') {
          recordName(currentSection, segments[0]);
        }
      }
    }

    if (countUnescapedDelimiter(line, '"""') % 2 === 1) {
      multilineQuote = '"""';
    } else if (countUnescapedDelimiter(line, "'''") % 2 === 1) {
      multilineQuote = "'''";
    }
  }

  return {
    mcpServerNames: [...mcpServers],
    pluginNames: [...plugins],
  };
}

const countUnescapedDelimiter = (line: string, delimiter: '"""' | "'''"): number => {
  let count = 0;
  let idx = 0;
  while (idx <= line.length - 3) {
    if (line.startsWith(delimiter, idx)) {
      if (delimiter === '"""' && idx > 0 && line[idx - 1] === '\\') {
        idx += 1;
        continue;
      }
      count += 1;
      idx += 3;
      continue;
    }
    idx += 1;
  }
  return count;
};

/**
 * Strips `[plugins.*]`, `[hooks.*]`, `[mcp_servers.*]` sections (including array
 * tables `[[...]]` and top-level direct/dotted keys) from Codex `config.toml`
 * while keeping provider routing, profiles, and other settings intact.
 */
export function stripCodexConfigToml(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const kept: string[] = [];
  let skippingSection = false;
  let inRootTable = true;
  let multilineQuote: '"""' | "'''" | null = null;

  for (const line of lines) {
    if (multilineQuote !== null) {
      if (!skippingSection) {
        kept.push(line);
      }
      if (countUnescapedDelimiter(line, multilineQuote) % 2 === 1) {
        multilineQuote = null;
      }
      continue;
    }

    const headerMatch = /^\s*\[\[?\s*(.+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
    if (headerMatch) {
      inRootTable = false;
      const rootSegment = extractTomlRootSegment(headerMatch[1] ?? '');
      skippingSection = rootSegment !== null && STRIPPED_CODEX_TOML_ROOTS.has(rootSegment);
      if (!skippingSection) {
        kept.push(line);
      }
      continue;
    }

    if (skippingSection) {
      // Track multiline strings even inside skipped sections so embedded `[...]`
      // lines do not prematurely exit skipping.
      if (countUnescapedDelimiter(line, '"""') % 2 === 1) {
        multilineQuote = '"""';
      } else if (countUnescapedDelimiter(line, "'''") % 2 === 1) {
        multilineQuote = "'''";
      }
      continue;
    }

    if (inRootTable) {
      const assignmentMatch =
        /^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))(?:\s*\.\s*[^=]+)?\s*=/.exec(line);
      const rootKey = (
        assignmentMatch?.[1] ??
        assignmentMatch?.[2] ??
        assignmentMatch?.[3] ??
        ''
      ).toLowerCase();
      if (STRIPPED_CODEX_TOML_ROOTS.has(rootKey)) {
        continue;
      }
    }

    kept.push(line);

    if (countUnescapedDelimiter(line, '"""') % 2 === 1) {
      multilineQuote = '"""';
    } else if (countUnescapedDelimiter(line, "'''") % 2 === 1) {
      multilineQuote = "'''";
    }
  }

  return kept.join('\n');
}

/**
 * Strips process-per-session / skip-permissions / duplicate isolation flags from
 * Antigravity launch args and appends the isolated `--gemini-dir` flags.
 */
export function filterAntigravityBtwLaunchArgs(
  args: readonly string[],
  geminiDir: string
): string[] {
  const filtered: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (
      arg === '--process-per-session' ||
      arg === '--dangerously-skip-permissions' ||
      arg === '--disable-telemetry' ||
      arg.startsWith('--disable-telemetry=') ||
      arg === '--include-default-customizations' ||
      arg.startsWith('--include-default-customizations=') ||
      arg.startsWith('--gemini-dir=')
    ) {
      continue;
    }
    if (arg === '--gemini-dir') {
      i += 1;
      continue;
    }
    filtered.push(arg);
  }
  filtered.push(
    '--gemini-dir',
    geminiDir,
    '--include-default-customizations=false',
    '--disable-telemetry'
  );
  return filtered;
}

/**
 * Strips all inherited `NMEM_*` variables, marks `LODY_BTW_AGENT=1`, overlays
 * provider-specific isolation variables, and enforces Layer 3 fail-closed `NMEM_*`.
 */
export function sanitizeBtwEnv(
  baseEnv: NodeJS.ProcessEnv,
  providerOverrides?: Readonly<Record<string, string>>
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (/^NMEM_/i.test(key)) continue;
    next[key] = value;
  }
  next.LODY_BTW_AGENT = '1';
  if (providerOverrides) {
    for (const [key, value] of Object.entries(providerOverrides)) {
      next[key] = value;
    }
  }
  for (const [key, value] of Object.entries(BTW_NMEM_FAIL_CLOSED_ENV)) {
    next[key] = value;
  }
  return next;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const parseJsonObject = (raw: string | undefined): Record<string, unknown> => {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const buildMergedCodexConfigObject = (
  existing: Record<string, unknown>,
  extraDisableOverrides?: CodexDisabledTableOverrides
): Record<string, unknown> => {
  const existingFeatures = isPlainObject(existing.features) ? existing.features : {};
  const merged: Record<string, unknown> = {
    ...existing,
    ...BTW_CODEX_CONFIG_OVERLAY,
    features: {
      ...existingFeatures,
      ...BTW_CODEX_CONFIG_OVERLAY.features,
    },
  };

  if (extraDisableOverrides?.mcpServerNames && extraDisableOverrides.mcpServerNames.length > 0) {
    const existingMcp = isPlainObject(existing.mcp_servers) ? existing.mcp_servers : {};
    const disabledMcp: Record<string, unknown> = { ...existingMcp };
    for (const name of extraDisableOverrides.mcpServerNames) {
      disabledMcp[name] = { enabled: false };
    }
    merged.mcp_servers = disabledMcp;
  }

  if (extraDisableOverrides?.pluginNames && extraDisableOverrides.pluginNames.length > 0) {
    const existingPlugins = isPlainObject(existing.plugins) ? existing.plugins : {};
    const disabledPlugins: Record<string, unknown> = { ...existingPlugins };
    for (const name of extraDisableOverrides.pluginNames) {
      disabledPlugins[name] = { enabled: false };
    }
    merged.plugins = disabledPlugins;
  }

  return merged;
};

export function mergeBtwCodexConfigEnv(
  env: NodeJS.ProcessEnv,
  extraDisableOverrides?: CodexDisabledTableOverrides
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {
    ...env,
    CODEX_CONFIG: JSON.stringify(
      buildMergedCodexConfigObject(parseJsonObject(env.CODEX_CONFIG), extraDisableOverrides)
    ),
  };
  if (env.LODY_CODEX_PROFILE_CONFIG) {
    next.LODY_CODEX_PROFILE_CONFIG = JSON.stringify(
      buildMergedCodexConfigObject(
        parseJsonObject(env.LODY_CODEX_PROFILE_CONFIG),
        extraDisableOverrides
      )
    );
  }
  return next;
}

const FORBIDDEN_PERMISSION_KINDS = new Set([
  'edit',
  'delete',
  'move',
  'execute',
  'fetch',
  'switch_mode',
]);

const READ_ONLY_TOOL_NAMES = new Set([
  'read',
  'read_file',
  'read_text_file',
  'view_file',
  'view_file_outline',
  'view_code_item',
  'glob',
  'grep',
  'grep_search',
  'find_by_name',
  'list_dir',
  'list_files',
  'ls',
  'search',
  'ripgrep',
]);

const FORBIDDEN_TOOL_NAMES = new Set([
  'bash',
  'shell',
  'exec',
  'terminal',
  'run_command',
  'execute_command',
  'write',
  'write_file',
  'write_to_file',
  'write_text_file',
  'edit',
  'edit_file',
  'multi_edit',
  'multiedit',
  'replace_file_content',
  'multi_replace_file_content',
  'notebook_edit',
  'notebookedit',
  'apply_patch',
  'delete',
  'delete_file',
  'remove',
  'rm',
  'mv',
  'move_file',
  'webfetch',
  'web_fetch',
  'websearch',
  'web_search',
]);

const extractExplicitToolName = (request: RequestPermissionRequest): string | undefined => {
  const meta = request.toolCall._meta;
  if (meta && typeof meta === 'object') {
    const record = meta as Record<string, unknown>;
    const claudeCode = record.claudeCode;
    if (claudeCode && typeof claudeCode === 'object') {
      const toolName = (claudeCode as Record<string, unknown>).toolName;
      if (typeof toolName === 'string' && toolName.trim()) {
        return toolName.trim().toLowerCase();
      }
    }
    if (typeof record.toolName === 'string' && record.toolName.trim()) {
      return record.toolName.trim().toLowerCase();
    }
  }
  return undefined;
};

const hasCommandRawInput = (rawInput: unknown): boolean => {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    return false;
  }
  const record = rawInput as Record<string, unknown>;
  return (
    typeof record.command === 'string' ||
    typeof record.cmd === 'string' ||
    typeof record.CommandLine === 'string'
  );
};

/**
 * Fail-closed read-only permission classifier used ONLY when `readOnlyTools === true`.
 * Allows only explicit read/search file inspection tools and rejects all write, edit,
 * delete, move, execute, network, interactive question, and unknown requests.
 */
export function isReadOnlyBtwPermissionRequest(request: RequestPermissionRequest): boolean {
  if (isAskUserQuestionPermissionRequest(request)) {
    return false;
  }
  if (hasCommandRawInput(request.toolCall.rawInput)) {
    return false;
  }

  const explicitToolName = extractExplicitToolName(request);
  if (explicitToolName && FORBIDDEN_TOOL_NAMES.has(explicitToolName)) {
    return false;
  }

  const kind = request.toolCall.kind ?? undefined;
  if (kind && FORBIDDEN_PERMISSION_KINDS.has(kind)) {
    return false;
  }
  if (kind === 'read' || kind === 'search') {
    return true;
  }

  if (explicitToolName && READ_ONLY_TOOL_NAMES.has(explicitToolName)) {
    return true;
  }

  const titleToken = request.toolCall.title
    ?.trim()
    .split(/[\s(:]/, 1)[0]
    ?.toLowerCase();
  if (titleToken && READ_ONLY_TOOL_NAMES.has(titleToken)) {
    return true;
  }

  return false;
}

export function createBtwPermissionHandler(
  readOnlyTools: boolean
): (requestId: string, request: RequestPermissionRequest) => Promise<RequestPermissionResponse> {
  if (!readOnlyTools) {
    return async () => ({ outcome: { outcome: 'cancelled' } });
  }
  return async (_requestId, request) => {
    if (!isReadOnlyBtwPermissionRequest(request)) {
      return { outcome: { outcome: 'cancelled' } };
    }
    const allowOnce = request.options.find((option) => option.kind === 'allow_once');
    if (!allowOnce) {
      return { outcome: { outcome: 'cancelled' } };
    }
    return { outcome: { outcome: 'selected', optionId: allowOnce.optionId } };
  };
}

export function createBtwNoopTerminalManager(): TerminalManager {
  return {
    createTerminal: async () => {
      throw new Error('Terminal is disabled in /btw mode');
    },
    terminalOutput: async () => {
      throw new Error('Terminal is disabled in /btw mode');
    },
    releaseTerminal: async () => {},
    waitForTerminalExit: async () => ({ exitCode: null }),
    killTerminal: async () => {},
  };
}

const copyPrivateFileIfPresent = (sourcePath: string, destinationPath: string): boolean => {
  try {
    const stat = fs.statSync(sourcePath);
    if (!stat.isFile()) {
      return false;
    }
  } catch {
    return false;
  }
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  fs.copyFileSync(sourcePath, destinationPath);
  fs.chmodSync(destinationPath, 0o600);
  return true;
};

const symlinkPrivateFileIfPresent = (sourcePath: string, destinationPath: string): boolean => {
  let targetPath: string;
  try {
    const stat = fs.statSync(sourcePath);
    if (!stat.isFile()) {
      return false;
    }
    targetPath = fs.realpathSync(sourcePath);
  } catch {
    return false;
  }
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  fs.symlinkSync(targetPath, destinationPath, 'file');
  return true;
};

const readCodexDisabledOverridesFromFile = (
  configPath: string,
  logger: Logger
): { readonly mcpServerNames: string[]; readonly pluginNames: string[] } => {
  try {
    if (!fs.existsSync(configPath)) {
      return { mcpServerNames: [], pluginNames: [] };
    }
    const stat = fs.statSync(configPath);
    if (!stat.isFile()) {
      return { mcpServerNames: [], pluginNames: [] };
    }
    return extractCodexDisabledTableOverrides(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    logger.debug(
      `[btw] Failed to inspect Codex config.toml at ${configPath}: ${formatErrorMessage(error)}`
    );
    return { mcpServerNames: [], pluginNames: [] };
  }
};

const isExistingDirectory = (candidate: string | null | undefined): candidate is string => {
  if (!candidate?.trim()) return false;
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
};

const ensureGitRepo = async (workdir: string, logger: Logger): Promise<boolean> => {
  try {
    await runCommandTextLegacy(
      {
        command: 'git',
        args: ['init', '--quiet'],
        cwd: workdir,
        timeout: BTW_GIT_INIT_TIMEOUT_MS,
        check: 'exit-0',
      },
      toShared()
    );
    return true;
  } catch (error) {
    logger.debug(`[btw] Failed to git init temp workdir ${workdir}: ${formatErrorMessage(error)}`);
    return false;
  }
};

export type PrepareBtwIsolationOptions = {
  readonly cliType: AgentConfigCliType;
  readonly agentType: string;
  readonly readOnlyTools: boolean;
  readonly sessionWorkdir?: string | null;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly codexProfile?: CodexProfileExecution;
  readonly logger: Logger;
  /** Test seam: override home directory instead of reading real `os.homedir()`. */
  readonly homeDir?: string;
  /** Test seam: override temp root directory instead of `os.tmpdir()`. */
  readonly tmpDir?: string;
  /** Test seam: override `git init` for Codex temp workdirs. */
  readonly initGitRepo?: (workdir: string) => Promise<boolean>;
};

export type PreparedBtwIsolation = {
  readonly workdir: string;
  /** True only when read-only tools were requested AND supported natively by this provider. */
  readonly effectiveReadOnlyTools: boolean;
  /** True only when `workdir` is the real session worktree rather than a temporary empty dir. */
  readonly usedSessionWorkdir: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly envTransform: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  readonly launchArgFilter?: (args: readonly string[]) => string[];
  readonly onRequestPermission: (
    requestId: string,
    request: RequestPermissionRequest
  ) => Promise<RequestPermissionResponse>;
  readonly terminalManager: TerminalManager;
  readonly tempDirs: readonly string[];
  readonly cleanup: () => void;
};

export async function prepareBtwIsolation(
  options: PrepareBtwIsolationOptions
): Promise<PreparedBtwIsolation> {
  const baseEnv = options.baseEnv ?? process.env;
  const homeDir = options.homeDir ?? baseEnv.HOME?.trim() ?? os.homedir();
  const tmpRoot = options.tmpDir ?? os.tmpdir();
  const tempDirs: string[] = [];
  let cleanedUp = false;

  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    for (const dir of tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        options.logger.debug(
          `[btw] Failed to remove temporary dir ${dir}: ${formatErrorMessage(error)}`
        );
      }
    }
  };

  try {
    const providerOverrides: Record<string, string> = {};
    let launchArgFilter: ((args: readonly string[]) => string[]) | undefined;
    const codex = isCodexAgent(options.agentType);
    const effectiveReadOnlyTools =
      options.readOnlyTools && supportsBtwNativeReadOnlyTools(options.agentType);
    const usedSessionWorkdir =
      effectiveReadOnlyTools && isExistingDirectory(options.sessionWorkdir);

    let workdir: string;
    if (usedSessionWorkdir && options.sessionWorkdir) {
      workdir = options.sessionWorkdir;
    } else {
      const emptyWorkdir = fs.mkdtempSync(path.join(tmpRoot, 'lody-btw-'));
      fs.chmodSync(emptyWorkdir, 0o700);
      tempDirs.push(emptyWorkdir);
      if (codex) {
        const initGit =
          options.initGitRepo ?? ((dir: string) => ensureGitRepo(dir, options.logger));
        await initGit(emptyWorkdir);
      }
      workdir = emptyWorkdir;
    }

    const codexDisabledMcpServers = new Set<string>();
    const codexDisabledPlugins = new Set<string>();

    if (isAntigravityAgent(options.agentType)) {
      const geminiDir = fs.mkdtempSync(path.join(tmpRoot, 'lody-btw-gemini-'));
      fs.chmodSync(geminiDir, 0o700);
      tempDirs.push(geminiDir);
      const sourceGeminiDir = baseEnv.GEMINI_DIR?.trim() || path.join(homeDir, '.gemini');
      for (const relPath of ANTIGRAVITY_AUTH_FILES) {
        copyPrivateFileIfPresent(
          path.join(sourceGeminiDir, relPath),
          path.join(geminiDir, relPath)
        );
      }
      providerOverrides.GEMINI_DIR = geminiDir;
      launchArgFilter = (args) => filterAntigravityBtwLaunchArgs(args, geminiDir);
    } else if (codex) {
      if (options.codexProfile?.profile.authStore !== 'keyring') {
        const sourceCodexHome =
          options.codexProfile?.profile.home ||
          baseEnv.CODEX_HOME?.trim() ||
          path.join(homeDir, '.codex');
        let codexHome: string;
        if (options.codexProfile) {
          // Preserve `<CODEX_HOME>/../processes` layout expected by CodexJsonRpcConnection
          // when LODY_CODEX_PROCESS_TOKEN is set on managed ChatGPT profiles.
          const codexRoot = fs.mkdtempSync(path.join(tmpRoot, 'lody-btw-codex-'));
          fs.chmodSync(codexRoot, 0o700);
          tempDirs.push(codexRoot);
          codexHome = path.join(codexRoot, 'home');
          fs.mkdirSync(codexHome, { mode: 0o700 });
          if (options.codexProfile.profile.profile.mode === 'chatgpt') {
            fs.symlinkSync(
              path.resolve(sourceCodexHome, '..', 'processes'),
              path.join(codexRoot, 'processes'),
              'dir'
            );
          }
        } else {
          codexHome = fs.mkdtempSync(path.join(tmpRoot, 'lody-btw-codex-'));
          fs.chmodSync(codexHome, 0o700);
          tempDirs.push(codexHome);
        }
        // Symlink (never copy) `auth.json` so OAuth refresh rotations write back to the
        // single authoritative credential file; removing the temp dir unlinks only the symlink.
        symlinkPrivateFileIfPresent(
          path.join(sourceCodexHome, 'auth.json'),
          path.join(codexHome, 'auth.json')
        );
        const sourceConfigPath = path.join(sourceCodexHome, 'config.toml');
        if (fs.existsSync(sourceConfigPath)) {
          try {
            const stat = fs.statSync(sourceConfigPath);
            if (stat.isFile()) {
              const rawToml = fs.readFileSync(sourceConfigPath, 'utf8');
              const cleanedToml = stripCodexConfigToml(rawToml);
              fs.writeFileSync(path.join(codexHome, 'config.toml'), cleanedToml, {
                encoding: 'utf8',
                mode: 0o600,
              });
            }
          } catch (error) {
            options.logger.debug(
              `[btw] Failed to prepare clean Codex config.toml: ${formatErrorMessage(error)}`
            );
          }
        }
        providerOverrides.CODEX_HOME = codexHome;
      } else {
        // Legacy keyring profiles derive the native OS keyring account from canonical CODEX_HOME,
        // so CODEX_HOME must stay on profile.home. Explicitly disable every hook, plugin, and
        // MCP server configured in profile.home/config.toml via CODEX_CONFIG + LODY_CODEX_PROFILE_CONFIG.
        const extracted = readCodexDisabledOverridesFromFile(
          path.join(options.codexProfile.profile.home, 'config.toml'),
          options.logger
        );
        for (const name of extracted.mcpServerNames) codexDisabledMcpServers.add(name);
        for (const name of extracted.pluginNames) codexDisabledPlugins.add(name);
      }
    } else if (isClaudeAgent(options.agentType)) {
      providerOverrides.CLAUDE_CODE_SAFE_MODE = '1';
    }

    const codexExtraDisableOverrides: CodexDisabledTableOverrides | undefined =
      codexDisabledMcpServers.size > 0 || codexDisabledPlugins.size > 0
        ? {
            mcpServerNames: [...codexDisabledMcpServers],
            pluginNames: [...codexDisabledPlugins],
          }
        : undefined;

    const envTransform = (childEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
      const sanitized = sanitizeBtwEnv(childEnv, providerOverrides);
      return codex ? mergeBtwCodexConfigEnv(sanitized, codexExtraDisableOverrides) : sanitized;
    };

    const env = envTransform(baseEnv);

    return {
      workdir,
      effectiveReadOnlyTools,
      usedSessionWorkdir,
      env,
      envTransform,
      launchArgFilter,
      onRequestPermission: createBtwPermissionHandler(effectiveReadOnlyTools),
      terminalManager: createBtwNoopTerminalManager(),
      tempDirs,
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
