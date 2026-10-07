/**
 * The page that hosts one agent-written widget.
 *
 * The desktop serves this page from its own loopback origin and frames it with
 * `sandbox="allow-scripts"` (no `allow-same-origin`), so a widget runs in an
 * opaque origin under this page's policy rather than the app's. The page holds
 * no widget content of its own: the conversation posts the widget code once
 * the page says it is ready, and the page talks back only through the messages
 * below. Kept dependency-free: the Electron main process imports it.
 */

/** The only origins a widget may load scripts, styles and fonts from. */
export const LODY_WIDGET_CDN_ORIGINS = [
  'https://cdnjs.cloudflare.com',
  'https://cdn.jsdelivr.net',
  'https://unpkg.com',
  'https://esm.sh',
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
] as const;

/** The path the desktop serves the page at. */
export const LODY_WIDGET_SHELL_PATH = '/widget';

const CDN = LODY_WIDGET_CDN_ORIGINS.join(' ');

/** No network but the CDNs; no frames, forms, plugins or workers of its own. */
export const LODY_WIDGET_SHELL_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  `script-src 'unsafe-inline' ${CDN}`,
  `style-src 'unsafe-inline' ${CDN}`,
  `font-src data: ${CDN}`,
  `img-src data: blob: ${CDN}`,
  `connect-src ${CDN}`,
  'media-src data: blob:',
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

export type LodyWidgetColorMode = 'light' | 'dark';

/** Conversation to widget page. */
export type LodyWidgetHostMessage =
  | {
      type: 'lody-widget:render';
      code: string;
      mode: LodyWidgetColorMode;
      vars: Record<string, string>;
    }
  | { type: 'lody-widget:theme'; mode: LodyWidgetColorMode; vars: Record<string, string> };

/** Widget page to conversation. */
export type LodyWidgetFrameMessage =
  | { type: 'lody-widget:ready' }
  | { type: 'lody-widget:height'; height: number }
  | { type: 'lody-widget:prompt'; text: string }
  | { type: 'lody-widget:link'; url: string }
  | { type: 'lody-widget:state'; state: unknown };

export const LODY_WIDGET_PROMPT_MAX_CHARS = 4_000;

/**
 * Reads a message posted by a widget page. Anything else, including a valid
 * shape with the wrong field types, is `null`.
 */
export const parseLodyWidgetFrameMessage = (data: unknown): LodyWidgetFrameMessage | null => {
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  switch (record['type']) {
    case 'lody-widget:ready':
      return { type: 'lody-widget:ready' };
    case 'lody-widget:height': {
      const height = record['height'];
      return typeof height === 'number' && Number.isFinite(height) && height >= 0
        ? { type: 'lody-widget:height', height }
        : null;
    }
    case 'lody-widget:prompt': {
      const text = record['text'];
      if (typeof text !== 'string') return null;
      const trimmed = text.trim();
      return trimmed.length > 0 && trimmed.length <= LODY_WIDGET_PROMPT_MAX_CHARS
        ? { type: 'lody-widget:prompt', text: trimmed }
        : null;
    }
    case 'lody-widget:link': {
      const url = record['url'];
      return typeof url === 'string' && url.length <= 2_048
        ? { type: 'lody-widget:link', url }
        : null;
    }
    case 'lody-widget:state':
      return { type: 'lody-widget:state', state: record['state'] };
    default:
      return null;
  }
};

/*
 * Base styles: the theme variables widgets are told to use, their short
 * aliases, and the SVG helper classes (`t`, `ts`, `th`, `box`, `node`, `arr`,
 * `leader`, `c-<ramp>`) that widgets written for Claude Desktop rely on. The
 * conversation overrides the variables with Lody's live theme.
 */
