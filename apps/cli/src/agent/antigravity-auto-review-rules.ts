import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * LAN fork: the deterministic layers of Antigravity Auto Review. Each
 * permission request either runs at once (reads, edits inside the workspace,
 * read-only commands), goes straight to the user (destructive or irreversible
 * actions, credentials, system configuration), or goes to the reviewer model.
 *
 * Shapes follow `agy_acp_server` 1.4.x in its `default` mode: commands arrive
 * as kind `execute` with `rawInput.CommandLine` / `rawInput.Cwd`, edits as kind
 * `edit` with `rawInput.TargetFile`, `locations` and diff `content`, web search
 * as kind `search` with `rawInput.query`. File reads never ask in that mode.
 */

export type AutoReviewToolCall = {
  title?: string | null;
  kind?: string | null;
  rawInput?: unknown;
  locations?: readonly { path: string }[] | null;
  content?: readonly unknown[] | null;
};

export type AutoReviewWorkspace = {
  /** The session cwd followed by its additional directories. */
  roots: readonly string[];
  homeDir?: string;
};

export type AutoReviewRuleVerdict =
  | { kind: 'allow'; rule: string }
  | { kind: 'ask'; reason: string }
  | { kind: 'review'; command?: string; subcommands?: string[] };

const READ_ONLY_COMMANDS = new Set([
  'ls',
  'll',
  'la',
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'egrep',
  'fgrep',
  'pwd',
  'echo',
  'printf',
  'which',
  'whereis',
  'type',
  'stat',
  'du',
  'df',
  'whoami',
  'id',
  'uname',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'cut',
  'tr',
  'column',
  'nl',
  'diff',
  'cmp',
  'comm',
  'jq',
  'true',
  'false',
  'test',
  '[',
  'sleep',
  'md5sum',
  'sha1sum',
  'sha256sum',
  'shasum',
]);

const READ_ONLY_GIT = new Set([
  'status',
  'log',
  'diff',
  'show',
  'rev-parse',
  'ls-files',
  'blame',
  'describe',
  'shortlog',
  'cat-file',
  'ls-tree',
  'merge-base',
  'grep',
  'rev-list',
  'show-ref',
  'name-rev',
]);

const SYSTEM_PACKAGE_MANAGERS = new Set([
  'apt',
  'apt-get',
  'aptitude',
  'dpkg',
  'dnf',
  'yum',
  'rpm',
  'pacman',
  'zypper',
  'apk',
  'snap',
  'flatpak',
  'port',
]);

const SHELLS_AND_INTERPRETERS = /^(sh|bash|zsh|dash|ksh|fish|python[0-9.]*|node|perl|ruby|php)$/;

/** Credentials and secrets the agent must never read or send without the user. */
const SENSITIVE_PATH_PATTERNS = [
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /(^|\/)\.aws\/credentials$/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.git-credentials$/,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)\.kube\/config$/,
  /(^|\/)\.config\/gh\/hosts\.yml$/,
  /(^|\/)\.gemini\/.*(token|creds|oauth)[^/]*$/i,
  /(^|\/)\.lody[^/]*\/credentials\.json$/,
  /(^|\/)\.codex\/auth\.json$/,
  /(^|\/)\.claude\/\.credentials\.json$/,
  /(^|\/)\.config\/(.+\/)?credentials[^/]*$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.pypirc$/,
  // `.env` and `.env.*`, except the committed templates.
  /(^|\/)\.env(\.(?!(example|sample|template|dist|defaults)$)[^/]+)?$/,
  /^\/etc\/(shadow|sudoers)/,
];

/**
 * Home directories holding an agent's own settings, hooks, plugins and tool
 * permissions (Antigravity's included). A change there lets an agent widen
 * what it may do, so it always goes to the user.
 */
const AGENT_CONFIG_DIRECTORY = /^\.(gemini|claude|codex|lody[^/\\]*)$|^\.claude\.json$/;

/** Files that change how the machine or every shell behaves. */
const SYSTEM_CONFIG_PATTERNS = [
  /^\/(etc|usr|bin|sbin|lib|lib64|boot|sys|proc|System|Library)(\/|$)/,
  /(^|\/)\.(bashrc|bash_profile|profile|zshrc|zprofile|zshenv|zlogin|config\/fish\/config\.fish)$/,
  /(^|\/)\.config\/(systemd|autostart)(\/|$)/,
  /(^|\/)Library\/LaunchAgents(\/|$)/,
  /(^|\/)\.gitconfig$/,
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringField = (record: unknown, ...keys: string[]): string | undefined => {
  if (!isRecord(record)) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
};

/**
 * Where `target` (relative to `base`) really is, resolved one segment at a time
 * the way the kernel does: a symlink is followed before a later `..` applies,
 * so `link/../config.toml` with `link → ~/.codex/log` is ~/.codex/config.toml.
 * Past the first missing segment nothing can be a link, so the rest is lexical.
 */
const resolveReal = (base: string, target: string, depth = 0): string => {
  const absolute = path.isAbsolute(target) ? target : `${base}${path.sep}${target}`;
  const segments = absolute.split(/[\\/]+/).filter((segment) => segment !== '' && segment !== '.');
  let current = path.parse(path.resolve(absolute)).root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (segment === '..') {
      current = path.dirname(current);
      continue;
    }
    const next = path.join(current, segment);
    try {
      current = fs.realpathSync.native(next);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        // A dangling link still leads somewhere: writing through it creates its target.
        let link: string | undefined;
        try {
          link = fs.lstatSync(next).isSymbolicLink() ? fs.readlinkSync(next) : undefined;
        } catch {
          link = undefined;
        }
        if (link !== undefined && depth < 40)
          return resolveReal(
            current,
            [link, ...segments.slice(index + 1)].join(path.sep),
            depth + 1
          );
        return path.resolve(next, ...segments.slice(index + 1));
      }
      // A link loop or an unreadable directory: keep the path as written.
      return path.resolve(absolute);
    }
  }
  return current;
};

