import * as stylex from '@stylexjs/stylex';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { buildLodyWidgetShellHtml, type LodyWidgetHostMessage } from '@lody/shared';
import { useResolvedTheme } from '@/theme-provider';
import { createWidgetBridge, readWidgetThemeVars } from '../agent-surfaces/widget-bridge';
import {
  loadWidgetHostSource,
  WidgetLinkDialog,
  type WidgetHostSource,
} from '../agent-surfaces/widget-frame';

const styles = stylex.create({
  frame: { display: 'block', width: '100%', height: '100%', borderWidth: 0 },
  note: { padding: '16px', fontSize: '12px', color: colors.secondaryLabel },
});

/*
 * Posted ahead of the article. The widget page is sized to its content and
 * already loaded when the article arrives, so the article scrolls in the
 * page itself, and its load handlers run as soon as its scripts do.
 */
const ARTICLE_PRELUDE =
  '<style>html,body{height:100%;overflow:auto!important}</style>' +
  '<script>(function(){[window,document].forEach(function(t){var add=t.addEventListener;' +
  "t.addEventListener=function(type,fn,o){if(type==='DOMContentLoaded'||type==='load'){" +
  "setTimeout(function(){var e=new Event(type);typeof fn==='function'?fn.call(t,e):fn&&fn.handleEvent&&fn.handleEvent(e);});return;}" +
  'return add.call(this,type,fn,o);};});})();</script>';

/**
 * A thread's HTML article beside its conversation. It runs in the widget page
 * (the desktop serves it from its own loopback origin): the same sandboxed,
 * opaque-origin frame and the same CDN-only policy as a widget, plus the app's
 * theme variables. A `srcdoc` frame would inherit the app's own policy, which
 * runs neither inline scripts nor CDN code. The page is posted once; a new
 * revision of the file remounts this component.
 */
export function ArticleHtmlFrame({ html, title }: { html: string; title: string }) {
  const { t } = useTranslation();
  const resolvedTheme = useResolvedTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [source, setSource] = useState<WidgetHostSource | null>(null);
  const [pendingLink, setPendingLink] = useState<string | null>(null);
  const readyRef = useRef(false);
  const latest = useRef({ html, resolvedTheme });
  latest.current = { html, resolvedTheme };

  useEffect(() => {
    let cancelled = false;
    void loadWidgetHostSource().then((next) => {
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
          code: ARTICLE_PRELUDE + latest.current.html,
          mode: latest.current.resolvedTheme,
          vars: readWidgetThemeVars(),
        });
      },
      onHeight: () => undefined,
      // An article is read, not a control surface: it cannot speak for the user.
      onPrompt: () => undefined,
      takeUserClick: async () => false,
      onLink: setPendingLink,
    });
    const onMessage = (event: MessageEvent) => {
      bridge.handle(event);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [source]);

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
      <div {...stylex.props(styles.note)}>
        {t('agentSurfaces.widget.unavailable', 'This widget cannot be shown here.')}
      </div>
    );
  }
  return (
    <>
      {source ? (
        <iframe
          ref={frameRef}
          title={title}
          sandbox="allow-scripts"
          // Requests the page makes carry no cookies or credentials of the app.
          {...{ credentialless: '' }}
          referrerPolicy="no-referrer"
          {...(source.kind === 'url' ? { src: source.url } : { srcDoc })}
          {...stylex.props(styles.frame)}
          style={{ colorScheme: resolvedTheme }}
        />
      ) : null}
      <WidgetLinkDialog url={pendingLink} onClose={() => setPendingLink(null)} />
    </>
  );
}
