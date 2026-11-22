import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  CODE_NAV_LIMITS,
  codeNavError,
  estimateCodeNavResponseBytes,
  type CodeNavCallerItem,
  type CodeNavCallersOk,
  type CodeNavConfidence,
  type CodeNavDefinitionOk,
  type CodeNavDiffOutlineFile,
  type CodeNavDiffOutlineHunk,
  type CodeNavDiffOutlineOk,
  type CodeNavDiffOutlineSymbol,
  type CodeNavEnclosingOk,
  type CodeNavLocation,
  type CodeNavQueryError,
  type CodeNavQueryResponse,
  type CodeNavTruncatedReason,
} from '@lody/shared';
import { runCommandTextLegacy } from '@lody/shared/node/process';
import { resolveAllChangesDiffBase } from '@/lib/code-collab/file-index-scan-core';
import {
  buildSymbolUsageMatcher,
  collectCallSitesFromMatchedNodes,
  extractFileSymbolIndex,
  findCallSitesInRoot,
  findEnclosingSymbolChain,
  findInnermostSymbolAtLine,
  loadAstGrep,
  parseUnifiedDiffHunks,
  resolveSymbolContextAtPosition,
  toAstGrepLang,
  toPublicCodeNavSymbol,
  type AstGrepModule,
  type AstGrepNode,
  type AstGrepRoot,
} from './ast-grep-extractor';
import { WorkspaceImportResolver } from './import-resolver';
import {
  getCodeNavLanguage,
  isSupportedCodeNavFile,
  resolveCanonicalWorkspaceRoot,
  resolveContainedWorkspacePath,
  toPosixRelPath,
  validateContainedCandidatePath,
} from './path-boundary';
import {
  BoundedAstLruCache,
  BoundedSymbolIndexCache,
  CODE_NAV_CACHE_LIMITS,
  computeWorkspaceSnapshotKey,
  type WorkspaceSnapshotKey,
} from './snapshot-cache';
import type {
  CodeNavCallersInput,
  CodeNavDefinitionInput,
  CodeNavDiffOutlineInput,
  CodeNavEnclosingInput,
  CodeNavLanguage,
  CodeNavProvider,
  FileSymbolIndex,
  IndexedSymbol,
} from './types';

const GIT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
/** Adaptive routing threshold: `< 50` files -> per-file NAPI; `>= 50` -> Rust `findInFiles`. */
const FIND_IN_FILES_THRESHOLD = 50;
/** Max candidate files scanned in one definition/caller query to stay within latency budget. */
const MAX_CANDIDATE_FILES_PER_QUERY = 200;
/** Hop-2 expansion cap: max unique depth-1 caller names traced further upward. */
const MAX_HOP2_SYMBOLS = 8;
/** If a hop-2 symbol matches more than this many files, stop to prevent fan-out explosion. */
const MAX_HOP2_CANDIDATE_FILES = 80;

/** Generic high-frequency names that explode fan-out if expanded on hop 2. */
const GENERIC_HOP2_STOP_NAMES: ReadonlySet<string> = new Set([
  'get',
  'set',
  'has',
  'add',
  'delete',
  'remove',
  'clear',
  'close',
  'open',
  'start',
  'stop',
  'run',
  'init',
  'reset',
  'dispose',
  'destroy',
  'render',
  'update',
  'create',
  'load',
  'save',
  'read',
  'write',
  'send',
  'handle',
  'on',
  'off',
  'emit',
  'next',
  'done',
  'then',
  'catch',
  'finally',
  'toString',
  'valueOf',
  'toJSON',
  'constructor',
  'apply',
  'call',
  'bind',
  'map',
  'filter',
  'reduce',
  'forEach',
  'find',
  'push',
  'pop',
  'parse',
  'format',
  'log',
  'error',
  'warn',
  'info',
  'debug',
  'default',
  'index',
  'main',
  'Component',
  'App',
]);

export type AstGrepCodeNavProviderOptions = {
  readonly loadAstGrep?: () => Promise<AstGrepModule | null>;
  readonly l1Limits?: {
    readonly maxFiles: number;
    readonly maxSourceBytes: number;
    readonly idleClearMs?: number;
  };
  readonly l2MaxBytes?: number;
  readonly maxResponseBytes?: number;
};

type ParsedFileHandle = {
  readonly root: AstGrepRoot;
  readonly source: string;
  readonly index: FileSymbolIndex;
};

export class AstGrepCodeNavProvider implements CodeNavProvider {
  readonly id = 'ast-grep' as const;
  private readonly astLru: BoundedAstLruCache<AstGrepRoot>;
  private readonly symbolIndexCache: BoundedSymbolIndexCache;
  private readonly importResolver = new WorkspaceImportResolver();
  private readonly astGrepLoader: () => Promise<AstGrepModule | null>;
  private readonly maxResponseBytes: number;

  constructor(options: AstGrepCodeNavProviderOptions = {}) {
    this.astGrepLoader = options.loadAstGrep ?? loadAstGrep;
    this.astLru = new BoundedAstLruCache<AstGrepRoot>(options.l1Limits);
    this.symbolIndexCache = new BoundedSymbolIndexCache(options.l2MaxBytes);
    this.maxResponseBytes = options.maxResponseBytes ?? CODE_NAV_LIMITS.maxResponseBytes;
  }

  getCacheStats() {
    return {
      l1: this.astLru.stats(),
      l2: this.symbolIndexCache.stats(),
    };
  }

  clearCaches(): void {
    this.astLru.clear();
    this.symbolIndexCache.clear();
  }

  private async requireAstGrep(): Promise<AstGrepModule | CodeNavQueryError> {
    const mod = await this.astGrepLoader();
    if (!mod) {
      return codeNavError('unavailable', {
        message: 'AST code navigation engine (@ast-grep/napi) is unavailable on this machine.',
      });
    }
    return mod;
  }

