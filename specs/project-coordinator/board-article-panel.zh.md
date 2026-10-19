# 看板：article 浮窗（左 article，右线程对话）

Status: draft
Translation: pending

2026-10-19 用户在 Mac 测试版上试了三轮，定下了现在的形态（分支 `feat/board-article-panel-proto`）。
功能在 Experimental features 的「Article 浮窗」开关后面，默认关闭。实现说明见
[experimental.md](../../.agents/docs/experimental.md) 的 Article window 一节。

## 场景

用户在看板里让线程 A 写一份调研报告和一个交互式演示页。线程 A 把
`articles/report.md` 和 `articles/demo.html` 写进自己的工作区，并在回复里给出路径。

用户在侧边 Board 面板里点 `report.md`，页面上直接弹出一个和 Settings 同一类的大浮窗：左边是
报告，带一条标题目录轨；右边是线程 A 的对话。用户选中一段文字，旁边出现一个小的「批注」
按钮，点开写「这里数据过时了」，批注作为 chip 进入右边的输入框。用户补一句「都改一下」后
发送。线程 A 改完文件，左边几秒内自动刷新。用户在右栏点面包屑切到线程 A 的子会话，浮窗
不关，左边仍是这份报告。按 Esc 关闭后，页面回到原样：侧边面板停在刚才那个对话和滚动位置，
输入框里没发的草稿还在，也没有多出文件 tab。

```
┌ 侧边栏 ┐┌──────────────────── 当前页面（被遮罩）────────────────────┐
│        ││ ┌─[MD] report.md · 5 分钟前  ⟳ ⧉ ⋯ ─┬─ 线程 A ──────── × ─┐ │
│ 看板行 ││ │ ≡  # 调研报告                      ┃ 消息流              │ │
│ 会话…  ││ │ ≡  ……选中的段落…… [批注]           ┃                     │ │
│        ││ │ ≡  ……                              ┃ [批注 chip]         │ │
│        ││ │    （目录轨）       article 60%    ┃ 输入框         40%  │ │
│        ││ └────────────────────────────────────┸─────────────────────┘ │
└────────┘└──────────────────────── ┃ 可拖动分隔 ─────────────────────────┘
```

## 决定

### article 就是线程工作区里的文件

- article 是线程所在机器上、线程工作区里的 `.md` 或 `.html`，路径就是它的身份。agent 用
  普通写文件工具创建和更新它，版本靠工作区自己的 git 管。不新增对象类型、Loro 文档或协议，
  也不加 MCP 工具：agent 只要约定把产出物写到 `articles/<name>.md|html`，并在回复里给出路径。
- 文件按线程**自己的**机器和工作区读取，沿用 PR #62 的 `ownerSessionId`。LAN 成员机器上
  的文件经该成员的 `requestFilePreview` 读，文本上限 10 MiB；被截断的 HTML 不预览。
- 不采用：像 plan review 那样把内容放进 tool call（上限 100k 字，每次更新都要整份重发，
  transcript 是唯一的记录）；也不建独立的 Loro 文档（需要 CLI 写入，内容还和文件重复）。

### 入口和浮窗

- 开关打开时，在看板侧边面板里点线程消息中的 `.md` / `.html` 链接，直接弹出浮窗，不创建
  文件 tab，其他类型的文件照旧开 tab。手机、compact 宽度和完整页线程也照旧开 tab；已经
  打开的浮窗在关掉开关或跨过 compact 断点时会自动关闭。
- 浮窗是 `@lody/ui` Dialog，带遮罩，四周留边距，左右默认 60/40，中间可以拖。Esc、点遮罩、
  右栏 × 都能关闭。⋯ 菜单里的「在侧边 tab 打开」是退路。
- 浮窗记两样东西：article 归哪个线程（`ownerThreadId`，决定从哪里读文件），以及右栏现在
  显示哪个对话（跟着 Board 面板走）。面包屑、父线程、本看板成员的会话链接只会切换右栏，
  浮窗不关，左边 article 不变；会离开 Board 面板的导航则关闭浮窗。

### 右栏和侧边面板是同一个对话实例

