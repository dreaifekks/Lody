import { useEffect, useState } from 'react';
import {
  formatSshDestination,
  parseSshDestination,
  type SshDestination,
} from '@lody/shared/lan-ssh';
import { MACHINE_SSH_ENTRY_STORAGE_KEY, machineSshEntryCache } from './local-storage-cache';

/**
 * The entry of this computer's SSH configuration the user named for a machine.
 * An editor is handed it instead of the one that answers first. It is kept on
 * this computer: the configuration it names is this computer's own.
 */
export const MACHINE_SSH_ENTRY_CHANGED_EVENT = 'lody:machine-ssh-entry-changed';

/**
 * What the user wrote: an entry or a host, with the user before it when the
 * entry names none. `null` for anything an editor could not be handed.
 */
export function parseMachineSshEntry(text: string): SshDestination | null {
  const parts = text.trim().split('@');
  if (parts.length > 2) return null;
  const [first, second] = parts;
  return parseSshDestination(
    second === undefined ? { host: first } : { host: second, user: first }
  );
}

export function readMachineSshEntry(machineId: string | null | undefined): SshDestination | null {
  if (!machineId) return null;
  const written = machineSshEntryCache.get(machineId);
  return written === null ? null : parseMachineSshEntry(written);
}

/** `null` leaves the choice to what answers first again. */
export function writeMachineSshEntry(machineId: string, entry: SshDestination | null): void {
  if (entry) machineSshEntryCache.set(machineId, formatSshDestination(entry));
  else machineSshEntryCache.remove(machineId);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(MACHINE_SSH_ENTRY_CHANGED_EVENT));
  }
}

function readAllMachineSshEntries(): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const [machineId, written] of Object.entries(machineSshEntryCache.readAll())) {
    const entry = parseMachineSshEntry(written);
    if (entry) entries[machineId] = formatSshDestination(entry);
  }
  return entries;
}

/** The entries the user named, by machine, as they are written; it follows every change. */
export function useMachineSshEntries(): Readonly<Record<string, string>> {
  const [entries, setEntries] = useState(readAllMachineSshEntries);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const refresh = () => setEntries(readAllMachineSshEntries());
    const onStorage = (event: StorageEvent) => {
      if (event.key === MACHINE_SSH_ENTRY_STORAGE_KEY) refresh();
    };
    window.addEventListener(MACHINE_SSH_ENTRY_CHANGED_EVENT, refresh);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(MACHINE_SSH_ENTRY_CHANGED_EVENT, refresh);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return entries;
}
