import { CODE_NAV_LIMITS, type CodeNavSymbol, type CodeNavSymbolKind } from '@lody/shared';
import type { NapiConfig } from '@ast-grep/napi';
import type {
  CodeNavLanguage,
  FileSymbolIndex,
  IndexedExport,
  IndexedImport,
  IndexedSymbol,
} from './types';
import { estimateFileSymbolIndexBytes } from './snapshot-cache';

export type AstGrepModule = typeof import('@ast-grep/napi');
export type AstGrepRoot = ReturnType<AstGrepModule['parse']>;
export type AstGrepNode = ReturnType<AstGrepRoot['root']>;

let cachedAstGrepPromise: Promise<AstGrepModule | null> | null = null;

/**
 * Lazily loads `@ast-grep/napi`. Returns `null` when the native binding is
 * unavailable on the host so callers return structured `unavailable` errors
 * instead of crashing the daemon.
 */
export async function loadAstGrep(): Promise<AstGrepModule | null> {
  if (!cachedAstGrepPromise) {
    cachedAstGrepPromise = import('@ast-grep/napi').then(
      (mod) => (typeof mod.parse === 'function' ? mod : null),
      () => null
    );
  }
  return await cachedAstGrepPromise;
}

export function toAstGrepLang(astGrep: AstGrepModule, language: CodeNavLanguage) {
  switch (language) {
    case 'typescript':
      return astGrep.Lang.TypeScript;
    case 'tsx':
      return astGrep.Lang.Tsx;
    case 'javascript':
      return astGrep.Lang.JavaScript;
  }
}

export function trimPreviewLine(lineText: string | undefined): string {
  if (!lineText) return '';
  const trimmed = lineText.trim();
  if (trimmed.length <= CODE_NAV_LIMITS.maxPreviewLineChars) return trimmed;
  return `${trimmed.slice(0, CODE_NAV_LIMITS.maxPreviewLineChars - 1)}…`;
}

export function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

const REACT_HOC_NAMES = new Set([
  'memo',
  'forwardRef',
  'observer',
  'withRouter',
  'connect',
  'lazy',
  'dynamic',
]);

function isPascalCaseName(name: string): boolean {
  return /^[A-Z][A-Za-z0-9_$]*$/u.test(name);
}

function unquoteStringLiteral(raw: string | undefined): string | null {
  if (!raw || raw.length < 2) return null;
  const first = raw[0];
  const last = raw[raw.length - 1];
  if ((first === "'" || first === '"' || first === '`') && last === first) {
    return raw.slice(1, -1);
  }
  return null;
}

function getCalleeTerminalName(callee: AstGrepNode | null): string | null {
  if (!callee) return null;
  const kind = String(callee.kind());
  if (kind === 'identifier') return callee.text();
  if (kind === 'member_expression') {
    return callee.field('property')?.text() ?? null;
  }
  return null;
}

/**
 * Inspects a `variable_declarator` value to determine whether it is a React HOC
 * wrapper (`memo(...)`, `React.memo(forwardRef(...))`, `memo(FooImpl, eq)`).
 */
function inspectReactHocCall(valueNode: AstGrepNode): {
  readonly isHoc: boolean;
  readonly wrapsIdentifier?: string;
} {
  let current: AstGrepNode | null = valueNode;
  let matchedHoc = false;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const k = String(current.kind());
    if (k === 'parenthesized_expression' || k === 'as_expression' || k === 'satisfies_expression') {
      current = current.namedChildren()[0] ?? null;
      continue;
    }
    if (k !== 'call_expression') break;
    const calleeName = getCalleeTerminalName(current.field('function'));
    if (!calleeName || !REACT_HOC_NAMES.has(calleeName)) break;
    matchedHoc = true;
    const argsNode: AstGrepNode | null = current.field('arguments');
    const firstArg: AstGrepNode | null = argsNode?.namedChildren()[0] ?? null;
    if (!firstArg) return { isHoc: true };
    const argKind = String(firstArg.kind());
    if (
      argKind === 'arrow_function' ||
      argKind === 'function_expression' ||
      argKind === 'generator_function'
    ) {
      return { isHoc: true };
    }
    if (argKind === 'identifier') {
      return { isHoc: true, wrapsIdentifier: firstArg.text() };
    }
    if (argKind === 'call_expression') {
      current = firstArg;
      continue;
    }
    return { isHoc: true };
  }
  return { isHoc: matchedHoc };
}

function isModuleOrNamespaceScopeDeclaration(node: AstGrepNode): {
  readonly isTopLevel: boolean;
  readonly isExported: boolean;
  readonly exportStartLine?: number;
} {
  const parent = node.parent();
  if (!parent) return { isTopLevel: false, isExported: false };
  const parentKind = String(parent.kind());

  // `function_declaration` / `class_declaration` / `interface_declaration` / etc.
  if (parentKind === 'program') {
    return { isTopLevel: true, isExported: false };
  }
  if (parentKind === 'export_statement') {
    return {
      isTopLevel: true,
      isExported: true,
      exportStartLine: parent.range().start.line + 1,
    };
  }
  if (parentKind === 'statement_block' && String(parent.parent()?.kind()) === 'internal_module') {
    return { isTopLevel: true, isExported: false };
  }

  // `variable_declarator` -> `lexical_declaration` / `variable_declaration` -> `program` | `export_statement`
  if (parentKind === 'lexical_declaration' || parentKind === 'variable_declaration') {
    const grand = parent.parent();
    if (!grand) return { isTopLevel: false, isExported: false };
    const grandKind = String(grand.kind());
    if (grandKind === 'program') {
      return { isTopLevel: true, isExported: false };
    }
    if (grandKind === 'export_statement') {
      return {
        isTopLevel: true,
        isExported: true,
        exportStartLine: grand.range().start.line + 1,
      };
    }
    if (grandKind === 'statement_block' && String(grand.parent()?.kind()) === 'internal_module') {
      return { isTopLevel: true, isExported: false };
    }
  }

  return { isTopLevel: false, isExported: false };
}

function findEnclosingContainerName(node: AstGrepNode): string | undefined {
  let current = node.parent();
  while (current) {
    const k = String(current.kind());
    if (
      k === 'class_declaration' ||
      k === 'abstract_class_declaration' ||
      k === 'class' ||
      k === 'internal_module' ||
      k === 'function_declaration' ||
      k === 'generator_function_declaration' ||
      k === 'method_definition'
    ) {
      const name = current.field('name')?.text();
      if (name) return name;
    } else if (k === 'variable_declarator') {
      const name = current.field('name');
      if (name && String(name.kind()) === 'identifier') {
        return name.text();
      }
    }
    current = current.parent();
  }
  return undefined;
}

