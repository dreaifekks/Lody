import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isSupportedCodeNavFile, validateContainedCandidatePath } from './path-boundary';

const RESOLVABLE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
] as const;

type WorkspacePackageEntry = {
  readonly name: string;
  readonly dir: string;
  readonly mainEntry?: string;
  readonly exportsMap?: Readonly<Record<string, string>>;
};

type TsconfigPathMapping = {
  readonly baseDir: string;
  readonly prefix: string;
  readonly targetPrefix: string;
};

/**
 * Lightweight, cached workspace package + tsconfig `@/` path resolver for TS/JS
 * import tracing. Every resolved file is strictly validated inside `canonicalRoot`.
 */
export class WorkspaceImportResolver {
  private readonly workspacePackagesByRoot = new Map<string, Map<string, WorkspacePackageEntry>>();
  private readonly tsconfigPathsByDir = new Map<string, readonly TsconfigPathMapping[]>();

  async resolveSpecifier(
    canonicalRoot: string,
    fromRelPath: string,
    specifier: string
  ): Promise<{ readonly absolutePath: string; readonly relPath: string } | null> {
    if (!specifier || specifier.includes('\0')) return null;

    // 1. Relative specifier: `./foo`, `../bar`
    if (
      specifier.startsWith('./') ||
      specifier.startsWith('../') ||
      specifier === '.' ||
      specifier === '..'
    ) {
      const baseDir = path.dirname(path.join(canonicalRoot, fromRelPath));
      return await this.probeFileCandidates(canonicalRoot, path.resolve(baseDir, specifier));
    }

    // 2. Alias specifier (e.g. `@/lib/foo` or `~/...`): check nearest tsconfig.json paths
    if (specifier.startsWith('@/') || specifier.startsWith('~/')) {
      const fromDir = path.dirname(path.join(canonicalRoot, fromRelPath));
      const mappings = await this.loadTsconfigPaths(canonicalRoot, fromDir);
      for (const mapping of mappings) {
        if (specifier.startsWith(mapping.prefix)) {
          const rest = specifier.slice(mapping.prefix.length);
          const candidate = path.resolve(mapping.baseDir, mapping.targetPrefix, rest);
          const hit = await this.probeFileCandidates(canonicalRoot, candidate);
          if (hit) return hit;
        }
      }
      // Conventional fallback: `<nearest package src>/...`
      const pkgRoot = await this.findNearestPackageDir(canonicalRoot, fromDir);
      if (pkgRoot) {
        const rest = specifier.slice(2);
        const hit = await this.probeFileCandidates(canonicalRoot, path.join(pkgRoot, 'src', rest));
        if (hit) return hit;
      }
      return null;
    }

    // 3. Monorepo workspace package specifier (e.g. `@lody/shared` or `@lody/shared/code-nav`)
    const packages = await this.loadWorkspacePackages(canonicalRoot);
    const { pkgName, subpath } = splitPackageSpecifier(specifier);
    const pkg = packages.get(pkgName);
    if (!pkg) return null;

    if (subpath) {
      const exportKey = `./${subpath}`;
      const mapped = pkg.exportsMap?.[exportKey];
      if (mapped) {
        const hit = await this.probeFileCandidates(canonicalRoot, path.resolve(pkg.dir, mapped));
        if (hit) return hit;
      }
      // Also try wildcard export `./node/*` -> `./src/node/*.ts`
      if (pkg.exportsMap) {
        for (const [pattern, target] of Object.entries(pkg.exportsMap)) {
          if (!pattern.includes('*') || !target.includes('*')) continue;
          const [pPre, pSuf] = pattern.split('*');
          if (
            pPre !== undefined &&
            pSuf !== undefined &&
            exportKey.startsWith(pPre) &&
            exportKey.endsWith(pSuf)
          ) {
            const matched = exportKey.slice(pPre.length, exportKey.length - pSuf.length);
            const expanded = target.replace('*', matched);
            const hit = await this.probeFileCandidates(
              canonicalRoot,
              path.resolve(pkg.dir, expanded)
            );
            if (hit) return hit;
          }
        }
      }
      const directSrc = await this.probeFileCandidates(
        canonicalRoot,
        path.join(pkg.dir, 'src', subpath)
      );
      if (directSrc) return directSrc;
      return await this.probeFileCandidates(canonicalRoot, path.join(pkg.dir, subpath));
    }

    const rootEntry = pkg.exportsMap?.['.'] ?? pkg.mainEntry ?? 'src/index.ts';
    const hit = await this.probeFileCandidates(canonicalRoot, path.resolve(pkg.dir, rootEntry));
    if (hit) return hit;
    return await this.probeFileCandidates(canonicalRoot, path.join(pkg.dir, 'src', 'index.ts'));
  }

  private async probeFileCandidates(
    canonicalRoot: string,
    rawBase: string
  ): Promise<{ readonly absolutePath: string; readonly relPath: string } | null> {
    const candidates: string[] = [];

    // TypeScript ESM imports often write `./foo.js` for `./foo.ts`.
    const ext = path.extname(rawBase).toLowerCase();
    if (ext === '.js' || ext === '.mjs' || ext === '.cjs' || ext === '.jsx') {
      const stem = rawBase.slice(0, -ext.length);
      const tsExt =
        ext === '.mjs' ? '.mts' : ext === '.cjs' ? '.cts' : ext === '.jsx' ? '.tsx' : '.ts';
      candidates.push(`${stem}${tsExt}`);
      if (ext === '.js') candidates.push(`${stem}.tsx`);
      candidates.push(rawBase);
    } else if (isSupportedCodeNavFile(rawBase)) {
      candidates.push(rawBase);
    } else {
      for (const candidateExt of RESOLVABLE_EXTENSIONS) {
        candidates.push(`${rawBase}${candidateExt}`);
      }
      for (const candidateExt of RESOLVABLE_EXTENSIONS) {
        candidates.push(path.join(rawBase, `index${candidateExt}`));
      }
    }

    for (const candidate of candidates) {
      const valid = await validateContainedCandidatePath(canonicalRoot, candidate);
      if (valid && isSupportedCodeNavFile(valid.relPath)) {
        return valid;
      }
    }
    return null;
  }