const realPath = (target: string): string => resolveReal(path.sep, target);

/** `~`, `$HOME` and `${HOME}` at the start of a word, expanded. */
const expandHome = (target: string, homeDir: string): string => {
  const match = /^(~|\$HOME|\$\{HOME\})(\/|$)/.exec(target);
  return match ? homeDir + target.slice(match[1]!.length) : target;
};

const resolvePath = (target: string, cwd: string, homeDir: string): string =>
  resolveReal(cwd, expandHome(target, homeDir));

const isInside = (target: string, root: string): boolean => {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const isInsideWorkspace = (target: string, workspace: AutoReviewWorkspace): boolean =>
  workspace.roots.some((root) => isInside(target, realPath(path.resolve(root))));

/** Places that hold secrets, relative to the home directory; probed by globs and recursive reads. */
const SECRET_LOCATIONS = [
  '.ssh/id_rsa',
  '.ssh/id_ed25519',
  '.ssh/config',
  '.aws/credentials',
  '.gnupg/private-keys-v1.d',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.docker/config.json',
  '.kube/config',
  '.config/gh/hosts.yml',
  '.config/gcloud/credentials.db',
  '.codex/auth.json',
  '.claude/.credentials.json',
  '.lody/credentials.json',
  '.lody-oss/credentials.json',
  '.gemini/oauth_creds.json',
  '.gemini/antigravity-acp/acp_token.json',
];

const secretLocations = (homeDir: string): string[] => {
  const files = SECRET_LOCATIONS.map((location) => path.join(homeDir, location));
  // The directories on the way, so `~/.a*` and `grep -r x ~/.aws` count too.
  const directories = files.flatMap((file) => {
    const result: string[] = [];
    for (
      let dir = path.dirname(file);
      isInside(dir, homeDir) && dir !== homeDir;
      dir = path.dirname(dir)
    )
      result.push(dir);
    return result;
  });
  return [...new Set([...files, ...directories])];
};

/** `{a,b}` alternatives of a word (not nested; capped). */
const expandBraces = (word: string): string[] => {
  const match = /\{([^{}]*,[^{}]*)\}/.exec(word);
  if (!match) return [word];
  const head = word.slice(0, match.index);
  const tail = word.slice(match.index + match[0].length);
  return match[1]!
    .split(',')
    .flatMap((part) => expandBraces(head + part + tail))
    .slice(0, 64);
};

const GLOB_CHARACTERS = /[*?[]/;

/** A regular expression for an absolute glob path (`**` crosses directories). */
const globToRegExp = (glob: string): RegExp => {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === '*') {
      if (glob[index + 1] === '*') {
        source += '.*';
        index += 1;
      } else source += '[^/]*';
    } else if (char === '?') source += '[^/]';
    else if (char === '[') {
      const end = glob.indexOf(']', index + 2);
      if (end < 0) source += '\\[';
      else {
        const body = glob
          .slice(index + 1, end)
          .replace(/^!/, '^')
          .replace(/\\/g, '\\\\');
        source += `[${body}]`;
        index = end;
      }
    } else source += char.replace(/[.+^${}()|\\\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
};

const GLOB_ENTRY_LIMIT = 5000;

/**
 * The existing files a glob matches, as the shell would expand it (dotfiles
 * included, to be safe). `complete` is false when the walk hit its limit.
 */
/** What one classification may spend expanding globs, shared by all its words. */
type GlobBudget = { left: number };

const expandGlob = (
  pattern: string,
  budget: GlobBudget
): { matches: string[]; complete: boolean } => {
  const segments = pattern.split('/').filter((segment) => segment !== '' && segment !== '.');
  let current = [path.parse(pattern).root || '/'];
  // Every directory entry read and every path resolved spends one unit; the
  // walk stops the moment the budget is gone (this runs on the daemon thread).
  const spend = (units: number) => (budget.left -= units) >= 0;
  const list = (directory: string): string[] => {
    if (budget.left < 0) return [];
    try {
      const entries = fs.readdirSync(directory);
      return spend(entries.length) ? entries : [];
    } catch {
      return [];
    }
  };
  for (const segment of segments) {
    const next: string[] = [];
    if (segment === '**') {
      const walk = (directory: string) => {
        if (budget.left < 0) return;
        next.push(directory);
        for (const entry of list(directory)) {
          if (!spend(1)) return;
          const child = path.join(directory, entry);
          try {
            if (fs.statSync(child).isDirectory()) walk(child);
          } catch {
            // vanished or unreadable
          }
        }
      };
      for (const directory of current) walk(directory);
    } else if (GLOB_CHARACTERS.test(segment)) {
      const matcher = globToRegExp(segment);
      for (const directory of current)
        for (const entry of list(directory))
          if (matcher.test(entry)) next.push(path.join(directory, entry));
    } else {
      for (const directory of current) {
        if (!spend(1)) break;
        const candidate =
          segment === '..' ? path.dirname(directory) : path.join(directory, segment);
        if (fs.existsSync(candidate)) next.push(candidate);
      }
    }
    if (budget.left < 0) return { matches: [], complete: false };
    current = next;
  }
  if (!spend(current.length)) return { matches: [], complete: false };
  return { matches: current.map(realPath), complete: true };
};

/**
 * Whether a word, read as a path from `cwd`, can name a secret: literally, or
 * through braces or a glob, by the files it matches now or the known secret
 * locations it could match.
 */
const namesSecret = (word: string, cwd: string, homeDir: string, budget: GlobBudget): boolean =>
  expandBraces(expandHome(word, homeDir)).some((candidate) => {
    if (isSensitivePath(candidate)) return true;
    if (!GLOB_CHARACTERS.test(candidate))
      return isSensitivePath(resolvePath(candidate, cwd, homeDir));
    const absolute = path.isAbsolute(candidate) ? candidate : `${cwd}/${candidate}`;
    // What it matches now, file by file, through links.
    const expanded = expandGlob(absolute, budget);
    if (expanded.matches.some(isSensitivePath)) return true;
    // And what it could match among the known secret places.
    const segments = absolute.split('/');
    const first = segments.findIndex((segment) => GLOB_CHARACTERS.test(segment));
    const directory = realPath(segments.slice(0, first).join('/') || '/');
    const pattern = globToRegExp(path.join(directory, ...segments.slice(first)));
    return secretLocations(homeDir).some((probe) => pattern.test(probe));
  });

const isSensitivePath = (target: string): boolean =>
  SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(target));

const isSystemConfigPath = (target: string): boolean =>
  SYSTEM_CONFIG_PATTERNS.some((pattern) => pattern.test(target));

/** The agent configuration directory `target` is in, unless it is in a workspace kept there. */
const agentConfigDirectory = (
  target: string,
  workspace: AutoReviewWorkspace,
  homeDir: string
): string | undefined => {
  const home = realPath(homeDir);
  const relative = path.relative(home, target);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  const first = relative.split(path.sep)[0]!;
  if (!AGENT_CONFIG_DIRECTORY.test(first)) return undefined;
  const directory = path.join(home, first);
  // Lody worktrees live under ~/.lody-oss: their own files are ordinary workspace files.
  const kept = workspace.roots.some((root) => {
    const resolved = realPath(path.resolve(root));
    return isInside(resolved, directory) && resolved !== directory && isInside(target, resolved);
  });
  return kept ? undefined : directory;
};

const isGitInternalPath = (target: string, workspace: AutoReviewWorkspace): boolean =>
  workspace.roots.some((root) => {
    const relative = path.relative(realPath(path.resolve(root)), target);
    return relative === '.git' || relative.startsWith(`.git${path.sep}`);
  });

/**
 * Glob and brace characters that were quoted or escaped stand in for
 * themselves; the splitter swaps them for private-use characters so nothing
 * later mistakes `find -name '*.ts'` for a glob, or `-name {a,-delete}` (which
 * the shell does expand) for a plain pattern.
 */
const PROTECTED: Record<string, string> = {
  '*': '\uE000',
  '?': '\uE001',
  '[': '\uE002',
  '{': '\uE003',
};
const UNPROTECTED = Object.fromEntries(
  Object.entries(PROTECTED).map(([key, value]) => [value, key])
);
const protect = (char: string) => PROTECTED[char] ?? char;
const unprotect = (word: string) =>
  word.replace(/[\uE000-\uE003]/g, (char) => UNPROTECTED[char] ?? char);

/**
 * Splits a shell command line into its simple commands at `|`, `||`, `&&`,
 * `;`, `&` and newlines, honoring quotes. `substitution` is set when any part
 * uses `$(...)`, backticks or process substitution, whose contents a split
 * cannot see.
 */
export function splitShellCommand(commandLine: string): {
  subcommands: string[][];
  pipelines: string[][][];
  substitution: boolean;
} {
  const pipelines: string[][][] = [];
  let pipeline: string[][] = [];
  let words: string[] = [];
  let word = '';
  let hasWord = false;
  let substitution = false;
  let quote: '"' | "'" | null = null;
  const endWord = () => {
    if (hasWord) words.push(word);
    word = '';
    hasWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) pipeline.push(words);
    words = [];
  };
  const endPipeline = () => {
    endCommand();
    if (pipeline.length > 0) pipelines.push(pipeline);
    pipeline = [];
  };
  for (let index = 0; index < commandLine.length; index += 1) {
    const char = commandLine[index]!;
    const next = commandLine[index + 1];
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += protect(char);
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === '\\' && next !== undefined) {
        word += protect(next);
        index += 1;
      } else {
        if ((char === '$' && next === '(') || char === '`') substitution = true;
        word += protect(char);
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      hasWord = true;
      continue;
    }
    if (char === '\\' && next !== undefined) {
      if (next !== '\n') {
        word += protect(next);
        hasWord = true;
      }
      index += 1;
      continue;
    }
    if (
      (char === '$' && next === '(') ||
      char === '`' ||
      ((char === '<' || char === '>') && next === '(')
    ) {
      substitution = true;
    }
    if (char === ' ' || char === '\t') {
      endWord();
      continue;
    }
    if (char === '\n' || char === ';') {
      endPipeline();
      continue;
    }
    if (char === '&' && next === '&') {
      endPipeline();
      index += 1;
      continue;
    }
    if (char === '|' && next === '|') {
      endPipeline();
      index += 1;
      continue;
    }
    if (char === '|') {
      endCommand();
      continue;
    }
    if (char === '&' && next !== '>' && commandLine[index - 1] !== '>') {
      endPipeline();
      continue;
    }
    if (char === '>' || char === '<') {
      // Redirections become their own words: `>`, `>>`, `2>`, `&>`, `<`.
      const fd = /^\d$|^&$/.test(word) ? word : '';
      if (!fd) endWord();
      let operator = fd + char;
      if (next === '>' || next === '&' || (char === '>' && next === '|')) {
        operator += next;
        index += 1;
      }
      word = '';
      hasWord = false;
      words.push(operator);
      continue;
    }
    word += char;
    hasWord = true;
  }
  endPipeline();
  return { subcommands: pipelines.flat(), pipelines, substitution };
}