function unwrapTypeWrapper(node: AstGrepNode | null): AstGrepNode | null {
  let current = node;
  for (let depth = 0; depth < 3 && current; depth += 1) {
    const k = String(current.kind());
    if (k === 'parenthesized_expression' || k === 'as_expression' || k === 'satisfies_expression') {
      current = current.namedChildren()[0] ?? null;
      continue;
    }
    break;
  }
  return current;
}

const SYMBOL_EXTRACTION_RULE: NapiConfig = {
  rule: {
    any: [
      { kind: 'function_declaration' },
      { kind: 'generator_function_declaration' },
      { kind: 'class_declaration' },
      { kind: 'abstract_class_declaration' },
      { kind: 'method_definition' },
      { kind: 'public_field_definition' },
      { kind: 'interface_declaration' },
      { kind: 'type_alias_declaration' },
      { kind: 'enum_declaration' },
      { kind: 'internal_module' },
      { kind: 'variable_declarator' },
      { kind: 'pair' },
    ],
  },
};

const IMPORT_EXPORT_RULE: NapiConfig = {
  rule: {
    any: [{ kind: 'import_statement' }, { kind: 'export_statement' }],
  },
};

/**
 * Extracts a pure-JSON `FileSymbolIndex` (declarations, callable scopes, static
 * imports, and re-exports) using Rust-pushed `root.findAll(rule)`.
 */
