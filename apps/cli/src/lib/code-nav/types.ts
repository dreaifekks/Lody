import type {
  CodeNavCallersOk,
  CodeNavDefinitionOk,
  CodeNavDiffOutlineOk,
  CodeNavEnclosingOk,
  CodeNavErrorCode,
  CodeNavProviderKind,
  CodeNavQueryError,
  CodeNavSymbol,
  CodeNavSymbolKind,
  SessionId,
} from '@lody/shared';

export type CodeNavLanguage = 'typescript' | 'tsx' | 'javascript';

export type CodeNavDiffOutlineInput = {
  readonly workspaceRoot: string;
  readonly scope: 'branch' | 'uncommitted';
  readonly baseRef?: string;
  readonly preferredBaseBranch?: string;
};

export type CodeNavEnclosingInput = {
  readonly workspaceRoot: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
};

export type CodeNavDefinitionInput = {
  readonly workspaceRoot: string;
  readonly path: string;
  readonly line: number;
  readonly character: number;
  readonly symbolHint?: string;
  readonly limit?: number;
};

export type CodeNavCallersInput = {
  readonly workspaceRoot: string;
  readonly path: string;
  readonly line: number;
  readonly character: number;
  readonly symbolHint?: string;
  readonly maxDepth?: 1 | 2;
  readonly limit?: number;
};

/**
 * Unified read-only code navigation engine contract.
 * Phase 1 uses `AstGrepCodeNavProvider`; future providers (`ts-ls`, Swift)
 * plug in behind this interface with zero RPC or UI changes.
 */
export interface CodeNavProvider {
  readonly id: CodeNavProviderKind;
  diffOutline(
    input: CodeNavDiffOutlineInput,
    signal?: AbortSignal
  ): Promise<CodeNavDiffOutlineOk | CodeNavQueryError>;
  enclosing(
    input: CodeNavEnclosingInput,
    signal?: AbortSignal
  ): Promise<CodeNavEnclosingOk | CodeNavQueryError>;
  definitions(
    input: CodeNavDefinitionInput,
    signal?: AbortSignal
  ): Promise<CodeNavDefinitionOk | CodeNavQueryError>;
  callers(
    input: CodeNavCallersInput,
    signal?: AbortSignal
  ): Promise<CodeNavCallersOk | CodeNavQueryError>;
}

export type CodeNavWorkspaceResolution =
  | {
      readonly ok: true;
      readonly ownerSessionId: SessionId;
      readonly workspaceRoot: string;
      readonly preferredBaseBranch?: string;
    }
  | {
      readonly ok: false;
      readonly code: CodeNavErrorCode;
      readonly message: string;
    };

export type CodeNavWorkspaceResolver = (
  sessionId: SessionId,
  rootId?: string
) => Promise<CodeNavWorkspaceResolution>;

export type IndexedSymbol = CodeNavSymbol & {
  /** 1-based line of the identifier token itself (may differ from startLine on decorators/exports). */
  readonly nameLine: number;
  /** 0-based column of the identifier token. */
  readonly nameCharacter: number;
  /** 1-based end line of the identifier token. */
  readonly nameEndLine: number;
  /** 0-based end column of the identifier token. */
  readonly nameEndCharacter: number;
  /** True only for real functions/methods/arrow functions/React HOCs, never plain `const x = fn()`. */
  readonly isCallable: boolean;
  /** Whether declared at module/class level as exported. */
  readonly isExported: boolean;
  /** Trimmed single-line source preview at nameLine. */
  readonly previewLine: string;
  /** For separated HOC wrappers like `export const Foo = memo(FooImpl)`, the wrapped local identifier. */
  readonly wrapsIdentifier?: string;
};

export type IndexedImport = {
  /** Module specifier as written in source (e.g. `./foo`, `@/lib/bar`, `@lody/shared`). */
  readonly specifier: string;
  /** Local identifier bound in this file. */
  readonly localName: string;
  /** Original exported name (`'default'` for default imports, `'*'` for namespace imports). */
  readonly importedName: string;
  readonly isTypeOnly: boolean;
};

export type IndexedExport =
  | {
      readonly kind: 'reexport-named';
      readonly specifier: string;
      readonly exportedName: string;
      readonly originalName: string;
    }
  | {
      readonly kind: 'reexport-all';
      readonly specifier: string;
    }
  | {
      readonly kind: 'local-alias';
      readonly exportedName: string;
      readonly localName: string;
    };

export type FileSymbolIndex = {
  readonly relPath: string;
  readonly language: CodeNavLanguage;
  readonly estimatedBytes: number;
  readonly symbols: readonly IndexedSymbol[];
  readonly imports: readonly IndexedImport[];
  readonly exports: readonly IndexedExport[];
};

export type CodeNavSymbolKindWithCallable = {
  readonly kind: CodeNavSymbolKind;
  readonly isCallable: boolean;
};