- 线程对话始终用 portal 渲染进一个持久的 DOM 宿主。宿主在 Board 面板的槽位和浮窗右栏的
  槽位之间搬节点，浮窗的槽位优先。React 不会重新挂载对话，所以输入框文字、批注 chip、
  `chatRefsMap[threadId]` 都留在原来那一个实例上，也没有两份订阅。
- 不用 Dialog 里再挂一个 `SessionChatInterface`：那样两个输入框会抢同一个 ref，chip 和草稿
  得来回交接。
- 滚动位置：节点用 `moveBefore` 搬（新旧两个位置都还在文档里时才能保住 scrollTop），所以
  关闭分两步：先让浮窗交还对话，下一次提交再卸载浮窗。不支持 `moveBefore` 的浏览器（网页版
  的 Safari、Firefox）关闭后对话会回到顶部。

### HTML：widget 页面，CDN 白名单

- 浮窗里的 HTML 放在 widget shell 的页面里跑（Electron 下由主进程的本机地址提供）。iframe
  只有 `allow-scripts`，没有 `allow-same-origin`。原因：普通文件预览用 srcdoc，会继承宿主
  页面的 CSP，CDN 放不开。
- CDN 照 Claude artifact 的做法：脚本、样式、字体、图片和 `connect-src` 只放 widget shell 已有
  的源（esm.sh、jsdelivr、unpkg、cdnjs、Google Fonts），其他网址一律不能请求。直接复用
  `LODY_WIDGET_SHELL_CONTENT_SECURITY_POLICY` 的源列表，不另写第三份。普通文件 tab 里的 HTML
  预览仍然禁网。
- 基准字号跟 app 的对话字号设置走（默认 14px），页面自己写了字号的以页面为准；明暗主题
  通过宿主的 CSS 变量跟随。行内 widget 维持原来的 15px。
- 多文件的完整应用不放进 article，仍由 agent 起服务，经 `lody_report_preview_candidate` 在
  Browser tab 里看。

### 批注：选中后先出按钮，内容进输入框，不持久化

- Markdown 接入上游 #1649（cherry-pick 进来）的 `DocumentSelectionSurface`。选中文字后只
  出现一个小的「批注」按钮，点了才展开编辑框。引用会在源码里定位行号（定位不到就只给引用），
  添加后成为右栏输入框里的 chip，发送时展开成纯文本，不用改 CLI。
- 编辑框开着时，Esc 只关编辑框；编辑框没开时，Esc 关浮窗。
- 批注不持久化，也不做锚点：agent 手里有文件，transcript 就是记录。浮窗里的 HTML 暂时
  没有元素批注。

### 刷新：digest 轮询

- 浮窗打开时，每 5 秒用 `requestFilePreview({ knownDigest })` 查一次，线程空闲时 15 秒一次，
  线程一轮结束时再补查一次。轮询结果回来时，如果用户正在编辑，或者浮窗已经关了，这次结果
  就丢弃。HTML 有变化时，若用户正在 iframe 里操作，只提示「已更新 · 重新加载」，不自动重载。

## 待定问题

1. 完整页线程模式：对话是页面主区，不在 Board 面板里，同样的挂法不成立，现在照旧开 tab。
2. 要不要加 `lody_open_article` 卡片工具（要发 dev）。
3. 浮窗里 HTML 的元素批注。
4. 普通（非看板）会话要不要也弹浮窗。

## 证据

- 实现：`packages/components/src/components/boards/board-article-dialog.tsx`、
  `boards/relocatable-host.tsx`、`sessions/article-html-frame.tsx`、`sessions/article-outline.tsx`、
  `hooks/use-session-file-digest-watch.ts`，`sessions/session-detail.tsx`（打开/关闭和状态）。
- 测试：`packages/components/tests/board-article-dialog.test.tsx`、`document-selection.test.tsx`、
  `use-session-file-digest-watch.test.tsx`、`session-file-content-view.test.tsx`。
- 验证：2026-10-19 在 Mac 测试版上连续三轮实际操作核对，全部通过（第三轮在 `ed8ee80e2`）。
  LAN 跨机器读取的情况还没有在真实 LAN 上测过。