  private async findNearestPackageDir(
    canonicalRoot: string,
    startDir: string
  ): Promise<string | null> {
    let dir = startDir;
    while (dir.startsWith(canonicalRoot)) {
      const pkgJson = await validateContainedCandidatePath(
        canonicalRoot,
        path.join(dir, 'package.json')
      );
      if (pkgJson) return dir;
      if (dir === canonicalRoot) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  }

  private async loadTsconfigPaths(
    canonicalRoot: string,
    startDir: string
  ): Promise<readonly TsconfigPathMapping[]> {
    const cached = this.tsconfigPathsByDir.get(startDir);
    if (cached) return cached;

    const mappings: TsconfigPathMapping[] = [];
    let dir = startDir;
    while (dir.startsWith(canonicalRoot)) {
      const tsconfig = await validateContainedCandidatePath(
        canonicalRoot,
        path.join(dir, 'tsconfig.json')
      );
      if (tsconfig) {
        try {
          const raw = await readFile(tsconfig.absolutePath, 'utf8');
          const stripped = stripJsonCommentsAndTrailingCommas(raw);
          const parsed = JSON.parse(stripped) as {
            compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
          };
          const baseDir = parsed.compilerOptions?.baseUrl
            ? path.resolve(dir, parsed.compilerOptions.baseUrl)
            : dir;
          const pathsObj = parsed.compilerOptions?.paths ?? {};
          for (const [key, targets] of Object.entries(pathsObj)) {
            if (!Array.isArray(targets) || targets.length === 0) continue;
            const prefix = key.endsWith('*') ? key.slice(0, -1) : key;
            for (const target of targets) {
              if (typeof target !== 'string') continue;
              const targetPrefix = target.endsWith('*') ? target.slice(0, -1) : target;
              mappings.push({ baseDir, prefix, targetPrefix });
            }
          }
        } catch {
          // Ignore malformed/non-JSON tsconfig files.
        }
        break;
      }
      if (dir === canonicalRoot) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    this.tsconfigPathsByDir.set(startDir, mappings);
    return mappings;
  }

  private async loadWorkspacePackages(
    canonicalRoot: string
  ): Promise<Map<string, WorkspacePackageEntry>> {
    const existing = this.workspacePackagesByRoot.get(canonicalRoot);
    if (existing) return existing;

    const map = new Map<string, WorkspacePackageEntry>();
    for (const group of ['packages', 'apps']) {
      const groupDir = path.join(canonicalRoot, group);
      let entries;
      try {
        entries = await readdir(groupDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const pkgDir = path.join(groupDir, entry.name);
        const pkgJson = await validateContainedCandidatePath(
          canonicalRoot,
          path.join(pkgDir, 'package.json')
        );
        if (!pkgJson) continue;
        try {
          const raw = JSON.parse(await readFile(pkgJson.absolutePath, 'utf8')) as {
            name?: string;
            main?: string;
            exports?: Record<string, unknown>;
          };
          if (typeof raw.name !== 'string' || !raw.name) continue;
          const exportsMap: Record<string, string> = {};
          if (raw.exports && typeof raw.exports === 'object') {
            for (const [k, v] of Object.entries(raw.exports)) {
              if (typeof v === 'string') {
                exportsMap[k] = v;
              } else if (v && typeof v === 'object') {
                const obj = v as Record<string, unknown>;
                const target =
                  (typeof obj.import === 'string' && obj.import) ||
                  (typeof obj.default === 'string' && obj.default) ||
                  (typeof obj.types === 'string' && obj.types);
                if (target) exportsMap[k] = target;
              }
            }
          }
          map.set(raw.name, {
            name: raw.name,
            dir: pkgDir,
            ...(typeof raw.main === 'string' ? { mainEntry: raw.main } : {}),
            ...(Object.keys(exportsMap).length > 0 ? { exportsMap } : {}),
          });
        } catch {
          // Skip unreadable package.json.
        }
      }
    }

    this.workspacePackagesByRoot.set(canonicalRoot, map);
    return map;
  }
}

function splitPackageSpecifier(specifier: string): {
  readonly pkgName: string;
  readonly subpath?: string;
} {
  const parts = specifier.split('/');
  if (specifier.startsWith('@') && parts.length >= 2) {
    const pkgName = `${parts[0]}/${parts[1]}`;
    const rest = parts.slice(2).join('/');
    return rest ? { pkgName, subpath: rest } : { pkgName };
  }
  const pkgName = parts[0] ?? specifier;
  const rest = parts.slice(1).join('/');
  return rest ? { pkgName, subpath: rest } : { pkgName };
}

function stripJsonCommentsAndTrailingCommas(input: string): string {
  // Strip block and line comments outside string literals, then trailing commas.
  const withoutComments = input.replace(
    /"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//gu,
    (match) => (match.startsWith('"') ? match : '')
  );
  return withoutComments.replace(/,\s*([}\]])/gu, '$1');
}
