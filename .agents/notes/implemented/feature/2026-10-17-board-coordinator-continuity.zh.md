# 看板协调者的连续对话：空闲整理与开始新对话

Status: implemented
Translation: current

[English](2026-10-17-board-coordinator-continuity.md)

## 摘要

看板协调者是一段长期的对话，模型上下文却不能无限变长，而原生自动压缩来得太晚，还会把只在
第一条消息里的看板说明压成转述。现在协调者空闲 10 分钟、上下文超过 min(150K, 窗口 40%) 时，
Lody 在同一个会话里依次跑三个安静的维护回合：整理记忆、`/compact`、带上当前看板说明的续接；
用户也可以手动整理，或开始一段新的 agent 对话。会话 id 始终不变，所以 Inbox、回报游标、笔记
权限和线程归属都不用迁移；代价是压缩质量仍归 agent 管，没有声明压缩能力的 agent 只能跳过。

## 决定与证据

接续[协调者的连续对话](../../../../specs/project-coordinator/coordinator-continuity.zh.md)
的方案 B 和用户 2026-10-17 的决定，那里的「实现」一节记了和提案不同的地方。

- **在哪里做**：协调者机器的 Host-lease Worker。`BoardContinuityWorkflow` 由
  `CoordinatorWorkflow` 持有，在看板回报之后、唤醒 Inbox 之前 reconcile，复用回报观察器对
  协调者历史的订阅和 `CoordinatorActivity` 的定时器，不新增传输或持久状态表。
- **维护回合在 Inbox 之外**：新的派发来源 `maintenance` 只有 assistant 条目、没有派发指针，
  跳过 Inbox 的受理和批次，结束时不写 `lastMessageAt`、不推送，然后唤醒 Inbox 和派发检查。
  另一个选择是把它做成 Inbox 的新输入类别，但那要改上游 SQLite 的受理和合批规则，而且 `task`
  输入会把排队的结果合进 `/compact` 的提示里。
- **状态都在历史里**：分隔线是一条系统回合，记种类、触发、状态、前后用量和是否已续接；手动
  请求就是一条 `requested` 状态的分隔线。Worker 读历史末尾 50 行判断「上次维护之后有没有新
  对话」，不需要内存外的状态，重启后把残留的 `running` 改成 `interrupted`。
- **重新注入**：压缩后紧接一个续接回合，提示由执行服务从当前看板行生成，和成员第一条消息同一个
  入口（`boardPromptContext` + `buildPrompt`）。没有改动给用户回合和 Inbox 批次组装提示的路径。
- **开始新对话**：同一个 Lody 会话，旧 agent 写交接文件，执行服务退掉旧 ACP 会话、新开一个，
  不续接也不重放历史，第一条消息带看板说明和交接事实。没有用 fork 或换代，因为它们都会换掉
  看板以之为锚的会话 id。
- **MCP 选择**：维护回合和新 agent 对话按对话追问的规则取选择：本对话最近记录的选择，
  没有就用工作区默认。只读驱动回合会在 Inbox 回合之后拿到空选择，新 agent 就没有工作区 MCP。
- **保底**：协调者进程的环境里设 `CLAUDE_CODE_AUTO_COMPACT_WINDOW=300000`。

前台回合释放后，只要原生后台工作尚未完成，原回合仍持有延后的完成发布。
Board 维护通过 `hasPendingNativeWork` 将其视为忙，并复用既有忙碌复查；否则维护回合会
撤回用户回合延后的未读与推送，甚至在后台工作运行时退役 agent。无需新增队列或定时器。

## 行为契约

| 问题     | 契约                                                                                                                                                                                                                                   |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 触发     | 协调者历史变化、`board-idle` 定时器或 30 秒的忙碌复查唤醒 reconcile。每个协调者同时最多一个运行，由 Worker 内的 `running` 集合保证；新的手动请求让旧的未处理请求作废。                                                                 |
| 所有者   | 运行是 Worker Scope 里 fork 出来的 fiber；回合本身归执行服务，和其他可见回合一样。维护回合的 Promise 不进 `rawWork`，所以 Worker 停止不会等它。                                                                                        |
| 取消     | Worker 停止只中断等待，不取消正在跑的回合；用户按 Stop 只取消当前步骤（维护回合没有 Inbox execution，不暂停 Inbox），运行记为 `interrupted`；Inbox 已暂停时不再自动整理。                                                              |
| 交接     | 每一步之前检查活动回合、尚待发布完成的原生后台工作、等着的用户回合和 Inbox；有就让路。新对话从交接开始由执行服务挡住 Inbox 批次，直到新 agent 第一回合结束；新回合被用户回合抢先时记为待切换（`running` 加 `handoff`），空闲后接着做。 |
| 失败恢复 | reconcile 出错时只记警告，30 秒后复查，不影响回报和 Inbox；运行失败记在分隔线上；压缩没有确认就记 `failed`，不显示「已整理」；续接没开始（`duplicate` 等）记 `renewed: false`，空闲时补，回合本身失败才记原因并停止重试。              |

