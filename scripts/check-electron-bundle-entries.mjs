#!/usr/bin/env node
// Fails when a built Electron main or preload bundle keeps a workspace package
// external whose entry is TypeScript. Workspace packages export their sources,
// and Node refuses to strip types below node_modules, so such a package passes
// every dev run and stops the packaged application from starting
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). It has to be inlined instead.
//
// The bundles are parsed: their comments and strings name these packages too.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WORKSPACE_SCOPE = '@lody/';
const TARGETS = ['main', 'preload'];
const BUNDLE_FILE = /\.(?:js|mjs|cjs)$/u;
const TYPESCRIPT_ENTRY = /\.(?:ts|tsx|mts|cts)$/u;
// Bundlers rename `require` when it collides: `require$1`, `__require`, `require2`.
const REQUIRE_NAME = /^_*require(?:\$?\d+)?$/u;
const CONFIG_PATH = 'apps/electron/electron.vite.config.ts';

function isCreateRequire(node) {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  const name = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
  return ts.isIdentifier(name) && name.text === 'createRequire';
}

function isModuleLoader(callee) {
  if (callee.kind === ts.SyntaxKind.ImportKeyword) return true;
  if (ts.isIdentifier(callee)) return REQUIRE_NAME.test(callee.text);
  if (isCreateRequire(callee)) return true;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  // module.require(x), require.resolve(x), createRequire(y).resolve(x), import.meta.resolve(x)
  if (REQUIRE_NAME.test(callee.name.text)) return true;
  if (callee.name.text !== 'resolve') return false;
  const owner = callee.expression;
  return (
    (ts.isIdentifier(owner) && REQUIRE_NAME.test(owner.text)) ||
    isCreateRequire(owner) ||
    ts.isMetaProperty(owner)
  );
}

/** The module specifiers a bundle loads at runtime, comments and strings excluded. */
function findLoadedSpecifiers(fileName, text) {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS
  );
  const specifiers = new Set();
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.add(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && isModuleLoader(node.expression)) {
      const [first] = node.arguments;
      if (first && ts.isStringLiteralLike(first)) specifiers.add(first.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...specifiers];
}

function splitSpecifier(specifier) {
  const [scope, name, ...rest] = specifier.split('/');
  return {
    packageName: `${scope}/${name}`,
    subpath: rest.length > 0 ? `./${rest.join('/')}` : '.',
  };
}

function findPackageDir(fromDir, packageName) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', packageName);
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (dir === path.dirname(dir)) return undefined;
  }
}

function findExportEntry(exportsField, subpath) {
  if (typeof exportsField === 'string' || Array.isArray(exportsField)) {
    return subpath === '.' ? exportsField : undefined;
  }
  const keys = Object.keys(exportsField);
  if (!keys.some((key) => key.startsWith('.'))) {
    return subpath === '.' ? exportsField : undefined;
  }
  if (subpath in exportsField) return exportsField[subpath];
  for (const key of keys) {
    const [prefix, suffix] = key.split('*');
    if (
      suffix !== undefined &&
      subpath.startsWith(prefix) &&
      subpath.endsWith(suffix) &&
      subpath.length >= prefix.length + suffix.length
    ) {
      const star = subpath.slice(prefix.length, subpath.length - suffix.length);
      return JSON.parse(JSON.stringify(exportsField[key]).replaceAll('*', star));
    }
  }
  return undefined;
}

// Which condition applies depends on who loads it, so every runtime one counts.
// `types` is the only one that never reaches a loader.
function runtimeTargets(entry) {
  if (typeof entry === 'string') return [entry];
  if (Array.isArray(entry)) return entry.flatMap(runtimeTargets);
  if (entry === null || typeof entry !== 'object') return [];
  return Object.entries(entry)
    .filter(([condition]) => condition !== 'types')
    .flatMap(([, value]) => runtimeTargets(value));
}

function resolveTargets(packageJson, subpath) {
  if (packageJson.exports !== undefined) {
    const entry = findExportEntry(packageJson.exports, subpath);
    return entry === undefined ? undefined : runtimeTargets(entry);
  }
  if (subpath !== '.') return [subpath];
  return [packageJson.main ?? './index.js'];
}

function checkSpecifier(specifier, fromDir) {
  const { packageName, subpath } = splitSpecifier(specifier);
  const packageDir = findPackageDir(fromDir, packageName);
  if (!packageDir) return `is not installed where the bundle loads it`;
  const packageJson = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  const targets = resolveTargets(packageJson, subpath);
  if (!targets) return `does not export ${subpath}`;
  const typescript = targets.find((target) => TYPESCRIPT_ENTRY.test(target));
  return typescript ? `resolves to TypeScript (${typescript})` : undefined;
}

function listBundles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && BUNDLE_FILE.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

/** Scans `<outDir>/main` and `<outDir>/preload`; returns what was read and what is wrong. */
function checkBundleEntries(outDir) {
  const problems = [];
  let scanned = 0;
  const externals = new Set();
  for (const target of TARGETS) {
    const targetDir = path.join(outDir, target);
    const bundles = existsSync(targetDir) ? listBundles(targetDir) : [];
    if (bundles.length === 0) {
      throw new Error(`No bundles in ${targetDir}; build the Electron application first.`);
    }
    for (const file of bundles) {
      scanned += 1;
      for (const specifier of findLoadedSpecifiers(file, readFileSync(file, 'utf8'))) {
        if (!specifier.startsWith(WORKSPACE_SCOPE)) continue;
        externals.add(specifier);
        const reason = checkSpecifier(specifier, path.dirname(file));
        if (reason) problems.push({ target, file, specifier, reason });
      }
    }
  }
  return { scanned, externals: [...externals].sort(), problems };
}

function main() {
  const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
  const outDir = path.resolve(process.argv[2] ?? path.join(repositoryRoot, 'apps/electron/out'));
  const { scanned, externals, problems } = checkBundleEntries(outDir);
  if (problems.length === 0) {
    const listed = externals.length > 0 ? externals.join(', ') : 'none';
    console.log(
      `Scanned ${scanned} bundle files. External ${WORKSPACE_SCOPE}* imports: ${listed}.`
    );
    return;
  }
  console.error(`The packaged application cannot load ${problems.length} external import(s):`);
  for (const { file, specifier, reason } of problems) {
    console.error(`  ${path.relative(outDir, file)}: ${specifier} ${reason}`);
  }
  for (const target of new Set(problems.map((problem) => problem.target))) {
    const packages = new Set(
      problems
        .filter((problem) => problem.target === target)
        .map((problem) => splitSpecifier(problem.specifier).packageName)
    );
    console.error(
      `Add ${[...packages].join(', ')} to ${target}.build.externalizeDeps.exclude in ${CONFIG_PATH}.`
    );
  }
  process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
