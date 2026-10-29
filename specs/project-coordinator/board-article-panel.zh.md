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
按钮，点开写「这里数据过时了」，这一段的行尾出现一个小批注图标，右边输入框下方显示
「将附带 1 条批注」。用户补一句「都改一下」后发送，批注拼在消息末尾一起发出，图标随之
消失。线程 A 改完文件，左边几秒内自动刷新。用户在右栏点面包屑切到线程 A 的子会话，浮窗
不关，左边仍是这份报告。按 Esc 关闭后，页面回到原样：侧边面板停在刚才那个对话和滚动位置，
输入框里没发的草稿还在，也没有多出文件 tab。

```
┌ 侧边栏 ┐┌──────────────────── 当前页面（被遮罩）────────────────────┐
│        ││ ┌─[MD] report.md · 5 分钟前  ⟳ ⧉ ⋯ ─┬─ 线程 A ──────── × ─┐ │
│ 看板行 ││ │ ≡  # 调研报告                      ┃ 消息流              │ │
│ 会话…  ││ │ ≡  ……批注过的段落…… 💬²            ┃                     │ │
│        ││ │ ≡  ……                              ┃ 输入框              │ │
│        ││ │    （目录轨）       article 60%    ┃ 将附带 2 条批注 40% │ │
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
  槽位之间搬节点，浮窗的槽位优先。React 不会重新挂载对话，所以输入框文字、附件 chip、
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

### 批注：停在段落末尾，随下一条消息发出，发出后留着等 agent 改

2026-10-21 用户改了批注的去处：写完不再往输入框插 chip，而是留在 article 里，发送时自动
带上。

- Markdown 接入上游 #1649（cherry-pick 进来）的 `DocumentSelectionSurface`。选中文字后只
  出现一个小的「批注」按钮，点了才展开编辑框，按钮是「添加批注」。
- 批注停在选区起点所在的渲染块（段落、列表项、标题、代码块、表格单元格等）末尾：块最后
  一行的行尾浮着一个低对比的小批注图标，不插进 Markdown DOM，正文不重排；一块有多条时
  图标带数字角标，一条时不带。点图标弹出 popover，列出这一块的批注（引用摘要 + 内容），
  每条可编辑、删除。popover 挂在浮窗面板里。
- 发送：在右栏线程输入框发送时，这个线程所有未发送的批注拼到消息末尾，纯文本 Markdown：

  ```
  ---
  批注（N 条）

  1. `<路径>`
     > <被选中的原文，多行逐行加 >
     <批注内容>
  ```

  按文件分组，文件内按文档顺序；批注内容为空就只有引用。不写行号：浮窗关着时文件也可能
  被改，行号会过时、指错地方，而引用的原文本身就能让 agent 搜到位置。没有批注时发送内容
  完全不变。
- 消息末尾在「批注（N 条）」下面多一行「请按编号逐条回应」，让 agent 按编号回复。
- 浮窗标头有「发送 N 条批注」按钮：让右栏线程的输入框按原样发送，输入框里已经打的字一起
  发出。
- 2026-10-29 用户参考 ryugi（Innei/ryugi，只借思路，不搬代码）改了发出之后的去处：发送真的被
  接受后，这次带上的批注不删，标成已发送，记下它在消息里的编号；图标变淡，popover 写
  「#2 · 已发送，等 agent 修改」。agent 改了那一段之后（渲染后找不到写批注时那一块的原文），
  图标变成强调色，popover 写「agent 改过这段」。已发送的批注可以「解决」（删掉）或「追问」：
  追问写一条新的未发送批注替换它，发出时带上「之前问过：…」。没人处理的已发送批注 30 天后
  删掉。发送失败时批注保持未发送，下次再带；等待接受期间改过的批注不算已发送，留到下次。
- 输入框里有未发送批注时，输入框内显示一行小号 muted 的「将附带 N 条批注」，0 条不显示。
  对话只有一个实例，所以关掉浮窗、在侧边面板里发送也照样带上、照样提示。
- 批注归属：发送它的线程（写批注时浮窗右栏的线程）+ article（文件所在线程 + 路径），存在
  本机 localStorage，重启还在，换一台设备看不到（用户 2026-10-29 选的「只存本机」；写到
  文章旁边的文件需要后端加写入通道，没做）。右栏切到别的成员时，article 上只显示要随这个
  成员的消息发出的批注。
- Esc 依次关编辑框或 popover（popover 里正在编辑时先退出编辑），最后关浮窗。
- 普通文件 tab 里的 Markdown 选区批注照旧作为 chip 进输入框。浮窗里的 HTML 暂时没有元素
  批注。

### 改动标记

- 浮窗打开后看到的第一个版本是基准；之后每个新版本里，前一版没有的块（按渲染后的文字比）
  在左边距画一条竖条。竖条跨版本累加（agent 是分几次写的），文字不在了或用户点「清除」才
  消失；标头显示「N 处改动」，可以上下跳。关掉浮窗就不记了，这代替 ryugi 的完整版本历史。

### HTML 测试台：控件值保留，报错可见

- agent 改写页面后，新版本恢复用户调过的输入框、选择框、勾选框的值（按 id，其次 name，再
  其次位置），以及展开的 `<details>` 和滚动位置，并对每个控件触发 `input`、`change`，页面
  从这些事件重新渲染。值只在内存里，按线程 + 路径存，应用开着时有效。
- 页面里未捕获的错误、未处理的 rejection、加载失败的文件列在页面下方（最多 20 条，下个
  版本清空）；「附到下条消息」把它们变成一条没有段落的批注，随线程下一条消息发出，发出后
  就删掉。

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
  `boards/relocatable-host.tsx`、`boards/article-annotations.ts`（批注存储和发送格式）、
  `boards/article-annotation-markers.tsx`（图标和 popover）、`boards/article-review.tsx`（改动标记和标头控件）、`sessions/article-html-frame.tsx`、
  `sessions/article-outline.tsx`、`hooks/use-session-file-digest-watch.ts`，
  `sessions/session-detail.tsx`（打开/关闭和状态）、`sessions/session-chat-input-area.tsx`（发送时拼接）。
- 测试：`packages/components/tests/board-article-dialog.test.tsx`、`document-selection.test.tsx`、
  `use-session-file-digest-watch.test.tsx`、`session-file-content-view.test.tsx`、
  `session-chat-input-submission.test.tsx`。
- 验证：2026-10-19 在 Mac 测试版上连续三轮实际操作核对，全部通过（第三轮在 `ed8ee80e2`）。
  LAN 跨机器读取的情况还没有在真实 LAN 上测过。