## 验证与限制

- `operation-coordinator.test.ts` 的「Board coordinator continuity」用真实的 Inbox、Loro 历史和
  注入时钟；`session-execution-service.test.ts` 的「Board maintenance turns」检查执行服务的边界；
  另有共享层策略和会话流构建的测试。
- 没有在真实 agent 上跑过完整流程。Codex 的 `/compact` 不接受保留清单；Kimi 的压缩在后台完成，
  多半会记为未确认；Grok 没有声明压缩能力。看板上没有运行中的 agent、缓存的命令里也没有
  `compact` 时，自动整理会跳过。
- PR：待补（随 `board-coordinator` 分支的 PR #53）。

## 后续决定（2026-10-20）：空闲整理算上待送达回执

看板回执是被动的：协调者空闲时它们堆在 Inbox 里，等下一条输入一起送达。用户的实际用法是同时在
几个线程里推进好几个需求，十几二十个回执会一起涌进主线程。所以空闲判断改成
`used + pending >= 阈值`：`pending` 是协调者所属用户在 Inbox 里还没有批次认领的结果（和下一条
输入一样按用户取、最多 50 条），按 `batchPreview` 实际产出的文本（上限 64 KiB）用
`estimateTokenCount` 估算。取数是 `CoordinatorBoardMaintenance.pendingTokens`，
不新增触发：回执写入 Inbox 的同一次 reconcile 里会重跑空闲判断（`coordinator-workflow.ts` 先跑看板
回报再跑连续性）。窗口比例可以配到 95%，所以不能指望阈值以下的余量装得下这些回执。
上一次整理之后协调者没有新活动时不重新判断，即使回执越堆越多：压缩只能缩已有的上下文，
回执要到下一条输入才进来，刚压缩过再压一次几乎省不下什么。

考虑过把回执批次放到当前请求之前；用户决定保持上游顺序（请求在前、回执在后）。

## 修复（2026-10-21）：GC 卸载协调者文档后，手动请求不开跑

现象：协调者空闲被 GC 清理后，用户点「立即整理上下文」，界面一直显示整理中，直到用户再发一条消息。
devNuc 上 algorithm 看板的持久化历史里，11:49 和 12:09 两条手动请求一直是 `requested`；
13:00 跑完的那次是另一个 runId 的空闲整理，它的分隔线一条也没落盘。

根因：回报观察器给每个看板会话只开一次 `SessionDocument` 并订阅它的历史。`cleanSessionDoc`
（GC、归档、派发清理都走它）销毁这个实例、把它移出缓存，之后的写入进的是仓库里新的副本，旧实例
既收不到变化，也不再落盘。手动请求只写历史、不改元数据，所以没有任何东西唤醒 reconcile。
用户发消息改了元数据，reconcile 才跑，但读写的仍是旧实例：它看不到请求，最后一条活动还是 09:36，
「空闲三个多小时」加上那一轮把用量推过 15 万，于是马上开跑空闲整理，分隔线写进了旧实例。

修法：`LoroDocumentManager.onSessionDocReleased` 在 `cleanSessionDoc` 销毁并移出缓存之后通知；
`CoordinatorHistory.observe` 收到自己会话的释放就唤醒一次，`released()` 读实例的 `isDestroyed`；
回报观察器在 `refresh` 里丢掉已释放的观察，按成员资格重新打开并订阅。重新打开发生在释放之后的
那次 reconcile 里，所以之后的写入（包括渲染端的手动请求）照常唤醒，读写的也是仓库的当前副本。
考虑过让 GC 跳过看板会话的文档：只能挡住 GC，归档和派发清理照样会让观察失效，还要让 GC 知道
看板。代价是看板会话的文档在 GC 后会重新载入（agent 进程照样退出），这和 Worker 启动时打开
所有看板成员的做法一致。
回报观察器只在 Worker Scope 上挂一个 finalizer，关闭时退订还剩下的订阅；提前退订的订阅自己从集合里
删掉，所以重复的 GC 和成员变化不会让 Scope 一直拿着旧文档（交叉审查发现，之前每次订阅都挂一个）。