export function extractFileSymbolIndex(
  relPath: string,
  language: CodeNavLanguage,
  source: string,
  root: AstGrepRoot
): FileSymbolIndex {
  const lines = source.split(/\r?\n/u);
  const rootNode = root.root();

  const symbols: IndexedSymbol[] = [];
  const seenSymbolKeys = new Set<string>();

  const pushSymbol = (symbol: IndexedSymbol) => {
    const key = `${symbol.name}:${symbol.kind}:${symbol.startLine}:${symbol.endLine}:${symbol.containerName ?? ''}`;
    if (seenSymbolKeys.has(key)) return;
    seenSymbolKeys.add(key);
    symbols.push(symbol);
  };

  const declNodes = rootNode.findAll(SYMBOL_EXTRACTION_RULE);
  for (const node of declNodes) {
    const nodeKind = String(node.kind());
    const range = node.range();

    if (nodeKind === 'function_declaration' || nodeKind === 'generator_function_declaration') {
      const nameNode = node.field('name');
      const name = nameNode?.text();
      if (!name || !nameNode) continue;
      const scope = isModuleOrNamespaceScopeDeclaration(node);
      const nameRange = nameNode.range();
      const kind: CodeNavSymbolKind =
        language === 'tsx' && isPascalCaseName(name) && scope.isTopLevel ? 'component' : 'function';
      pushSymbol({
        name,
        kind,
        ...(scope.isTopLevel ? {} : { containerName: findEnclosingContainerName(node) }),
        startLine: scope.exportStartLine ?? range.start.line + 1,
        endLine: range.end.line + 1,
        nameLine: nameRange.start.line + 1,
        nameCharacter: nameRange.start.column,
        nameEndLine: nameRange.end.line + 1,
        nameEndCharacter: nameRange.end.column,
        isCallable: true,
        isExported: scope.isExported,
        previewLine: trimPreviewLine(lines[nameRange.start.line]),
      });
      continue;
    }

    if (nodeKind === 'class_declaration' || nodeKind === 'abstract_class_declaration') {
      const nameNode = node.field('name');
      const name = nameNode?.text();
      if (!name || !nameNode) continue;
      const scope = isModuleOrNamespaceScopeDeclaration(node);
      const nameRange = nameNode.range();
      pushSymbol({
        name,
        kind: 'class',
        ...(scope.isTopLevel ? {} : { containerName: findEnclosingContainerName(node) }),
        startLine: scope.exportStartLine ?? range.start.line + 1,
        endLine: range.end.line + 1,
        nameLine: nameRange.start.line + 1,
        nameCharacter: nameRange.start.column,
        nameEndLine: nameRange.end.line + 1,
        nameEndCharacter: nameRange.end.column,
        isCallable: false,
        isExported: scope.isExported,
        previewLine: trimPreviewLine(lines[nameRange.start.line]),
      });
      continue;
    }

    if (nodeKind === 'method_definition') {
      const nameNode = node.field('name');
      const name = nameNode?.text();
      if (!name || !nameNode) continue;
      const nameRange = nameNode.range();
      const containerName = findEnclosingContainerName(node);
      pushSymbol({
        name,
        kind: 'method',
        ...(containerName ? { containerName } : {}),
        startLine: range.start.line + 1,
        endLine: range.end.line + 1,
        nameLine: nameRange.start.line + 1,
        nameCharacter: nameRange.start.column,
        nameEndLine: nameRange.end.line + 1,
        nameEndCharacter: nameRange.end.column,
        isCallable: true,
        isExported: false,
        previewLine: trimPreviewLine(lines[nameRange.start.line]),
      });
      continue;
    }

    if (nodeKind === 'public_field_definition') {
      const nameNode = node.field('name');
      const name = nameNode?.text();
      if (!name || !nameNode) continue;
      const valueNode = unwrapTypeWrapper(node.field('value'));
      const valueKind = valueNode ? String(valueNode.kind()) : '';
      const isCallable =
        valueKind === 'arrow_function' ||
        valueKind === 'function_expression' ||
        valueKind === 'generator_function';
      const nameRange = nameNode.range();
      const containerName = findEnclosingContainerName(node);
      pushSymbol({
        name,
        kind: isCallable ? 'method' : 'property',
        ...(containerName ? { containerName } : {}),
        startLine: range.start.line + 1,
        endLine: range.end.line + 1,
        nameLine: nameRange.start.line + 1,
        nameCharacter: nameRange.start.column,
        nameEndLine: nameRange.end.line + 1,
        nameEndCharacter: nameRange.end.column,
        isCallable,
        isExported: false,
        previewLine: trimPreviewLine(lines[nameRange.start.line]),
      });
      continue;
    }

    if (
      nodeKind === 'interface_declaration' ||
      nodeKind === 'type_alias_declaration' ||
      nodeKind === 'enum_declaration' ||
      nodeKind === 'internal_module'
    ) {
      const nameNode = node.field('name');
      const name = nameNode?.text();
      if (!name || !nameNode) continue;
      const scope = isModuleOrNamespaceScopeDeclaration(node);
      const nameRange = nameNode.range();
      const kind: CodeNavSymbolKind =
        nodeKind === 'interface_declaration'
          ? 'interface'
          : nodeKind === 'type_alias_declaration'
            ? 'type'
            : nodeKind === 'enum_declaration'
              ? 'enum'
              : 'namespace';
      pushSymbol({
        name,
        kind,
        ...(scope.isTopLevel ? {} : { containerName: findEnclosingContainerName(node) }),
        startLine: scope.exportStartLine ?? range.start.line + 1,
        endLine: range.end.line + 1,
        nameLine: nameRange.start.line + 1,
        nameCharacter: nameRange.start.column,
        nameEndLine: nameRange.end.line + 1,
        nameEndCharacter: nameRange.end.column,
        isCallable: false,
        isExported: scope.isExported,
        previewLine: trimPreviewLine(lines[nameRange.start.line]),
      });
      continue;
    }

    if (nodeKind === 'variable_declarator') {
      const nameNode = node.field('name');
      if (!nameNode || String(nameNode.kind()) !== 'identifier') continue;
      const name = nameNode.text();
      const valueNode = unwrapTypeWrapper(node.field('value'));
      const valueKind = valueNode ? String(valueNode.kind()) : '';
      const scope = isModuleOrNamespaceScopeDeclaration(node);

      const isDirectFunction =
        valueKind === 'arrow_function' ||
        valueKind === 'function_expression' ||
        valueKind === 'generator_function';
      const hoc =
        !isDirectFunction && valueNode ? inspectReactHocCall(valueNode) : { isHoc: false };

      if (!isDirectFunction && !hoc.isHoc) {
        // Only record top-level constants/variables; NEVER treat local `const x = fn()`
        // inside a function body as an enclosing symbol or callable.
        if (!scope.isTopLevel) continue;
        const nameRange = nameNode.range();
        const declStartLine =
          scope.exportStartLine ?? node.parent()?.range().start.line ?? range.start.line;
        const startLine = scope.exportStartLine ?? declStartLine + 1;
        pushSymbol({
          name,
          kind: 'variable',
          startLine,
          endLine: range.end.line + 1,
          nameLine: nameRange.start.line + 1,
          nameCharacter: nameRange.start.column,
          nameEndLine: nameRange.end.line + 1,
          nameEndCharacter: nameRange.end.column,
          isCallable: false,
          isExported: scope.isExported,
          previewLine: trimPreviewLine(lines[nameRange.start.line]),
        });
        continue;
      }

      const nameRange = nameNode.range();
      const parentRangeStartLine = node.parent()?.range().start.line;
      const startLine =
        scope.exportStartLine ??
        (parentRangeStartLine !== undefined ? parentRangeStartLine + 1 : range.start.line + 1);
      const kind: CodeNavSymbolKind =
        hoc.isHoc || (language === 'tsx' && isPascalCaseName(name) && scope.isTopLevel)
          ? 'component'
          : 'function';
      pushSymbol({
        name,
        kind,
        ...(scope.isTopLevel ? {} : { containerName: findEnclosingContainerName(node) }),
        startLine,
        endLine: range.end.line + 1,
        nameLine: nameRange.start.line + 1,
        nameCharacter: nameRange.start.column,
        nameEndLine: nameRange.end.line + 1,
        nameEndCharacter: nameRange.end.column,
        isCallable: true,
        isExported: scope.isExported,
        previewLine: trimPreviewLine(lines[nameRange.start.line]),
        ...(hoc.wrapsIdentifier ? { wrapsIdentifier: hoc.wrapsIdentifier } : {}),
      });
      continue;
    }

    if (nodeKind === 'pair') {
      // Capture callable object properties (`const api = { fetch: () => ... }`) so
      // callers inside object methods report a meaningful enclosing caller.
      const valueNode = unwrapTypeWrapper(node.field('value'));
      const valueKind = valueNode ? String(valueNode.kind()) : '';
      if (
        valueKind !== 'arrow_function' &&
        valueKind !== 'function_expression' &&
        valueKind !== 'generator_function'
      ) {
        continue;
      }
      const keyNode = node.field('key');
      if (!keyNode) continue;
      const keyKind = String(keyNode.kind());
      if (keyKind !== 'property_identifier' && keyKind !== 'identifier') continue;
      const name = keyNode.text();
      const nameRange = keyNode.range();
      const containerName = findEnclosingContainerName(node);
      pushSymbol({
        name,
        kind: 'method',
        ...(containerName ? { containerName } : {}),
        startLine: range.start.line + 1,
        endLine: range.end.line + 1,
        nameLine: nameRange.start.line + 1,
        nameCharacter: nameRange.start.column,
        nameEndLine: nameRange.end.line + 1,
        nameEndCharacter: nameRange.end.column,
        isCallable: true,
        isExported: false,
        previewLine: trimPreviewLine(lines[nameRange.start.line]),
      });
    }
  }

  // Sort symbols by startLine ascending, then larger span first (outermost before innermost).
  symbols.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);

  const imports: IndexedImport[] = [];
  const exports: IndexedExport[] = [];
  const importExportNodes = rootNode.findAll(IMPORT_EXPORT_RULE);

  for (const stmt of importExportNodes) {
    const stmtKind = String(stmt.kind());
    if (stmtKind === 'import_statement') {
      const specifier = unquoteStringLiteral(stmt.field('source')?.text());
      if (!specifier) continue;
      const stmtText = stmt.text();
      const isStmtTypeOnly = /^\s*import\s+type\b/u.test(stmtText);

      // Default import: `import Foo from '...'`
      const clause = stmt.find({ rule: { kind: 'import_clause' } });
      if (!clause) continue;
      const defaultId = clause
        .namedChildren()
        .find((child) => String(child.kind()) === 'identifier');
      if (defaultId) {
        imports.push({
          specifier,
          localName: defaultId.text(),
          importedName: 'default',
          isTypeOnly: isStmtTypeOnly,
        });
      }

      // Namespace import: `import * as Ns from '...'`
      const nsNode = clause.find({ rule: { kind: 'namespace_import' } });
      if (nsNode) {
        const nsId = nsNode.namedChildren().find((child) => String(child.kind()) === 'identifier');
        if (nsId) {
          imports.push({
            specifier,
            localName: nsId.text(),
            importedName: '*',
            isTypeOnly: isStmtTypeOnly,
          });
        }
      }

      // Named imports: `import { a, b as c } from '...'`
      const specifiers = clause.findAll({ rule: { kind: 'import_specifier' } });
      for (const spec of specifiers) {
        const importedName = spec.field('name')?.text();
        if (!importedName) continue;
        const localName = spec.field('alias')?.text() ?? importedName;
        const isSpecTypeOnly = isStmtTypeOnly || /^\s*type\b/u.test(spec.text());
        imports.push({
          specifier,
          localName,
          importedName,
          isTypeOnly: isSpecTypeOnly,
        });
      }
      continue;
    }

    if (stmtKind === 'export_statement') {
      const specifier = unquoteStringLiteral(stmt.field('source')?.text());
      if (specifier) {
        // Re-exports: `export * from '...'` or `export { a, b as c } from '...'`
        const exportClause = stmt.find({ rule: { kind: 'export_clause' } });
        if (!exportClause) {
          exports.push({ kind: 'reexport-all', specifier });
          continue;
        }
        const exportSpecs = exportClause.findAll({ rule: { kind: 'export_specifier' } });
        for (const spec of exportSpecs) {
          const originalName = spec.field('name')?.text();
          if (!originalName) continue;
          const exportedName = spec.field('alias')?.text() ?? originalName;
          exports.push({
            kind: 'reexport-named',
            specifier,
            exportedName,
            originalName,
          });
        }
      } else {
        // Local export list: `export { foo, bar as baz }`
        const exportClause = stmt.find({ rule: { kind: 'export_clause' } });
        if (exportClause) {
          const exportSpecs = exportClause.findAll({ rule: { kind: 'export_specifier' } });
          for (const spec of exportSpecs) {
            const localName = spec.field('name')?.text();
            if (!localName) continue;
            const exportedName = spec.field('alias')?.text() ?? localName;
            exports.push({
              kind: 'local-alias',
              exportedName,
              localName,
            });
          }
        }
      }
    }
  }

  // Mark symbols exported via local `export { foo }` or `export default foo`.
  const exportedLocalNames = new Set(
    exports
      .filter(
        (item): item is Extract<IndexedExport, { kind: 'local-alias' }> =>
          item.kind === 'local-alias'
      )
      .map((item) => item.localName)
  );
  const finalSymbols =
    exportedLocalNames.size === 0
      ? symbols
      : symbols.map((sym) =>
          !sym.isExported && !sym.containerName && exportedLocalNames.has(sym.name)
            ? { ...sym, isExported: true }
            : sym
        );

  const base = {
    relPath,
    language,
    symbols: finalSymbols,
    imports,
    exports,
  };
  return {
    ...base,
    estimatedBytes: estimateFileSymbolIndexBytes(base),
  };
}