  /**
   * Parses a file and keeps its `SgRoot` in the bounded L1 LRU (used for active
   * files like the origin file of a query). Also populates L2 symbol index.
   */
  private async parseFileRetainingL1(
    astGrep: AstGrepModule,
    snapshotKey: WorkspaceSnapshotKey,
    absolutePath: string,
    relPath: string,
    language: CodeNavLanguage
  ): Promise<ParsedFileHandle | null> {
    const cacheKey = `${snapshotKey}\0${relPath}`;
    const cachedAst = this.astLru.get(cacheKey);
    if (cachedAst) {
      let index = this.symbolIndexCache.get(snapshotKey, relPath);
      if (!index) {
        index = extractFileSymbolIndex(relPath, language, cachedAst.source, cachedAst.root);
        this.symbolIndexCache.set(snapshotKey, relPath, index);
      }
      return { root: cachedAst.root, source: cachedAst.source, index };
    }

    const loaded = await readBoundedSourceFile(absolutePath);
    if (!loaded) return null;
    const root = astGrep.parse(toAstGrepLang(astGrep, language), loaded.source);
    let index = this.symbolIndexCache.get(snapshotKey, relPath);
    if (!index) {
      index = extractFileSymbolIndex(relPath, language, loaded.source, root);
      this.symbolIndexCache.set(snapshotKey, relPath, index);
    }
    this.astLru.set(cacheKey, {
      root,
      source: loaded.source,
      sourceBytes: loaded.byteLength,
    });
    return { root, source: loaded.source, index };
  }

  /**
   * Returns L2 pure-JSON `FileSymbolIndex` for a candidate file, parsing transiently
   * and immediately discarding `SgRoot` so scanning many files never inflates Rust RSS.
   */
  private async getFileSymbolIndex(
    astGrep: AstGrepModule,
    snapshotKey: WorkspaceSnapshotKey,
    absolutePath: string,
    relPath: string,
    language: CodeNavLanguage
  ): Promise<FileSymbolIndex | null> {
    const cached = this.symbolIndexCache.get(snapshotKey, relPath);
    if (cached) return cached;

    const l1 = this.astLru.get(`${snapshotKey}\0${relPath}`);
    if (l1) {
      const index = extractFileSymbolIndex(relPath, language, l1.source, l1.root);
      this.symbolIndexCache.set(snapshotKey, relPath, index);
      return index;
    }

    const loaded = await readBoundedSourceFile(absolutePath);
    if (!loaded) return null;
    // Parse transiently and immediately drop SgRoot after extracting pure-JSON index.
    const root = astGrep.parse(toAstGrepLang(astGrep, language), loaded.source);
    const index = extractFileSymbolIndex(relPath, language, loaded.source, root);
    this.symbolIndexCache.set(snapshotKey, relPath, index);
    return index;
  }

  /* ── 1. diff-outline ─────────────────────────────────────────────────────── */

  async diffOutline(
    input: CodeNavDiffOutlineInput,
    signal?: AbortSignal
  ): Promise<CodeNavDiffOutlineOk | CodeNavQueryError> {
    const astGrep = await this.requireAstGrep();
    if ('status' in astGrep) return astGrep;

    const canonicalRoot = await resolveCanonicalWorkspaceRoot(input.workspaceRoot);
    if (!canonicalRoot) {
      return codeNavError('workspace_unavailable', {
        message: 'Workspace directory is unavailable.',
      });
    }

    signal?.throwIfAborted();
    const { snapshotKey, headSha, isGitRepo } = await computeWorkspaceSnapshotKey(
      canonicalRoot,
      signal
    );
    if (!isGitRepo) {
      return {
        type: 'code-nav/query',
        status: 'ok',
        action: 'diff-outline',
        files: [],
        truncated: false,
        provider: this.id,
      };
    }

    let diffTarget: string | null = null;
    if (input.scope === 'uncommitted') {
      diffTarget = headSha;
    } else if (input.baseRef) {
      const validated = await resolveExplicitDiffBase(canonicalRoot, input.baseRef, signal);
      if (!validated.ok) {
        return codeNavError('invalid_request', { message: validated.message });
      }
      diffTarget = validated.commit;
    } else {
      diffTarget = await resolveAllChangesDiffBase(
        canonicalRoot,
        input.preferredBaseBranch,
        signal
      );
    }

    const [diffResult, untrackedResult] = await Promise.all([
      diffTarget
        ? runCommandTextLegacy(
            {
              command: 'git',
              args: [
                '-c',
                'core.quotePath=false',
                'diff',
                '-U0',
                '--no-renames',
                '--relative',
                diffTarget,
                '--',
              ],
              cwd: canonicalRoot,
              maxOutputBytes: GIT_MAX_BUFFER_BYTES,
              check: 'none',
            },
            { signal }
          )
        : Promise.resolve({ code: 0, stdout: '', stderr: '' }),
      runCommandTextLegacy(
        {
          command: 'git',
          args: ['ls-files', '--others', '--exclude-standard', '-z'],
          cwd: canonicalRoot,
          maxOutputBytes: GIT_MAX_BUFFER_BYTES,
          check: 'none',
        },
        { signal }
      ),
    ]);

    const parsedFiles = diffResult.code === 0 ? parseUnifiedDiffHunks(diffResult.stdout) : [];
    const seenPaths = new Set(parsedFiles.map((f) => f.relPath));

    // Include untracked supported source files (e.g. newly created TS files in uncommitted/branch work).
    const untrackedPaths: string[] = [];
    if (untrackedResult.code === 0 && untrackedResult.stdout) {
      for (const raw of untrackedResult.stdout.split('\0')) {
        if (!raw || seenPaths.has(raw) || !isSupportedCodeNavFile(raw)) continue;
        untrackedPaths.push(raw);
      }
    }

    const outlineFiles: CodeNavDiffOutlineFile[] = [];
    let truncated = false;

    const processOneFile = async (
      rawRelPath: string,
      rawHunks:
        | readonly {
            readonly startLine: number;
            readonly endLine: number;
            readonly codeLines: readonly number[];
            readonly fallbackLines: readonly number[];
          }[]
        | 'untracked'
    ) => {
      if (outlineFiles.length >= CODE_NAV_LIMITS.maxDiffOutlineFiles) {
        truncated = true;
        return;
      }
      if (!isSupportedCodeNavFile(rawRelPath)) return;
      const valid = await validateContainedCandidatePath(canonicalRoot, rawRelPath);
      if (!valid) return;
      const language = getCodeNavLanguage(valid.relPath);
      if (!language) return;

      signal?.throwIfAborted();
      const index = await this.getFileSymbolIndex(
        astGrep,
        snapshotKey,
        valid.absolutePath,
        valid.relPath,
        language
      );
      if (!index) return;

      let hunksToProcess: readonly {
        readonly startLine: number;
        readonly endLine: number;
        readonly codeLines: readonly number[];
        readonly fallbackLines: readonly number[];
      }[];
      if (rawHunks === 'untracked') {
        const loaded = await readBoundedSourceFile(valid.absolutePath);
        if (!loaded) return;
        const lineCount = Math.max(1, loaded.source.split(/\r?\n/u).length);
        const allLines = index.symbols.map((s) => s.nameLine);
        hunksToProcess = [
          {
            startLine: 1,
            endLine: lineCount,
            codeLines: allLines.length > 0 ? allLines : [1],
            fallbackLines: [1],
          },
        ];
      } else {
        hunksToProcess = rawHunks;
      }

      const symbolHunkCounts = new Map<IndexedSymbol, number>();
      const outHunks: CodeNavDiffOutlineHunk[] = [];

      const cappedHunks =
        hunksToProcess.length > CODE_NAV_LIMITS.maxHunksPerFile
          ? ((truncated = true), hunksToProcess.slice(0, CODE_NAV_LIMITS.maxHunksPerFile))
          : hunksToProcess;

      for (const hunk of cappedHunks) {
        const linesToProbe = hunk.codeLines.length > 0 ? hunk.codeLines : hunk.fallbackLines;
        const hitSymbols = new Set<IndexedSymbol>();
        const frequency = new Map<IndexedSymbol, number>();

        for (const lineNo of linesToProbe) {
          const sym = findInnermostSymbolAtLine(index.symbols, lineNo);
          if (sym) {
            hitSymbols.add(sym);
            frequency.set(sym, (frequency.get(sym) ?? 0) + 1);
          }
        }

        // Choose the most frequently intersected innermost symbol as the hunk's primary enclosing symbol.
        let primary: IndexedSymbol | undefined;
        let primaryCount = 0;
        for (const [sym, count] of frequency) {
          if (
            !primary ||
            count > primaryCount ||
            (count === primaryCount && sym.isCallable && !primary.isCallable)
          ) {
            primary = sym;
            primaryCount = count;
          }
        }

        for (const sym of hitSymbols) {
          symbolHunkCounts.set(sym, (symbolHunkCounts.get(sym) ?? 0) + 1);
        }

        outHunks.push({
          startLine: hunk.startLine,
          endLine: hunk.endLine,
          ...(primary ? { enclosing: toPublicCodeNavSymbol(primary) } : {}),
        });
      }

      // Surface separated React HOC wrappers (`export const Foo = memo(FooImpl)`)
      // when their wrapped implementation `FooImpl` was modified in this diff.
      for (const wrapper of index.symbols) {
        if (!wrapper.wrapsIdentifier) continue;
        if (symbolHunkCounts.has(wrapper)) continue;
        for (const [touched, count] of symbolHunkCounts) {
          if (touched.name === wrapper.wrapsIdentifier) {
            symbolHunkCounts.set(wrapper, count);
            break;
          }
        }
      }

      const outSymbols: CodeNavDiffOutlineSymbol[] = [...symbolHunkCounts.entries()]
        .sort(([a], [b]) => a.startLine - b.startLine || a.endLine - b.endLine)
        .slice(0, CODE_NAV_LIMITS.maxSymbolsPerFile)
        .map(([sym, hunkCount]) => ({
          ...toPublicCodeNavSymbol(sym),
          hunkCount,
        }));

      if (symbolHunkCounts.size > CODE_NAV_LIMITS.maxSymbolsPerFile) {
        truncated = true;
      }

      outlineFiles.push({
        path: valid.relPath,
        symbols: outSymbols,
        hunks: outHunks,
      });
    };

    for (const file of parsedFiles) {
      await processOneFile(file.relPath, file.hunks);
    }
    for (const relPath of untrackedPaths) {
      await processOneFile(relPath, 'untracked');
    }

    const response: CodeNavDiffOutlineOk = {
      type: 'code-nav/query',
      status: 'ok',
      action: 'diff-outline',
      ...(diffTarget ? { baseRef: diffTarget } : {}),
      ...(headSha ? { headSha } : {}),
      files: outlineFiles,
      truncated,
      provider: this.id,
    };

    return trimResponseToBudget(response, this.maxResponseBytes) as CodeNavDiffOutlineOk;
  }

