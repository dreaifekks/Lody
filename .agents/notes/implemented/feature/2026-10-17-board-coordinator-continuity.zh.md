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

## 行为契约

| 问题 | 契约 |
| --- | --- |
| 触发 | 协调者历史变化、`board-idle` 定时器或 30 秒的忙碌复查唤醒 reconcile。每个协调者同时最多一个运行，由 Worker 内的 `running` 集合保证；新的手动请求让旧的未处理请求作废。 |
| 所有者 | 运行是 Worker Scope 里 fork 出来的 fiber；回合本身归执行服务，和其他可见回合一样。维护回合的 Promise 不进 `rawWork`，所以 Worker 停止不会等它。 |
| 取消 | Worker 停止只中断等待，不取消正在跑的回合；用户按 Stop 只取消当前步骤（维护回合没有 Inbox execution，不暂停 Inbox），运行记为 `interrupted`；Inbox 已暂停时不再自动整理。 |
| 交接 | 每一步之前检查活动回合、等着的用户回合和 Inbox；有就让路。新对话从交接开始由执行服务挡住 Inbox 批次，直到新 agent 第一回合结束；新回合被用户回合抢先时记为待切换（`running` 加 `handoff`），空闲后接着做。 |
| 失败恢复 | reconcile 出错时只记警告，30 秒后复查，不影响回报和 Inbox；运行失败记在分隔线上；压缩没有确认就记 `failed`，不显示「已整理」；续接没开始（`duplicate` 等）记 `renewed: false`，空闲时补，回合本身失败才记原因并停止重试。 |

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