export function toPublicCodeNavSymbol(sym: IndexedSymbol): CodeNavSymbol {
  return {
    name: sym.name,
    kind: sym.kind,
    ...(sym.containerName ? { containerName: sym.containerName } : {}),
    startLine: sym.startLine,
    endLine: sym.endLine,
  };
}

/**
 * Finds the innermost symbol covering a 1-based line number.
 * When `callableOnly` is true, considers ONLY real callable/component scopes
 * (never plain variables, interfaces, or classes).
 */
export function findInnermostSymbolAtLine(
  symbols: readonly IndexedSymbol[],
  line: number,
  options: { readonly callableOnly?: boolean } = {}
): IndexedSymbol | undefined {
  let best: IndexedSymbol | undefined;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (const sym of symbols) {
    if (options.callableOnly && !sym.isCallable) continue;
    if (sym.startLine <= line && line <= sym.endLine) {
      const span = sym.endLine - sym.startLine;
      if (!best || span < bestSpan || (span === bestSpan && sym.isCallable && !best.isCallable)) {
        best = sym;
        bestSpan = span;
      }
    }
  }
  return best;
}

/**
 * Returns the enclosing symbol chain from outermost to innermost covering
 * `[startLine, endLine]` (1-based inclusive).
 */
export function findEnclosingSymbolChain(
  symbols: readonly IndexedSymbol[],
  startLine: number,
  endLine: number
): CodeNavSymbol[] {
  const effectiveStart = Math.min(startLine, endLine);
  const effectiveEnd = Math.max(startLine, endLine);
  const covering = symbols.filter(
    (sym) => sym.startLine <= effectiveStart && sym.endLine >= effectiveEnd
  );
  // If no single symbol covers the entire range (e.g. hunk crosses comment header
  // into function body), fall back to symbols containing the anchor/end line.
  const matched =
    covering.length > 0
      ? covering
      : symbols.filter((sym) => sym.startLine <= effectiveEnd && sym.endLine >= effectiveEnd);

  matched.sort(
    (a, b) =>
      b.endLine - b.startLine - (a.endLine - a.startLine) ||
      a.startLine - b.startLine ||
      Number(a.isCallable) - Number(b.isCallable)
  );
  return matched.slice(0, CODE_NAV_LIMITS.maxEnclosingDepth).map(toPublicCodeNavSymbol);
}

export type LocalLexicalBinding = {
  readonly name: string;
  readonly kind: CodeNavSymbolKind;
  readonly line: number;
  readonly character: number;
  readonly endLine: number;
  readonly endCharacter: number;
  readonly previewLine: string;
  readonly containerName?: string;
};

export type SymbolCursorContext = {
  readonly symbol: string;
  readonly isMemberAccess: boolean;
  readonly receiver?: string;
  readonly isTypePosition: boolean;
  readonly isJsxTag: boolean;
  readonly isCallCallee: boolean;
  readonly importSpecifier?: string;
  readonly importedOriginalName?: string;
  /** True when the cursor resolved to an AST identifier node and enclosing lexical scopes were checked. */
  readonly scopeVerified: boolean;
  /** Nearest enclosing non-module lexical binding shadowing `symbol` at the cursor, if any. */
  readonly localBinding?: LocalLexicalBinding;
  /** True when `receiver` (for `Ns.foo`) is shadowed by an enclosing local binding. */
  readonly receiverShadowedLocally?: boolean;
};

const FUNCTION_LIKE_SCOPE_KINDS = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'generator_function',
  'arrow_function',
  'method_definition',
]);

const BLOCK_SCOPE_KINDS = new Set(['statement_block', 'switch_case', 'switch_default']);