  /* ── 2. enclosing ────────────────────────────────────────────────────────── */

  async enclosing(
    input: CodeNavEnclosingInput,
    signal?: AbortSignal
  ): Promise<CodeNavEnclosingOk | CodeNavQueryError> {
    const astGrep = await this.requireAstGrep();
    if ('status' in astGrep) return astGrep;

    const canonicalRoot = await resolveCanonicalWorkspaceRoot(input.workspaceRoot);
    if (!canonicalRoot) {
      return codeNavError('workspace_unavailable', {
        message: 'Workspace directory is unavailable.',
      });
    }

    const resolved = await resolveContainedWorkspacePath(canonicalRoot, input.path);
    if (!resolved.ok) {
      return codeNavError(resolved.code, { message: resolved.message });
    }
    const language = getCodeNavLanguage(resolved.relPath);
    if (!language) {
      return codeNavError('unsupported_language', {
        message: `Unsupported language for ${resolved.relPath}`,
      });
    }

    signal?.throwIfAborted();
    const { snapshotKey } = await computeWorkspaceSnapshotKey(canonicalRoot, signal);
    const parsed = await this.parseFileRetainingL1(
      astGrep,
      snapshotKey,
      resolved.absolutePath,
      resolved.relPath,
      language
    );
    if (!parsed) {
      return codeNavError('transient_io', {
        message: `Could not read or parse ${resolved.relPath}`,
      });
    }

    const chain = findEnclosingSymbolChain(parsed.index.symbols, input.startLine, input.endLine);
    return {
      type: 'code-nav/query',
      status: 'ok',
      action: 'enclosing',
      path: resolved.relPath,
      chain,
      provider: this.id,
    };
  }

  /* ── 3. definition ───────────────────────────────────────────────────────── */

