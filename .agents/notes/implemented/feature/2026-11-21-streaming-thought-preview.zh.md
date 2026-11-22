# 极简原生流式推理目录与原生后台任务态

Status: implemented
Translation: current

[English](2026-11-21-streaming-thought-preview.md)

## 摘要

主要通过 `agent_thought_chunk` 输出过程说明的 agent（尤其是 Antigravity CLI）在长工具循环中仅显示收起的计数标题，且回合结束后展开过程需要点穿「工作了 X → 收起的活动组」两层套娃；同时，主回合已结束但后台任务仍在运行（`running + backgroundTaskState: background`）时，原有界面会在最终回答下方留下无计时的孤立「思考中」行与活跃旋转图标。本 fork 落地两项改动：（1）挂载在设备级实验开关 `streamingThoughtPreviewFeatureEnabledAtom` 下的 Option C 极简原生固定双排实时头部（第 1 排固定状态 + 工具计数 + 耗时，第 2 排完整展示最新一段有效思考正文）与单层过程目录；（2）始终生效的侧边栏、顶部标签栏与对话流底部原生后台任务态。真实 daemon 的 chunk 推送节奏与 iOS 原生渲染不在本次改动范围内。

## 决策

将改动拆分为独立模块：实验开关门控的纯展示升级（`streaming-thought-preview.ts`、`compact-native-directory.ts`、`compact-native-directory-row.tsx`）与始终生效的原生后台态展示（`background-task-status-row.tsx`、`working-status-mark.tsx`、`session-list-rows.ts`、`sidebar-row-shared.tsx`、`session-tab-bar.tsx`），并在 `view.tsx` 保持最小接线面。

- **前置同步上游 #2896。** 先 cherry-pick 上游 `1c2a979cb`（使流式状态与流式思考共享同一虚拟行测量边界），减少后续合并上游 `view.tsx` 时的冲突面。
- **Option C 固定双排实时头部（跨 provider 统一）。** 开启 `streamingThoughtPreviewFeatureEnabledAtom` 时生效，关闭时 100% 保持上游原貌，上下两排在思考与跑工具切换期间永不互换位置：
  - **第 1 排（13px，单行 `nowrap`，外层 `.agent-shimmer` 包裹内层 flex 截断容器；低刺激模式关扫光与展开过渡）：** 固定放状态 + 已完成/后台工具计数 + 耗时，永不放思考正文。思考中统一使用 `sessions.compactProcess.thinking`（即便是纯 Antigravity 起手占位句也不在 `思考中…` 与 `思考中` 间跳动），显示 `思考中（<耗时>）` 或 `思考中 · <工具计数>（<耗时>）`；有进行中非后台工具时显示 `运行中 <目标>（<耗时>）` 或 `运行中 <目标> · <工具计数>（<耗时>）`。`summarizeCompactTools(entries)` 在整个 `isLive` 期间持续计算以保证工具计数不消失也不跳排；状态动词与 `（<耗时>）` 固定 `flexShrink: 0`，跑工具态下 `<目标>`（`flex: 0 10000 auto`，在存在计数且 `shortTarget.length >= 10` 时保底 `minWidth: 64px`）优先收缩以使短命令不限宽、中等计数完整保留，重度多类计数再由 `<工具计数>`（`flex: 0 1 auto`）单行省略，确保 390px 窄屏下既不把 `<目标>` 压成 `0px`、也不挤出耗时。
  - **第 2 排（12px 次级灰 `secondaryLabel`，`white-space: pre-line` + `overflow-wrap: anywhere`，无 `line-clamp`）：** 仅在 `isLive && !expanded` 且存在有效思考（过滤 Antigravity 占位句后非空）时渲染，完整展示最新一段有效思考正文（保留段内全部有效行、多句、自然换行与长路径/URL 折行，不做 32 行或 8,192 字符截断）；跑工具或新思考刚吐出占位句/未闭合 `**` 标题时稳定保留上一段有效思考，展开目录或回合结束后自动消失（桌面回合结束保留 `工作了<耗时>`，移动端按规范隐藏标题耗时由 footer 负责）。
