import * as stylex from '@stylexjs/stylex';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { buildLodyWidgetShellHtml, type LodyWidgetHostMessage } from '@lody/shared';
import { useAtomValue } from 'jotai';
import { conversationFontSizeAtom } from '@/atoms';
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
 * Posted around the article. The widget page is sized to its content and
 * already loaded when the article arrives, so the article scrolls in the page
 * itself. Its text starts at the conversation's size rather than the widget
 * page's 15px; whatever size the article sets for itself still wins, since it
 * comes after this. The page runs the article's scripts one by one, waiting for each CDN
 * script, so its `DOMContentLoaded`/`load` handlers are held until the last
 * script has run, then called in that order (`onload` too).
 */
const ARTICLE_PRELUDE =
  '<style>html,body{height:100%;overflow:auto!important}' +
  'body{font-size:var(--lody-article-font-size)}</style>' +
  '<script>(function(){var ready={DOMContentLoaded:[],load:[]},done=false;' +
  "function call(t,type,fn){var e=new Event(type);typeof fn==='function'?fn.call(t,e):fn&&fn.handleEvent&&fn.handleEvent(e);}" +
  '[window,document].forEach(function(t){var add=t.addEventListener;' +
  't.addEventListener=function(type,fn,o){if(ready[type]){' +
  'if(done)setTimeout(function(){call(t,type,fn);});else ready[type].push([t,fn]);return;}' +
  'return add.call(this,type,fn,o);};});' +
  'window.__lodyArticleReady=function(){if(done)return;done=true;' +
  "['DOMContentLoaded','load'].forEach(function(type){ready[type].forEach(function(e){call(e[0],type,e[1]);});});" +
  "if(typeof window.onload==='function')call(window,'load',window.onload);};})();</script>";
const ARTICLE_EPILOGUE = '<script>window.__lodyArticleReady&&window.__lodyArticleReady();</script>';

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
  const fontSize = useAtomValue(conversationFontSizeAtom);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [source, setSource] = useState<WidgetHostSource | null>(null);
  const [pendingLink, setPendingLink] = useState<string | null>(null);
  const readyRef = useRef(false);
  const latest = useRef({ html, resolvedTheme, fontSize });
  latest.current = { html, resolvedTheme, fontSize };
  // The widget page's theme variables plus the article's base size; a theme
  // message updates both without reloading the article.
  const themeVars = (size: number) => ({
    ...readWidgetThemeVars(),
    '--lody-article-font-size': `${size}px`,
  });

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
          code: ARTICLE_PRELUDE + latest.current.html + ARTICLE_EPILOGUE,
          mode: latest.current.resolvedTheme,
          vars: themeVars(latest.current.fontSize),
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
    post({ type: 'lody-widget:theme', mode: resolvedTheme, vars: themeVars(fontSize) });
  }, [fontSize, resolvedTheme]);

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