  async definitions(
    input: CodeNavDefinitionInput,
    signal?: AbortSignal
  ): Promise<CodeNavDefinitionOk | CodeNavQueryError> {
    const astGrep = await this.requireAstGrep();
    if ('status' in astGrep) return astGrep;

    const canonicalRoot = await resolveCanonicalWorkspaceRoot(input.workspaceRoot);
    if (!canonicalRoot) {
      return codeNavError('workspace_unavailable', {
        message: 'Workspace directory is unavailable.',
      });
    }

    const resolved = await resolveContainedWorkspacePath(canonicalRoot, input.path);
    if (!resolved.ok) {
      return codeNavError(resolved.code, { message: resolved.message });
    }
    const language = getCodeNavLanguage(resolved.relPath);
    if (!language) {
      return codeNavError('unsupported_language', {
        message: `Unsupported language for ${resolved.relPath}`,
      });
    }

    signal?.throwIfAborted();
    const { snapshotKey, isGitRepo } = await computeWorkspaceSnapshotKey(canonicalRoot, signal);
    const origin = await this.parseFileRetainingL1(
      astGrep,
      snapshotKey,
      resolved.absolutePath,
      resolved.relPath,
      language
    );
    if (!origin) {
      return codeNavError('transient_io', {
        message: `Could not read or parse ${resolved.relPath}`,
      });
    }

    const cursor = resolveSymbolContextAtPosition(
      origin.root,
      origin.source,
      input.line,
      input.character,
      input.symbolHint
    );
    if (!cursor || !cursor.symbol) {
      return {
        type: 'code-nav/query',
        status: 'ok',
        action: 'definition',
        symbol: input.symbolHint ?? '',
        items: [],
        confidence: 'heuristic',
        totalCandidates: 0,
        truncated: false,
        provider: this.id,
      };
    }

    const limit = Math.min(
      input.limit ?? CODE_NAV_LIMITS.defaultDefinitionLimit,
      CODE_NAV_LIMITS.maxDefinitionLimit
    );

    type ScoredCandidate = {
      readonly location: CodeNavLocation;
      readonly score: number;
      readonly provenance:
        | 'same-file'
        | 'this-member'
        | 'direct-import'
        | 'namespace-import'
        | 'repo-scan';
    };

    const candidates: ScoredCandidate[] = [];
    const seenKeys = new Set<string>();
    const pushCandidate = (candidate: ScoredCandidate) => {
      const key = `${candidate.location.path}:${candidate.location.line}:${candidate.location.character}:${candidate.location.name}`;
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
      candidates.push(candidate);
    };

    const toLocation = (relPath: string, sym: IndexedSymbol): CodeNavLocation => ({
      path: relPath,
      line: sym.nameLine,
      character: sym.nameCharacter,
      endLine: sym.nameEndLine,
      endCharacter: sym.nameEndCharacter,
      name: sym.name,
      kind: sym.kind,
      ...(sym.containerName ? { containerName: sym.containerName } : {}),
      previewLine: sym.previewLine,
    });

    const kindBonus = (sym: IndexedSymbol): number => {
      if (cursor.isTypePosition) {
        return sym.kind === 'interface' ||
          sym.kind === 'type' ||
          sym.kind === 'class' ||
          sym.kind === 'enum'
          ? 12
          : 0;
      }
      if (cursor.isJsxTag) {
        return sym.kind === 'component' || sym.kind === 'function' ? 12 : 0;
      }
      if (cursor.isCallCallee) {
        return sym.isCallable || sym.kind === 'class' ? 10 : 0;
      }
      return 0;
    };

    // Helper: resolve a symbol from a target module file, following up to 1 hop of barrel re-exports.
    const resolveExportedSymbolInModule = async (
      moduleRelPath: string,
      moduleAbsPath: string,
      targetName: string,
      allowBarrelHop: boolean
    ): Promise<Array<{ readonly relPath: string; readonly sym: IndexedSymbol }>> => {
      const targetLang = getCodeNavLanguage(moduleRelPath);
      if (!targetLang) return [];
      const modIndex = await this.getFileSymbolIndex(
        astGrep,
        snapshotKey,
        moduleAbsPath,
        moduleRelPath,
        targetLang
      );
      if (!modIndex) return [];

      // Local export alias mapping (`export { impl as Target }`)
      const aliasMatches = modIndex.exports
        .filter(
          (e): e is Extract<FileSymbolIndex['exports'][number], { kind: 'local-alias' }> =>
            e.kind === 'local-alias' && e.exportedName === targetName
        )
        .map((e) => e.localName);
      const searchNames = new Set([targetName, ...aliasMatches]);

      const directHits = modIndex.symbols.filter(
        (sym) => !sym.containerName && searchNames.has(sym.name)
      );
      if (directHits.length > 0) {
        return directHits.map((sym) => ({ relPath: moduleRelPath, sym }));
      }

      // Default export fallback: prefer exact local name match, else unique exported symbol.
      if (targetName === 'default') {
        const exportedTop = modIndex.symbols.filter((sym) => !sym.containerName && sym.isExported);
        if (exportedTop.length === 1) {
          return [{ relPath: moduleRelPath, sym: exportedTop[0]! }];
        }
      }

      if (!allowBarrelHop) return [];

      // 1-hop named re-export: `export { foo as Target } from './sub'`
      for (const exp of modIndex.exports) {
        if (exp.kind === 'reexport-named' && exp.exportedName === targetName) {
          const next = await this.importResolver.resolveSpecifier(
            canonicalRoot,
            moduleRelPath,
            exp.specifier
          );
          if (next) {
            const subHits = await resolveExportedSymbolInModule(
              next.relPath,
              next.absolutePath,
              exp.originalName,
              false
            );
            if (subHits.length > 0) return subHits;
          }
        }
      }

      // 1-hop wildcard barrel: `export * from './sub'`
      const starExports = modIndex.exports.filter(
        (e): e is Extract<FileSymbolIndex['exports'][number], { kind: 'reexport-all' }> =>
          e.kind === 'reexport-all'
      );
      for (const exp of starExports.slice(0, 64)) {
        const next = await this.importResolver.resolveSpecifier(
          canonicalRoot,
          moduleRelPath,
          exp.specifier
        );
        if (!next) continue;
        const subHits = await resolveExportedSymbolInModule(
          next.relPath,
          next.absolutePath,
          targetName,
          false
        );
        if (subHits.length > 0) return subHits;
      }

      return [];
    };

    // (A) Direct `this.member` resolution inside enclosing class.
    if (cursor.isMemberAccess && cursor.receiver === 'this') {
      const enclosingClass = origin.index.symbols.find(
        (sym) => sym.kind === 'class' && sym.startLine <= input.line && input.line <= sym.endLine
      );
      if (enclosingClass) {
        for (const sym of origin.index.symbols) {
          if (sym.containerName === enclosingClass.name && sym.name === cursor.symbol) {
            pushCandidate({
              location: toLocation(resolved.relPath, sym),
              score: 120 + kindBonus(sym),
              provenance: 'this-member',
            });
          }
        }
      }
    }

    // (B) Namespace import member access: `Ns.foo` where `import * as Ns from '...'`
    if (cursor.isMemberAccess && cursor.receiver && cursor.receiver !== 'this') {
      const nsImport = origin.index.imports.find(
        (imp) => imp.importedName === '*' && imp.localName === cursor.receiver
      );
      if (nsImport) {
        const target = await this.importResolver.resolveSpecifier(
          canonicalRoot,
          resolved.relPath,
          nsImport.specifier
        );
        if (target) {
          const hits = await resolveExportedSymbolInModule(
            target.relPath,
            target.absolutePath,
            cursor.symbol,
            true
          );
          for (const hit of hits) {
            pushCandidate({
              location: toLocation(hit.relPath, hit.sym),
              score: 110 + kindBonus(hit.sym),
              provenance: 'namespace-import',
            });
          }
        }
      }
    }

    // (C) Cursor directly on an `import` specifier, or non-member symbol imported in this file.
    if (cursor.importSpecifier) {
      const target = await this.importResolver.resolveSpecifier(
        canonicalRoot,
        resolved.relPath,
        cursor.importSpecifier
      );
      if (target) {
        const hits = await resolveExportedSymbolInModule(
          target.relPath,
          target.absolutePath,
          cursor.importedOriginalName ?? cursor.symbol,
          true
        );
        for (const hit of hits) {
          pushCandidate({
            location: toLocation(hit.relPath, hit.sym),
            score: 115 + kindBonus(hit.sym),
            provenance: 'direct-import',
          });
        }
      }
    } else if (!cursor.isMemberAccess) {
      // Check same-file declaration first.
      for (const sym of origin.index.symbols) {
        if (sym.name !== cursor.symbol) continue;
        // Skip class methods when resolving a bare identifier outside `this.`.
        if (sym.kind === 'method' || sym.kind === 'property') continue;
        pushCandidate({
          location: toLocation(resolved.relPath, sym),
          score: 115 + kindBonus(sym),
          provenance: 'same-file',
        });
      }

      // Check static imports in the origin file.
      const matchingImports = origin.index.imports.filter(
        (imp) => imp.localName === cursor.symbol && imp.importedName !== '*'
      );
      for (const imp of matchingImports) {
        const target = await this.importResolver.resolveSpecifier(
          canonicalRoot,
          resolved.relPath,
          imp.specifier
        );
        if (!target) continue;
        let hits = await resolveExportedSymbolInModule(
          target.relPath,
          target.absolutePath,
          imp.importedName === 'default' ? cursor.symbol : imp.importedName,
          true
        );
        if (hits.length === 0 && imp.importedName === 'default') {
          hits = await resolveExportedSymbolInModule(
            target.relPath,
            target.absolutePath,
            'default',
            true
          );
        }
        for (const hit of hits) {
          pushCandidate({
            location: toLocation(hit.relPath, hit.sym),
            score: 105 + kindBonus(hit.sym),
            provenance: 'direct-import',
          });
        }
      }
    }

    // Fast path: if we already have an exact high-confidence binding (same-file, `this.member`,
    // `direct-import`, or `namespace-import`), return without scanning the whole repository.
    const exactProvenanceHits = candidates.filter((c) => c.provenance !== 'repo-scan');
    if (exactProvenanceHits.length === 1) {
      return {
        type: 'code-nav/query',
        status: 'ok',
        action: 'definition',
        symbol: cursor.symbol,
        items: [exactProvenanceHits[0]!.location],
        confidence: 'exact',
        totalCandidates: 1,
        truncated: false,
        provider: this.id,
      };
    }

    // (D) Repo-wide pre-filter via `git grep -l -w -F` + untracked code files.
    let truncated = false;
    let totalFilesMatched = 0;

    if (exactProvenanceHits.length === 0) {
      const candidateFiles = await findCandidateCodeFilesByWord(
        canonicalRoot,
        cursor.symbol,
        isGitRepo,
        signal
      );
      totalFilesMatched = candidateFiles.length;
      const filesToScan =
        candidateFiles.length > MAX_CANDIDATE_FILES_PER_QUERY
          ? ((truncated = true), candidateFiles.slice(0, MAX_CANDIDATE_FILES_PER_QUERY))
          : candidateFiles;

      const originDir = path.posix.dirname(resolved.relPath);
      const originPkg = topPackagePrefix(resolved.relPath);
      const receiverLower = cursor.receiver?.toLowerCase();

      for (const file of filesToScan) {
        signal?.throwIfAborted();
        const lang = getCodeNavLanguage(file.relPath);
        if (!lang) continue;
        const idx = await this.getFileSymbolIndex(
          astGrep,
          snapshotKey,
          file.absolutePath,
          file.relPath,
          lang
        );
        if (!idx) continue;

        for (const sym of idx.symbols) {
          if (sym.name !== cursor.symbol) continue;
          let score = 20 + kindBonus(sym);
          if (file.relPath === resolved.relPath) score += 40;
          if (path.posix.dirname(file.relPath) === originDir) score += 25;
          if (originPkg && topPackagePrefix(file.relPath) === originPkg) score += 12;
          if (sym.isExported) score += 10;
          if (cursor.isMemberAccess) {
            if (sym.kind === 'method' || sym.kind === 'property') score += 18;
            if (
              receiverLower &&
              sym.containerName &&
              (sym.containerName.toLowerCase() === receiverLower ||
                sym.containerName.toLowerCase().includes(receiverLower) ||
                receiverLower.includes(sym.containerName.toLowerCase()))
            ) {
              score += 25;
            }
          } else if (!sym.containerName) {
            score += 15;
          }
          pushCandidate({
            location: toLocation(file.relPath, sym),
            score,
            provenance: 'repo-scan',
          });
        }
      }
    }

    candidates.sort(
      (a, b) =>
        b.score - a.score ||
        a.location.path.localeCompare(b.location.path) ||
        a.location.line - b.location.line
    );

    const totalCandidates = Math.max(
      candidates.length,
      totalFilesMatched > MAX_CANDIDATE_FILES_PER_QUERY ? totalFilesMatched : candidates.length
    );
    if (candidates.length > limit) {
      truncated = true;
    }

    const items = candidates.slice(0, limit).map((c) => c.location);

    // Strict confidence rule:
    // NEVER report `'exact'` for arbitrary member methods (`foo.close()`) or
    // repo-scan heuristic guesses without same-file / `this` / explicit import proof.
    const isExact =
      candidates.length === 1 && !truncated && candidates[0]!.provenance !== 'repo-scan';
    const confidence: CodeNavConfidence = isExact ? 'exact' : 'heuristic';

    const response: CodeNavDefinitionOk = {
      type: 'code-nav/query',
      status: 'ok',
      action: 'definition',
      symbol: cursor.symbol,
      items,
      confidence,
      totalCandidates,
      truncated,
      provider: this.id,
    };

    return trimResponseToBudget(response, this.maxResponseBytes) as CodeNavDefinitionOk;
  }

