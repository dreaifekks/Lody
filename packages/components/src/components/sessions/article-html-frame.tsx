import * as stylex from '@stylexjs/stylex';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TriangleAlert } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { buildLodyWidgetShellHtml, type LodyWidgetHostMessage, type SessionId } from '@lody/shared';
import { useAtomValue } from 'jotai';
import { conversationFontSizeAtom } from '@/atoms';
import { useResolvedTheme } from '@/theme-provider';
import { createWidgetBridge, readWidgetThemeVars } from '../agent-surfaces/widget-bridge';
import {
  loadWidgetHostSource,
  WidgetLinkDialog,
  type WidgetHostSource,
} from '../agent-surfaces/widget-frame';
import { useArticleAnnotationActions } from '../boards/article-annotations';

const styles = stylex.create({
  root: { display: 'flex', flexDirection: 'column', width: '100%', height: '100%' },
  frame: { display: 'block', width: '100%', flex: '1 1 auto', minHeight: 0, borderWidth: 0 },
  note: { padding: '16px', fontSize: '12px', color: colors.secondaryLabel },
  errors: {
    flexShrink: 0,
    maxHeight: '40%',
    overflowY: 'auto',
    paddingBlock: '6px',
    paddingInline: '12px 8px',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.separator,
    fontSize: '0.75rem',
  },
  errorsHead: { display: 'flex', alignItems: 'center', gap: '6px', color: colors.warning },
  errorsTitle: { flex: '1 1 auto', cursor: 'pointer' },
  errorList: {
    margin: 0,
    paddingTop: '4px',
    paddingLeft: '18px',
    color: colors.secondaryLabel,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    overflowWrap: 'anywhere',
  },
});

/** A page that keeps failing reports this many at most. */
const MAX_PAGE_ERRORS = 20;
const MAX_PAGE_ERROR_CHARS = 300;

/**
 * The reader's settings in each HTML article, by article: the frame reports
 * them as they change and gets them back when the agent's next revision
 * replaces the page. Kept while the app runs.
 */
const savedPageStates = new Map<string, unknown>();

/*
 * Around the page's own code, after the ready handlers: carries the reader's
 * controls, open `<details>` and scroll over to the new revision, and reports
 * uncaught errors, rejections and files that fail to load. Controls match by
 * `id`, then `name` (a radio by its value too), then position; each restored
 * control fires `input` and `change`, so the page renders from them.
 */
const articleStateScript = (saved: unknown): string =>
  '<script>(function(){var saved=' +
  JSON.stringify(saved ?? null).replace(/</g, '\\u003c') +
  ';function all(s){return Array.prototype.slice.call(document.querySelectorAll(s));}' +
  "function key(el,i){return el.id?'#'+el.id:el.name?'@'+el.name+(el.type==='radio'?'='+el.value:''):'%'+i;}" +
  "function snapshot(){var c={};all('input,select,textarea').forEach(function(el,i){" +
  "if(el.type==='checkbox'||el.type==='radio')c[key(el,i)]={checked:el.checked};" +
  "else if(el.type!=='file'&&el.type!=='password')c[key(el,i)]={value:el.value};});" +
  "return{controls:c,details:all('details').map(function(d){return d.open;})," +
  'scroll:[document.documentElement.scrollTop,document.body.scrollTop]};}' +
  "var timer;function report(){clearTimeout(timer);timer=setTimeout(function(){parent.postMessage({type:'lody-article:state',state:snapshot()},'*');},200);}" +
  "['input','change','toggle','scroll'].forEach(function(t){document.addEventListener(t,report,true);});" +
  "function fail(m){parent.postMessage({type:'lody-article:error',message:String(m)},'*');}" +
  "window.addEventListener('error',function(e){var t=e.target;" +
  "if(t&&t!==window&&(t.src||t.href))fail('Failed to load '+(t.src||t.href));" +
  "else fail(e.message+(e.lineno?' (line '+e.lineno+')':''));},true);" +
  "window.addEventListener('unhandledrejection',function(e){var r=e.reason;fail('Unhandled rejection: '+(r&&r.message||r));});" +
  'window.__lodyArticleRestore=function(){if(!saved)return;' +
  "all('input,select,textarea').forEach(function(el,i){var v=saved.controls[key(el,i)];if(!v)return;" +
  "if('checked' in v)el.checked=v.checked;else el.value=v.value;" +
  "el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));});" +
  "all('details').forEach(function(d,i){if(saved.details[i]!==undefined)d.open=saved.details[i];});" +
  'document.documentElement.scrollTop=saved.scroll[0];document.body.scrollTop=saved.scroll[1];};' +
  '})();</script>';

/*
 * Posted around the article. The widget page is sized to its content and
 * already loaded when the article arrives, so the article scrolls in the page
 * itself. Its text starts at the conversation's size rather than the widget
 * page's 15px; whatever size the article sets for itself still wins, since it
 * comes after this. The page runs the article's scripts one by one, waiting for each CDN
 * script, so its `DOMContentLoaded`/`load` handlers are held until the last
 * script has run, then called in that order (`onload` too); it returns their
 * settling, so the reader's settings come back after async handlers finish.
 */