- **单层展开过程目录。** 点击流式摘要行或回合结束后的原生标题 `工作了{{duration}}`（不加 token 统计或多余说明），一步直达平铺单层目录，消灭两层套娃：每段有效思考默认收成单行首句摘录并自动剥离 Antigravity 占位句（多于 1 段有效思考时顶部右侧提供轻量的「展开全部思考 / 收起全部思考」按钮）；连续多个已完成的非后台 `read` 工具按首个工具稳定标识聚合为一行（流式追加第 3 个读文件不丢展开态）；带输出/diff 详情的单条 `read`/`edit` 行在点击整行展开详情的同时保留独立可点击文件名以打开源文件；其他工具点击整行原地展开详情（无「查看输出」徽章），带持久 `tool_call.backgroundTaskId` 的命令展示中性历史 `后台` / `BG` 微标（不绑定实时 presence）。完整保留 #2353 回合结束折叠、按 `sessionId + messageId` 分区隔离 Fork 会话的手动展开缓存、与占位句剥离一致的思考搜索索引及低刺激规则。
- **安全提取、虚拟列表动态高度与防闪烁。** 复用 `streaming-thought-preview.ts` 的单遍 O(n) 扫描（跨段 HTML 注释跟踪、未闭合 `**` 行界判定、占位句过滤，以及 1500 ms / 低刺激 4000 ms 停留节流）。收起态第 2 排通过 `extractLatestThoughtParagraphFromText` / `extractLatestCompactThoughtParagraph` 对最新有效段落内的所有有效行做完整 O(n) 清洗输出（不按 32 行或 8,192 字符截断），并将 `STREAMING_THOUGHT_PREVIEW_MAX_CLEANED_LINES`（32 行）与 `MAX_CLEANED_CHARS`（8,192 字符）护栏专门用于约束尚未命中有效内容前的空输出噪音洪水；展开目录继续保留保护 `view.tsx`/`v2.1` 等点号的首句摘要。思考文本提取与工具统计严格只读已同步历史；布局层仅对最新已结束回合额外消费粗粒度的 `backgroundTaskStatusMode`（`'waiting' | 'wakeup' | null`，严格来自权威 Core `sessionActivity` presence）以识别 `end_turn` 后的唤醒续流，避免提前结束或炸开平铺，同时不引入心跳抖动。第 2 排多行动态增高/缩回（含节流定时器异步触发）由 `EngineConversationScroller` 的行级 `ResizeObserver` 经 `ScrollController.onRowsResized`（`flushSync`）同步重算后续行（`subagent_tasks`、`footer`）偏移并保持自动吸底（`follow`）；同时 `ScrollController.preserveDisclosure` 标记被点击标题行为 dirty，使流式多行标题展开缩回时在点击同一 commit 内即完成重测，避免移动端误触发揭示跳动。
- **中途播报分段与权威后台唤醒续流折叠。** 当进行中的前台回合或最新已结束回合的权威活跃后台任务（`wakeup`，或该回合自身含中途正文后续工作 / 持久化 `backgroundTaskId` 工具时的 `waiting`）在可见进度播报正文之后继续产生思考/工具时，Option C 按全部非 notice 可见正文（保留流式 Codex `commentary` 原位可见，并跨越独立渲染的 `system_notice` 而不切断工作批次、丢失扫光或打乱展开行序）将活动组切分为独立工作批次，避免单一 live 头部倒挂在中途正文上方或因末尾非正文触发 `!shouldUseWorkedGroup` 炸开平铺：前段收起为 `已完成工作`，中途播报正文原位完整可见，后续工作在下方以独立的 Option C 双排 live 头部呈现（后台唤醒续流期间隐藏跨等待期失真的实时耗时，唤醒转入静默等待则收起为 `处理中`）。仅在开启 Option C 时，回合级于 `backgroundTaskStatusMode === 'wakeup'`（含迟到工具尚未落库或纯正文续流）及分段后台等待期压制终态 footer（时间戳/耗时/复制/Fork），关闭 Option C 保持上游原貌；单段答复后的 `waiting` 保持 `#2353` `已工作 <耗时>`，而真正中断或取消的回合（按尾部 `chat_failed` 通知或按 `userTurnId` 跨占位行与过滤索引判定，包括断线后仅剩 `commentary` 的尾巴）以及缺少权威 `backgroundTaskStatus` 的迟到纯工作尾巴均保持展开，待最终正文落地后再收起。各工作批次独立参与搜索自动展开与 `SelectionTurnLayout` 选区冻结；彻底收口且无后台任务后仍按 `#2353` 合并为单个 `已工作 <耗时>`（含在 `final_answer` 之上收起 `commentary`）。
- **始终生效的原生后台任务态。** 不挂在实验开关下，消费 Phase 1 提供的 `liveSessionStatus`（`backgroundTaskState: 'background' | 'running'`、`backgroundTaskCount`），并保持 `phase` 仅限 `'finalizing'` 以兼容混合版本 LAN 基准客户端：
  - 侧边栏会话行、折叠分组标记（`failed > waiting > working > background > sending > unread`）与 `SessionTabBar` 在静默后台等待期显示克制的后台呼吸环（`BackgroundStatusMark`，低刺激下静态），唤醒脉冲期（`backgroundTaskState: 'running'`）恢复活跃态指示。
  - 在已结束回合的最终回答下方，`BackgroundTaskStatusRow` 替换孤立的无计时「思考中」行，以零卡片零边框的不可展开纯排版单行（对齐 `conversation.railInset`）仅展示可靠的聚合 presence 信号：静默等待期显示柔和呼吸点 + `{{count}} 个后台任务运行中`（无 count 时 `后台任务运行中`），唤醒脉冲期显示轻扫光 `后台任务处理中`，不从历史命令倒推当前正在运行的任务。
  - 极简红线：`ChatComposer`（默认 placeholder、发送箭头 `↑`）与 `SessionTabBar` 右侧保持完全原样，不加教学文案、提示语、presence JSON 或轮询说明。

