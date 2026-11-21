# Antigravity ACP v1 后台工作与空闲 GC

Status: implemented
Translation: current

[English](2026-11-16-antigravity-background-wakeup.md)

## 摘要

`agy acp` 在后台工作仍在运行时就以 `end_turn` 结束 `session/prompt`，之后不再向 stdout
写入，于是 Lody 的空闲 GC 会杀掉仍在工作的进程。Lody 现在照常结束 turn，并在这些工作
唤醒模型、重新安静之前合成 Core `sessionActivity`，只使用无副作用的 `session/list` 轮询。
agy 在这些唤醒中产生的输出不会回放到 Lody：唯一能返回它的接口 `session/load` 会重启会话
的 MCP 服务器，并在真机运行中打断了一次工具调用。agy 1.5.10 及之后会即时发出这些输出。

## 问题

`agy acp`（`Antigravity ACP Server`，ACP v1）只要模型让出控制权就以 `end_turn`
结束 `session/prompt`，即使它启动的后台工作仍在运行：超过异步阈值的
`run_command`、`schedule` 定时器与 cron、`invoke_subagent` / `send_message`、
`swarm` 以及异步 `run_workflow`。这些工作结束后，agy 在自己的会话里唤醒模型，
但 agy 1.5.9 及之前直到下一个 prompt 都不再向 stdout 写 `session/update` 或
`session/request_permission`。更正：agy 1.5.10 及之后会立即发出，Lody 的迟到输出路由把它们
写进已结束的那一轮（[实测](../feature/2026-11-15-antigravity-agy-cli-acp.zh.md#发现)）。agy 没有声明
Core `sessionActivity` 扩展，所以 Lody 看到的是空闲会话，`SessionGCManager` 在空闲
超时后杀掉了仍在工作的进程。

## 决策

修复留在 `apps/cli/src/agent/`（`antigravity-background.ts` 与 `AgentClient`），复用
[Session GC 尊重原生 Agent 的工作](2026-10-18-gc-respects-native-agent-work.zh.md)
的原生工作契约：turn 在 `end_turn` 结束，由 `sessionActivity` 保持进程存活。

- **`end_turn` 时的待完成项。** 根据 turn 中实时收到的工具通知，Lody 按 `toolCallId`
  在 `pendingToolIds` 中追踪仍处于 `pending` 或 `in_progress` 的工具（首次 `tool_call`
  省略 `status` 时默认按 `pending` 处理），并在 `pendingWakeups` 中单独计数仅靠唤醒回报
  结果的工作：完整输出为独立单行 agy「running as a background task with task id: ...」
  占位文本的工具（排除读写/搜索/编辑/删除/移动/思考等非后台工具与多块输出），以及派出后
  只能靠唤醒模型报告结果的工具（`invoke_subagent`、`send_message`、`swarm`、没有输出的
  `run_workflow`）。同一个 `toolCallId` 在 `pendingToolIds` 与 `pendingWakeups` 之间
  严格互斥迁移，且仅唤醒项最多计一次。agy 会让 `schedule` 一直保持 `in_progress` 直到
  触发，所以定时器不需要特殊处理。`IsDaemon: true` 与失败的工具不计入。不解析 agy 工具参数。
- **按实时终态、活动与对账释放。** 存在待完成项时，Lody 每 2 秒查询一次 `session/list`，
  上报 `background`，`updatedAt` 变化或 `end_turn` 后收到实时唤醒事件期间上报 `running`。
  在 agy 1.5.10 及之后，终态 `tool_call_update` 会按 `toolCallId` 精准移除对应待完成
  工具，同时保留 30 秒静默窗口保护模型写完唤醒回复；同波合并唤醒中终结的多个工具会一并
  销账且不误扣其他未完成工具，唤醒期间新启动的后台工具也会纳入 `pendingToolIds` 或
  `pendingWakeups` 追踪，纯 `in_progress` 进度更新不会触发推断扣减。通过实时唤醒信号
  （模型唤醒回复或唤醒期辅助工具完成）结算 `pendingWakeups` 项时直接扣减 `pendingWakeups`，
  避免后续跨轮工具终态误将其撤回；一旦会话已观测到 `end_turn` 后实时流，迟到回复也不会
  误扣仍在运行的 `pendingToolIds`。对于 agy 1.5.9 及之前（不发送 `end_turn` 后工具更新）
  或无实时工具事件的纯轮询活动，符合条件的唤醒在静止 30 秒后累加 `inferredCompletions`
  （而非猜测删除某个 `toolCallId`），有效待完成数为
  `pendingToolIds.size + pendingWakeups - inferredCompletions`。当有效待完成数归零且
  不在唤醒窗口内时上报空闲；最长 24 小时，与 Core `background` 上限一致。当剩余待完成项
  缺少足够结算证据时（例如既无可用的实时结算信号也无 `session/list` 轮询活动，或多个匿名
  派发项合并在同一波唤醒中只结算了一项），监视器可持续保活至 24 小时上限。
- **跨 turn。** 用户发出新消息时，`pendingToolIds`、`pendingWakeups` 与
  `inferredCompletions` 会延续到新 turn，使之前的后台工作继续受保护；若新 turn 中途收到
  或补发先前 `toolCallId` 的终态 `tool_call_update`，会立即从 `pendingToolIds` 移除并
  对账抵消 1 笔先前轮询推断出的 `inferredCompletions`，避免同一次完成被重复扣减。
- **Presence 与工具调用元信息透传。** `AgentClient.getNativeWork()` 与 `onNativeWorkChanged`
  统一携带 `{ kind: 'running' | 'background'; backgroundTaskCount }`，覆盖 Antigravity 合成
  追踪器（未结算期间按 `Math.max(1, effectivePendingCount)` 上报，结算后归 `0`）与 Core
  `sessionActivity`。无活跃 turn lease 时，`session-active-presence.ts` 在后台等待期发布
  `{ type: 'running', backgroundTaskState: 'background', backgroundTaskCount }`，唤醒脉冲期
  发布 `{ type: 'running', backgroundTaskState: 'running', backgroundTaskCount }`
  （`running` 且计数为 `0` 时省略两个可选字段），计数上限 `1..999`，且仅在状态/计数变化或
  30s 心跳到期时写入。保持 `phase` 仅允许 `'finalizing'`，确保混合版本 LAN 的基准旧客户端剥离
  未知字段后仍稳定保留 `{ type: 'running' }` 而不丢弃整条 presence。在 Antigravity 工具通知上，
  `normalizeAntigravityToolNotification` 复用同一套严格的独立单行/单块占位检测（排除读写/
  搜索/编辑/删除/移动/思考等非后台工具与失败更新）提取任务 id 注入 `_meta.lody.backgroundTaskId`
  （超 128 字符直接拒绝不截断，经 `history-apply.ts` 单调持久化为 `tool_call.backgroundTaskId`），
  并补齐 PascalCase `CommandLine`/`Cwd`（`Path`/`TargetFile` 路径回退在 `tool-call-history.ts`
  中处理）。
- **`cwd`。** Lody 把工作目录的 `realpath` 作为 Antigravity ACP 的 `cwd` 协商；agy 按
  realpath 比较编辑目标，否则符号链接工作目录下的工作区内编辑也会要求审批。

## 已否决方案

- **从 `session/load` 快照回放唤醒输出。** 已实现并在真实 agy 1.5.7 与
  `gemini-4-hydrogen-medium` 上测试，回放本身可用。但每次加载都会停止并重启会话的 MCP
  服务器：按 6 秒节奏，125 秒内 19 次加载、20 次服务器启动。把加载限制为每分钟一次、
  且只在 `updatedAt` 静止 10 秒后进行，一次 30 秒的 MCP 工具调用仍在约 10.7 秒处被切断，
  以 EOF 返回 `failed`，因为工具运行期间 `updatedAt` 不会变化。从外部无法用任何时间规则
  区分「说完了」和「在等一个慢工具」。
- **加载时传空的 `mcpServers`。** 未经验证；agy 可能在会话剩余生命周期内卸下其 MCP 服务器。
- **直接读取 agy 磁盘上的会话记录。** 没有副作用，但格式没有文档，任何 agy 版本都可能改变。
- **保持 `session/prompt` 挂起直到后台工作完成。** 最多锁住输入栏 30 分钟，还需要第二套
  状态机；原生工作契约已经覆盖 turn 结束后的后台工作。
- **按 agy 工具参数计数**（`DurationSeconds`、`CronExpression`、`MaxIterations`、swarm
  `tasks`/`n`、`manage_*` kill）。agy 一改参数计数就会出错。
- **`end_turn` 后发送合成 prompt 或 steer。** 根 `AGENTS.md` 禁止引导 agent 的文本。
- **在 `SessionGCManager` 或 `MessageHandler` 中特判 Antigravity。** 这些消费者保持与
  提供方无关。

## 验证

`apps/cli/src/agent/antigravity-background.test.ts` 用真实 `AgentClient` 对接模拟的
`session/list`，固定以下行为：turn 在 `end_turn` 结束、静默工作在空闲超时之后仍受保护、
每个待完成项对应一次唤醒、24 小时上限、`session/list` 失败时继续保护、守护进程与失败工具
排除、跨新消息延续、`realpath` 协商，以及从不调用 `session/load`。真机运行覆盖的是本 note
否决的回放设计；仅按活动释放的规则尚未在真实 agy 上运行。

## 局限

- agy 1.5.9 及之前，agy 在 `end_turn` 之后写出的输出要等下一个 prompt 才到 Lody，落进新的一轮；
  进程先被替换时则永远不会到。agy 1.5.10 及之后会立即发出。
- 对于没有终态工具更新的仅唤醒派发任务或 agy 1.5.9 及之前版本，多个待完成项在同一段活动中
  唤醒 agy 时仍只会释放一项，会话会一直受保护，直到下一段活动或 24 小时上限。在 agy 1.5.9
  及之前，模型在唤醒中新启动的工作要到下一轮才可见，因此不会计入；agy 1.5.10 及之后会实时
  推送这些工具通知并纳入追踪。
- agy 1.5.9 及之前，`end_turn` 后等待 agy 未转发的权限请求的工具，仍会卡住该 agy 会话，直到
  用户取消；`realpath` 协商消除了最常见的触发原因。agy 1.5.10 会转发该请求。
- 由于 `updatedAt` 与模型文本回复都不携带任务归属，若已追踪的带 ID 工具在终结同波已推进
  `updatedAt`，而模型超过 `wakeupQuietMs`（30 秒）后才发出迟到回复，且此时并行存在仅唤醒
  派发项，协议输入上无法将该迟到回复与并行匿名派发项的独立完成区分（沿用既有 `wakeupQuietMs`
  波次结算约定）；反之，若该工具终结同波既无模型输出也未推进 `updatedAt`，后续首次唤醒回复会
  保守归属给该工具，以继续保护并行匿名派发项。