  /* ── 4. callers (1–2 hop upward trace) ──────────────────────────────────── */

  async callers(
    input: CodeNavCallersInput,
    signal?: AbortSignal
  ): Promise<CodeNavCallersOk | CodeNavQueryError> {
    const astGrep = await this.requireAstGrep();
    if ('status' in astGrep) return astGrep;

    const canonicalRoot = await resolveCanonicalWorkspaceRoot(input.workspaceRoot);
    if (!canonicalRoot) {
      return codeNavError('workspace_unavailable', {
        message: 'Workspace directory is unavailable.',
      });
    }

    const resolved = await resolveContainedWorkspacePath(canonicalRoot, input.path);
    if (!resolved.ok) {
      return codeNavError(resolved.code, { message: resolved.message });
    }
    const language = getCodeNavLanguage(resolved.relPath);
    if (!language) {
      return codeNavError('unsupported_language', {
        message: `Unsupported language for ${resolved.relPath}`,
      });
    }

    signal?.throwIfAborted();
    const { snapshotKey, isGitRepo } = await computeWorkspaceSnapshotKey(canonicalRoot, signal);
    const origin = await this.parseFileRetainingL1(
      astGrep,
      snapshotKey,
      resolved.absolutePath,
      resolved.relPath,
      language
    );
    if (!origin) {
      return codeNavError('transient_io', {
        message: `Could not read or parse ${resolved.relPath}`,
      });
    }

    const cursor = resolveSymbolContextAtPosition(
      origin.root,
      origin.source,
      input.line,
      input.character,
      input.symbolHint
    );
    const symbolName = cursor?.symbol ?? input.symbolHint ?? '';
    if (!symbolName) {
      return {
        type: 'code-nav/query',
        status: 'ok',
        action: 'callers',
        symbol: '',
        items: [],
        totalCandidates: 0,
        truncated: false,
        provider: this.id,
      };
    }

    const maxDepth = input.maxDepth ?? 1;
    const limit = Math.min(
      input.limit ?? CODE_NAV_LIMITS.defaultCallersLimit,
      CODE_NAV_LIMITS.maxCallersLimit
    );

    const hop1 = await this.findDirectCallersForSymbol({
      astGrep,
      canonicalRoot,
      snapshotKey,
      isGitRepo,
      symbolName,
      originRelPath: resolved.relPath,
      originLine: input.line,
      maxFiles: MAX_CANDIDATE_FILES_PER_QUERY,
      signal,
    });

    const items: CodeNavCallerItem[] = [];
    const seenSiteKeys = new Set<string>();
    let totalCandidates = hop1.sites.length;
    let truncated = hop1.truncated;
    let truncatedReason: CodeNavTruncatedReason | undefined = hop1.truncated ? 'limit' : undefined;

    for (const site of hop1.sites) {
      if (items.length >= limit) {
        truncated = true;
        truncatedReason = truncatedReason ?? 'limit';
        break;
      }
      const key = `${site.path}:${site.line}:${site.character}`;
      if (seenSiteKeys.has(key)) continue;
      seenSiteKeys.add(key);
      items.push({
        path: site.path,
        line: site.line,
        character: site.character,
        previewLine: site.previewLine,
        ...(site.receiver ? { receiver: site.receiver } : {}),
        depth: 1,
        ...(site.caller ? { caller: site.caller } : {}),
      });
    }

    // Optional hop 2: trace upward from unique depth-1 enclosing caller function names,
    // with fan-out protection against generic/short high-frequency names.
    if (maxDepth === 2 && items.length < limit) {
      const hop1Callers = new Map<string, { readonly path: string; readonly line: number }>();
      for (const item of items) {
        const callerName = item.caller?.name;
        if (!callerName || callerName === symbolName) continue;
        if (!hop1Callers.has(callerName)) {
          hop1Callers.set(callerName, { path: item.path, line: item.caller!.startLine });
        }
      }

      let expandedCount = 0;
      for (const [callerName, callerOrigin] of hop1Callers) {
        signal?.throwIfAborted();
        if (items.length >= limit) {
          truncated = true;
          truncatedReason = truncatedReason ?? 'limit';
          break;
        }
        if (callerName.length < 3 || GENERIC_HOP2_STOP_NAMES.has(callerName)) {
          truncated = true;
          truncatedReason = 'fanout';
          continue;
        }
        if (expandedCount >= MAX_HOP2_SYMBOLS) {
          truncated = true;
          truncatedReason = 'fanout';
          break;
        }
        expandedCount += 1;

        const hop2 = await this.findDirectCallersForSymbol({
          astGrep,
          canonicalRoot,
          snapshotKey,
          isGitRepo,
          symbolName: callerName,
          originRelPath: callerOrigin.path,
          originLine: callerOrigin.line,
          maxFiles: MAX_HOP2_CANDIDATE_FILES,
          abortIfExceedsMaxFiles: true,
          signal,
        });

        if (hop2.fanoutSkipped) {
          truncated = true;
          truncatedReason = 'fanout';
          continue;
        }
        totalCandidates += hop2.sites.length;
        if (hop2.truncated) {
          truncated = true;
          truncatedReason = truncatedReason ?? 'limit';
        }

        for (const site of hop2.sites) {
          if (items.length >= limit) {
            truncated = true;
            truncatedReason = truncatedReason ?? 'limit';
            break;
          }
          const key = `${site.path}:${site.line}:${site.character}`;
          if (seenSiteKeys.has(key)) continue;
          seenSiteKeys.add(key);
          items.push({
            path: site.path,
            line: site.line,
            character: site.character,
            previewLine: site.previewLine,
            ...(site.receiver ? { receiver: site.receiver } : {}),
            depth: 2,
            viaSymbol: callerName,
            ...(site.caller ? { caller: site.caller } : {}),
          });
        }
      }
    }

    const response: CodeNavCallersOk = {
      type: 'code-nav/query',
      status: 'ok',
      action: 'callers',
      symbol: symbolName,
      items,
      totalCandidates,
      truncated,
      ...(truncated && truncatedReason ? { truncatedReason } : {}),
      provider: this.id,
    };

    return trimResponseToBudget(response, this.maxResponseBytes) as CodeNavCallersOk;
  }

