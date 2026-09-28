/**
 * The name a workspace stores for this machine when it registers.
 *
 * A workspace keeps the name it was given: a rename made in the app must
 * survive every later start. Two cases replace it anyway. A name chosen for
 * the machine itself is the same in every workspace the machine belongs to.
 * And a stored name that is only this machine's host name with a network
 * domain appended was never chosen by anyone: it names the network the machine
 * was on when it first registered.
 */
export function resolveRegisteredMachineName(options: {
  /** The name this process starts with. */
  machineName: string;
  /** Whether that name was chosen rather than derived from the host name. */
  explicit: boolean;
  /** The name the workspace already stores, if any. */
  storedName: string | null | undefined;
}): string {
  const stored = options.storedName?.trim() ?? '';
  if (!stored || options.explicit) return options.machineName;
  if (stored.toLowerCase().startsWith(`${options.machineName.toLowerCase()}.`)) {
    return options.machineName;
  }
  return stored;
}