function collectPatternBindingIdentifiers(node: AstGrepNode | null, out: AstGrepNode[]): void {
  if (!node) return;
  const kind = String(node.kind());
  if (
    kind === 'identifier' ||
    kind === 'shorthand_property_identifier_pattern' ||
    kind === 'type_identifier'
  ) {
    out.push(node);
    return;
  }
  if (kind === 'required_parameter' || kind === 'optional_parameter') {
    collectPatternBindingIdentifiers(node.field('pattern'), out);
    return;
  }
  if (kind === 'assignment_pattern' || kind === 'object_assignment_pattern') {
    collectPatternBindingIdentifiers(node.field('left'), out);
    return;
  }
  if (kind === 'pair_pattern') {
    collectPatternBindingIdentifiers(node.field('value'), out);
    return;
  }
  if (
    kind === 'rest_pattern' ||
    kind === 'rest_parameter' ||
    kind === 'object_pattern' ||
    kind === 'array_pattern'
  ) {
    for (const child of node.namedChildren()) {
      collectPatternBindingIdentifiers(child, out);
    }
  }
}

function collectVarBindingsInFunctionBody(
  node: AstGrepNode | null,
  out: AstGrepNode[],
  depth = 0
): void {
  if (!node || depth > 24) return;
  for (const child of node.namedChildren()) {
    const kind = String(child.kind());
    if (FUNCTION_LIKE_SCOPE_KINDS.has(kind)) continue;
    if (kind === 'variable_declaration') {
      for (const decl of child.namedChildren()) {
        if (String(decl.kind()) === 'variable_declarator') {
          collectPatternBindingIdentifiers(decl.field('name'), out);
        }
      }
      continue;
    }
    collectVarBindingsInFunctionBody(child, out, depth + 1);
  }
}

function toLocalLexicalBinding(
  nameNode: AstGrepNode,
  kind: CodeNavSymbolKind,
  lines: readonly string[]
): LocalLexicalBinding {
  const r = nameNode.range();
  const containerName = findEnclosingContainerName(nameNode);
  return {
    name: nameNode.text(),
    kind,
    line: r.start.line + 1,
    character: r.start.column,
    endLine: r.end.line + 1,
    endCharacter: r.end.column,
    previewLine: trimPreviewLine(lines[r.start.line]),
    ...(containerName ? { containerName } : {}),
  };
}

/**
 * Walks enclosing non-module lexical scopes from `targetNode` up to `program`
 * (exclusive) and returns the nearest local binding (parameter, local
 * `variable_declarator`, `catch` binding, `for` binding, nested function/class,
 * or type parameter in type positions) that shadows `symbolName`.
 */
function findLocalLexicalBinding(
  targetNode: AstGrepNode,
  symbolName: string,
  isTypePosition: boolean,
  lines: readonly string[]
): LocalLexicalBinding | undefined {
  let prev: AstGrepNode = targetNode;
  let current = targetNode.parent();

  while (current) {
    const scopeKind = String(current.kind());
    if (scopeKind === 'program') break;

    if (isTypePosition) {
      // Type parameters on functions, classes, interfaces, type aliases, or methods.
      const typeParams = current.field('type_parameters');
      if (typeParams) {
        for (const tp of typeParams.namedChildren()) {
          const nameNode = tp.field('name');
          if (nameNode && nameNode.text() === symbolName) {
            return toLocalLexicalBinding(nameNode, 'type', lines);
          }
        }
      }
      if (BLOCK_SCOPE_KINDS.has(scopeKind)) {
        const parentKind = String(current.parent()?.kind() ?? '');
        if (parentKind !== 'internal_module') {
          for (const stmt of current.namedChildren()) {
            const stmtKind = String(stmt.kind());
            if (
              stmtKind === 'type_alias_declaration' ||
              stmtKind === 'interface_declaration' ||
              stmtKind === 'class_declaration' ||
              stmtKind === 'abstract_class_declaration' ||
              stmtKind === 'enum_declaration'
            ) {
              const nameNode = stmt.field('name');
              if (nameNode && nameNode.text() === symbolName) {
                const symKind: CodeNavSymbolKind =
                  stmtKind === 'interface_declaration'
                    ? 'interface'
                    : stmtKind === 'enum_declaration'
                      ? 'enum'
                      : stmtKind === 'type_alias_declaration'
                        ? 'type'
                        : 'class';
                return toLocalLexicalBinding(nameNode, symKind, lines);
              }
            }
          }
        }
      }
      prev = current;
      current = current.parent();
      continue;
    }

    // (1) Function-like scope: parameters, function-expression self-name, and hoisted `var`.
    if (FUNCTION_LIKE_SCOPE_KINDS.has(scopeKind)) {
      const ownName = current.field('name');
      const clickedOwnName = ownName !== null && ownName.id() === targetNode.id();
      if (!clickedOwnName) {
        const paramNodes: AstGrepNode[] = [];
        const formalParams = current.field('parameters');
        if (formalParams) {
          for (const param of formalParams.namedChildren()) {
            collectPatternBindingIdentifiers(param, paramNodes);
          }
        }
        const singleParam = current.field('parameter');
        if (singleParam) {
          collectPatternBindingIdentifiers(singleParam, paramNodes);
        }
        for (const idNode of paramNodes) {
          if (idNode.text() === symbolName) {
            return toLocalLexicalBinding(idNode, 'variable', lines);
          }
        }

        // Named function expression self-binding (`const f = function self() { self(); }`).
        if (
          (scopeKind === 'function_expression' || scopeKind === 'generator_function') &&
          ownName &&
          ownName.text() === symbolName
        ) {
          return toLocalLexicalBinding(ownName, 'function', lines);
        }

        // Function-scoped hoisted `var` bindings inside the body.
        const bodyNode = current.field('body');
        if (bodyNode && prev.id() === bodyNode.id()) {
          const varNodes: AstGrepNode[] = [];
          collectVarBindingsInFunctionBody(bodyNode, varNodes);
          for (const idNode of varNodes) {
            if (idNode.text() === symbolName) {
              return toLocalLexicalBinding(idNode, 'variable', lines);
            }
          }
        }
      }
    }

    // (2) Catch clause binding: `catch (err)` / `catch ({ code })`.
    if (scopeKind === 'catch_clause') {
      const catchBindings: AstGrepNode[] = [];
      collectPatternBindingIdentifiers(current.field('parameter'), catchBindings);
      for (const idNode of catchBindings) {
        if (idNode.text() === symbolName) {
          return toLocalLexicalBinding(idNode, 'variable', lines);
        }
      }
    }

    // (3) Loop bindings: `for (let i = ...)` and `for (const x of ...)`.
    if (scopeKind === 'for_statement') {
      const init = current.field('initializer');
      if (init) {
        const initKind = String(init.kind());
        if (initKind === 'lexical_declaration' || initKind === 'variable_declaration') {
          const loopBindings: AstGrepNode[] = [];
          for (const decl of init.namedChildren()) {
            if (String(decl.kind()) === 'variable_declarator') {
              collectPatternBindingIdentifiers(decl.field('name'), loopBindings);
            }
          }
          for (const idNode of loopBindings) {
            if (idNode.text() === symbolName) {
              return toLocalLexicalBinding(idNode, 'variable', lines);
            }
          }
        }
      }
    }

    if (scopeKind === 'for_in_statement') {
      const kindText = current.field('kind')?.text();
      const hasDeclKind =
        kindText === 'const' ||
        kindText === 'let' ||
        kindText === 'var' ||
        current
          .children()
          .some(
            (child) =>
              !child.isNamed() &&
              (child.text() === 'const' || child.text() === 'let' || child.text() === 'var')
          );
      if (hasDeclKind) {
        const loopBindings: AstGrepNode[] = [];
        collectPatternBindingIdentifiers(current.field('left'), loopBindings);
        for (const idNode of loopBindings) {
          if (idNode.text() === symbolName) {
            return toLocalLexicalBinding(idNode, 'variable', lines);
          }
        }
      }
    }

    // (4) Block scope: local `const`/`let`/`var`, nested `function_declaration`, nested `class_declaration`.
    if (BLOCK_SCOPE_KINDS.has(scopeKind)) {
      const parentKind = String(current.parent()?.kind() ?? '');
      // Skip namespace (`internal_module`) body because its declarations are module-level.
      if (parentKind !== 'internal_module') {
        for (const stmt of current.namedChildren()) {
          const stmtKind = String(stmt.kind());
          if (stmtKind === 'lexical_declaration' || stmtKind === 'variable_declaration') {
            const varBindings: AstGrepNode[] = [];
            for (const decl of stmt.namedChildren()) {
              if (String(decl.kind()) === 'variable_declarator') {
                collectPatternBindingIdentifiers(decl.field('name'), varBindings);
              }
            }
            for (const idNode of varBindings) {
              if (idNode.text() === symbolName) {
                return toLocalLexicalBinding(idNode, 'variable', lines);
              }
            }
          } else if (
            stmtKind === 'function_declaration' ||
            stmtKind === 'generator_function_declaration'
          ) {
            const nameNode = stmt.field('name');
            if (nameNode && nameNode.text() === symbolName) {
              return toLocalLexicalBinding(nameNode, 'function', lines);
            }
          } else if (
            stmtKind === 'class_declaration' ||
            stmtKind === 'abstract_class_declaration'
          ) {
            const nameNode = stmt.field('name');
            if (nameNode && nameNode.text() === symbolName) {
              return toLocalLexicalBinding(nameNode, 'class', lines);
            }
          }
        }
      }
    }

    // (5) Named class expression self-binding (`const C = class Self { ... }`).
    if (scopeKind === 'class') {
      const ownName = current.field('name');
      if (ownName && ownName.id() !== targetNode.id() && ownName.text() === symbolName) {
        return toLocalLexicalBinding(ownName, 'class', lines);
      }
    }

    prev = current;
    current = current.parent();
  }

  return undefined;
}

