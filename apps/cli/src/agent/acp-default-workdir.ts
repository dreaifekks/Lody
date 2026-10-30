import os from 'node:os';
import path from 'node:path';

/**
 * Working directory for an ACP start that has no session directory (capability
 * probes, login, quota reads): the daemon's own, unless that is the filesystem
 * root. A macOS app started from Finder runs in `/`, a read-only volume, and
 * agents that create project folders under their cwd (Antigravity's
 * `.gemini/skills`) then fail to start. The home directory matches a daemon
 * started from a shell.
 */
export function defaultAcpWorkdir(
  cwd: string = process.cwd(),
  home: string = os.homedir()
): string {
  const resolved = path.resolve(cwd);
  return resolved === path.parse(resolved).root ? home : cwd;
}
