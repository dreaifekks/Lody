import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { CodeNavErrorCode } from '@lody/shared';
import type { CodeNavLanguage } from './types';

const EXTENSION_TO_LANGUAGE: Readonly<Record<string, CodeNavLanguage>> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'tsx',
};

export const SUPPORTED_CODE_NAV_EXTENSIONS = Object.keys(EXTENSION_TO_LANGUAGE);

export function getCodeNavLanguage(filePath: string): CodeNavLanguage | null {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_TO_LANGUAGE[ext] ?? null;
}

export function isSupportedCodeNavFile(filePath: string): boolean {
  return getCodeNavLanguage(filePath) !== null;
}

export function toPosixRelPath(canonicalRoot: string, absolutePath: string): string {
  const rel = path.relative(canonicalRoot, absolutePath);
  return rel.split(path.sep).join('/');
}

export function isPathInsideCanonicalRoot(
  canonicalRoot: string,
  candidateRealPath: string
): boolean {
  if (candidateRealPath === canonicalRoot) return true;
  const prefix = canonicalRoot.endsWith(path.sep) ? canonicalRoot : `${canonicalRoot}${path.sep}`;
  return candidateRealPath.startsWith(prefix);
}

export async function resolveCanonicalWorkspaceRoot(workspaceRoot: string): Promise<string | null> {
  try {
    const resolved = await realpath(path.resolve(workspaceRoot));
    const info = await lstat(resolved);
    return info.isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

export type ResolvedContainedPath =
  | {
      readonly ok: true;
      readonly absolutePath: string;
      readonly relPath: string;
    }
  | {
      readonly ok: false;
      readonly code: Extract<
        CodeNavErrorCode,
        'invalid_path' | 'path_not_allowed' | 'file_not_found'
      >;
      readonly message: string;
    };

/**
 * Resolves a workspace-relative or absolute path strictly inside `canonicalRoot`
 * after resolving all symlinks. Any path escaping `canonicalRoot` (via `..`,
 * absolute prefix, or symlink target) is rejected.
 */
export async function resolveContainedWorkspacePath(
  canonicalRoot: string,
  requestedPath: string
): Promise<ResolvedContainedPath> {
  if (!requestedPath || requestedPath.includes('\0')) {
    return { ok: false, code: 'invalid_path', message: 'Invalid file path.' };
  }
  const trimmed = requestedPath.trim();
  if (!trimmed) {
    return { ok: false, code: 'invalid_path', message: 'File path is empty.' };
  }

  // Normalize POSIX separators so relative paths from web/git work on all platforms.
  const candidate = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(canonicalRoot, trimmed);

  // Lexical pre-check before touching the filesystem so an out-of-root missing
  // path never leaks existence as `file_not_found`.
  if (!isPathInsideCanonicalRoot(canonicalRoot, candidate)) {
    return {
      ok: false,
      code: 'path_not_allowed',
      message: 'File is outside the workspace.',
    };
  }

  let realCandidate: string;
  try {
    realCandidate = await realpath(candidate);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      // Also verify that if a symlink exists at `candidate` with a dangling target
      // outside the workspace, we classify it as `path_not_allowed`, not `file_not_found`.
      try {
        const linkStat = await lstat(candidate);
        if (linkStat.isSymbolicLink()) {
          return {
            ok: false,
            code: 'path_not_allowed',
            message: 'Symlink target is outside the workspace.',
          };
        }
      } catch {
        // Plain missing path inside canonicalRoot.
      }
      return { ok: false, code: 'file_not_found', message: `File not found: ${requestedPath}` };
    }
    return {
      ok: false,
      code: 'path_not_allowed',
      message: 'File is outside the workspace.',
    };
  }

  if (!isPathInsideCanonicalRoot(canonicalRoot, realCandidate)) {
    return {
      ok: false,
      code: 'path_not_allowed',
      message: 'File is outside the workspace.',
    };
  }

  const info = await lstat(realCandidate).catch(() => null);
  if (!info || !info.isFile()) {
    return { ok: false, code: 'invalid_path', message: 'Path is not a regular file.' };
  }

  const relPath = toPosixRelPath(canonicalRoot, realCandidate);
  if (!relPath || relPath.startsWith('..') || path.isAbsolute(relPath)) {
    return { ok: false, code: 'path_not_allowed', message: 'File is outside the workspace.' };
  }

  return { ok: true, absolutePath: realCandidate, relPath };
}

/**
 * Validates a candidate path discovered via git or import resolution.
 * Returns canonical `{ absolutePath, relPath }` only if it is a regular file
 * whose realpath stays inside `canonicalRoot`.
 */
export async function validateContainedCandidatePath(
  canonicalRoot: string,
  candidatePath: string
): Promise<{ readonly absolutePath: string; readonly relPath: string } | null> {
  const result = await resolveContainedWorkspacePath(canonicalRoot, candidatePath);
  return result.ok ? { absolutePath: result.absolutePath, relPath: result.relPath } : null;
}