const isRedirect = (word: string) => /^(\d|&)?(>>?|<)[&|]?$/.test(word);

const isAssignment = (word: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);

/** Index of the wrapped command after flags whose value is the next word. */
const afterOptions =
  (valued: RegExp, positional = 0) =>
  (words: readonly string[]): number => {
    let index = 1;
    while (index < words.length) {
      const word = words[index]!;
      if (word === '--') return index + 1 + positional;
      if (isAssignment(word)) index += 1;
      else if (word.startsWith('-')) index += valued.test(word) ? 2 : 1;
      else break;
    }
    return index + positional;
  };

const WRAPPERS = new Map<string, (words: readonly string[]) => number>([
  ['env', afterOptions(/^-[uCS]$|^--(unset|chdir|split-string)$/)],
  ['exec', afterOptions(/^-a$/)],
  ['nohup', afterOptions(/^$/)],
  ['timeout', afterOptions(/^-[sk]$|^--(signal|kill-after)$/, 1)],
  ['stdbuf', afterOptions(/^-[ioe]$/)],
  [
    'xargs',
    afterOptions(
      /^-[IiLlnPsdEa]$|^--(replace|max-lines|max-args|max-procs|max-chars|delimiter|eof|arg-file)$/
    ),
  ],
]);

/**
 * The command with leading `VAR=value` assignments and harmless wrappers
 * removed, for the ask rules. An assignment (`GIT_EXTERNAL_DIFF=…`,
 * `LD_PRELOAD=…`, `PAGER=…`) can make any command run a program, so
 * `assigns` keeps such a command off the read-only path.
 */
