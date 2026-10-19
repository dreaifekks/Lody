import type { Meta, StoryObj } from '@storybook/react';
import type { SessionMeta } from '@lody/shared';
import { Button } from '@lody/ui';
import { DesktopSessionDetailLayout } from '@/components/sessions/desktop-session-detail-layout';
import { SessionFileContentView } from '@/components/sessions/session-file-content-view';
import { createFakeSessionFileProvider } from '@/lib/session-file-provider';
import * as stylex from '@stylexjs/stylex';
import { fn } from 'storybook/test';
import { useEffect, useMemo, useState } from 'react';
import type { SessionFilePayload } from '@lody/shared';
import { SessionKeptMediaFile } from '@/components/ai-gui/session-kept-media-file';
import { SessionFileCard, SessionFileCardList } from '@/components/ai-gui/session-file-card';
import { getAudioMimeTypeForPath, getVideoMimeTypeForPath } from '@/lib/video-file-preview';
import { useTranslation } from 'react-i18next';
import { resolveRevealFileLabel } from '@/lib/session-file-actions';
import { SessionFileBinaryPreview } from '@/components/sessions/session-file-binary-preview';
import { SessionFileNoticeCard } from '@/components/sessions/session-file-error-state';
import { sampleDocx, samplePptx, sampleXlsx } from './fixtures/office-viewer-files';
import type { DocumentSelection } from '@/lib/document-selection';
import { PendingImageMarkupDialog } from '@/components/sessions/pending-image-markup-dialog';

const styles = stylex.create({
  frame: { width: 'min(100%, 960px)', height: '640px' },
});

