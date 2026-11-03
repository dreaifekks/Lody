import { describe, expect, it } from 'vitest';
import { buildMentionFilePathsEntryFromProviderEntries } from '../src/components/mentions/mention-project-file-source';

describe('buildMentionFilePathsEntryFromProviderEntries', () => {
  it('leaves ignored files and directories out of mention completion', () => {
    expect(
      buildMentionFilePathsEntryFromProviderEntries(
        [
          {
            entryType: 'lazy-directory',
            directoryId: 'node_modules',
            path: 'node_modules',
            kind: 'special',
            sourceState: 'live-collaborative',
            ignored: true,
          },
          {
            entryType: 'file',
            fileId: 'debug.log',
            path: 'debug.log',
            kind: 'text',
            sourceState: 'live-collaborative',
            ignored: true,
          },
          {
            entryType: 'file',
            fileId: 'README.md',
            path: 'README.md',
            kind: 'text',
            sourceState: 'live-collaborative',
          },
        ],
        456
      )
    ).toEqual({ paths: ['README.md'], truncated: false, fetchedAt: 456 });
  });
});
