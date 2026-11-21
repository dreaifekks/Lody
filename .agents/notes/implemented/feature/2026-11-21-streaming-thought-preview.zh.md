# 极简原生流式推理目录与原生后台任务态

Status: implemented
Translation: current

[English](2026-11-21-streaming-thought-preview.md)

## 摘要

主要通过 `agent_thought_chunk` 输出过程说明的 agent（尤其是 Antigravity CLI）在长工具循环中仅显示收起的计数标题，且回合结束后展开过程需要点穿「工作了 X → 收起的活动组」两层套娃；同时，主回合已结束但后台任务仍在运行（`running + backgroundTaskState: background`）时，原有界面会在最终回答下方留下无计时的孤立「思考中」行与活跃旋转图标。本 fork 落地两项改动：（1）挂载在设备级实验开关 `streamingThoughtPreviewFeatureEnabledAtom` 下的 Option C 极简原生 2 行流式摘要与单层过程目录；（2）始终生效的侧边栏、顶部标签栏与对话流底部原生后台任务态。真实 daemon 的 chunk 推送节奏与 iOS 原生渲染不在本次改动范围内。

## 决策

将改动拆分为独立模块：实验开关门控的纯展示升级（`streaming-thought-preview.ts`、`compact-native-directory.ts`、`compact-native-directory-row.tsx`）与始终生效的原生后台态展示（`background-task-status-row.tsx`、`working-status-mark.tsx`、`session-list-rows.ts`、`sidebar-row-shared.tsx`、`session-tab-bar.tsx`），并在 `view.tsx` 保持最小接线面。

- **前置同步上游 #2896。** 先 cherry-pick 上游 `1c2a979cb`（使流式状态与流式思考共享同一虚拟行测量边界），减少后续合并上游 `view.tsx` 时的冲突面。
- **Option C 流式 2 行分工（跨 provider 统一）。** 开启 `streamingThoughtPreviewFeatureEnabledAtom` 时生效，关闭时 100% 保持上游原貌：第 1 行（13px，外层 `.agent-shimmer` 包裹内层 flex 截断容器，确保 390px 窄屏下尾部耗时完整可见；低刺激模式关扫光与展开过渡）在存在进行中非后台工具时显示 `运行中 <目标>（<耗时>）`，否则在有有效思考时显示 `思考中 · <首句摘录>（<耗时>）`，仅起手占位句时显示 `思考中…（<耗时>）`；第 2 行（12px 次级灰，单行截断，绝不画第 3 行）在调工具时保留上一句有效思考摘录（无多余前缀），思考中且已有已完成/后台工具时显示紧凑工具计数，尚未调用工具时不渲染。
- **单层展开过程目录。** 点击流式摘要行或回合结束后的原生标题 `工作了{{duration}}`（不加 token 统计或多余说明），一步直达平铺单层目录，消灭两层套娃：每段有效思考默认收成单行首句摘录并自动剥离 Antigravity 占位句（多于 1 段有效思考时顶部右侧提供轻量的「展开全部思考 / 收起全部思考」按钮）；连续多个已完成的非后台 `read` 工具按首个工具稳定标识聚合为一行（流式追加第 3 个读文件不丢展开态）；带输出/diff 详情的单条 `read`/`edit` 行在点击整行展开详情的同时保留独立可点击文件名以打开源文件；其他工具点击整行原地展开详情（无「查看输出」徽章），带持久 `tool_call.backgroundTaskId` 的命令展示中性历史 `后台` / `BG` 微标（不绑定实时 presence）。完整保留 #2353 回合结束折叠、按 `sessionId + messageId` 分区隔离 Fork 会话的手动展开缓存、与占位句剥离一致的思考搜索索引及低刺激规则。
- **安全提取与防闪烁。** 复用 `streaming-thought-preview.ts` 的单遍 O(n) 扫描（跨段 HTML 注释跟踪、未闭合 `**` 行界判定、1024 字符有界行内 Markdown 清洗、保护 `view.tsx`/`v2.1` 等点号的首句截取，以及 1500 ms / 低刺激 4000 ms 停留节流）。Option C 严格只读已同步历史，不读 presence，避免重现上游 #807 的心跳拥堵。
- **始终生效的原生后台任务态。** 不挂在实验开关下，消费 Phase 1 提供的 `liveSessionStatus`（`backgroundTaskState: 'background' | 'running'`、`backgroundTaskCount`），并保持 `phase` 仅限 `'finalizing'` 以兼容混合版本 LAN 基准客户端：
  - 侧边栏会话行、折叠分组标记（`failed > waiting > working > background > sending > unread`）与 `SessionTabBar` 在静默后台等待期显示克制的后台呼吸环（`BackgroundStatusMark`，低刺激下静态），唤醒脉冲期（`backgroundTaskState: 'running'`）恢复活跃态指示。
  - 在已结束回合的最终回答下方，`BackgroundTaskStatusRow` 替换孤立的无计时「思考中」行，以零卡片零边框的不可展开纯排版单行（对齐 `conversation.railInset`）仅展示可靠的聚合 presence 信号：静默等待期显示柔和呼吸点 + `{{count}} 个后台任务运行中`（无 count 时 `后台任务运行中`），唤醒脉冲期显示轻扫光 `后台任务处理中`，不从历史命令倒推当前正在运行的任务。
  - 极简红线：`ChatComposer`（默认 placeholder、发送箭头 `↑`）与 `SessionTabBar` 右侧保持完全原样，不加教学文案、提示语、presence JSON 或轮询说明。

## 备选方案

- **保留「工作了 X → 收起活动组」两层嵌套：** 回合结束后查看思考或工具输出需要连点两次，且增加冗余标题层。
- **流式自动展开活动组或在 ACP 流中改写思考为 commentary：** 会造成流式刷屏频闪，或把推理泄漏进 `lody_session_history` 并破坏 #2353 折叠边界。
- **在 `ChatComposer` 或 `SessionTabBar` 旁添加后台任务说明提示：** 破坏极简界面，且用户已能从呼吸环与底部状态行直观理解后台状态。

## 验证

- 纯函数提取、点号安全首句、read 聚合、工具计数与后台态解析：[streaming-thought-preview.test.ts](../../../../packages/components/tests/streaming-thought-preview.test.ts)。
- 流式 2 行分工、占位句过滤、单层目录与单条思考/read 聚合/工具展开、搜索自动展开、后台等待/唤醒行、侧边栏呼吸环、低刺激模式与实验开关关闭回归：[streaming-thought-preview-ui.test.tsx](../../../../packages/components/tests/streaming-thought-preview-ui.test.tsx)。
- 标签栏与会话列表后台态图标及子会话聚合：[session-tab-bar.test.tsx](../../../../packages/components/tests/session-tab-bar.test.tsx)、[session-list-rows.test.ts](../../../../packages/components/tests/session-list-rows.test.ts)。
- 覆盖 Option C 与原生后台态全场景的 Storybook（含低刺激与明暗主题）：[StreamingThoughtPreview.stories.tsx](../../../../packages/components/src/stories/StreamingThoughtPreview.stories.tsx)。
- 未在本次改动中验证：真实运行 daemon 下的 Antigravity ACP chunk 推送节奏与 iOS 原生会话渲染。