  /**
   * Adaptive two-stage caller finder:
   * 1. Pre-filter candidates via `git grep -l -w -F` (+ untracked code files).
   * 2. `< 50` files -> per-file NAPI parsing with L1/L2 caches;
   *    `>= 50` files -> Rust multithreaded `findInFiles` grouped by language.
   */
  private async findDirectCallersForSymbol(args: {
    readonly astGrep: AstGrepModule;
    readonly canonicalRoot: string;
    readonly snapshotKey: WorkspaceSnapshotKey;
    readonly isGitRepo: boolean;
    readonly symbolName: string;
    readonly originRelPath: string;
    readonly originLine: number;
    readonly maxFiles: number;
    readonly abortIfExceedsMaxFiles?: boolean;
    readonly signal?: AbortSignal;
  }) {
    const candidates = await findCandidateCodeFilesByWord(
      args.canonicalRoot,
      args.symbolName,
      args.isGitRepo,
      args.signal
    );

    if (args.abortIfExceedsMaxFiles && candidates.length > args.maxFiles) {
      return { sites: [], truncated: true, fanoutSkipped: true };
    }

    let truncated = false;
    const filesToScan =
      candidates.length > args.maxFiles
        ? ((truncated = true), candidates.slice(0, args.maxFiles))
        : candidates;

    const excludeOrigin = { relPath: args.originRelPath, line: args.originLine };
    const sites: Array<ReturnType<typeof findCallSitesInRoot>[number]> = [];

    if (filesToScan.length < FIND_IN_FILES_THRESHOLD) {
      for (const file of filesToScan) {
        args.signal?.throwIfAborted();
        const lang = getCodeNavLanguage(file.relPath);
        if (!lang) continue;
        const l1 = this.astLru.get(`${args.snapshotKey}\0${file.relPath}`);
        if (l1) {
          const index =
            this.symbolIndexCache.get(args.snapshotKey, file.relPath) ??
            extractFileSymbolIndex(file.relPath, lang, l1.source, l1.root);
          this.symbolIndexCache.set(args.snapshotKey, file.relPath, index);
          sites.push(
            ...findCallSitesInRoot(
              l1.root,
              l1.source,
              file.relPath,
              args.symbolName,
              index.symbols,
              excludeOrigin
            )
          );
          continue;
        }
        const loaded = await readBoundedSourceFile(file.absolutePath);
        if (!loaded) continue;
        const root = args.astGrep.parse(toAstGrepLang(args.astGrep, lang), loaded.source);
        const index =
          this.symbolIndexCache.get(args.snapshotKey, file.relPath) ??
          extractFileSymbolIndex(file.relPath, lang, loaded.source, root);
        this.symbolIndexCache.set(args.snapshotKey, file.relPath, index);
        sites.push(
          ...findCallSitesInRoot(
            root,
            loaded.source,
            file.relPath,
            args.symbolName,
            index.symbols,
            excludeOrigin
          )
        );
      }
    } else {
      // `>= 50` candidate files: use Rust multithreaded `findInFiles` grouped by language.
      const byLang = new Map<CodeNavLanguage, Array<{ absolutePath: string; relPath: string }>>();
      for (const file of filesToScan) {
        const lang = getCodeNavLanguage(file.relPath);
        if (!lang) continue;
        const bucket = byLang.get(lang) ?? [];
        bucket.push(file);
        byLang.set(lang, bucket);
      }

      const matcher = buildSymbolUsageMatcher(args.symbolName);
      for (const [lang, bucket] of byLang) {
        args.signal?.throwIfAborted();
        const globs =
          lang === 'typescript'
            ? ['*.ts', '*.mts', '*.cts']
            : lang === 'tsx'
              ? ['*.tsx', '*.jsx']
              : ['*.js', '*.mjs', '*.cjs'];
        const absToRel = new Map(bucket.map((item) => [item.absolutePath, item.relPath]));

        await args.astGrep.findInFiles(
          toAstGrepLang(args.astGrep, lang),
          {
            paths: bucket.map((item) => item.absolutePath),
            languageGlobs: globs,
            matcher,
          },
          (err, nodes) => {
            if (err || !nodes || nodes.length === 0) return;
            const fileName = nodes[0]!.getRoot().filename();
            const relPath = absToRel.get(fileName) ?? toPosixRelPath(args.canonicalRoot, fileName);
            if (!relPath || relPath.startsWith('..')) return;
            const root = nodes[0]!.getRoot();
            const source = root.root().text();
            let index = this.symbolIndexCache.get(args.snapshotKey, relPath);
            if (!index) {
              index = extractFileSymbolIndex(relPath, lang, source, root);
              this.symbolIndexCache.set(args.snapshotKey, relPath, index);
            }
            const lines = source.split(/\r?\n/u);
            sites.push(
              ...collectCallSitesFromMatchedNodes(
                nodes as readonly AstGrepNode[],
                lines,
                relPath,
                index.symbols,
                excludeOrigin
              )
            );
          }
        );
      }
    }

    // Prioritize callers in the same directory or package, then stable path/line order.
    const originDir = path.posix.dirname(args.originRelPath);
    const originPkg = topPackagePrefix(args.originRelPath);
    sites.sort((a, b) => {
      const aSameFile = a.path === args.originRelPath ? 1 : 0;
      const bSameFile = b.path === args.originRelPath ? 1 : 0;
      if (aSameFile !== bSameFile) return bSameFile - aSameFile;
      const aSameDir = path.posix.dirname(a.path) === originDir ? 1 : 0;
      const bSameDir = path.posix.dirname(b.path) === originDir ? 1 : 0;
      if (aSameDir !== bSameDir) return bSameDir - aSameDir;
      const aSamePkg = originPkg && topPackagePrefix(a.path) === originPkg ? 1 : 0;
      const bSamePkg = originPkg && topPackagePrefix(b.path) === originPkg ? 1 : 0;
      if (aSamePkg !== bSamePkg) return bSamePkg - aSamePkg;
      return a.path.localeCompare(b.path) || a.line - b.line || a.character - b.character;
    });

    return { sites, truncated, fanoutSkipped: false };
  }
}

