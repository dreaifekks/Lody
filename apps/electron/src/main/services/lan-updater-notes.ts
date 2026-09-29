import { getLanReleasePageUrl, type LanReleaseSource } from '@lody/shared/lan-release'

const MAX_CHANGES = 30
const SUBJECT_MAX = 160

/** Where the repository says what changed between two of its commits. */
export function getLanCompareUrl(source: LanReleaseSource, from: string, to: string): string {
  return `https://api.github.com/repos/${source.repository}/compare/${from}...${to}`
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The subjects of the commits a comparison lists, newest first. Anything that
 * is not a comparison gives none: the notes then say less, not something wrong.
 */
export function readLanChanges(comparison: unknown): string[] {
  if (!isRecord(comparison) || !Array.isArray(comparison.commits)) return []
  const subjects: string[] = []
  for (const entry of comparison.commits) {
    const commit = isRecord(entry) ? entry.commit : null
    const message = isRecord(commit) ? commit.message : null
    if (typeof message !== 'string') continue
    const subject = message.split('\n', 1)[0]?.trim()
    if (subject) subjects.push(subject.slice(0, SUBJECT_MAX))
  }
  return subjects.reverse()
}

// A subject is text somebody wrote; in the notes it must not become markup.
const escapeMarkdown = (text: string): string => text.replace(/([\\`*_{}[\]<>()#+!|])/gu, '\\$1')

const WORDS = {
  en: {
    build: (version: string, commit: string) => `Build \`${version}\` of commit \`${commit}\`.`,
    changes: 'What changed since the build you run:',
    more: (count: number) => `… and ${count} more`,
    files: 'All files of this release'
  },
  zh_CN: {
    build: (version: string, commit: string) => `版本 \`${version}\`，提交 \`${commit}\`。`,
    changes: '自当前版本以来的变更：',
    more: (count: number) => `…… 另有 ${count} 项`,
    files: '此发布的全部文件'
  }
} as const

export function composeLanReleaseNotes(input: {
  source: LanReleaseSource
  version: string
  commit: string
  changes: readonly string[]
}): { en: string; zh_CN: string } {
  const compose = (words: (typeof WORDS)[keyof typeof WORDS]): string => {
    const shown = input.changes.slice(0, MAX_CHANGES)
    const hidden = input.changes.length - shown.length
    return [
      words.build(input.version, input.commit.slice(0, 8)),
      ...(shown.length > 0
        ? [
            words.changes,
            [
              ...shown.map((change) => `- ${escapeMarkdown(change)}`),
              ...(hidden > 0 ? [`- ${words.more(hidden)}`] : [])
            ].join('\n')
          ]
        : []),
      `[${words.files}](${getLanReleasePageUrl(input.source)})`
    ].join('\n\n')
  }
  return { en: compose(WORDS.en), zh_CN: compose(WORDS.zh_CN) }
}
