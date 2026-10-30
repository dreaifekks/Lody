import * as stylex from '@stylexjs/stylex';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { buildLodyWidgetShellHtml, type LodyWidgetHostMessage } from '@lody/shared';
import { createWidgetBridge } from '../agent-surfaces/widget-bridge';
import { loadWidgetHostSource, type WidgetHostSource } from '../agent-surfaces/widget-frame';
import {
  ARTICLE_EPILOGUE,
  ARTICLE_PRELUDE,
  articleStateScript,
  MAX_PAGE_ERROR_CHARS,
  savedPageStates,
} from '../sessions/article-html-frame';
import type { CompareSize } from './compare-manifest';

const styles = stylex.create({
  box: { position: 'relative', overflow: 'hidden', flexShrink: 0 },
  frame: {
    position: 'absolute',
    insetBlockStart: 0,
    insetInlineStart: 0,
    display: 'block',
    borderWidth: 0,
    transformOrigin: '0 0',
  },
  imageBox: { position: 'relative', overflowX: 'hidden', overflowY: 'auto', flexShrink: 0 },
  image: { display: 'block', width: '100%', height: 'auto' },
});

/** A spot the reader pointed at in an option's page, in the page's own CSS pixels. */
export interface ComparePick {
  readonly x: number;
  readonly y: number;
  /** The element there, briefly: tag, id or class, and its first words. */
  readonly label: string;
}

/** What the view asks of one option on screen. */
export interface CompareBoardControl {
  scrollTo: (top: number) => void;
  setPicking: (on: boolean) => void;
}

interface BoardProps {
  readonly title: string;
  /** The option's design size; the page lays out at it. */
  readonly size: CompareSize;
  readonly scale: number;
  readonly mode: 'light' | 'dark';
  readonly picking: boolean;
  readonly register: (control: CompareBoardControl | null) => void;
  /** `own` is false when the scroll followed another option. */
  readonly onScroll: (top: number, own: boolean) => void;
  readonly onPick: (pick: ComparePick) => void;
  /** Drawn over the board, given how far its page is scrolled. */
  readonly overlay: (scrollTop: number) => ReactNode;
}

/*
 * Runs in each option's page beside the article state script: reports its
 * scroll and follows another option's without echoing it; while the reader is
 * pointing, outlines the element under the pointer and reports a click as a
 * spot instead of letting the page act on it.
 */
const COMPARE_SCRIPT =
  '<style>html{background:#fff}[data-mode=dark]{background:#1e1e1e}' +
  '[data-lody-pick]{outline:2px solid #2f7de1!important;outline-offset:-2px!important;cursor:crosshair!important}</style>' +
  '<script>(function(){var H=document.documentElement,B=document.body,picking=false,quiet=false,hovered=null,raf=0;' +
  'function top(){return Math.max(H.scrollTop,B.scrollTop);}' +
  'function left(){return Math.max(H.scrollLeft,B.scrollLeft);}' +
  "function send(m){parent.postMessage(m,'*');}" +
  "document.addEventListener('scroll',function(){if(raf)return;raf=requestAnimationFrame(function(){raf=0;" +
  "send({type:'lody-compare:scroll',top:top(),own:!quiet});quiet=false;});},true);" +
  "function mark(el){if(hovered)hovered.removeAttribute('data-lody-pick');hovered=el;if(el)el.setAttribute('data-lody-pick','');}" +
  "document.addEventListener('mouseover',function(e){if(picking)mark(e.target===B||e.target===H?null:e.target);},true);" +
  'function describe(el){var tag=el.tagName.toLowerCase(),' +
  "name=(el.getAttribute('aria-label')||el.getAttribute('alt')||el.getAttribute('title')||el.innerText||el.textContent||'').trim().split('\\n')[0];" +
  "if(name.length>40)name=name.slice(0,40)+'\\u2026';" +
  "var cls=typeof el.className==='string'?el.className.trim().split(/\\s+/)[0]:'';" +
  "return tag+(el.id?'#'+el.id:cls?'.'+cls:'')+(name?' \\u201c'+name+'\\u201d':'');}" +
  "['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t){document.addEventListener(t,function(e){" +
  "if(!picking)return;e.preventDefault();e.stopImmediatePropagation();if(t!=='click')return;var el=e.target;" +
  "send({type:'lody-compare:pick',x:e.clientX+left(),y:e.clientY+top(),label:el&&el.tagName?describe(el):''});},true);});" +
  "window.addEventListener('message',function(e){if(e.source!==parent)return;var d=e.data;if(!d||typeof d!=='object')return;" +
  "if(d.type==='lody-compare:scroll-to'){var before=top();H.scrollTop=d.top;B.scrollTop=d.top;quiet=top()!==before;}" +
  "if(d.type==='lody-compare:picking'){picking=!!d.on;if(!picking)mark(null);}});" +
  '})();</script>';

/**
 * One HTML option of a comparison, laid out at its design width and shown
 * scaled: the widget page's sandboxed, CDN-only frame, as an HTML article
 * has. A new revision of the file remounts it with the reader's controls and
 * scroll carried over (`stateKey`). Links and prompts from the page go
 * nowhere: a design option speaks for nobody.
 */