/* ── Shared helpers ───────────────────────────────────────────────────────── */

async function readBoundedSourceFile(
  absolutePath: string
): Promise<{ readonly source: string; readonly byteLength: number } | null> {
  try {
    const info = await stat(absolutePath);
    if (!info.isFile() || info.size > CODE_NAV_CACHE_LIMITS.maxSingleFileBytes) {
      return null;
    }
    const buf = await readFile(absolutePath);
    if (buf.byteLength > CODE_NAV_CACHE_LIMITS.maxSingleFileBytes) return null;
    if (buf.includes(0)) return null; // binary guard
    return { source: buf.toString('utf8'), byteLength: buf.byteLength };
  } catch {
    return null;
  }
}

async function resolveExplicitDiffBase(
  canonicalRoot: string,
  baseRef: string,
  signal?: AbortSignal
): Promise<
  { readonly ok: true; readonly commit: string } | { readonly ok: false; readonly message: string }
> {
  const trimmed = baseRef.trim();
  if (!trimmed || trimmed.startsWith('-') || /[\0\r\n\s]/u.test(trimmed)) {
    return { ok: false, message: 'Invalid git baseRef.' };
  }
  const verified = await runCommandTextLegacy(
    {
      command: 'git',
      args: ['rev-parse', '--verify', `${trimmed}^{commit}`],
      cwd: canonicalRoot,
      check: 'none',
    },
    { signal }
  );
  if (verified.code !== 0 || !verified.stdout.trim()) {
    return { ok: false, message: `Git baseRef not found: ${trimmed}` };
  }
  const baseCommit = verified.stdout.trim();
  const mergeBase = await runCommandTextLegacy(
    {
      command: 'git',
      args: ['merge-base', baseCommit, 'HEAD'],
      cwd: canonicalRoot,
      check: 'none',
    },
    { signal }
  );
  return {
    ok: true,
    commit: mergeBase.code === 0 && mergeBase.stdout.trim() ? mergeBase.stdout.trim() : baseCommit,
  };
}