const RAMPS: Record<string, readonly string[]> = {
  purple: ['#EEEDFE', '#CECBF6', '#AFA9EC', '#7F77DD', '#534AB7', '#3C3489', '#26215C'],
  teal: ['#E1F5EE', '#9FE1CB', '#5DCAA5', '#1D9E75', '#0F6E56', '#085041', '#04342C'],
  coral: ['#FAECE7', '#F5C4B3', '#F0997B', '#D85A30', '#993C1D', '#712B13', '#4A1B0C'],
  pink: ['#FBEAF0', '#F4C0D1', '#ED93B1', '#D4537E', '#993556', '#72243E', '#4B1528'],
  gray: ['#F1EFE8', '#D3D1C7', '#B4B2A9', '#888780', '#5F5E5A', '#444441', '#2C2C2A'],
  blue: ['#E6F1FB', '#B5D4F4', '#85B7EB', '#378ADD', '#185FA5', '#0C447C', '#042C53'],
  green: ['#EAF3DE', '#C0DD97', '#97C459', '#639922', '#3B6D11', '#27500A', '#173404'],
  amber: ['#FAEEDA', '#FAC775', '#EF9F27', '#BA7517', '#854F0B', '#633806', '#412402'],
  red: ['#FCEBEB', '#F7C1C1', '#F09595', '#E24B4A', '#A32D2D', '#791F1F', '#501313'],
};

const rampCss = (): string =>
  Object.entries(RAMPS)
    .map(([name, stops]) => {
      // Stops: 50, 100, 200, 400, 600, 800, 900.
      const [s50, s100, s200, , s600, s800] = stops;
      const shapes = `rect,circle,ellipse,polygon`;
      const light = [
        `.c-${name}:is(${shapes}),.c-${name}>:is(${shapes}){fill:${s50};stroke:${s600}}`,
        `.c-${name}>.t,.c-${name}>.th{fill:${s800}}`,
        `.c-${name}>.ts{fill:${s600}}`,
      ];
      const dark = [
        `[data-mode=dark] .c-${name}:is(${shapes}),[data-mode=dark] .c-${name}>:is(${shapes}){fill:${s800};stroke:${s200}}`,
        `[data-mode=dark] .c-${name}>.t,[data-mode=dark] .c-${name}>.th{fill:${s100}}`,
        `[data-mode=dark] .c-${name}>.ts{fill:${s200}}`,
      ];
      return [...light, ...dark].join('');
    })
    .join('');

const BASE_CSS = `
:root{
  --font-sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue","PingFang SC","Noto Sans CJK SC",sans-serif;
  --font-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --font-voice:ui-serif,Georgia,"Times New Roman",serif;
  --radius:8px;
  --pad-sm:8px;--pad-md:12px;--pad-lg:16px;--pad-xl:24px;
  --gap-xs:4px;--gap-sm:8px;--gap-md:12px;--gap-lg:16px;--gap-xl:24px;
  --surface-0:#fafafa;--surface-1:#ffffff;--surface-2:#ffffff;
  --text-primary:#1a1a1a;--text-secondary:#5f5f5f;--text-muted:#8a8a8a;
  --text-accent:#185FA5;--text-danger:#A32D2D;--text-success:#3B6D11;--text-warning:#854F0B;
  --bg-accent:#E6F1FB;--bg-danger:#FCEBEB;--bg-success:#EAF3DE;--bg-warning:#FAEEDA;
  --border:rgba(0,0,0,.12);--border-strong:rgba(0,0,0,.24);--border-stronger:rgba(0,0,0,.4);
  --border-accent:#378ADD;--border-danger:#E24B4A;--border-success:#639922;--border-warning:#BA7517;
}
[data-mode=dark]{
  --surface-0:#1e1e1e;--surface-1:#262626;--surface-2:#2e2e2e;
  --text-primary:#ececec;--text-secondary:#a8a8a8;--text-muted:#7a7a7a;
  --text-accent:#85B7EB;--text-danger:#F09595;--text-success:#97C459;--text-warning:#EF9F27;
  --bg-accent:#0C447C;--bg-danger:#791F1F;--bg-success:#27500A;--bg-warning:#633806;
  --border:rgba(255,255,255,.12);--border-strong:rgba(255,255,255,.24);--border-stronger:rgba(255,255,255,.4);
}
:root{--p:var(--text-primary);--s:var(--text-secondary);--t:var(--text-muted);--bg2:var(--surface-1);--b:var(--border)}
html,body{margin:0;padding:0;background:transparent}
body{font-family:var(--font-sans);font-size:15px;line-height:1.6;color:var(--text-primary);overflow:hidden}
#lody-widget-root{display:block;width:100%}
h1,h2,h3{color:var(--text-primary);font-weight:500}
h1{font-size:22px}h2{font-size:18px}h3{font-size:16px}
a{color:var(--text-accent)}
svg text{font-family:var(--font-sans)}
.t{font-size:14px;fill:var(--text-primary)}
.ts{font-size:12px;fill:var(--text-secondary)}
.th{font-size:14px;font-weight:500;fill:var(--text-primary)}
.box{fill:var(--surface-1);stroke:var(--border-strong)}
.node{cursor:pointer}
.node:hover{opacity:.8}
.arr{fill:none;stroke:var(--text-secondary);stroke-width:1.5}
.leader{fill:none;stroke:var(--text-muted);stroke-width:.5;stroke-dasharray:3 3}
`;