界面：`requested` 分隔线改为「已请求整理 · 协调者空闲后开始」（新对话同理），和 `running` 的
「正在整理上下文…」分开。

测试：「Board coordinator continuity」新增一个用真实 `LoroDocumentManager` 的用例：
`cleanSessionDoc` 之后不用测试唤醒，只靠释放通知和写入本身，手动请求就开跑并在仓库副本里记成
`done`。撤掉 `refresh` 里的重新打开，这个用例会失败。

没有改：`CoordinatorWorkflow` 对 Operation 目标会话的历史订阅（`subscriptions`）同样不会在释放后
重建，那条链路靠 SQLite 和元数据唤醒兜着，这次不动。

## 后续决定（2026-11-19）：开始新对话时可以换 agent

已有会话的 agent 是固定的，协调者的模型只能在它最初的 agent 里换。桌面上的「开始新对话」现在先
弹出对话框（`BoardNewConversationDialog`），默认选中协调者当前的 agent 和输入框显示的设置；用户
可以换成协调者所在机器上的其他 agent 配置，以及它的模型、模式和选项。选择随请求分隔线记为
`agent`（`BoardCoordinatorAgentSchema`：定时任务的 agent 去掉记忆绑定）。交接仍由旧 agent 用原来
的设置写。新 agent 的第一回合（`renew`）拿到会话之后、启动任何 agent 之前，
`runBoardMaintenanceTurn` 才写会话的 `agentConfigId`、`cliType` 和 `agentType`
（`SessionDocument.setAgentConfig`），于是它启动的 agent 和之后每一回合都按新配置解析。同一次
写入去掉旧 agent 的会话 id（`acpSessionId`），因为别的 agent 无法恢复它；维护回合要恢复的会话也只看
会话本身，不再沿用驱动它的用户回合里的 `resume`（两处都是审查中发现的：新 agent 启动失败后，下一回合
或之后的整理上下文会把旧 id 交给新 agent 去恢复）。所以启动失败或被停止后，会话停在新 agent 上、没有
agent 对话：用户下一回合用历史重建对话来启动它，再开一次新对话则不写交接、直接新开。机器、项目
范围和看板说明不变。

为什么等到那时：已经排队的用户回合带着旧 agent 的类型，元数据提前切换的话它会因
`agent_type_mismatch` 失败。用户回合先到的话照常由旧 agent 回答，切换在协调者空闲后接着做。

新设置在用户下次说话之前放在哪里：输入框只在运行时基线挂在最近一条用户回合上时才用它，所以新
agent 的第一回合把它实际生效的设置记到那条回合上（`runtimeConfigTurnId`，即会话的
`latestUserMsgId`），输入框不用加新规则就显示选中的模型。用户下次说话之前的维护回合，从驱动回合
之后的 `renew` 条目找到切换，再读它的分隔线（`switchedAgent`）。按分隔线自己的位置判断被否掉了：
切换挂起期间跑过的用户回合在分隔线之后、切换之前。输入框直接读分隔线也因同样的原因否掉，而且
输入框只拿得到历史的尾部。

没有做：不开新对话的切换（旧的 agent 对话换了 agent 接不上）；看板设置里的「默认协调者
agent」，换 agent 总要开新对话，那会是同一件事的第二个入口；手机菜单仍沿用当前 agent 开始新对话。
还没有用户回合的协调者没有回合可挂基线，输入框显示新 agent 的默认模型。Mirror 读回存储的 map 时带
一个继承来的 `$cid`，record 解析会把它拷进来，所以 schema 从 `configOptionValues` 里去掉它，否则它
会作为选项发给 agent。

测试：`operation-coordinator.test.ts` 的「Board coordinator continuity」（交接用旧设置，新对话和
之后的维护用选中 agent 的设置），「SessionExecutionService Board maintenance turns」（启动 agent
之前切换元数据，基线挂到最近一条用户回合；agent 配置被删时会话保持原样；维护回合不沿用驱动回合的
`resume`），「SessionDocument
agent switch」（旧会话 id 随切换去掉），以及 `board-overview.test.tsx` 里头部菜单的用例。在临时
桌面实例上用两个脚本化 agent 端到端跑过；还没有在真实 agent 上跑过。

