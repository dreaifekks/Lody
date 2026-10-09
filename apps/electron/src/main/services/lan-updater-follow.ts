import fs from 'node:fs'
import path from 'node:path'
import { resolveLanReleaseChannel, type LanReleaseSource } from '@lody/shared/lan-release'

const RECORD_NAME = 'lan-release.json'

/**
 * The release this installation follows. A release may carry the installers a
 * dev build published first, stamped with the dev release, so the stamp
 * decides only on the first start. What is followed from then on is recorded
 * beside the data of the application, which an update keeps.
 */
export function readFollowedLanRelease(stamp: LanReleaseSource, dataDir: string): LanReleaseSource {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(dataDir, RECORD_NAME), 'utf8')) as {
      tag?: unknown
    }
    if (typeof record.tag === 'string' && resolveLanReleaseChannel(record.tag)) {
      return { ...stamp, tag: record.tag }
    }
  } catch {
    // The first start of a build that records it.
  }
  writeFollowedLanRelease(dataDir, stamp.tag)
  return stamp
}

export function writeFollowedLanRelease(dataDir: string, tag: string): void {
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, RECORD_NAME), `${JSON.stringify({ tag })}\n`)
}