const IDENTIFIER_KINDS_RULE: NapiConfig = {
  rule: {
    any: [
      { kind: 'identifier' },
      { kind: 'property_identifier' },
      { kind: 'type_identifier' },
      { kind: 'shorthand_property_identifier' },
      { kind: 'shorthand_property_identifier_pattern' },
    ],
  },
};

function extractWordAtColumn(lineText: string, character: number): string | null {
  if (!lineText) return null;
  const clamped = Math.max(0, Math.min(character, Math.max(0, lineText.length - 1)));
  const isIdent = (ch: string) => /[A-Za-z0-9_$]/u.test(ch);
  let pos = clamped;
  if (!isIdent(lineText[pos] ?? '')) {
    if (pos > 0 && isIdent(lineText[pos - 1] ?? '')) {
      pos -= 1;
    } else {
      return null;
    }
  }
  let start = pos;
  while (start > 0 && isIdent(lineText[start - 1] ?? '')) start -= 1;
  let end = pos + 1;
  while (end < lineText.length && isIdent(lineText[end] ?? '')) end += 1;
  return lineText.slice(start, end) || null;
}

/**
 * Resolves the identifier and AST usage context at 1-based `line` / 0-based `character`.
 */
export function resolveSymbolContextAtPosition(
  root: AstGrepRoot,
  source: string,
  line: number,
  character: number,
  symbolHint?: string
): SymbolCursorContext | null {
  const targetLine0 = line - 1;
  const lines = source.split(/\r?\n/u);
  const lineText = lines[targetLine0] ?? '';

  // Targeted Rust findAll over identifier kinds; filter to target line.
  const allIdentifiers = root.root().findAll(IDENTIFIER_KINDS_RULE);
  let targetNode: AstGrepNode | null = null;

  for (const node of allIdentifiers) {
    const r = node.range();
    if (r.start.line > targetLine0 || r.end.line < targetLine0) continue;
    if (r.start.line === targetLine0 && r.end.line === targetLine0) {
      if (character >= r.start.column && character <= r.end.column) {
        targetNode = node;
        break;
      }
    }
  }

  // Fallback: match `symbolHint` on the target line if cursor landed on adjacent punctuation.
  if (!targetNode && symbolHint) {
    let bestDist = Number.POSITIVE_INFINITY;
    for (const node of allIdentifiers) {
      const r = node.range();
      if (r.start.line !== targetLine0) continue;
      if (node.text() !== symbolHint) continue;
      const dist = Math.abs(r.start.column - character);
      if (dist < bestDist) {
        bestDist = dist;
        targetNode = node;
      }
    }
  }

  if (!targetNode) {
    const fallbackWord = symbolHint ?? extractWordAtColumn(lineText, character);
    if (!fallbackWord) return null;
    return {
      symbol: fallbackWord,
      isMemberAccess: false,
      isTypePosition: false,
      isJsxTag: false,
      isCallCallee: false,
      scopeVerified: false,
    };
  }

  const symbol = targetNode.text();
  const nodeKind = String(targetNode.kind());
  const parent = targetNode.parent();
  const parentKind = parent ? String(parent.kind()) : '';

  let isMemberAccess = false;
  let receiver: string | undefined;
  let isCallCallee = false;
  let isJsxTag = false;
  let isTypePosition = nodeKind === 'type_identifier';
  let importSpecifier: string | undefined;
  let importedOriginalName: string | undefined;

  if (parentKind === 'member_expression' && parent?.field('property')?.id() === targetNode.id()) {
    isMemberAccess = true;
    receiver = parent.field('object')?.text();
    const grand = parent.parent();
    if (
      grand &&
      String(grand.kind()) === 'call_expression' &&
      grand.field('function')?.id() === parent.id()
    ) {
      isCallCallee = true;
    }
    if (
      grand &&
      (String(grand.kind()) === 'jsx_opening_element' ||
        String(grand.kind()) === 'jsx_self_closing_element')
    ) {
      isJsxTag = true;
    }
  } else if (
    parentKind === 'call_expression' &&
    parent?.field('function')?.id() === targetNode.id()
  ) {
    isCallCallee = true;
  } else if (
    (parentKind === 'jsx_opening_element' ||
      parentKind === 'jsx_self_closing_element' ||
      parentKind === 'jsx_closing_element') &&
    parent?.field('name')?.id() === targetNode.id()
  ) {
    isJsxTag = true;
  } else if (parentKind === 'import_specifier') {
    importedOriginalName = parent?.field('name')?.text() ?? symbol;
    let cur = parent?.parent();
    while (cur && String(cur.kind()) !== 'import_statement') {
      cur = cur.parent();
    }
    if (cur) {
      importSpecifier = unquoteStringLiteral(cur.field('source')?.text()) ?? undefined;
    }
  } else if (parentKind === 'import_clause') {
    importedOriginalName = 'default';
    const importStmt = parent?.parent();
    if (importStmt && String(importStmt.kind()) === 'import_statement') {
      importSpecifier = unquoteStringLiteral(importStmt.field('source')?.text()) ?? undefined;
    }
  } else if (
    parentKind === 'type_annotation' ||
    parentKind === 'generic_type' ||
    parentKind === 'extends_type_clause'
  ) {
    isTypePosition = true;
  }

  const localBinding =
    !isMemberAccess && !importSpecifier
      ? findLocalLexicalBinding(targetNode, symbol, isTypePosition, lines)
      : undefined;
  const receiverShadowedLocally =
    isMemberAccess &&
    receiver &&
    receiver !== 'this' &&
    /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(receiver)
      ? findLocalLexicalBinding(targetNode, receiver, false, lines) !== undefined
      : false;

  return {
    symbol,
    isMemberAccess,
    ...(receiver ? { receiver } : {}),
    isTypePosition,
    isJsxTag,
    isCallCallee,
    ...(importSpecifier ? { importSpecifier } : {}),
    ...(importedOriginalName ? { importedOriginalName } : {}),
    scopeVerified: true,
    ...(localBinding ? { localBinding } : {}),
    ...(receiverShadowedLocally ? { receiverShadowedLocally: true } : {}),
  };
}