## 修复（2026-11-22）：Antigravity 协调者的空闲自动压缩

现象：托管版与存量 registry 版 Antigravity（`agy 1.5.10`）作为看板协调者时，空闲自动压缩总是被跳过。

实测事实：对托管的 `antigravity 1.5.10` 实测确认，它在 `available_commands_update` 里上报了 `compact`
命令；收到带说明文本的 `/compact <说明>`（即 `COMPACT_PROMPT`）时，会在同一次 `session/prompt`
返回前同步完成压缩并执行后续确认回复，从而在回合结束前推送下降后的 `usage_update`（实测下降比例远低于
`USAGE_DROP_PROOF` 0.8）。边界在于裸 `/compact`（无后续文本）虽同步压缩，但当回合不触发第二次模型调用，
`usage_update` 要到下一回合才刷新，会触发 `compaction-unconfirmed`；因此 `COMPACT_PROMPT` 必须保留
`/compact` 后的说明文本。

根因（两处断层）：

1. **活进程断层**：`AgentClient.supportsContextCompaction()` 只认 `_meta.lody.compaction?.version === 1`；
   闭源 `agy` 在 `initialize` 中只发 `_meta.antigravity`，不发 `_meta.lody.compaction`，活进程恒返回 `false`。
2. **无活进程回退断层**：空闲 GC 或守护进程重启后没有活进程，`coordinator-sessions.ts` 回退查 Machine Flock
   的 `acpCapability.availableCommands`；由于 `agy` 通过异步 `available_commands_update` 推送命令而不写在
   `NewSessionResponse`，`acp-capabilities.ts` 的能力探测不从异步 `available_commands_update` 通知中采集
   `compact`，导致缓存里没有 `compact`，回退返回 `undefined`。同时 `AcpCapabilityCacheEntrySchema` 使用了
   `.strict()`，不能靠新增缓存字段解决，否则会破坏混合版本 LAN 节点的 `acpCapability` 同步。

修法：

- 在 `apps/cli/src/agent/antigravity-acp-stream.ts` 的 `withAntigravityAcpStream` 兼容层里传入
  `cliType`，入口保持原有的 `isAntigravity(agentType)`（保留既有 YOLO 与 `mcpCapabilities.http` 兼容），
  仅在 `initialize` 响应注入 `_meta.lody.compaction: { version: 1 }` 时按 `isAntigravityProvider(cliType, agentType)`
  收口（仅匹配 `builtin/antigravity` 与 `registry/antigravity-acp`，活进程与离线均不对 `custom/antigravity`
  注入或回退 compaction），保留原有 `_meta` 与 `_meta.lody` 字段且不覆盖服务端已提供的 `compaction`，
  保持 `AgentClient` 中立不变。
- 导出 `antigravitySupportsContextCompaction(cliType, agentType)`。`coordinator-sessions.ts` 的
  `compactionSupport` 维持活进程结果最高优先级；仅当无活进程（`live === undefined`）时对这两类
  Antigravity 直接返回 `true`，其余 agent 查询缓存命令时把名称归一化去掉前导 `/`。
- `board-continuity-workflow.ts` 在 `:memory` 回合结束后、发 `/compact` 前重读最新用量作为紧邻基线
  `beforeCompact`，用它判定 `USAGE_DROP_PROOF`（避免 `:memory` 自身拉高上下文或补出首个用量读数导致
  误判 `compaction-unconfirmed`）；分隔线展示仍优先沿用初始 `before`（仅当其缺失时回退用
  `beforeCompact`），且 `usedAfter` 只在严格低于展示基线时写入，避免出现上升读数。

测试：`antigravity-acp-stream.test.ts` 覆盖 `initialize` 注入、已有字段与服务端声明保留、非 Antigravity
透传、`custom/antigravity` 保留 HTTP MCP/YOLO 且不注入 compaction、`antigravitySupportsContextCompaction`
判定，以及经 `withAntigravityAcpStream` 的 `AgentClient` 集成；`operation-coordinator.test.ts` 覆盖活进程 `false` 优先、无活进程 Antigravity 回退、
缓存 `/compact` 前导斜杠归一化、`:memory` 拉高用量后重读基线判定，以及无 `context_compaction` tool_call
标记、仅凭 `usage_update` 下降走通 `:memory` → `/compact` → `:renew` 的端到端流程。
