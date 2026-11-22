# Antigravity ACP v1 后台工作与空闲 GC

Status: implemented
Translation: current

[English](2026-11-16-antigravity-background-wakeup.md)

## 摘要

`agy acp`（`Antigravity ACP Server`，ACP v1）在后台工作仍在运行时就会以 `end_turn` 结束
`session/prompt`，且未声明 Core `sessionActivity`。Lody 曾尝试通过 stdout 工具通知启发式计数、
占位文本正则与 `session/list` `updatedAt` 轮询来合成 `sessionActivity` 及
`_meta.lody.backgroundTaskId`，现已对齐上游 `#3097` 彻底移除：实机 `agy 1.5.14` 线级实测与线上
故障均证实，占位文本与 `<SYSTEM_MESSAGE>` 只留在 `agy` 内部 transcript 而不走 ACP 线路，启发式
误计数会导致会话卡在 `running`（“工作中”）状态、抑制未读/完成通知，并持续每 2 秒轮询
`session/list` 长达 24 小时。现仅保留确定性的 Antigravity 兼容逻辑（`isAntigravityServer`、
`realpath` `cwd` 协商、`session/resume` 优先、`CommandLine`/`Cwd` 与 `Path`/`TargetFile`
规范化），仅在服务端权威声明时消费 Core `sessionActivity` v1 与 `_meta.lody.backgroundTaskId`，
并在 `MessageHandler.enqueueACPUpdate` 对所有实时 post-turn 模型/工具输出无条件刷新空闲 GC 计时。

## 问题

`agy acp` 不声明 Core `sessionActivity`（`_lody/session/activity_update`）。`agy 1.5.14`
线级实测与线上案例推翻了旧启发式追踪器的全部前提：

- `run_command` 与 `schedule` 转后台的占位文本（`Tool is running as a background task with
  task id: ...`）只写入 `agy` 内部 `transcript.jsonl`，ACP JSON-RPC 线上不会发出占位
  `tool_call_update`（原 `tool_call` 保持 `in_progress` 直到真正 `completed`/`failed`）；
  `BG_TASK_PLACEHOLDER_*` 正则在真实后台命令上不会命中，反而会在命令输出包含源码/日志时误触发。
- `<SYSTEM_MESSAGE>` 唤醒通知从不通过 ACP 的 `user_message_chunk` 发送。
- `invoke_subagent` / `send_message` / `swarm` 派发瞬间即返回 `status: "completed"`，且可在同
  turn 内直接续吐正文而无 `tool_call_update` 或 `agent_thought_chunk`，导致 `pendingWakeups`
  永久泄漏至 24 小时上限。
- `agy 1.5.10+` 的 `end_turn` 后唤醒流没有封口边界帧（慢工具与长思考期间 `session/list` 的
  `updatedAt` 亦静止），任何固定静默计时器都无法区分“仍在工作”与“已结束”。
- 把不可靠的启发式接入 `AgentClient.reportsSessionActivity()` / `getNativeWork()` 后，
  `SessionActivePresence` 会持续广播 `running`（UI 卡在“工作中”），`SessionExecutionService`
  会抑制完成通知并在超时后写出误报的 `nativeWorkInterrupted`，且后台每 2 秒轮询一次 `session/list`。

## 决策

- **移除启发式 `sessionActivity` 与占位符 `backgroundTaskId` 合成（对齐上游 `#3097`）。**
  从 `antigravity-background.ts` 与 `agent-client.ts` 删除 `AntigravitySessionTracker`、
  `runAntigravityPollLoop`、`BG_TASK_PLACEHOLDER_LINE_PATTERN` 与
  `extractAntigravityBackgroundTaskId`。`AgentClient.reportsSessionActivity()` 仅在 agent
  权威声明 Core `sessionActivity` v1 时返回 `true`。在 `agy` 未提供权威活动协议之前，turn 在
  `end_turn` 正常结束并沿用标准空闲 GC，与
  [Session GC 尊重原生 Agent 的工作](2026-10-18-gc-respects-native-agent-work.zh.md) 一致。
  `packages/shared` 与 `packages/components` 中基于权威 Core `sessionActivity` v1 的 presence
  （`backgroundTaskState`、`backgroundTaskCount`、`BackgroundTaskStatusRow`、侧栏呼吸环）及
  `_meta.lody.backgroundTaskId` 契约完整保留，继续服务 Claude、DeepSeek Harness 及未来声明
  Core `sessionActivity` v1 的 `agy` 版本。
- **实时 post-turn 输出无条件保活空闲 GC。** `MessageHandler.enqueueACPUpdate` 在收到路由至
  `finalized_turn` 的实时模型/工具输出（`agent_message_chunk`、`agent_thought_chunk`、
  `tool_call`、`tool_call_update`、`subagent_event`、`plan`、`plan_update`、`plan_removed`）
  时无条件调用 `touchSession(sessionId)`（不再门控于 `reportsSessionActivity()`），防止
  `agy 1.5.10+` 在唤醒实时吐字或跑工具中途被 20 分钟空闲 GC 回收；纯元信息通知
  （`session_info_update`、`available_commands_update` 等）不刷新空闲计时。
- **保留确定性的 Antigravity 兼容逻辑。** `antigravity-background.ts` 保留 `isAntigravityServer`
  （内置 `antigravity` 与自定义 `Antigravity ACP Server` 对齐，排除旧版 `antigravity-acp`），
  `AgentClient` 保留 `realpath` `cwd` 协商、`session/resume` 优先于 `session/load`、`toolName`
  投影及 PascalCase `CommandLine`/`Cwd` 规范化（与 `tool-call-history.ts` 的 `Path`/`TargetFile`
  路径回退配合）。

## 已否决方案

- **基于 stdout 工具通知 + `session/list` 轮询合成 `sessionActivity`。** 2026-11-16 实现、
  2026-11-22 移除：缺乏服务端权威任务计数时，误报会让会话卡在“工作中”长达 24 小时。
- **从 `session/load` 快照回放唤醒输出。** 在真实 `agy` 1.5.7 上验证过：每次 `session/load`
  都会重启会话的 MCP 服务器，打断正在运行的工具调用。
- **直接读取 `agy` 磁盘上的会话记录。** 属于无文档内部格式，随版本变化不可依赖。
- **挂起 `session/prompt` 或在 `end_turn` 后发送合成 steer。** 会锁住输入栏或违反根 `AGENTS.md`。

## 验证

`apps/cli/src/agent/antigravity-background.test.ts` 驱动真实 `AgentClient`，固定以下契约：
内置/自定义 `Antigravity ACP Server` 对齐并排除旧版 `antigravity-acp`；`CommandLine`/`Cwd` 与
`toolName` 规范化；未声明 Core `sessionActivity` 时 `end_turn` 后绝不合成 `nativeWork`、
占位 `backgroundTaskId`，也不轮询 `session/list` / `session/load`；若服务端权威声明 Core
`sessionActivity` v1 与 `_meta.lody.backgroundTaskId` 则正常消费；以及 `realpath` `cwd` 协商。
`apps/cli/tests/message-handler-acp-batching.test.ts` 固定了实时 post-turn 输出不受
`reportsSessionActivity()` 限制均刷新空闲 GC 计时、纯元信息通知不刷新的行为。
