import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import {
  getSessionRoomId,
  splitAgentTextWidgets,
  type AgentTextWidgetEmbed,
  type MachineId,
  type SessionId,
} from '@lody/shared';
import { sessionMetaAtomFamily } from '@/atoms/doc-meta';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { inlineWidgetFeatureEnabledAtom } from '@/atoms/settings';
import { WidgetFrame } from './widget-frame';

const styles = stylex.create({
  note: { fontSize: '12px', color: colors.secondaryLabel, overflowWrap: 'anywhere' },
});

/** Widget files are pages, not documents: refuse anything larger. */
const WIDGET_FILE_MAX_BYTES = 512 * 1024;

/**
 * Assistant reply text, with file widgets other agents reference from it:
 * Codex's `visualize{...}` line and Antigravity's `<agent-embed>` tag. While
 * the experiment is off, or the reply is still streaming, the text renders
 * exactly as written.
 */
export function AgentTextWidgets({
  text,
  sessionId,
  isStreaming,
  renderText,
}: {
  text: string;
  sessionId: SessionId;
  isStreaming?: boolean;
  /** Renders a text run; `whole` is true when the reply has no widget. */
  renderText: (text: string, whole: boolean) => ReactNode;
}) {
  const enabled = useAtomValue(inlineWidgetFeatureEnabledAtom);
  const segments = useMemo(
    () => (enabled && !isStreaming ? splitAgentTextWidgets(text) : null),
    [enabled, isStreaming, text]
  );
  if (!segments || (segments.length === 1 && segments[0]?.type === 'text')) {
    return <>{renderText(text, true)}</>;
  }
  return (
    <>
      {segments.map((segment, index) =>
        segment.type === 'text' ? (
          <Fragment key={index}>{renderText(segment.text, false)}</Fragment>
        ) : (
          <FileWidget key={index} sessionId={sessionId} embed={segment.embed} />
        )
      )}
    </>
  );
}

type FileState =
  | { status: 'loading' }
  | { status: 'ready'; code: string }
  | { status: 'failed'; reason: 'outside' | 'unreadable' | 'too_large' };

/**
 * A widget file on the machine that ran the agent, possibly another LAN
 * member, read through the session's own file preview: only files in the
 * session's workspace are shown.
 */
function FileWidget({ sessionId, embed }: { sessionId: SessionId; embed: AgentTextWidgetEmbed }) {
  const { t } = useTranslation();
  const state = useWidgetFile(sessionId, embed.path);
  const name = embed.title ?? embed.path.split(/[\\/]/).at(-1) ?? embed.path;
  if (state.status === 'ready') return <WidgetFrame code={state.code} title={name} />;
  if (state.status === 'loading') {
    return (
      <span role="status" {...stylex.props(styles.note)}>
        {t('agentSurfaces.widget.loading', 'Loading {{name}}…', { name })}
      </span>
    );
  }
  return (
    <span {...stylex.props(styles.note)}>
      {state.reason === 'outside'
        ? t(
            'agentSurfaces.widget.outsideWorkspace',
            '{{name}} is outside this session’s folder, so it is not shown.',
            { name }
          )
        : state.reason === 'too_large'
          ? t('agentSurfaces.widget.tooLarge', '{{name}} is too large to show.', { name })
          : t('agentSurfaces.widget.unreadable', '{{name}} could not be read.', { name })}
    </span>
  );
}

function useWidgetFile(sessionId: SessionId, path: string): FileState {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const meta = useAtomValue(sessionMetaAtomFamily(getSessionRoomId(sessionId)));
  const machineId = meta?.machineId as MachineId | undefined;
  // A child tab's files belong to its parent's workspace.
  const ownerSessionId = meta?.parentSessionId ?? sessionId;
  const [state, setState] = useState<FileState>({ status: 'loading' });

  useEffect(() => {
    if (!runtime) {
      // Shared presentations have no machine to read from.
      setState({ status: 'failed', reason: 'unreadable' });
      return undefined;
    }
    if (!machineId) return undefined;
    let cancelled = false;
    setState({ status: 'loading' });
    void (async () => {
      const finish = (next: FileState) => {
        if (!cancelled) setState(next);
      };
      try {
        const result = await runtime.requestFilePreview(
          machineId,
          { sessionId, path, maxBytes: WIDGET_FILE_MAX_BYTES },
          { ownerSessionId }
        );
        // `external` is any path outside the session's workspace, including
        // the temporary folders the preview otherwise allows.
        if (result.status !== 'error' && 'external' in result && result.external === true) {
          return finish({ status: 'failed', reason: 'outside' });
        }
        if (result.status === 'error') {
          return finish({
            status: 'failed',
            reason:
              result.code === 'path_not_allowed'
                ? 'outside'
                : result.code === 'too_large'
                  ? 'too_large'
                  : 'unreadable',
          });
        }
        if (result.status === 'resource') {
          return finish({ status: 'failed', reason: 'too_large' });
        }
        if (result.status !== 'ok' || result.kind !== 'text') {
          return finish({ status: 'failed', reason: 'unreadable' });
        }
        const content = result.content;
        if (content.encoding === 'utf8-plain') {
          return finish({ status: 'ready', code: content.text });
        }
        if (content.encoding === 'utf8-gzip-base64') {
          const bytes = Uint8Array.from(atob(content.data), (char) => char.charCodeAt(0));
          const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
          return finish({ status: 'ready', code: await new Response(stream).text() });
        }
        return finish({ status: 'failed', reason: 'unreadable' });
      } catch {
        finish({ status: 'failed', reason: 'unreadable' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [machineId, ownerSessionId, path, runtime, sessionId]);

  return state;
}