export function CompareHtmlBoard({
  html,
  stateKey,
  onError,
  ...board
}: BoardProps & {
  readonly html: string;
  readonly stateKey: string;
  readonly onError: (message: string) => void;
}) {
  const { title, size, scale, mode, picking } = board;
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [source, setSource] = useState<WidgetHostSource | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const readyRef = useRef(false);
  const latest = useRef({ board, html, stateKey, onError });
  latest.current = { board, html, stateKey, onError };

  useEffect(() => {
    let cancelled = false;
    void loadWidgetHostSource().then((next) => {
      if (!cancelled) setSource(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const post = (
    message:
      | LodyWidgetHostMessage
      | { readonly type: 'lody-compare:picking'; readonly on: boolean }
      | { readonly type: 'lody-compare:scroll-to'; readonly top: number }
  ) => frameRef.current?.contentWindow?.postMessage(message, '*');

  useEffect(() => {
    readyRef.current = false;
    const bridge = createWidgetBridge({
      frameWindow: () => frameRef.current?.contentWindow,
      onReady: () => {
        readyRef.current = true;
        const current = latest.current;
        post({
          type: 'lody-widget:render',
          code:
            ARTICLE_PRELUDE +
            articleStateScript(savedPageStates.get(current.stateKey)) +
            COMPARE_SCRIPT +
            current.html +
            ARTICLE_EPILOGUE,
          mode: current.board.mode,
          vars: {},
        });
        post({ type: 'lody-compare:picking', on: current.board.picking });
      },
      onHeight: () => undefined,
      onPrompt: () => undefined,
      takeUserClick: async () => false,
      onLink: () => undefined,
    });
    const onMessage = (event: MessageEvent) => {
      if (bridge.handle(event) || event.source !== frameRef.current?.contentWindow) return;
      const data: unknown = event.data;
      if (typeof data !== 'object' || data === null) return;
      const message = data as Record<string, unknown>;
      const current = latest.current;
      if (message.type === 'lody-article:state')
        savedPageStates.set(current.stateKey, message.state);
      if (message.type === 'lody-article:error' && typeof message.message === 'string')
        current.onError(message.message.slice(0, MAX_PAGE_ERROR_CHARS));
      if (message.type === 'lody-compare:scroll' && typeof message.top === 'number') {
        setScrollTop(message.top);
        current.board.onScroll(message.top, message.own === true);
      }
      if (
        message.type === 'lody-compare:pick' &&
        typeof message.x === 'number' &&
        typeof message.y === 'number' &&
        typeof message.label === 'string'
      )
        current.board.onPick({ x: message.x, y: message.y, label: message.label.slice(0, 120) });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [source]);

  useEffect(() => {
    if (readyRef.current) post({ type: 'lody-widget:theme', mode, vars: {} });
  }, [mode]);
  useEffect(() => {
    if (readyRef.current) post({ type: 'lody-compare:picking', on: picking });
  }, [picking]);
  useEffect(() => {
    latest.current.board.register({
      scrollTo: (top) => post({ type: 'lody-compare:scroll-to', top }),
      setPicking: (on) => post({ type: 'lody-compare:picking', on }),
    });
    return () => latest.current.board.register(null);
  }, []);

  const srcDoc = useMemo(
    () => (source?.kind === 'srcdoc' ? buildLodyWidgetShellHtml() : undefined),
    [source]
  );
  return (
    <div
      {...stylex.props(styles.box)}
      style={{ width: size.width * scale, height: size.height * scale }}
      data-compare-board
    >
      {source && source.kind !== 'unavailable' ? (
        <iframe
          ref={frameRef}
          title={title}
          sandbox="allow-scripts"
          {...{ credentialless: '' }}
          referrerPolicy="no-referrer"
          {...(source.kind === 'url' ? { src: source.url } : { srcDoc })}
          {...stylex.props(styles.frame)}
          style={{
            width: size.width,
            height: size.height,
            transform: `scale(${scale})`,
            colorScheme: mode,
          }}
        />
      ) : null}
      {board.overlay(scrollTop)}
    </div>
  );
}

/**
 * A picture as an option (a screenshot, before and after): fitted to the
 * design width, scrolled within the design height, and pointed at directly.
 */
export function CompareImageBoard({ url, ...board }: BoardProps & { readonly url: string }) {
  const { title, size, scale, picking } = board;
  const boxRef = useRef<HTMLDivElement>(null);
  const quiet = useRef(false);
  const latest = useRef(board);
  latest.current = board;
  useEffect(() => {
    latest.current.register({
      scrollTo: (top) => {
        const box = boxRef.current!;
        const before = box.scrollTop;
        box.scrollTop = top * latest.current.scale;
        quiet.current = box.scrollTop !== before;
      },
      setPicking: () => undefined,
    });
    return () => latest.current.register(null);
  }, []);
  return (
    <div
      ref={boxRef}
      {...stylex.props(styles.imageBox)}
      style={{
        width: size.width * scale,
        height: size.height * scale,
        cursor: picking ? 'crosshair' : undefined,
      }}
      data-compare-board
      onScroll={(event) => {
        board.onScroll(event.currentTarget.scrollTop / scale, !quiet.current);
        quiet.current = false;
      }}
      onClick={(event) => {
        if (!picking) return;
        const box = event.currentTarget.getBoundingClientRect();
        board.onPick({
          x: (event.clientX - box.left) / scale,
          y: (event.clientY - box.top + event.currentTarget.scrollTop) / scale,
          label: '',
        });
      }}
    >
      <img src={url} alt={title} draggable={false} {...stylex.props(styles.image)} />
      {/* Inside what scrolls, so the pins move with the picture. */}
      {board.overlay(0)}
    </div>
  );
}
