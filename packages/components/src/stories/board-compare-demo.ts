/**
 * A synthetic UI comparison for stories: one settings page drawn three ways,
 * a phone take, and a "before" picture. Only the navigation differs.
 */

export const COMPARE_MANIFEST_MD = `---
viewport: 1280x800
---
# 设置页导航：侧栏、顶部标签还是图标栏

三版内容一致，只比导航。B 让内容区全宽；C 给小屏留了位置。

- [侧栏导航](nav-a.html) 层级清楚，内容区窄
- [顶部标签](nav-b.html) 内容全宽
- [图标栏](nav-c.html) 折叠成图标，悬停出名字
- [手机](nav-phone.html) 390x844
- [改版前](before.svg) 现在的样子
`;

const PAGE_STYLE = `
:root{--bg:#f6f7f9;--card:#fff;--ink:#1d2330;--muted:#667085;--line:#e4e7ec;--accent:#3a5bd9;--accent-ink:#fff}
[data-mode=dark]{--bg:#14161b;--card:#1d2027;--ink:#e7e9ee;--muted:#9aa1ad;--line:#2c3039;--accent:#7b93f0;--accent-ink:#0d1020}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"PingFang SC",sans-serif}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px 24px;margin-bottom:16px}
.card h3{margin:0 0 4px;font-size:15px}.card p{margin:0 0 14px;color:var(--muted)}
.row{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-top:1px solid var(--line)}
.row:first-of-type{border-top:0}
.switch{width:34px;height:20px;border-radius:10px;background:var(--accent);position:relative}
.switch::after{content:"";position:absolute;right:3px;top:3px;width:14px;height:14px;border-radius:7px;background:var(--accent-ink)}
select{background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:4px 8px}
h1{font-size:22px;margin:0 0 18px;font-weight:600}
`;

const CONTENT = `
<h1>通用</h1>
<section class="card"><h3>外观</h3><p>界面主题和字号。</p>
<div class="row"><span>主题</span><select><option>跟随系统</option><option>浅色</option><option>深色</option></select></div>
<div class="row"><span>紧凑模式</span><span class="switch"></span></div></section>
<section class="card"><h3>通知</h3><p>什么时候提醒你。</p>
<div class="row"><span>agent 完成时</span><span class="switch"></span></div>
<div class="row"><span>需要确认时</span><span class="switch"></span></div></section>
<section class="card"><h3>局域网</h3><p>这台机器在 LAN 里的名字和角色。</p>
<div class="row"><span>机器名</span><span>devnuc</span></div>
<div class="row"><span>hub</span><span>N100</span></div></section>
<section class="card"><h3>实验功能</h3><p>还在试的功能，随时可能变。</p>
<div class="row"><span>Article 浮窗</span><span class="switch"></span></div>
<div class="row"><span>多方案对比</span><span class="switch"></span></div></section>
`;

const SECTIONS = ['通用', '账户', '机器', '局域网', '快捷键', '实验功能'];

const page = (style: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>设置</title><style>${PAGE_STYLE}${style}</style></head><body>${body}</body></html>`;

export const COMPARE_NAV_A_HTML = page(
  `.shell{display:flex;min-height:100vh}
nav{width:220px;flex-shrink:0;border-right:1px solid var(--line);background:var(--card);padding:20px 12px}
nav b{display:block;padding:0 10px 12px;font-size:13px;color:var(--muted)}
nav a{display:block;padding:7px 10px;border-radius:6px;color:var(--ink);text-decoration:none}
nav a.on{background:var(--bg);font-weight:600}
main{flex:1;padding:28px 36px;max-width:720px}`,
  `<div class="shell"><nav><b>设置</b>${SECTIONS.map((name, index) => `<a href="#" class="${index === 0 ? 'on' : ''}">${name}</a>`).join('')}</nav><main>${CONTENT}</main></div>`
);

export const COMPARE_NAV_B_HTML = page(
  `header{position:sticky;top:0;background:var(--card);border-bottom:1px solid var(--line);padding:0 36px;display:flex;gap:4px;z-index:1}
header a{padding:14px 12px;color:var(--muted);text-decoration:none;border-bottom:2px solid transparent}
header a.on{color:var(--ink);border-bottom-color:var(--accent);font-weight:600}
main{padding:28px 36px;max-width:1040px;margin:0 auto}`,
  `<header>${SECTIONS.map((name, index) => `<a href="#" class="${index === 0 ? 'on' : ''}">${name}</a>`).join('')}</header><main>${CONTENT}</main>`
);

export const COMPARE_NAV_C_HTML = page(
  `.shell{display:flex;min-height:100vh}
nav{width:56px;flex-shrink:0;border-right:1px solid var(--line);background:var(--card);padding:16px 8px;display:flex;flex-direction:column;gap:6px}
nav a{width:40px;height:40px;border-radius:10px;display:grid;place-items:center;color:var(--muted);text-decoration:none;font-weight:600}
nav a.on{background:var(--accent);color:var(--accent-ink)}
main{flex:1;padding:28px 36px;max-width:820px}`,
  `<div class="shell"><nav>${SECTIONS.map((name, index) => `<a href="#" title="${name}" class="${index === 0 ? 'on' : ''}">${name.slice(0, 1)}</a>`).join('')}</nav><main>${CONTENT}</main></div>`
);

export const COMPARE_NAV_PHONE_HTML = page(
  `header{position:sticky;top:0;background:var(--card);border-bottom:1px solid var(--line);padding:12px 16px;font-weight:600}
.tabs{display:flex;gap:8px;overflow-x:auto;padding:10px 16px}
.tabs a{flex-shrink:0;padding:6px 12px;border-radius:16px;background:var(--card);border:1px solid var(--line);color:var(--ink);text-decoration:none}
.tabs a.on{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
main{padding:4px 16px 24px}
h1{display:none}`,
  `<header>设置</header><div class="tabs">${SECTIONS.map((name, index) => `<a href="#" class="${index === 0 ? 'on' : ''}">${name}</a>`).join('')}</div><main>${CONTENT}</main>`
);

/** The page as it is now, as a picture: a plain list with no navigation at all. */
export const COMPARE_BEFORE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800">
<rect width="1280" height="800" fill="#f2f2f2"/>
<text x="48" y="64" font-family="system-ui,sans-serif" font-size="24" fill="#333">设置</text>
${[0, 1, 2, 3, 4, 5]
  .map(
    (index) =>
      `<rect x="48" y="${96 + index * 108}" width="1184" height="92" rx="6" fill="#fff" stroke="#ddd"/>` +
      `<text x="72" y="${148 + index * 108}" font-family="system-ui,sans-serif" font-size="16" fill="#555">${SECTIONS[index]}</text>`
  )
  .join('')}
</svg>`;

/** Option B after the agent's next revision: the tabs grow an underline track. */
export const COMPARE_NAV_B_REVISED_HTML = COMPARE_NAV_B_HTML.replace(
  'header a.on{',
  'header{box-shadow:0 1px 0 var(--line)}header a.on{background:var(--bg);'
);