export type ExtractedCallSite = {
  readonly path: string;
  readonly line: number;
  readonly character: number;
  readonly previewLine: string;
  readonly receiver?: string;
  readonly caller?: CodeNavSymbol;
};

/**
 * Builds an AST-grep NapiConfig matcher targeting identifiers/properties matching
 * `symbolName` exactly so Rust filters candidate nodes before returning to JS.
 */
export function buildSymbolUsageMatcher(symbolName: string) {
  const exactRegex = `^${escapeRegexLiteral(symbolName)}$`;
  return {
    rule: {
      any: [
        { kind: 'identifier', regex: exactRegex },
        { kind: 'property_identifier', regex: exactRegex },
      ],
    },
  };
}

/**
 * Classifies whether a matched identifier/property node is a real call/JSX/callback
 * reference site (never a declaration, import/export, type annotation, comment,
 * string, or `function_expression` self-name).
 */
export function classifyCallSiteNode(
  node: AstGrepNode
): { readonly isCallSite: true; readonly receiver?: string } | { readonly isCallSite: false } {
  const parent = node.parent();
  if (!parent) return { isCallSite: false };
  const parentKind = String(parent.kind());

  // Explicitly reject function_expression self-names (`const f = function mySelf() {}`).
  if (
    parentKind === 'function_expression' ||
    parentKind === 'generator_function' ||
    parentKind === 'function_declaration' ||
    parentKind === 'generator_function_declaration' ||
    parentKind === 'method_definition' ||
    parentKind === 'class_declaration' ||
    parentKind === 'abstract_class_declaration' ||
    parentKind === 'class' ||
    parentKind === 'interface_declaration' ||
    parentKind === 'type_alias_declaration' ||
    parentKind === 'enum_declaration' ||
    parentKind === 'import_specifier' ||
    parentKind === 'import_clause' ||
    parentKind === 'namespace_import' ||
    parentKind === 'export_specifier' ||
    parentKind === 'required_parameter' ||
    parentKind === 'optional_parameter' ||
    parentKind === 'formal_parameters' ||
    parentKind === 'public_field_definition'
  ) {
    return { isCallSite: false };
  }

  // Reject LHS of `variable_declarator`, `pair` key, or assignment LHS.
  if (parentKind === 'variable_declarator' && parent.field('name')?.id() === node.id()) {
    return { isCallSite: false };
  }
  if (parentKind === 'pair' && parent.field('key')?.id() === node.id()) {
    return { isCallSite: false };
  }

  // 1. Direct call: `foo(...)`
  if (parentKind === 'call_expression' && parent.field('function')?.id() === node.id()) {
    return { isCallSite: true };
  }

  // 2. Constructor call: `new Foo(...)`
  if (parentKind === 'new_expression' && parent.field('constructor')?.id() === node.id()) {
    return { isCallSite: true };
  }

  // 3. JSX component render: `<Foo ...>` or `<Foo ... />`
  if (
    (parentKind === 'jsx_opening_element' || parentKind === 'jsx_self_closing_element') &&
    parent.field('name')?.id() === node.id()
  ) {
    return { isCallSite: true };
  }

  // 4. Member access: `obj.foo(...)`, `new ns.Foo()`, `<Ns.Foo />`, or callback `map(obj.foo)`
  if (parentKind === 'member_expression' && parent.field('property')?.id() === node.id()) {
    const grand = parent.parent();
    if (!grand) return { isCallSite: false };
    const grandKind = String(grand.kind());
    const receiver = parent.field('object')?.text();
    if (
      (grandKind === 'call_expression' && grand.field('function')?.id() === parent.id()) ||
      (grandKind === 'new_expression' && grand.field('constructor')?.id() === parent.id()) ||
      ((grandKind === 'jsx_opening_element' || grandKind === 'jsx_self_closing_element') &&
        grand.field('name')?.id() === parent.id()) ||
      grandKind === 'arguments' ||
      (grandKind === 'jsx_expression' && String(grand.parent()?.kind()) === 'jsx_attribute')
    ) {
      return { isCallSite: true, ...(receiver ? { receiver } : {}) };
    }
    return { isCallSite: false };
  }

  // 5. Passed as a callback / HOC argument: `memo(FooImpl)`, `items.map(handleItem)`
  if (parentKind === 'arguments') {
    return { isCallSite: true };
  }

  // 6. Passed as a JSX prop handler: `<Button onClick={handleSave} />`
  if (parentKind === 'jsx_expression' && String(parent.parent()?.kind()) === 'jsx_attribute') {
    return { isCallSite: true };
  }

  return { isCallSite: false };
}