## 备选方案

- **在思考与跑工具切换时互换第 1/2 排的思考摘录与工具计数：** 每次启停工具都会导致视觉焦点上下跳动，且单行/两行截断会拦腰截断当前推理正文。
- **保留「工作了 X → 收起活动组」两层嵌套：** 回合结束后查看思考或工具输出需要连点两次，且增加冗余标题层。
- **流式自动展开活动组或在 ACP 流中改写思考为 commentary：** 会造成流式刷屏频闪，或把推理泄漏进 `lody_session_history` 并破坏 #2353 折叠边界。
- **在 `ChatComposer` 或 `SessionTabBar` 旁添加后台任务说明提示：** 破坏极简界面，且用户已能从呼吸环与底部状态行直观理解后台状态。

## 验证

- 纯函数整段提取（`inspectLatestThoughtParagraph`、`extractLatestCompactThoughtParagraph`）、旧版预览兼容、点号安全首句、read 聚合、工具计数与后台态解析：[streaming-thought-preview.test.ts](../../../../packages/components/tests/streaming-thought-preview.test.ts)。
- 固定双排实时头部（不互换位置、窄屏防挤压槽位、无截断多行思考正文、虚拟列表动态高度与自动吸底）、占位句过滤、单层目录与单条思考/read 聚合/工具展开、搜索自动展开、后台等待/唤醒行、侧边栏呼吸环、低刺激模式与实验开关关闭回归：[streaming-thought-preview-ui.test.tsx](../../../../packages/components/tests/streaming-thought-preview-ui.test.tsx)。
- 滚动引擎 `preserveDisclosure` 对流式多行标题展开缩回的同 commit 重测验证：[conversation-scroll-engine.test.ts](../../../../packages/components/tests/conversation-scroll-engine.test.ts)、[engine-conversation-scroller.test.tsx](../../../../packages/components/tests/engine-conversation-scroller.test.tsx)。
- 标签栏与会话列表后台态图标及子会话聚合：[session-tab-bar.test.tsx](../../../../packages/components/tests/session-tab-bar.test.tsx)、[session-list-rows.test.ts](../../../../packages/components/tests/session-list-rows.test.ts)。
- 覆盖 Option C 与原生后台态全场景的 Storybook（含低刺激与明暗主题）：[StreamingThoughtPreview.stories.tsx](../../../../packages/components/src/stories/StreamingThoughtPreview.stories.tsx)。
- 未在本次改动中验证：真实运行 daemon 下的 Antigravity ACP chunk 推送节奏与 iOS 原生会话渲染。