const commandWords = (words: readonly string[]): { words: string[]; assigns: boolean } => {
  let start = 0;
  while (start < words.length && isAssignment(words[start]!)) start += 1;
  const rest = words.slice(start);
  const name = rest[0];
  if (name === 'command' || name === 'time' || name === 'nice') {
    const inner = commandWords(rest.slice(1));
    return { words: inner.words, assigns: start > 0 || inner.assigns };
  }
  // Wrappers that run the command after them; what they run is judged, and
  // the wrapped command never counts as read-only.
  const skip = WRAPPERS.get(name ?? '');
  if (skip) {
    const inner = commandWords(rest.slice(skip(rest)));
    return { words: inner.words, assigns: true };
  }
  return { words: rest, assigns: start > 0 };
};

/** Arguments that are not flags and not redirections or their targets. */
const operands = (words: readonly string[]): string[] => {
  const result: string[] = [];
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index]!;
    if (isRedirect(word)) {
      index += 1;
      continue;
    }
    if (word.startsWith('-')) continue;
    result.push(word);
  }
  return result;
};

const redirectTargets = (words: readonly string[]): string[] => {
  const targets: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (!isRedirect(word) || word.includes('<')) continue;
    const target = words[index + 1];
    // `>&2` duplicates a descriptor; `>& FILE` writes FILE (stdout and stderr).
    if (!target || (word.endsWith('&') && /^(\d+-?|-)$/.test(target))) {
      index += 1;
      continue;
    }
    targets.push(target);
    index += 1;
  }
  return targets;
};