/**
 * Finds workspace code files containing whole-word literal `symbolName` using
 * `git grep -l -w -F -z` (tracked files, respecting `.gitignore`) plus untracked
 * non-ignored code files, validating every path inside `canonicalRoot`.
 */
async function findCandidateCodeFilesByWord(
  canonicalRoot: string,
  symbolName: string,
  isGitRepo: boolean,
  signal?: AbortSignal
): Promise<Array<{ readonly absolutePath: string; readonly relPath: string }>> {
  if (!isGitRepo || !symbolName || symbolName.includes('\0')) return [];

  const [grepResult, untrackedResult] = await Promise.all([
    runCommandTextLegacy(
      {
        command: 'git',
        args: ['grep', '-l', '-w', '-F', '-z', '--', symbolName],
        cwd: canonicalRoot,
        maxOutputBytes: GIT_MAX_BUFFER_BYTES,
        check: 'none',
      },
      { signal }
    ),
    runCommandTextLegacy(
      {
        command: 'git',
        args: ['ls-files', '--others', '--exclude-standard', '-z'],
        cwd: canonicalRoot,
        maxOutputBytes: GIT_MAX_BUFFER_BYTES,
        check: 'none',
      },
      { signal }
    ),
  ]);

  const rawPaths: string[] = [];
  const seen = new Set<string>();

  if (grepResult.code === 0 && grepResult.stdout) {
    for (const rel of grepResult.stdout.split('\0')) {
      if (!rel || seen.has(rel) || !isSupportedCodeNavFile(rel)) continue;
      seen.add(rel);
      rawPaths.push(rel);
    }
  }

  // Also check untracked non-ignored code files (capped to keep fast on messy repos).
  if (untrackedResult.code === 0 && untrackedResult.stdout) {
    const wordRegex = new RegExp(`\\b${escapeRegexForWord(symbolName)}\\b`, 'u');
    let checkedUntracked = 0;
    for (const rel of untrackedResult.stdout.split('\0')) {
      if (!rel || seen.has(rel) || !isSupportedCodeNavFile(rel)) continue;
      if (checkedUntracked >= 200) break;
      checkedUntracked += 1;
      const valid = await validateContainedCandidatePath(canonicalRoot, rel);
      if (!valid) continue;
      const loaded = await readBoundedSourceFile(valid.absolutePath);
      if (loaded && wordRegex.test(loaded.source)) {
        seen.add(valid.relPath);
        rawPaths.push(valid.relPath);
      }
    }
  }

  const verified: Array<{ readonly absolutePath: string; readonly relPath: string }> = [];
  for (const rel of rawPaths) {
    const valid = await validateContainedCandidatePath(canonicalRoot, rel);
    if (valid) verified.push(valid);
  }
  return verified;
}

function escapeRegexForWord(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function topPackagePrefix(relPath: string): string | null {
  const parts = relPath.split('/');
  if (parts.length >= 2 && (parts[0] === 'packages' || parts[0] === 'apps')) {
    return `${parts[0]}/${parts[1]}`;
  }
  return null;
}

/**
 * Enforces the 256 KiB hard response wire budget across all actions by trimming
 * trailing files/items when necessary and setting `truncated: true`.
 */
export function trimResponseToBudget(
  response: CodeNavQueryResponse,
  maxBytes: number = CODE_NAV_LIMITS.maxResponseBytes
): CodeNavQueryResponse {
  if (response.status === 'error') return response;
  if (estimateCodeNavResponseBytes(response) <= maxBytes) return response;

  if (response.action === 'diff-outline') {
    const files = [...response.files];
    while (files.length > 0) {
      const candidate: CodeNavDiffOutlineOk = { ...response, files, truncated: true };
      if (estimateCodeNavResponseBytes(candidate) <= maxBytes) return candidate;
      files.pop();
    }
    return { ...response, files: [], truncated: true };
  }

  if (response.action === 'definition') {
    const items = [...response.items];
    while (items.length > 0) {
      const candidate: CodeNavDefinitionOk = {
        ...response,
        items,
        confidence: 'heuristic',
        truncated: true,
      };
      if (estimateCodeNavResponseBytes(candidate) <= maxBytes) return candidate;
      items.pop();
    }
    return { ...response, items: [], confidence: 'heuristic', truncated: true };
  }

  if (response.action === 'callers') {
    const items = [...response.items];
    while (items.length > 0) {
      const candidate: CodeNavCallersOk = {
        ...response,
        items,
        truncated: true,
        truncatedReason: 'budget',
      };
      if (estimateCodeNavResponseBytes(candidate) <= maxBytes) return candidate;
      items.pop();
    }
    return { ...response, items: [], truncated: true, truncatedReason: 'budget' };
  }

  return response;
}
