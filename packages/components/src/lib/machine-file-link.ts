import { normalizeLanMachineAlias, type MachineId } from '@lody/shared';
import type { FilePathTextSegment } from './linkify-file-paths';
import { parseMarkdownAgentFileHref } from './markdown-agent-file-link';

// A file on a named machine of the LAN, written the way `lody-lan lan cp`
// takes it: `<machine>:<path>`. The machine is its id, its own name or the
// name its LAN gave it (case-insensitive, one machine only); the path is
// absolute, `~/…` or relative to that machine's home, and is read there.
//
// Recognition has two steps, like a relative path confirmed by the file
// index: parsing marks the shape, rendering confirms the machine against the
// workspace's machines. A prefix that names no machine leaves the text as it
// was. Lody never rewrites the paths an agent wrote.

export type MachineFileHref = { readonly machine: string; readonly path: string };

// Two characters at least, so a drive letter (`C:\…`) is never a machine;
// `scheme://` is a URL.
const MACHINE_PREFIX = /^([A-Za-z0-9][A-Za-z0-9._-]+):(?![\\/]{2})/u;

/** The machine and path of a `<machine>:<path>` href, by its shape alone. */
export function parseMachineFileHref(href: string): MachineFileHref | null {
  const trimmed = href.trim();
  const match = MACHINE_PREFIX.exec(trimmed);
  if (!match?.[1] || !parseMarkdownAgentFileHref(trimmed)) return null;
  const path = trimmed.slice(match[0].length);
  // `host:8080/x`, `12:30`: a port or a time.
  if (/^\d+$/u.test(path.split(/[\\/]/u, 1)[0] ?? '')) return null;
  return parseMarkdownAgentFileHref(path) ? { machine: match[1], path } : null;
}

/** What a machine is called: its id, its own name, the name its LAN gave it. */
export type MachineNames = {
  readonly id: string;
  readonly name?: string;
  readonly lanAlias?: unknown;
};

/**
 * The machine a link names, as `lody-lan` finds it: by id, else by its own
 * name, else by its LAN name, when only one machine has it.
 */
export function findLinkedMachine(
  machines: readonly MachineNames[],
  selector: string
): MachineId | null {
  const byId = machines.find((machine) => machine.id === selector);
  if (byId) return byId.id as MachineId;
  const wanted = selector.toLowerCase();
  const byName = machines.filter((machine) => machine.name?.toLowerCase() === wanted);
  const named =
    byName.length > 0
      ? byName
      : machines.filter(
          (machine) => normalizeLanMachineAlias(machine.lanAlias)?.toLowerCase() === wanted
        );
  return named.length === 1 && named[0] ? (named[0].id as MachineId) : null;
}

/**
 * How a written link names a machine (a copied path): its LAN name, else its
 * own name, where a link can spell it, else its id.
 */
export function machineLinkName(machine: MachineNames): string {
  for (const candidate of [normalizeLanMachineAlias(machine.lanAlias), machine.name]) {
    if (candidate && /^[A-Za-z0-9][A-Za-z0-9._-]+$/u.test(candidate)) return candidate;
  }
  return machine.id;
}

/** A file on a machine of the workspace, as a link names it. */
export type MachineFileLink = { readonly machineId: MachineId; readonly path: string };

export function resolveMachineFileLink(
  href: string,
  machines: readonly MachineNames[]
): MachineFileLink | null {
  const parsed = parseMachineFileHref(href);
  const machineId = parsed && findLinkedMachine(machines, parsed.machine);
  return parsed && machineId ? { machineId, path: parsed.path } : null;
}

/** A machine's file as one opens: the path decoded, its line suffix apart. */
export type MachineFileOpenTarget = MachineFileLink & {
  readonly startLine?: number;
  readonly endLine?: number;
};

export function resolveMachineFileTarget(
  href: string,
  machines: readonly MachineNames[]
): MachineFileOpenTarget | null {
  const link = resolveMachineFileLink(href, machines);
  const parsed = link && parseMarkdownAgentFileHref(link.path);
  if (!link || !parsed) return null;
  let path = parsed.filePath;
  try {
    path = decodeURIComponent(path);
  } catch {
    /* A literal percent sign. */
  }
  return {
    machineId: link.machineId,
    path,
    ...(parsed.startLine === undefined ? {} : { startLine: parsed.startLine }),
    ...(parsed.endLine === undefined ? {} : { endLine: parsed.endLine }),
  };
}

/** How a machine's file is spelled where a path is all there is (a side tab): by its id. */
export const machineFileTabPath = (machineId: string, path: string): string =>
  `${machineId}:${path}`;

// A side tab of a machine's file is told apart by its id, which persists with it.
const MACHINE_FILE_TAB_PREFIX = 'file:machine:';

export const machineFileTabId = (machineId: string, path: string): string =>
  `${MACHINE_FILE_TAB_PREFIX}${machineFileTabPath(machineId, path)}`;

/** The machine file a side tab shows, or null for any other tab. */
export function machineFileOfTab(tab: {
  readonly id: string;
  readonly filePath: string;
}): MachineFileLink | null {
  if (!tab.id.startsWith(MACHINE_FILE_TAB_PREFIX)) return null;
  const spelled = tab.id.slice(MACHINE_FILE_TAB_PREFIX.length);
  const colon = spelled.indexOf(':');
  if (colon < 1 || spelled !== tab.filePath) return null;
  return { machineId: spelled.slice(0, colon) as MachineId, path: spelled.slice(colon + 1) };
}

/** A bare path right after `<machine>:` in text, taken together with its prefix. */
export type MachinePathTextSegment = {
  readonly type: 'machine-path';
  readonly value: string;
  readonly prefix: string;
};

// The token before the colon must start the word: `a@mini:`, `x/mini:` are not machines.
const PREFIX_BEFORE_PATH = /(?:^|[^A-Za-z0-9._@:/\\~-])([A-Za-z0-9][A-Za-z0-9._-]+:)$/u;

/**
 * Joins `<machine>:` in the text in front of a bare path to that path. Whether
 * it names a machine is decided when the link renders; until then nothing of
 * the text is lost.
 */
export function attachMachinePrefixes(
  segments: readonly FilePathTextSegment[]
): (FilePathTextSegment | MachinePathTextSegment)[] {
  const joined: (FilePathTextSegment | MachinePathTextSegment)[] = [];
  for (const segment of segments) {
    const previous = joined.at(-1);
    const prefix =
      segment.type === 'path' && previous?.type === 'text'
        ? PREFIX_BEFORE_PATH.exec(previous.value)?.[1]
        : undefined;
    if (!prefix || !previous || !parseMachineFileHref(`${prefix}${segment.value}`)) {
      joined.push(segment);
      continue;
    }
    const before = previous.value.slice(0, -prefix.length);
    if (before) joined[joined.length - 1] = { type: 'text', value: before };
    else joined.pop();
    joined.push({ type: 'machine-path', value: `${prefix}${segment.value}`, prefix });
  }
  return joined;
}