/** Files a whitelisted command writes through its own options: `sort -o`, `uniq IN OUT`, `tree -o`. */
const optionOutputs = (words: readonly string[]): string[] => {
  const name = words[0];
  if (name === 'uniq') return operands(words).slice(1, 2);
  if (name !== 'sort' && name !== 'tree' && name !== 'git') return [];
  const outputs: string[] = [];
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index]!;
    if (isLongOption(word, '--output')) {
      const value = word.includes('=') ? word.slice(word.indexOf('=') + 1) : words[(index += 1)];
      if (value) outputs.push(value);
      continue;
    }
    const short = name === 'git' ? null : /^-[A-Za-z]*o(.*)$/.exec(word);
    if (short) {
      const value = short[1] || words[(index += 1)];
      if (value) outputs.push(value);
    }
  }
  return outputs;
};

/**
 * Whether `arg` names the long option `option`, abbreviations included: GNU
 * getopt and git accept any unambiguous prefix (`sort --out` is `--output`).
 */
const isLongOption = (arg: string, option: string): boolean => {
  if (!arg.startsWith('--')) return false;
  const name = arg.split('=')[0]!;
  return name.length > 2 && option.startsWith(name);
};

const hasFlag = (words: readonly string[], ...flags: string[]): boolean =>
  words.some((word) =>
    flags.some((flag) =>
      flag.startsWith('--')
        ? isLongOption(word, flag)
        : word === flag || (/^-[A-Za-z]+$/.test(word) && word.includes(flag.slice(1)))
    )
  );

/** `git` with its global options (`-C dir`, `-c k=v`, ...) removed. */
const gitArguments = (words: readonly string[]): string[] => {
  const args = words.slice(1);
  while (args.length > 0 && args[0]!.startsWith('-')) {
    const option = args.shift()!;
    if (option === '-C' || option === '-c' || option === '--git-dir' || option === '--work-tree')
      args.shift();
  }
  return args;
};

const destructiveGitReason = (words: readonly string[]): string | undefined => {
  const [subcommand, ...rest] = gitArguments(words);
  switch (subcommand) {
    case 'push':
      if (
        hasFlag(
          rest,
          '-f',
          '-d',
          '--force',
          '--force-with-lease',
          '--force-if-includes',
          '--delete',
          '--mirror',
          '--prune'
        ) ||
        rest.some((arg) => /^[+:]/.test(arg))
      )
        return 'force-pushes or deletes a remote branch';
      return undefined;
    case 'reset':
      return hasFlag(rest, '--hard', '--merge', '--keep')
        ? 'discards local changes (git reset --hard)'
        : undefined;
    case 'clean':
      return hasFlag(rest, '-f', '--force') ? 'deletes untracked files (git clean)' : undefined;
    case 'checkout':
      return rest.includes('--') || rest.includes('.') || hasFlag(rest, '-f', '--force')
        ? 'discards working tree changes'
        : undefined;
    case 'restore':
      return hasFlag(rest, '--staged') && !hasFlag(rest, '--worktree', '-W')
        ? undefined
        : 'discards working tree changes';
    case 'branch':
      return hasFlag(rest, '-D') ||
        (hasFlag(rest, '-d', '--delete') && hasFlag(rest, '-f', '--force'))
        ? 'force-deletes a branch'
        : undefined;
    case 'stash':
      return rest[0] === 'drop' || rest[0] === 'clear' ? 'deletes stashed changes' : undefined;
    case 'filter-branch':
    case 'filter-repo':
      return 'rewrites repository history';
    case 'reflog':
      return rest[0] === 'expire' || rest[0] === 'delete' ? 'deletes reflog entries' : undefined;
    case 'update-ref':
      return hasFlag(rest, '-d') ? 'deletes a ref' : undefined;
    case 'gc':
      return rest.some((arg) => arg.startsWith('--prune'))
        ? 'prunes unreachable objects'
        : undefined;
    default:
      return undefined;
  }
};

const isReadOnlyGit = (words: readonly string[]): boolean => {
  // Any global option but `-C <dir>` can run a program (`-c core.fsmonitor=…`,
  // `-c diff.external=…`, `-c core.pager=…`, `--exec-path`) or point git at
  // another repository (`--git-dir`, `--work-tree`).
  for (let index = 1; index < words.length && words[index]!.startsWith('-'); index += 1) {
    if (words[index] !== '-C') return false;
    index += 1;
  }
  const [subcommand, ...rest] = gitArguments(words);
  if (!subcommand) return false;
  // Output files and external programs, for every subcommand below (`stash
  // show` and `stash list` take diff and log options too).
  if (hasFlag(rest, '--output', '--ext-diff', '--textconv', '--filters', '--open-files-in-pager'))
    return false;
  if (subcommand === 'grep' && rest.some((arg) => /^-[A-Za-z]*O/.test(arg))) return false;
  if (READ_ONLY_GIT.has(subcommand)) return true;
  if (subcommand === 'branch')
    return rest.every((arg) =>
      /^(-a|-r|-v|-vv|--all|--list|--show-current|--remotes|--verbose|--merged|--no-merged|--contains)$/.test(
        arg
      )
    );
  if (subcommand === 'tag')
    return rest.length === 0 || rest.every((arg) => arg === '-l' || arg === '--list');
  if (subcommand === 'remote') return rest.length === 0 || (rest.length === 1 && rest[0] === '-v');
  if (subcommand === 'stash') return rest[0] === 'list' || rest[0] === 'show';
  if (subcommand === 'worktree') return rest[0] === 'list';
  if (subcommand === 'config') return hasFlag(rest, '--get', '--get-all', '--list', '-l');
  return false;
};