/**
 * Finds all verified call/JSX/callback sites of `symbolName` in one parsed `SgRoot`
 * and attaches the innermost callable enclosing function (never plain local vars).
 */
export function findCallSitesInRoot(
  root: AstGrepRoot,
  source: string,
  relPath: string,
  symbolName: string,
  fileSymbols: readonly IndexedSymbol[],
  excludeOrigin?: { readonly relPath: string; readonly line: number }
): ExtractedCallSite[] {
  const lines = source.split(/\r?\n/u);
  const matchedNodes = root.root().findAll(buildSymbolUsageMatcher(symbolName));
  return collectCallSitesFromMatchedNodes(matchedNodes, lines, relPath, fileSymbols, excludeOrigin);
}

export function collectCallSitesFromMatchedNodes(
  matchedNodes: readonly AstGrepNode[],
  lines: readonly string[],
  relPath: string,
  fileSymbols: readonly IndexedSymbol[],
  excludeOrigin?: { readonly relPath: string; readonly line: number }
): ExtractedCallSite[] {
  const results: ExtractedCallSite[] = [];
  const seen = new Set<string>();

  for (const node of matchedNodes) {
    const classified = classifyCallSiteNode(node);
    if (!classified.isCallSite) continue;
    const range = node.range();
    const line = range.start.line + 1;
    const character = range.start.column;
    if (excludeOrigin && excludeOrigin.relPath === relPath && excludeOrigin.line === line) {
      continue;
    }
    const dedupeKey = `${line}:${character}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const enclosing = findInnermostSymbolAtLine(fileSymbols, line, { callableOnly: true });
    results.push({
      path: relPath,
      line,
      character,
      previewLine: trimPreviewLine(lines[range.start.line]),
      ...(classified.receiver ? { receiver: classified.receiver } : {}),
      ...(enclosing ? { caller: toPublicCodeNavSymbol(enclosing) } : {}),
    });
  }
  return results;
}

/* ── Unified diff hunk parsing ────────────────────────────────────────────── */

export type ParsedDiffHunk = {
  /** 1-based start line in new file (0 if pure deletion at top of file). */
  readonly startLine: number;
  /** 1-based end line in new file (0 if pure deletion at top of file). */
  readonly endLine: number;
  /** 1-based line numbers of non-blank, non-comment modified lines in this hunk. */
  readonly codeLines: readonly number[];
  /** Fallback 1-based anchor lines when the hunk only deleted lines or edited comments. */
  readonly fallbackLines: readonly number[];
};

export type ParsedFileDiffHunks = {
  readonly relPath: string;
  readonly hunks: readonly ParsedDiffHunk[];
};

function isCommentOrBlankLine(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return true;
  if (
    trimmed.startsWith('//') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('*/')
  ) {
    return true;
  }
  return false;
}

const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u;

/**
 * Parses `git -c core.quotePath=false diff -U0 --no-renames --relative` output
 * into per-file hunks with exact non-comment modified line numbers.
 */
export function parseUnifiedDiffHunks(diffOutput: string): ParsedFileDiffHunks[] {
  const files: ParsedFileDiffHunks[] = [];
  let currentPath: string | null = null;
  let currentHunks: ParsedDiffHunk[] = [];
  let activeHunk: {
    startLine: number;
    endLine: number;
    codeLines: number[];
    fallbackLines: number[];
    nextNewLine: number;
  } | null = null;

  const flushHunk = () => {
    if (!activeHunk) return;
    currentHunks.push({
      startLine: activeHunk.startLine,
      endLine: activeHunk.endLine,
      codeLines: activeHunk.codeLines,
      fallbackLines: activeHunk.fallbackLines,
    });
    activeHunk = null;
  };

  const flushFile = () => {
    flushHunk();
    if (currentPath && currentHunks.length > 0) {
      files.push({ relPath: currentPath, hunks: currentHunks });
    }
    currentPath = null;
    currentHunks = [];
  };

  for (const rawLine of diffOutput.split(/\r?\n/u)) {
    if (rawLine.startsWith('diff --git ')) {
      flushFile();
      continue;
    }
    if (rawLine.startsWith('+++ ')) {
      const target = rawLine.slice(4).trim();
      if (target === '/dev/null') {
        currentPath = null;
      } else {
        currentPath = target.startsWith('b/') ? target.slice(2) : target;
      }
      continue;
    }
    if (rawLine.startsWith('--- ')) {
      continue;
    }
    if (!currentPath) continue;

    if (rawLine.startsWith('@@ ')) {
      flushHunk();
      const match = HUNK_HEADER_RE.exec(rawLine);
      if (!match) continue;
      const newStart = Number(match[1]);
      const newCount = match[2] === undefined ? 1 : Number(match[2]);
      if (newCount === 0) {
        const anchor = Math.max(1, newStart);
        activeHunk = {
          startLine: newStart,
          endLine: newStart,
          codeLines: [],
          fallbackLines: [anchor],
          nextNewLine: newStart,
        };
      } else {
        activeHunk = {
          startLine: newStart,
          endLine: newStart + newCount - 1,
          codeLines: [],
          fallbackLines: [newStart],
          nextNewLine: newStart,
        };
      }
      continue;
    }

    if (!activeHunk) continue;
    if (rawLine.startsWith('+')) {
      const lineNumber = activeHunk.nextNewLine;
      activeHunk.nextNewLine += 1;
      const content = rawLine.slice(1);
      if (!isCommentOrBlankLine(content)) {
        activeHunk.codeLines.push(lineNumber);
      }
    } else if (rawLine.startsWith(' ')) {
      activeHunk.nextNewLine += 1;
    }
  }

  flushFile();
  return files;
}
