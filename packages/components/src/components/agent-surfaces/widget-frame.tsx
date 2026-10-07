import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { AlertDialog } from '@lody/ui/alert-dialog';
import { Button } from '@lody/ui/button';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { buildLodyWidgetShellHtml, type LodyWidgetHostMessage } from '@lody/shared';
import { isElectronRenderer } from '@/lib/electron';
import { getIpcServices } from '@/lib/electron-ipc-client';
import { openExternalUrl } from '@/lib/native-browser';
import { useResolvedTheme } from '@/theme-provider';
import {
  AgentSurfaceTurnContext,
  useAgentSurfaceActions,
  widgetPromptKey,
} from './agent-surface-context';
import { createWidgetBridge, readWidgetThemeVars, WIDGET_MAX_HEIGHT_PX } from './widget-bridge';
import { isUserGestureInFrame } from './widget-gesture';

const styles = stylex.create({
  root: { display: 'block', width: '100%', minWidth: 0 },
  frame: {
    display: 'block',
    width: '100%',
    borderWidth: 0,
    backgroundColor: 'transparent',
  },
  note: { fontSize: '12px', color: colors.secondaryLabel },
  url: { overflowWrap: 'anywhere', fontFamily: 'ui-monospace, monospace', fontSize: '12px' },
});

type HostSource = { kind: 'url'; url: string } | { kind: 'srcdoc' } | { kind: 'unavailable' };

let hostSource: Promise<HostSource> | null = null;

/**
 * Where widgets are framed from. The desktop serves the page from its own
 * loopback origin (`apps/electron/src/main/services/widget-host.ts`). Other
 * builds (the web app, Storybook) frame the same page through `srcdoc`, where
 * it also inherits the host page's policy.
 */
const loadHostSource = (): Promise<HostSource> => {
  const ipc = isElectronRenderer() ? getIpcServices() : null;
  hostSource ??= ipc
    ? ipc.widgets.getHostUrl().then(
        (url): HostSource => ({ kind: 'url', url }),
        (): HostSource => {
          hostSource = null;
          return { kind: 'unavailable' };
        }
      )
    : Promise.resolve({ kind: 'srcdoc' });
  return hostSource;
};

const INITIAL_HEIGHT_PX = 160;

/**
 * One widget, isolated: a sandboxed frame (`allow-scripts` only, so an
 * opaque origin) under the widget page's own policy. The bridge takes
 * messages only from this frame, asks a question only right after the user
 * clicked into it, and asks before any link leaves the app.
 */
export function WidgetFrame({ code, title }: { code: string; title: string }) {
  const { t } = useTranslation();
  const actions = useAgentSurfaceActions();
  const turnId = useContext(AgentSurfaceTurnContext);
  const resolvedTheme = useResolvedTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [source, setSource] = useState<HostSource | null>(null);
  const [height, setHeight] = useState(INITIAL_HEIGHT_PX);
  const [pendingLink, setPendingLink] = useState<string | null>(null);
  const readyRef = useRef(false);
  const latest = useRef({ code, resolvedTheme, turnId, send: actions?.sendWidgetPrompt });
  latest.current = { code, resolvedTheme, turnId, send: actions?.sendWidgetPrompt };

  useEffect(() => {
    let cancelled = false;
    void loadHostSource().then((next) => {
      if (!cancelled) setSource(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const post = (message: LodyWidgetHostMessage) =>
    frameRef.current?.contentWindow?.postMessage(message, '*');

  useEffect(() => {
    readyRef.current = false;
    const bridge = createWidgetBridge({
      frameWindow: () => frameRef.current?.contentWindow,
      onReady: () => {
        readyRef.current = true;
        post({
          type: 'lody-widget:render',
          code: latest.current.code,
          mode: latest.current.resolvedTheme,
          vars: readWidgetThemeVars(),
        });
      },
      onHeight: setHeight,
      onPrompt: (text) =>
        latest.current.send?.({
          text,
          turnId: latest.current.turnId,
          key: widgetPromptKey(latest.current.code, text),
        }),
      isUserGesture: () => !!frameRef.current && isUserGestureInFrame(frameRef.current),
      onLink: setPendingLink,
    });
    const onMessage = (event: MessageEvent) => {
      bridge.handle(event);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [source]);

  // The page follows the app between light and dark without reloading.
  useEffect(() => {
    if (!readyRef.current) return;
    post({ type: 'lody-widget:theme', mode: resolvedTheme, vars: readWidgetThemeVars() });
  }, [resolvedTheme]);

  const srcDoc = useMemo(
    () => (source?.kind === 'srcdoc' ? buildLodyWidgetShellHtml() : undefined),
    [source]
  );

  if (source?.kind === 'unavailable') {
    return (
      <span {...stylex.props(styles.note)}>
        {t('agentSurfaces.widget.unavailable', 'This widget cannot be shown here.')}
      </span>
    );
  }

  return (
    <div data-agent-widget {...stylex.props(styles.root)}>
      {source ? (
        <iframe
          ref={frameRef}
          title={title}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          {...(source.kind === 'url' ? { src: source.url } : { srcDoc })}
          {...stylex.props(styles.frame)}
          // The same scheme as the page inside, or the browser paints the frame opaque.
          style={{ height, maxHeight: WIDGET_MAX_HEIGHT_PX, colorScheme: resolvedTheme }}
        />
      ) : null}
      <AlertDialog.Root
        open={pendingLink !== null}
        onOpenChange={(open) => {
          if (!open) setPendingLink(null);
        }}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>
              {t('agentSurfaces.widget.openLinkTitle', 'Open this link?')}
            </AlertDialog.Title>
            <AlertDialog.Description>
              <span {...stylex.props(styles.url)}>{pendingLink}</span>
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Close render={<Button variant="secondary" />}>
              {t('common.cancel', 'Cancel')}
            </AlertDialog.Close>
            <AlertDialog.Close
              render={
                <Button
                  variant="primary"
                  onClick={() => {
                    if (pendingLink) void openExternalUrl(pendingLink);
                  }}
                />
              }
            >
              {t('agentSurfaces.widget.openLink', 'Open')}
            </AlertDialog.Close>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </div>
  );
}