/**
 * Whitelisted commands whose options or operands write files or run programs,
 * checked one by one (GNU and BSD spellings).
 */
const isReadOnlyCommand = (words: readonly string[]): boolean => {
  const name = words[0];
  if (!name) return true;
  const args = words.slice(1);
  const plain = operands(words);
  switch (name) {
    case 'git':
      return isReadOnlyGit(words);
    case 'sort':
      // -o/--output writes, --compress-program runs a program, -T writes temp files.
      return !(
        args.some((arg) => /^-[A-Za-z]*[oT]/.test(arg)) ||
        hasFlag(args, '--output', '--compress-program', '--temporary-directory')
      );
    case 'uniq':
      // `uniq IN OUT` writes OUT.
      return plain.length <= 1;
    case 'tree':
      // -o writes the listing; -R with -H writes an index into every directory.
      return !args.some((arg) => /^-[A-Za-z]*[oR]/.test(arg)) && !hasFlag(args, '--output');
    case 'rg':
      // --pre runs a program per file; -z runs decompressors.
      return (
        !args.some((arg) => /^-[A-Za-z]*z/.test(arg)) &&
        !hasFlag(args, '--pre', '--pre-glob', '--search-zip')
      );
    case 'ag':
      return !args.some((arg) => /^-[A-Za-z]*z/.test(arg)) && !hasFlag(args, '--search-zip');
    case 'file':
      // -C compiles a magic file into the current directory.
      return !args.some((arg) => /^-[A-Za-z]*C/.test(arg)) && !hasFlag(args, '--compile');
    case 'date':
      return !args.some((arg) => /^-[A-Za-z]*s/.test(arg)) && !hasFlag(args, '--set');
    case 'hostname':
      // An operand sets the hostname.
      return (
        plain.length === 0 &&
        !args.some((arg) => /^-[A-Za-z]*[bF]/.test(arg)) &&
        !hasFlag(args, '--boot', '--file')
      );
  }
  if (name === 'find')
    return !words.some((word) =>
      /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(word)
    );
  if (name === 'fd') return !hasFlag(words.slice(1), '-x', '-X', '--exec', '--exec-batch');
  return READ_ONLY_COMMANDS.has(name);
};

