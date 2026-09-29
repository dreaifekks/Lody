import type { LanInstallTarget } from './lan-updater-policy'

/**
 * What replaces the application once it is gone. It runs detached from the
 * application, which cannot replace files it still runs from, and it starts
 * the application again when it is done.
 */
export type LanInstallCommand = {
  command: string
  args: string[]
  env?: Record<string, string>
}

// Values reach the scripts as arguments, never as text of the script: a path
// may contain anything a shell would read.

// How long the scripts wait for the application to be gone, in fifths of a second.
const WAIT_STEPS = 600

const WAIT_FOR_EXIT = `
steps=0
while kill -0 "$pid" 2>/dev/null; do
  steps=$((steps + 1))
  [ "$steps" -gt ${WAIT_STEPS} ] && exit 1
  sleep 0.2
done
`

/**
 * Both moves stay within one directory, so each is a rename: the application
 * is never half there. When the new one cannot take its place the old one
 * goes back, and whichever is there is started. Nobody watches a script that
 * outlives the application, so it leaves what went wrong where the
 * application that starts next reads it.
 */
const MAC_SCRIPT = `
pid="$1"
bundle="$2"
staged="$3"
backup="$4"
staging="$5"
report="$6"
${WAIT_FOR_EXIT}
rm -rf "$backup"
failure=
if ! said=$(mv "$bundle" "$backup" 2>&1); then
  failure="\${said:-the application could not be moved away}"
elif ! said=$(mv "$staged" "$bundle" 2>&1); then
  failure="\${said:-the new application could not be moved into place}"
  mv "$backup" "$bundle"
else
  xattr -dr com.apple.quarantine "$bundle" 2>/dev/null
  rm -rf "$backup" "$staging"
fi
[ -n "$failure" ] && printf '%s\\n' "$failure" > "$report"
open "$bundle"
`

const APPIMAGE_SCRIPT = `
pid="$1"
target="$2"
download="$3"
report="$4"
shift 4
${WAIT_FOR_EXIT}
if ! said=$(mv -f "$download" "$target" 2>&1); then
  printf '%s\\n' "\${said:-the new application could not be moved into place}" > "$report"
fi
exec "$target" "$@"
`

export function buildLanInstallCommand(input: {
  target: LanInstallTarget
  /** The application that has to be gone before anything is replaced. */
  pid: number
  /** The application staged for a bundle; where the download is for the others. */
  staged: string
  /** What the application was started with, for the one that replaces it. */
  relaunchArgs: readonly string[]
}): LanInstallCommand {
  const { target } = input
  const pid = String(input.pid)

  if (target.kind === 'mac-bundle') {
    return {
      command: '/bin/sh',
      args: [
        '-c',
        MAC_SCRIPT,
        'lody-update',
        pid,
        target.bundlePath,
        input.staged,
        target.backup,
        target.staging,
        target.report
      ]
    }
  }

  if (target.kind === 'appimage') {
    return {
      command: '/bin/sh',
      args: [
        '-c',
        APPIMAGE_SCRIPT,
        'lody-update',
        pid,
        target.target,
        input.staged,
        target.report,
        ...input.relaunchArgs
      ],
      // The runtime of an AppImage offers to integrate it with the desktop on
      // a first start, which this is not.
      env: { APPIMAGE_SILENT_INSTALL: 'true' }
    }
  }

  // The installer waits for the application itself, replaces what it
  // installed for this user without asking, and starts the application.
  return { command: input.staged, args: ['/S', '--updated', '--force-run'] }
}

/**
 * What a replacement that failed left behind, as one line short enough to show.
 * `null` when it left nothing that says anything.
 */
export function readLanInstallFailure(report: string): string | null {
  const line = report
    .split('\n')
    .map((candidate) => candidate.trim())
    .find(Boolean)
  return line ? line.slice(0, 300) : null
}

/**
 * The version a staged application claims in its property list, or `null`
 * when the list does not say it in a way this reads.
 */
export function readBundleVersion(propertyList: string): string | null {
  const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/u.exec(
    propertyList
  )
  return match?.[1]?.trim() || null
}
