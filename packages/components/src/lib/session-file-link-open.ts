import type { SessionMeta } from '@lody/shared';
import type { WorkspaceRuntime } from '@/atoms/runtime';
import type { SessionFileProvider } from './session-file-provider';
import {
  resolveSessionFileOpenTarget,
  type SessionFileOpenPathKind,
} from './session-file-open-target';
import {
  resolveMissingFileLink,
  classifyFileLinkProbe,
  type FileLinkContext,
} from './session-file-link-fallback';
import {
  resolveSessionFileProviderOpenPath,
  type SessionFileProviderOpenPathResolution,
} from './session-file-provider-symlink';

export type SessionFileOpenContext = {
  session: SessionMeta | null;
  workspacePath: string | null;
  preserveWorktreePath: boolean;
  fileProvider: SessionFileProvider | null;
};

const FILE_LINK_PROBE_TIMEOUT_MS = 2_500;

export type SessionDetailOpenFileOptions = {
  /** Analytics only. */
  readonly source?:
    | 'file_tree'
    | 'conversation_file_diff'
    | 'lsp'
    | 'diff_header'
    | 'html_attachment';
  /** Defaults to `markdown-href`; see `lib/session-file-open-target.ts`. */
  readonly pathKind?: SessionFileOpenPathKind;
  /** Explicit 1-based anchor, for callers that have one without encoding it in the path. */
  readonly startLine?: number;
  readonly endLine?: number;
  /** Enter rendered HTML after the file snapshot becomes available. */
  readonly previewHtml?: boolean;
  /**
   * The conversation a chat link was clicked in. Lets a relative link the
   * machine cannot find be looked up where the conversation says the file is;
   * see `lib/session-file-link-fallback.ts`.
   */
  readonly linkContext?: () => FileLinkContext;
};

/** Shared by the active conversation and Board panel threads. */
export async function resolveSessionFileLinkOpen(
  filePath: string,
  options: SessionDetailOpenFileOptions,
  context: SessionFileOpenContext,
  runtime: WorkspaceRuntime | null
) {
  // Where the path came from decides whether it may be rewritten at all;
  // `resolveSessionFileOpenTarget` owns that rule and documents why.
  const target = resolveSessionFileOpenTarget({
    rawPath: filePath,
    pathKind: options.pathKind ?? 'markdown-href',
    workspacePath: context.workspacePath,
    preserveWorktreePath: context.preserveWorktreePath,
    ...(options.startLine === undefined ? {} : { startLine: options.startLine }),
    ...(options.endLine === undefined ? {} : { endLine: options.endLine }),
  });
  const linkSession = context.session;
  const linkMachineId = linkSession?.machineId;
  // A path the index already lists exists; only an unlisted one is asked about.
  const linkIsIndexed =
    (await context.fileProvider?.getFile(target.filePath).catch(() => null)) != null;
  const openPath =
    options.linkContext && runtime && linkSession && linkMachineId && !linkIsIndexed
      ? await resolveMissingFileLink({
          path: target.filePath,
          context: options.linkContext,
          // One byte is enough to learn whether the path exists, and a
          // machine that does not answer must not hold the viewer back.
          probe: async (path) =>
            classifyFileLinkProbe(
              await runtime.requestFilePreview(
                linkMachineId,
                { sessionId: linkSession.id, path, maxBytes: 1 },
                {
                  ownerSessionId: linkSession.parentSessionId ?? linkSession.id,
                  timeoutMs: FILE_LINK_PROBE_TIMEOUT_MS,
                }
              )
            ),
        })
      : target.filePath;
  const resolution = await resolveSessionFileProviderOpenPath(context.fileProvider, openPath).catch(
    (): SessionFileProviderOpenPathResolution => ({
      path: openPath,
      redirected: false,
    })
  );
  const resolvedFilePath = resolution.path;

  return { ...target, ...resolution, filePath: resolvedFilePath };
}