const isRemoteHost = (url: string): boolean => {
  const match = /^[a-z]+:\/\/([^/:?#]+)/i.exec(url);
  const host = match?.[1]?.toLowerCase();
  return host !== undefined && host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]';
};

/** Why a single command must go to the user, or undefined. */
const askReason = (
  words: readonly string[],
  cwd: string,
  workspace: AutoReviewWorkspace,
  homeDir: string
): string | undefined => {
  const name = words[0];
  if (!name) return undefined;
  const args = words.slice(1);
  const targets = operands(words).map((operand) => resolvePath(operand, cwd, homeDir));
  const outside = (candidates: readonly string[]) =>
    candidates.some(
      (target) => !isInsideWorkspace(target, workspace) || target === path.parse(target).root
    );

  if (/^(sudo|su|doas|pkexec|runas)$/.test(name)) return 'runs as another user';
  const written = [
    ...(isReadOnlyCommand(words) ? [] : targets),
    ...[...redirectTargets(words), ...optionOutputs(words)].map((target) =>
      resolvePath(target, cwd, homeDir)
    ),
  ];
  if (written.some((target) => agentConfigDirectory(target, workspace, homeDir) !== undefined))
    return "changes an agent's own configuration";
  if (written.some((target) => isGitInternalPath(target, workspace)))
    return 'changes git internals (.git)';
  if (/^(rm|rmdir|shred|unlink|srm|trash)$/.test(name) && outside(targets))
    return 'deletes files outside the workspace';
  if (
    name === 'find' &&
    words.some((word) => word === '-delete' || word === '-exec' || word === '-execdir')
  ) {
    const roots = operands(words).filter(
      (operand) => !operand.startsWith('-') && !/^[{};+]$/.test(operand)
    );
    if (outside(roots.slice(0, 1).map((root) => resolvePath(root, cwd, homeDir))))
      return 'deletes or runs commands on files outside the workspace';
  }
  if (name === 'git') {
    const reason = destructiveGitReason(words);
    if (reason) return reason;
  }
  if (/^(chmod|chown|chgrp)$/.test(name) && outside(targets.slice(1)))
    return 'changes permissions outside the workspace';
  if (/^(mkfs.*|fdisk|parted|wipefs|diskutil|shutdown|reboot|halt|poweroff)$/.test(name))
    return 'changes disks or power state';
  if (name === 'dd' && args.some((arg) => arg.startsWith('of='))) return 'writes raw data with dd';
  if (
    name === 'systemctl' &&
    !/^(status|show|cat|list-.*|is-.*)$/.test(args.find((arg) => !arg.startsWith('-')) ?? '')
  )
    return 'changes system services';
  if (name === 'launchctl' && !/^(list|print)$/.test(args[0] ?? ''))
    return 'changes system services';
  if (
    /^(service|update-rc\.d|chkconfig|sysctl|update-alternatives|chsh|useradd|usermod|userdel|groupadd|passwd|visudo|scutil|networksetup|nvram|csrutil)$/.test(
      name
    )
  )
    return 'changes system configuration';
  if (name === 'crontab' && !hasFlag(args, '-l')) return 'changes scheduled jobs (crontab)';
  if (name === 'defaults' && args[0] !== 'read') return 'changes system preferences';
  if (SYSTEM_PACKAGE_MANAGERS.has(name)) return 'installs or removes system packages';
  if (
    name === 'brew' &&
    /^(install|uninstall|remove|upgrade|reinstall|link|unlink|tap|untap|services)$/.test(
      args[0] ?? ''
    )
  )
    return 'installs or removes system packages';
  if (/^(npm|pnpm|yarn|bun)$/.test(name) && hasFlag(args, '-g', '--global'))
    return 'installs global packages';
  if (
    name === 'curl' &&
    words.some(isRemoteHost) &&
    hasFlag(
      args,
      '-d',
      '-F',
      '-T',
      '--data',
      '--data-binary',
      '--data-raw',
      '--data-urlencode',
      '--json',
      '--form',
      '--upload-file'
    )
  )
    return 'uploads data to the network';
  if (
    name === 'wget' &&
    hasFlag(args, '--post-data', '--post-file', '--method', '--body-data', '--body-file')
  )
    return 'uploads data to the network';
  if (/^(scp|sftp|ftp|nc|ncat|netcat|socat|telnet)$/.test(name))
    return 'transfers data over the network';
  if (name === 'rsync' && args.some((arg) => /^[^/][^:]*:/.test(arg) && !arg.startsWith('-')))
    return 'transfers data over the network';
  for (const target of [...redirectTargets(words), ...optionOutputs(words)]) {
    if (target === '/dev/null' || target === '/dev/stdout' || target === '/dev/stderr') continue;
    const resolved = resolvePath(target, cwd, homeDir);
    if (!isInsideWorkspace(resolved, workspace)) return 'writes a file outside the workspace';
  }
  return undefined;
};

const isRecursiveSearch = (words: readonly string[]): boolean => {
  const name = words[0] ?? '';
  return (
    name === 'rg' ||
    name === 'ag' ||
    (/^[ef]?grep$/.test(name) &&
      (hasFlag(words.slice(1), '-r', '-R', '--recursive', '--dereference-recursive') ||
        words.includes('recurse')))
  );
};

const classifyCommand = (
  commandLine: string,
  startCwd: string,
  workspace: AutoReviewWorkspace,
  homeDir: string
): AutoReviewRuleVerdict => {
  const { subcommands, pipelines, substitution } = splitShellCommand(commandLine);
  const display = subcommands.map((command) => unprotect(command.join(' ')));
  // Follow `cd`/`pushd` in order, so `cd ~/.aws && cat credentials` reads
  // ~/.aws/credentials. A target that cannot be known (`cd -`, `$VAR`, `popd`)
  // leaves later paths unknown, which keeps the command off the fast path.
  let cwd: string | undefined = startCwd;
  const steps = subcommands.map((command) => {
    const { words, assigns } = commandWords(command);
    const step = { words, assigns, cwd };
    const name = words[0];
    if (name === 'cd' || name === 'pushd') {
      const target = operands(words)[0] ?? '~';
      const expanded = expandHome(target, homeDir);
      cwd =
        cwd && target !== '-' && !expanded.includes('$') && !GLOB_CHARACTERS.test(expanded)
          ? resolvePath(expanded, cwd, homeDir)
          : undefined;
    } else if (name === 'popd') {
      cwd = undefined;
    }
    return step;
  });
  const budget: GlobBudget = { left: GLOB_ENTRY_LIMIT };
  const sensitive = (word: string, at: string | undefined) =>
    namesSecret(word, startCwd, homeDir, budget) ||
    (at !== undefined && at !== startCwd && namesSecret(word, at, homeDir, budget));
  if (steps.some((step) => step.words.some((word) => sensitive(word, step.cwd))))
    return { kind: 'ask', reason: 'touches credentials or secrets' };
  // A recursive search over the home directory or a secret directory reads secrets.
  const secrets = secretLocations(homeDir);
  for (const step of steps) {
    if (!isRecursiveSearch(step.words)) continue;
    const at = step.cwd ?? startCwd;
    const roots = [at, ...operands(step.words).map((operand) => resolvePath(operand, at, homeDir))];
    if (roots.some((root) => secrets.some((secret) => isInside(secret, root))))
      return { kind: 'ask', reason: 'searches through credentials or secrets' };
  }
  // `sh -c '…'`: the inner command line gets the same ask rules.
  for (const step of steps) {
    const inline = step.words.indexOf('-c');
    if (!/^(sh|bash|zsh|dash|ksh)$/.test(step.words[0] ?? '') || inline < 0) continue;
    const inner = step.words[inline + 1];
    if (!inner) continue;
    const verdict = classifyCommand(inner, step.cwd ?? startCwd, workspace, homeDir);
    if (verdict.kind === 'ask') return verdict;
  }
  for (const pipeline of pipelines) {
    const names = pipeline.map((command) => commandWords(command).words[0] ?? '');
    const downloads = names.findIndex((name) => name === 'curl' || name === 'wget');
    if (
      downloads >= 0 &&
      names.slice(downloads + 1).some((name) => SHELLS_AND_INTERPRETERS.test(name))
    )
      return { kind: 'ask', reason: 'runs code downloaded from the network' };
  }
  for (const step of steps) {
    // The ask rules see arguments as the shell passes them: `rm -rf {/opt/x,y}` is two.
    const reason = askReason(
      step.words.flatMap((word) => expandBraces(word)),
      step.cwd ?? startCwd,
      workspace,
      homeDir
    );
    if (reason) return { kind: 'ask', reason };
  }
  const readOnly = (step: (typeof steps)[number]) => {
    const name = step.words[0] ?? '';
    const cleanRedirects = redirectTargets(step.words).every((target) => target === '/dev/null');
    if (name === 'cd' || name === 'pushd' || name === 'popd') return cleanRedirects;
    // What a glob, a brace or a recursive search reads is for the reviewer to judge.
    if (isRecursiveSearch(step.words)) return false;
    return (
      !step.assigns &&
      !step.words.some(
        (word) =>
          expandHome(word, homeDir).includes('$') ||
          GLOB_CHARACTERS.test(word) ||
          expandBraces(word).length > 1
      ) &&
      step.cwd !== undefined &&
      isInsideWorkspace(step.cwd, workspace) &&
      isReadOnlyCommand(step.words) &&
      cleanRedirects
    );
  };
  if (
    !substitution &&
    steps.length > 0 &&
    (cwd === undefined || isInsideWorkspace(cwd, workspace)) &&
    steps.every(readOnly)
  )
    return { kind: 'allow', rule: 'read-only command' };
  return { kind: 'review', command: commandLine, subcommands: display };
};

const editPaths = (toolCall: AutoReviewToolCall): string[] => {
  const paths = new Set<string>();
  for (const location of toolCall.locations ?? []) if (location.path) paths.add(location.path);
  const target = stringField(
    toolCall.rawInput,
    'TargetFile',
    'file_path',
    'path',
    'AbsolutePath',
    'Destination',
    'Source'
  );
  if (target) paths.add(target);
  for (const block of toolCall.content ?? []) {
    const blockPath = isRecord(block) && block.type === 'diff' ? block.path : undefined;
    if (typeof blockPath === 'string') paths.add(blockPath);
  }
  return [...paths];
};

/** Reads the command line Antigravity asks to run, for review and display. */
export function readAntigravityCommand(toolCall: AutoReviewToolCall): {
  command?: string;
  cwd?: string;
} {
  return {
    command: stringField(toolCall.rawInput, 'CommandLine', 'command_line', 'command') ?? undefined,
    cwd: stringField(toolCall.rawInput, 'Cwd', 'working_dir', 'cwd'),
  };
}

export function classifyAntigravityPermission(
  toolCall: AutoReviewToolCall,
  workspace: AutoReviewWorkspace
): AutoReviewRuleVerdict {
  const homeDir = workspace.homeDir ?? os.homedir();
  const primaryRoot = workspace.roots[0] ?? process.cwd();
  switch (toolCall.kind) {
    case 'think':
      return { kind: 'allow', rule: 'no side effects' };
    case 'execute': {
      const { command, cwd } = readAntigravityCommand(toolCall);
      if (!command) return { kind: 'review' };
      return classifyCommand(
        command,
        cwd ? path.resolve(primaryRoot, cwd) : primaryRoot,
        workspace,
        homeDir
      );
    }
    case 'read':
    case 'edit':
    case 'delete':
    case 'move': {
      const paths = editPaths(toolCall).map((target) => resolvePath(target, primaryRoot, homeDir));
      if (paths.some(isSensitivePath))
        return { kind: 'ask', reason: 'touches credentials or secrets' };
      if (
        toolCall.kind !== 'read' &&
        paths.some((target) => agentConfigDirectory(target, workspace, homeDir) !== undefined)
      )
        return { kind: 'ask', reason: "changes an agent's own configuration" };
      if (toolCall.kind !== 'read' && paths.some(isSystemConfigPath))
        return { kind: 'ask', reason: 'changes system or shell configuration' };
      if (toolCall.kind !== 'read' && paths.some((target) => isGitInternalPath(target, workspace)))
        return { kind: 'ask', reason: 'changes git internals (.git)' };
      if (paths.length > 0 && paths.every((target) => isInsideWorkspace(target, workspace))) {
        if (toolCall.kind === 'read') return { kind: 'allow', rule: 'read inside the workspace' };
        if (toolCall.kind === 'edit') return { kind: 'allow', rule: 'edit inside the workspace' };
      }
      return { kind: 'review' };
    }
    case 'search':
      return stringField(toolCall.rawInput, 'query', 'Query')
        ? { kind: 'review' }
        : { kind: 'allow', rule: 'local search' };
    default:
      return { kind: 'review' };
  }
}