const meta = {
  title: 'Sessions/SessionFileBinaryPreview',
  component: SessionFileBinaryPreview,
  render: function BinaryPreviewStory(args) {
    const { t } = useTranslation();
    const fileActions = args.fileActions;
    return (
      <SessionFileBinaryPreview
        {...args}
        fileActions={
          fileActions?.localHost
            ? {
                ...fileActions,
                localHost: {
                  ...fileActions.localHost,
                  revealLabel: resolveRevealFileLabel('darwin', t),
                },
              }
            : fileActions
        }
      />
    );
  },
  decorators: [
    (Story) => (
      <div {...stylex.props(styles.frame)}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SessionFileBinaryPreview>;
export default meta;
type Story = StoryObj<typeof meta>;

const createSamplePdf = (): Uint8Array => {
  const header = '%PDF-1.4\n';
  const pageTitles = ['Overview', 'Revenue', 'Operations', 'Outlook'];
  const pages = pageTitles.map((title, index) => {
    const content = `BT /F1 30 Tf 72 700 Td (${title}) Tj /F1 16 Tf 0 -60 Td (Quarterly report page ${index + 1}) Tj ET`;
    const pageId = 4 + index * 2;
    const streamId = pageId + 1;
    return {
      pageId,
      streamId,
      page: `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>\nendobj\n`,
      stream: `${streamId} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
    };
  });
  const objectCount = 3 + pages.length * 2;
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    `2 0 obj\n<< /Type /Pages /Kids [${pages.map(({ pageId }) => `${pageId} 0 R`).join(' ')}] /Count ${pages.length} >>\nendobj\n`,
    '3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    ...pages.flatMap(({ page, stream }) => [page, stream]),
  ];
  let offset = header.length;
  const offsets = objects.map((object) => {
    const currentOffset = offset;
    offset += object.length;
    return currentOffset;
  });
  const xrefOffset = offset;
  const xref = `xref\n0 ${objectCount + 1}\n0000000000 65535 f \n${offsets.map((position) => `${String(position).padStart(10, '0')} 00000 n \n`).join('')}`;
  const trailer = `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new TextEncoder().encode(`${header}${objects.join('')}${xref}${trailer}`);
};

export const LocalArchive: Story = {
  args: {
    path: '/tmp/build/Lody.zip',
    fileActions: {
      onCopyPath: fn(),
      localHost: {
        openTarget: 'default-app',
        revealLabel: 'Reveal in Finder',
        onOpen: fn(),
        onReveal: fn(),
      },
    },
  },
};

export const RemoteArchive: Story = {
  args: { path: 'build/Lody.zip', fileActions: { onCopyPath: fn() } },
};

/** A member of a LAN that gives parts of its files: the file itself can be saved. */
export const RemoteArchiveDownload: Story = {
  args: { path: 'build/Lody.zip', fileActions: { onCopyPath: fn(), onDownload: fn() } },
};

/** One second of a 440 Hz tone, as a WAV file. */
const createSampleWav = (): Uint8Array => {
  const sampleRate = 8000;
  const bytes = new Uint8Array(44 + sampleRate * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  ascii(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, sampleRate * 2, true);
  for (let index = 0; index < sampleRate; index += 1) {
    view.setInt16(44 + index * 2, Math.sin((index / sampleRate) * 2 * Math.PI * 440) * 8000, true);
  }
  return bytes;
};

export const AudioRecording: Story = {
  args: {
    path: 'recordings/tone.wav',
    bytes: createSampleWav(),
    fileActions: { onCopyPath: fn(), onDownload: fn() },
  },
};

export const NativeArchive: Story = {
  args: { path: 'build/package.deb', fileActions: { onCopyPath: fn(), onShare: fn() } },
};

export const NativeSharing: Story = {
  args: {
    path: 'build/package.deb',
    fileActions: { onCopyPath: fn(), onShare: fn(), sharing: true },
  },
};

export const PdfDocument: Story = {
  args: { path: '/tmp/annual-report.pdf', bytes: createSamplePdf() },
};

function PdfFilePanelStory({ preload = false }: { preload?: boolean }) {
  const [mounted, setMounted] = useState(preload);
  const [open, setOpen] = useState(false);
  const provider = useMemo(
    () =>
      createFakeSessionFileProvider({
        sourceState: 'live-readonly',
        files: [
          { fileId: 'pdf', path: 'report.pdf', kind: 'binary', sourceState: 'live-readonly' },
        ],
        snapshots: { 'report.pdf': { kind: 'binary', bytes: createSamplePdf() } },
      }),
    []
  );
  const session = {
    id: 'storybook-pdf-panel',
    machineId: 'storybook-machine',
    userId: 'storybook-user',
    createdAt: '2026-10-19T00:00:00Z',
    cliType: 'codex',
    agentType: 'codex',
  } as unknown as SessionMeta;
  return (
    <DesktopSessionDetailLayout
      defaultSizes={{ main: 50, sidebar: 50 }}
      topBar={null}
      chatSurfaces={
        <Button
          onClick={() => {
            setMounted(true);
            setOpen(true);
          }}
        >
          Open PDF
        </Button>
      }
      terminalDock={null}
      secondaryPanel={
        mounted ? (
          <SessionFileContentView
            sessionId={session.id}
            session={session}
            filePath="report.pdf"
            fileId="pdf"
            fileProvider={provider}
            fileProviderRole="read"
            active={open}
          />
        ) : null
      }
      sidebarOpen={open}
      onSidebarCollapse={() => setOpen(false)}
      deleteConfirmDialog={null}
    />
  );
}

export const PdfFilePanel: Story = {
  args: { path: 'report.pdf' },
  render: () => <PdfFilePanelStory />,
};

export const PdfCollapsedFilePanel: Story = {
  args: { path: 'report.pdf' },
  render: () => <PdfFilePanelStory preload />,
};

export const DocxDocument: Story = {
  args: { path: '/tmp/quarterly-report.docx', bytes: sampleDocx() },
};

export const XlsxWorkbook: Story = {
  args: { path: '/tmp/revenue.xlsx', bytes: sampleXlsx() },
};

// The mock composer retains the actual File so browser acceptance can decode its pixels.
const acceptSelection = fn((selection: DocumentSelection) => {
  (window as Window & { documentSelection?: DocumentSelection }).documentSelection = selection;
  return true;
});
export const PdfSelection: Story = {
  args: { ...PdfDocument.args, onAddSelectionToChat: acceptSelection },
};
export const DocxSelection: Story = {
  args: { ...DocxDocument.args, onAddSelectionToChat: acceptSelection },
};
export const XlsxSelection: Story = {
  args: { ...XlsxWorkbook.args, onAddSelectionToChat: acceptSelection },
};
export const PptxSelection: Story = {
  args: { path: '/tmp/slides.pptx', bytes: samplePptx(), onAddSelectionToChat: acceptSelection },
};

function AttachedImageMarkupStory({ file }: { file: File }) {
  const [open, setOpen] = useState(true);
  return open ? (
    <PendingImageMarkupDialog
      file={file}
      onClose={() => setOpen(false)}
      onAdd={(selection) => {
        acceptSelection(selection);
        setOpen(false);
        return true;
      }}
    />
  ) : null;
}
export const AttachedImageMarkup: Story = {
  args: { path: 'screenshot.png' },
  loaders: [
    async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 800;
      canvas.height = 400;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#fff';
      context.fillRect(0, 0, 800, 400);
      context.fillStyle = '#2563eb';
      context.fillRect(40, 40, 720, 100);
      context.fillStyle = '#111';
      context.font = '28px sans-serif';
      context.fillText('Synthetic screenshot', 40, 210);
      const blob = await new Promise<Blob>((resolve) =>
        canvas.toBlob((value) => resolve(value!), 'image/png')
      );
      return { file: new File([blob], 'screenshot.png', { type: 'image/png' }) };
    },
  ],
  render: (_args, { loaded }) => <AttachedImageMarkupStory file={loaded.file} />,
};

function PreviousXlsxFallback() {
  const { t } = useTranslation();
  return (
    <SessionFileNoticeCard
      presentation={{
        title: t('sessions.fileDiff.binary.title', 'Binary file'),
        description: t(
          'sessions.fileViewer.binary.message',
          'This binary file cannot be previewed.'
        ),
      }}
    />
  );
}

export const XlsxPreviousFallback: Story = {
  args: { path: '/tmp/revenue.xlsx', bytes: sampleXlsx() },
  render: () => <PreviousXlsxFallback />,
};

export const InactiveXlsxWorkbook: Story = {
  args: { path: '/tmp/revenue.xlsx', bytes: sampleXlsx(), active: false },
};

export const PptxPresentation: Story = {
  args: { path: '/tmp/quarterly-report.pptx', bytes: samplePptx() },
};

// Synthetic 160x90 VP8 color pattern; no captured user media.
export const WebmVideo: Story = {
  args: { path: 'clip.webm' },
  loaders: [
    async () => ({
      bytes: new Uint8Array(
        await (
          await fetch(new URL('./fixtures/video-preview.webm', import.meta.url).href)
        ).arrayBuffer()
      ),
    }),
  ],
  render: (args, { loaded }) => <SessionFileBinaryPreview {...args} bytes={loaded.bytes} />,
};

export const UnsupportedVideo: Story = {
  args: {
    path: 'broken.webm',
    bytes: Uint8Array.of(1, 2, 3),
    fileActions: { onCopyPath: fn(), onShare: fn() },
  },
};

export const InactiveVideo: Story = {
  args: { path: 'clip.webm', bytes: Uint8Array.of(1), active: false },
};

export const UnsupportedAudio: Story = {
  args: {
    path: 'broken.wav',
    bytes: Uint8Array.of(1, 2, 3),
    fileActions: { onCopyPath: fn(), onDownload: fn() },
  },
};

export const InactiveAudio: Story = {
  args: { path: 'recordings/tone.wav', bytes: createSampleWav(), active: false },
};

/** Only the member resource response is mocked; both the player and attachment card are real. */
function ChatMediaStory({ path, bytes }: { path: string; bytes: Uint8Array }) {
  const [ready, setReady] = useState(false);
  const mimeType = getAudioMimeTypeForPath(path) ?? getVideoMimeTypeForPath(path) ?? '';
  useEffect(() => {
    const previous = window.ipc;
    const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: mimeType }));
    window.ipc = {
      invoke: async () => ({ ok: true, url, sizeBytes: bytes.length }),
      on: () => () => {},
      send: () => {},
    };
    setReady(true);
    return () => {
      window.ipc = previous;
      URL.revokeObjectURL(url);
    };
  }, [bytes, mimeType]);
  const file: SessionFilePayload = {
    type: 'file',
    fileId: path,
    fileName: path,
    mimeType,
    sizeBytes: bytes.length,
    sha256: 'a'.repeat(64),
    textPreview: false,
    transport: 'local',
    machineId: 'devnuc',
    uploadedAt: 1,
  };
  return ready ? (
    <SessionFileCardList>
      <SessionKeptMediaFile
        file={file}
        workspaceId="story-workspace"
        sessionId="story-session"
        renderCard={(media) => (
          <SessionFileCard
            media={media}
            file={file}
            uploads={false}
            pendingMachineName="devnuc"
            onDownload={fn()}
          />
        )}
      />
    </SessionFileCardList>
  ) : null;
}

export const ChatVideo: Story = {
  ...WebmVideo,
  render: (args, { loaded }) => <ChatMediaStory path={args.path} bytes={loaded.bytes} />,
};

export const ChatAudio: Story = {
  args: { path: 'recording.wav', bytes: createSampleWav() },
  render: (args) => <ChatMediaStory path={args.path} bytes={args.bytes!} />,
};

export const ChatAudioError: Story = {
  args: { path: 'broken.wav', bytes: Uint8Array.of(1, 2, 3) },
  render: (args) => <ChatMediaStory path={args.path} bytes={args.bytes!} />,
};

export const ChatAudioDark: Story = {
  ...ChatAudio,
  globals: { theme: 'dark' },
};
