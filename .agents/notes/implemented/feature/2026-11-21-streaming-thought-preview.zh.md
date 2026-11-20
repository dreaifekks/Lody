# 收起活动组标题下的流式思维预览

Status: implemented
Translation: current

[English](2026-11-21-streaming-thought-preview.md)

## 摘要

主要通过 `agent_thought_chunk` 输出过程说明的 agent（尤其是 Antigravity CLI）在长工具循环中会把相邻思考和工具合并为一个默认收起的活动组，导致流式期间只能看到计数标题。本 fork 新增了一个设备级实验开关控制的纯渲染层两行预览，在回合进行中显示于末尾收起活动组标题下方。该实现直接读取已同步的回合历史而非 presence 通道，保留回合结束后的既有折叠行为，并联动低刺激模式。真实会话的 chunk 粒度与 iOS 原生渲染不在本次改动范围内。

## 决策

将能力完全限制在前端渲染层（`streaming-thought-preview.ts` 与 `streaming-thought-preview-row.tsx`，`view.tsx` 仅做最小接线），由设备级实验开关 `streamingThoughtPreviewFeatureEnabledAtom`（`lody-streaming-thought-preview-enabled`）控制。

- **前置同步上游 #2896。** 先 cherry-pick 上游 `1c2a979cb`（使流式状态与流式思考共享同一虚拟行测量边界），保证流式状态与思维预览位于同一测量边界内，并减少后续合并上游 `view.tsx` 时的冲突面。
- **全 provider 统一、纯展示边界。** 对末尾收起活动组的 `block.entries` 逆序查找最新一条 `thought`，不按 provider 或模型分支；不改存储历史、不改 ACP 适配器、不走 presence，也不改变 #2353 回合结束后的折叠规则。
- **规避 #807 问题。** 上游 #807 曾跳过历史并把思考经实时状态推送，导致心跳拥堵被撤回（#852）。直接读取已同步历史既保留完整思考记录，也天然支持 LAN 远端会话。
- **138k 大文本与流式半截保护。** 采用无回溯线性逆序扫段与尾部窗口截断，避免长思考卡顿；过滤 Antigravity 占位句（`"I'm thinking through how to approach this."`）、HTML 注释与行首未闭合的 `**` 半截加粗标题，清理行内 Markdown 同时保留 `snake_case` 标识符，长度上限 260 字符，界面侧对齐 `conversation.railInset`、`line-clamp-2`、`select-none`、无卡片底色与新增动画。
- **防闪烁与低刺激节奏。** 相同文本去重且不重置计时器；常规模式每句至少停留 1500 ms，低刺激模式（`lowStimulusModeEnabledAtom`）拉长至 4000 ms，停留期内多次更新合并到最新一段；未闭合半截行在同组内保留上一条有效预览，切换组立即重置。行匹配不强依赖 `agentActivityShimmer`，低刺激与无 shimmer 态下仍正常显示；手动展开或回合结束后立即隐藏。

## 备选方案

- **流式时自动展开含思考的活动组：** 会连同大量工具行和数千字思考正文一起摊开，造成刷屏与频闪。
- **在 ACP 流中将 Antigravity 思考改写为 commentary 文字：** 会把全部推理暴露给 `lody_session_history`，在思考紧贴最终回答的回合里破坏结束后折叠边界，反复触发未读标记，并永久改变存储语义。
- **经 presence 推送最新思考：** 会重现导致上游 #807 撤回的心跳拥堵风险。

## 验证

- 纯函数提取、占位句/注释/未闭合加粗保护、138k 大文本性能边界、调工具期间保留思考与行匹配逻辑：[streaming-thought-preview.test.ts](../../../../packages/components/tests/streaming-thought-preview.test.ts)。
- 1500 ms / 4000 ms 节流与低刺激模式、去重、切组重置、同虚拟行测量、手动展开与回合结束隐藏、实验开关接线：[streaming-thought-preview-ui.test.tsx](../../../../packages/components/tests/streaming-thought-preview-ui.test.tsx)。
- 视觉隔离场景（纯思考、工具保留思考、手动展开、低刺激、回合结束、开关关闭）：[StreamingThoughtPreview.stories.tsx](../../../../packages/components/src/stories/StreamingThoughtPreview.stories.tsx)。
- 未在本次改动中验证：真实运行 daemon 下的 Antigravity ACP chunk 推送节奏与 iOS 原生会话渲染。