/* The page's own script. Plain ES5 so any engine that frames it can run it. */
const BOOTSTRAP = `(function(){
var host=window.parent;
function post(m){host.postMessage(m,'*');}
var rendered=false,widgetState=null,lastHeight=-1;
window.sendPrompt=function(text){if(typeof text==='string'&&text.trim())post({type:'lody-widget:prompt',text:text});};
window.openLink=function(url){if(url)post({type:'lody-widget:link',url:String(url)});};
window.openai={
  theme:'light',
  get widgetState(){return widgetState;},
  sendFollowUpMessage:function(a){window.sendPrompt(a&&typeof a==='object'?a.prompt:a);return Promise.resolve();},
  setWidgetState:function(s){widgetState=s;post({type:'lody-widget:state',state:s});return Promise.resolve();},
  openExternal:function(a){window.openLink(a&&typeof a==='object'?a.href:a);}
};
document.addEventListener('click',function(e){
  var t=e.target,a=t&&t.closest?t.closest('a[href]'):null;
  if(!a)return;var h=a.getAttribute('href');
  if(!h||h.charAt(0)==='#')return;
  e.preventDefault();window.openLink(a.href);
},true);
function theme(mode,vars){
  var r=document.documentElement;r.setAttribute('data-mode',mode);r.style.colorScheme=mode;
  window.openai.theme=mode;
  for(var k in vars){if(/^--[a-z0-9-]+$/.test(k)&&typeof vars[k]==='string')r.style.setProperty(k,vars[k]);}
}
function measure(){
  var root=document.getElementById('lody-widget-root');
  var h=Math.ceil(root.getBoundingClientRect().height);
  if(h!==lastHeight){lastHeight=h;post({type:'lody-widget:height',height:h});}
}
function runScripts(root){
  var list=Array.prototype.slice.call(root.querySelectorAll('script')),i=0;
  function next(){
    if(i>=list.length){measure();return;}
    var old=list[i++],s=document.createElement('script');
    for(var j=0;j<old.attributes.length;j++)s.setAttribute(old.attributes[j].name,old.attributes[j].value);
    if(old.src){s.onload=next;s.onerror=next;old.parentNode.replaceChild(s,old);}
    else{s.textContent=old.textContent;old.parentNode.replaceChild(s,old);next();}
  }
  next();
}
function render(code){
  if(rendered)return;rendered=true;
  var root=document.getElementById('lody-widget-root'),tpl=document.createElement('template');
  tpl.innerHTML=code;root.appendChild(tpl.content);runScripts(root);
  if(window.ResizeObserver)new ResizeObserver(measure).observe(root);
  window.addEventListener('load',measure);measure();
}
window.addEventListener('message',function(e){
  if(e.source!==host)return;var d=e.data;if(!d||typeof d!=='object')return;
  if(d.type==='lody-widget:render'&&typeof d.code==='string'){theme(d.mode,d.vars||{});render(d.code);}
  else if(d.type==='lody-widget:theme'){theme(d.mode,d.vars||{});}
});
post({type:'lody-widget:ready'});
})();`;

const TABLER_ICONS =
  'https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3/dist/tabler-icons.min.css';

/** The complete page, with its policy also in a meta tag for framings without headers. */
export const buildLodyWidgetShellHtml = (): string =>
  [
    '<!doctype html>',
    '<html data-mode="light"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${LODY_WIDGET_SHELL_CONTENT_SECURITY_POLICY}">`,
    '<meta name="referrer" content="no-referrer">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<link rel="stylesheet" href="${TABLER_ICONS}">`,
    `<style>${BASE_CSS}${rampCss()}</style>`,
    '</head><body><div id="lody-widget-root"></div>',
    `<script>${BOOTSTRAP}</script>`,
    '</body></html>',
  ].join('');