const ARTICLE_PRELUDE =
  '<style>html,body{height:100%;overflow:auto!important}' +
  'body{font-size:var(--lody-article-font-size)}</style>' +
  '<script>(function(){var ready={DOMContentLoaded:[],load:[]},done=false;' +
  "function call(t,type,fn){var e=new Event(type);return typeof fn==='function'?fn.call(t,e):fn&&fn.handleEvent&&fn.handleEvent(e);}" +
  '[window,document].forEach(function(t){var add=t.addEventListener;' +
  't.addEventListener=function(type,fn,o){if(ready[type]){' +
  'if(done)setTimeout(function(){call(t,type,fn);});else ready[type].push([t,fn]);return;}' +
  'return add.call(this,type,fn,o);};});' +
  'window.__lodyArticleReady=function(){if(done)return;done=true;var pending=[];' +
  "['DOMContentLoaded','load'].forEach(function(type){ready[type].forEach(function(e){pending.push(call(e[0],type,e[1]));});});" +
  "if(typeof window.onload==='function')pending.push(call(window,'load',window.onload));" +
  'return Promise.all(pending);};})();</script>';
// Restores once the ready handlers have settled, async ones included.
const ARTICLE_EPILOGUE =
  '<script>Promise.resolve(window.__lodyArticleReady&&window.__lodyArticleReady())' +
  '.then(function(){window.__lodyArticleRestore&&window.__lodyArticleRestore();});</script>';

/**
 * A thread's HTML article beside its conversation. It runs in the widget page
 * (the desktop serves it from its own loopback origin): the same sandboxed,
 * opaque-origin frame and the same CDN-only policy as a widget, plus the app's
 * theme variables. A `srcdoc` frame would inherit the app's own policy, which
 * runs neither inline scripts nor CDN code. The page is posted once; a new
 * revision of the file remounts this component, and the reader's settings
 * carry over (`stateKey`). Errors the page reports show under it, and can go
 * to the thread beside it with its next message (`comments`).
 */
export function ArticleHtmlFrame({
  html,
  title,
  stateKey,
  comments,
}: {
  html: string;
  title: string;
  /** The article, whose settings a new revision gets back. */
  stateKey: string;
  /** Where page errors go as comments, or null when there is no thread beside it. */
  comments: {
    readonly threadId: SessionId;
    readonly ownerThreadId: SessionId;
    readonly path: string;
  } | null;
}) {
  const { t } = useTranslation();
  const [errors, setErrors] = useState<readonly string[]>([]);
  const [errorsAttached, setErrorsAttached] = useState(0);
  const { add } = useArticleAnnotationActions();
  const resolvedTheme = useResolvedTheme();
  const fontSize = useAtomValue(conversationFontSizeAtom);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [source, setSource] = useState<WidgetHostSource | null>(null);
  const [pendingLink, setPendingLink] = useState<string | null>(null);
  const readyRef = useRef(false);
  const latest = useRef({ html, resolvedTheme, fontSize, stateKey });
  latest.current = { html, resolvedTheme, fontSize, stateKey };
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
          code:
            ARTICLE_PRELUDE +
            articleStateScript(savedPageStates.get(latest.current.stateKey)) +
            latest.current.html +
            ARTICLE_EPILOGUE,
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
      if (bridge.handle(event) || event.source !== frameRef.current?.contentWindow) return;
      const data: unknown = event.data;
      if (typeof data !== 'object' || data === null) return;
      const message = data as { type?: unknown; state?: unknown; message?: unknown };
      if (message.type === 'lody-article:state')
        savedPageStates.set(latest.current.stateKey, message.state);
      if (message.type === 'lody-article:error' && typeof message.message === 'string') {
        const text = message.message.slice(0, MAX_PAGE_ERROR_CHARS);
        setErrors((current) =>
          current.length >= MAX_PAGE_ERRORS || current.includes(text) ? current : [...current, text]
        );
      }
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
  const attachErrors = () => {
    if (!comments) return;
    add({
      ...comments,
      quote: errors.join('\n'),
      comment: t('sessions.article.pageErrors.comment', 'The page reported these errors.'),
      block: { index: -1, text: '' },
    });
    setErrorsAttached(errors.length);
  };
  return (
    <div {...stylex.props(styles.root)}>
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
      {errors.length > 0 ? (
        <details {...stylex.props(styles.errors)} data-article-page-errors>
          <summary {...stylex.props(styles.errorsHead)}>
            <TriangleAlert size={14} aria-hidden />
            <span {...stylex.props(styles.errorsTitle)}>
              {t('sessions.article.pageErrors.count', 'The page reported {{count}} errors', {
                count: errors.length,
              })}
            </span>
            {comments ? (
              <Button
                size="mini"
                variant="ghost"
                disabled={errorsAttached === errors.length}
                onClick={(event) => {
                  event.preventDefault();
                  attachErrors();
                }}
              >
                {errorsAttached === errors.length
                  ? t('sessions.article.pageErrors.attached', 'Goes with the next message')
                  : t('sessions.article.pageErrors.attach', 'Add to the next message')}
              </Button>
            ) : null}
          </summary>
          <ol {...stylex.props(styles.errorList)}>
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ol>
        </details>
      ) : null}
      <WidgetLinkDialog url={pendingLink} onClose={() => setPendingLink(null)} />
    </div>
  );
}
