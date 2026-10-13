import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { FileTreeProviderView } from '@/components/sessions/components/file-tree-view';
import { writeFileTreeViewState } from '@/lib/file-tree-view-state';
import {
  createFakeSessionFileProvider,
  type SessionFileProviderEntry,
} from '@/lib/session-file-provider';

// Renders the REAL session "Files" surface. `FileTreeProviderView` owns the
// ScrollArea, the flat virtualized row list, and the row height / indent, so this
// story exercises production rows rather than re-composing them here.
const folderPaths = [
  '.changeset',
  '.cursor',
  '.devcontainer',
  '.github',
  '.vscode',
  'crates',
  'docs',
  'examples',
  'moon',
  'packages',
  'plans',
  'scripts',
  'skills',
  'sponsorkit',
  'supply-chain',
];

const rootFiles = [
  '.editorconfig',
  '.gitignore',
  'AGENTS.md',
  'Cargo.lock',
  'Cargo.toml',
  'cliff.toml',
  'CONTRIBUTING.md',
  'deno.lock',
  'deny.toml',
  'LICENSE',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'README.md',
  'rust-toolchain',
  'sponsorkit.config.js',
];

// One nested file per folder so each directory is a real expandable node, which
// is how the provider file index actually reports directories.
const repoRootPaths = [...folderPaths.map((folder) => `${folder}/README.md`), ...rootFiles];

// Well past the virtualization threshold, so this story covers the windowed row
// path that large repositories hit.
const largeRepoPaths = Array.from(
  { length: 600 },
  (_, index) => `packages/app/src/module-${String(index).padStart(3, '0')}.ts`
);

// What the file index reports for ignored paths: a directory nobody opened is one
// lazy row, an opened one also lists its level, and every row under it is ignored.
const ignoredFile = (path: string): SessionFileProviderEntry => ({
  path,
  kind: 'text',
  sourceState: 'live-collaborative',
  ignored: true,
});
const ignoredDirectory = (path: string): SessionFileProviderEntry => ({
  entryType: 'lazy-directory',
  directoryId: path,
  path,
  kind: 'special',
  sourceState: 'live-collaborative',
  ignored: true,
});
const ignoredRowsPaths = ['.gitignore', 'README.md', 'src/app.ts', 'src/index.ts'];
const ignoredRowsEntries = [
  ignoredDirectory('node_modules'),
  ignoredDirectory('notes'),
  ignoredDirectory('notes/demoday'),
  ignoredFile('notes/plan.md'),
  ignoredFile('notes/todo.md'),
  ignoredFile('debug.log'),
];
const IGNORED_ROWS_VIEW_STATE_KEY = 'story-file-tree-ignored-rows';
writeFileTreeViewState(IGNORED_ROWS_VIEW_STATE_KEY, {
  expandedIds: new Set(['notes', 'src']),
  selectedId: undefined,
});

function FileTreeStory({
  paths,
  entries,
  changedFilePaths,
  viewStateKey,
}: {
  readonly paths: readonly string[];
  readonly entries?: readonly SessionFileProviderEntry[];
  readonly changedFilePaths?: readonly string[];
  readonly viewStateKey?: string;
}) {
  const provider = useMemo(
    () =>
      createFakeSessionFileProvider({
        sourceState: 'live-collaborative',
        files: [
          ...paths.map((path) => ({
            path,
            kind: 'text' as const,
            sourceState: 'live-collaborative' as const,
          })),
          ...(entries ?? []),
        ],
      }),
    [paths, entries]
  );

  return (
    <FileTreeProviderView
      fileProvider={provider}
      fileProviderPending={false}
      handleOpenFile={fn()}
      changedFilePaths={changedFilePaths}
      viewStateKey={viewStateKey}
    />
  );
}

const meta = {
  title: 'Sessions/FileTreeList',
  component: FileTreeStory,
  parameters: {
    layout: 'centered',
  },
  decorators: [
    (Story) => (
      <div className="h-[640px] w-[320px] border border-border bg-background">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof FileTreeStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RepoRoot: Story = {
  args: { paths: repoRootPaths },
};

// Scroll this one: only a viewport-sized window of rows is ever mounted.
export const LargeVirtualizedTree: Story = {
  args: { paths: largeRepoPaths },
};

// Ignored rows are dimmed next to ordinary and modified ones: `node_modules` is an
// ignored directory nobody opened, `notes` an opened one, `debug.log` a lone file.
export const IgnoredRows: Story = {
  args: {
    paths: ignoredRowsPaths,
    entries: ignoredRowsEntries,
    changedFilePaths: ['src/app.ts'],
    viewStateKey: IGNORED_ROWS_VIEW_STATE_KEY,
  },
};
