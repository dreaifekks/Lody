# 协调者的连续对话（提案）

Status: draft
Translation: pending

本文是[看板与协调者](design.zh.md)的补充提案，等用户拍板后再补英文版，并把定下的部分并入
主设计。只是调研和设计，还没有实现。

## 场景

用户在一个看板里和协调者聊了几天：派线程、看回报、改方向。界面上始终是**一段不间断的
对话**，往上翻能看到全部原文。但协调者的模型上下文不应该无限变长：早期已经过时的讨论、
几百条回报 JSON 会让注意力偏向奇怪的地方。用户希望协调者像 Hermes Agent 的网关会话那样，
在空闲时自己「整理」上下文，然后接着聊，用户几乎感觉不到。

关键区分：**Lody 的会话历史**（Loro 文档，界面显示的东西）和 **agent 的模型上下文**是两份
东西。压缩只缩后者；前者可以一直完整保留，这是「不间断」在界面上成立的基础。

## 现状

### 协调者今天会遇到的问题

- **看板说明只在第一条消息里。** `buildPrompt` 在启动回合末尾追加 `buildBoardInstructions`
  （`apps/cli/src/session/session-execution-helpers.ts:86-155`），调用点只在
  `prepareStartSessionTurn`（`apps/cli/src/session/session-execution-service.ts:6501-6563`）。
  它是一条 user 消息，不是 system prompt；原生压缩会把它和其他早期内容一起压成摘要，协调者的
  身份、规则和用户写的看板指令之后只剩摘要里的转述。另外 `boards/AGENTS.md` 写明「已启动的
  会话保持读到的版本」（`packages/components/src/components/boards/AGENTS.md:58-59`），用户改了
  指令，协调者永远读不到。
- **原生自动压缩来得很晚。** Claude Code 不设窗口时到模型上下文上限才压缩，原生 1M 窗口的模型
  默认约 967K 才压（[model-config › Set the auto-compact window](https://code.claude.com/docs/en/model-config#set-the-auto-compact-window)）。
  对协调者来说，注意力早在这之前就开始漂了。
- **回报批次很占地方。** 每个 Inbox 批次是一条系统回合，正文是固定说明加成员 JSON
  （设计文档「内置提示」一节；`apps/cli/src/orchestration/inbox/model.ts` 的 `batchPreview`）。

### Lody 已经有的

| 能力 | 现状 | 位置 |
| --- | --- | --- |
| 读上下文用量 | ACP `usage_update`（used/size）写进 `SessionMeta.contextWindowUsage`，400 ms 节流，回合结束强制落盘 | `apps/cli/src/agent/agent-client.ts:990`、`:1261-1279`；`apps/cli/src/lib/message-handler.ts:1633-1666`；`packages/shared/src/schema.ts:804` |
| 显示用量 | 输入区「已用 x%」浮窗，压缩中显示「Compacting context」 | `packages/components/src/lib/session-usage.ts:103-120`；`components/sessions/session-usage-popover.tsx:124-131`；`session-chat-input-area.tsx:2146` |
| 显示压缩点 | 适配器发出带 `contextCompaction` 标记的合成 tool_call，界面渲染成一行状态 | `packages/shared/src/acp/history-apply.ts:121-134`；`components/ai-gui/view.tsx:7692-7705` |
| 触发压缩 | **没有专门的 RPC**。只能把 `/compact` 当普通 prompt 发出去，由适配器解析；测试证明 Lody 原样转交 | `apps/cli/tests/session-execution-service.test.ts:7916` |
| 声明压缩能力 | Lody 的扩展 schema 认识 `compaction` 能力，但没有代码读它；Lody 的 ACP 客户端能力里也没有声明 `session.compaction` | `apps/cli/src/agent/lody-acp-extension.ts:81`；`apps/cli/src/agent/agent-client.ts:2012-2022` |
| 判断空闲 | Inbox 投递门控：没有活动回合、没有待派发 | `apps/cli/src/orchestration/operation-coordinator.ts:142-146` |
| 回合结束钩子 | 运行时释放后调用 `operationInbox.wake()` 和 `onInboxReleased` | `apps/cli/src/session/session-execution-service.ts:952-955`；`operation-coordinator.ts:159-161` |
| 定时器 | 协调者 Worker 里的 `arm(key, delay, reason)`，看板回报已经用它做重试 | `apps/cli/src/orchestration/coordinator-activity.ts:70-76`；`board-report-workflow.ts:285-295` |
| 回报带用量 | 看板回报已经携带成员的 `contextWindowUsage` 和 `generation` | `packages/shared/src/board.ts:224-225` |
| 续接新会话 | **没有「用摘要开新会话」的机制**。重放提示只在同一会话的 ACP 恢复失败时使用；fork 是复制历史 | `packages/shared/src/replay-prompt-builder.ts:437`；`apps/cli/src/session/session-fork-service.ts:107-178` |

### 各 agent 的原生压缩

适配器都是子模块，本 worktree 没有检出。下面的结论来自主检出 `/home/dreaife/out/Lody` 里，
本分支固定的子模块提交。

- **Claude（`acp-extension-claude` @ `2ff63b6`）**
  - 声明 `compaction: { version: 1 }`（`src/acp-agent.ts:506`）。
  - `/compact` 由 SDK 自己处理，重放时隐藏（`src/acp-agent.ts:2068-2075`）。
  - 把 SDK 的 `status: compacting` 和 `compact_boundary` 转成压缩生命周期，并用
    `post_tokens` 立刻刷新用量（`src/acp-agent.ts:5455-5490`）。
  - 客户端声明了 `session.compaction` 才走 `compaction_update` 和 `compaction_summary_chunk`，
    后者会流式发出摘要正文；否则退回旧的合成 tool_call（`src/context-compaction.ts:13-21`、
    `:51-54`、`:285-296`）。Lody 现在走的是后者。
  - 原生配置：`/compact <指示>`、CLAUDE.md 里的「Compact instructions」
    （[costs › Manage context proactively](https://code.claude.com/docs/en/costs#manage-context-proactively)）；
    自动压缩窗口用 `autoCompactWindow` 或 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 设，范围 100K–1M
    （[model-config](https://code.claude.com/docs/en/model-config#set-the-auto-compact-window)）。
- **Codex（`acp-extension-codex` @ `9138cf3`）**
  - 声明 `compaction: {version: 1}`（`src/AcpExtensions.ts:82`）。
  - `/compact` 被当作 `codexTurnCommand`（`src/CodexCommands.ts:113-115`、`:263`），
    走 app-server 的 `thread/compact/start`（`src/CodexAppServerClient.ts:628-648`、`:858-859`）。
  - 自动压缩阈值是 `model_auto_compact_token_limit`
    （[官方示例配置](https://developers.openai.com/codex/config-sample)）。
- **共享契约（`acp-extension-core` @ `97007e7`）**：`LodyActivityMeta` 带 `usedTokensBefore` 和
  `usedTokensAfter`（`src/session.ts:12-20`）；用量通知是 `_lody/session/usage_update`（`src/methods.ts:5`）。
- **其他 agent（Kimi、Pi、Grok、Devin、dsh）**：没有核实。运行时可以看机器 `acpCapabilities` 里
  有没有 `compaction`，或者可用命令里有没有 `compact`
  （`apps/cli/src/agent/acp-capability-normalization.ts:111-150`）。

## Hermes Agent 的做法（参考）

「hermes」指 Nous Research 的 [Hermes Agent](https://github.com/NousResearch/hermes-agent)。
它的网关会话（Telegram 等）就是这里想要的形态：「A gateway chat is designed to be **one continuous
session** — compacted repeatedly as it grows」，并且「Gateway conversations do not reset after inactivity
or at a daily boundary」（[sessions.md:1026、:1074](https://github.com/NousResearch/hermes-agent/blob/848fc0ad8be766b9dc10fe42bd80b5fc2d45d95c/website/docs/user-guide/sessions.md#L1026)）。
Hermes 也是一个模型系列的名字，但那是模型，不是 agent。没找到别的同名产品有这种行为。
下面引用的都是 main `848fc0a`（2026-10-16，正式版 v0.22.2）。链接前缀是
`https://github.com/NousResearch/hermes-agent/blob/848fc0ad8be766b9dc10fe42bd80b5fc2d45d95c/`。

1. **什么时候压缩：按用量，回合边界上做；空闲是可选的另一个触发。**
   - 主压缩器在回合开始和每次 API 调用前检查。阈值 `(context_length − max_tokens) × threshold`，
     默认 0.5；窗口小于 512K 时最低抬到 0.75（`agent/context_compressor.py#L2777-L2810`、`#L1151-L1152`）。
   - `idle_compact_after_seconds`（默认 0，即关）：会话闲置这么久后再回来，在第一次回复前先压缩。
     已经低于压缩目标时不做，并且和其他自动压缩一样有失败冷却、防抖和会话锁
     （[configuration.md:999、:1049](https://github.com/NousResearch/hermes-agent/blob/848fc0ad8be766b9dc10fe42bd80b5fc2d45d95c/website/docs/user-guide/configuration.md#L1049)）。
   - 网关另有一层 85% 的保底（`gateway/run_turn_hygiene.py#L97-L103`）。
   - 手动命令：`/compress [here [N] | focus topic]`。
2. **压缩什么、保留什么。**
   - 先不调用 LLM，把旧的工具输出清掉。
   - 保留头部（system prompt 加前几条；第一次压缩后头部保护归零，免得早期回合「化石化」）
     和按 token 预算算出的尾部，最近一条用户消息一定保留。
   - 中间部分交给辅助模型，生成一份结构化摘要：Goal、Constraints & Preferences、
     Completed Actions、Active State、Blocked、Key Decisions、Resolved Questions、Relevant Files 等。
     之后的压缩是「更新上一份摘要」，不是重写。摘要失败时有不调 LLM 的兜底。
   - 摘要前缀写明「REFERENCE ONLY」，并声明持久记忆优先于摘要。
   - 出处：`agent/context_compressor.py#L4100-L4170`、`#L4056-L4070`、`#L253-L293`、`#L4647-L4666`，以及
     [context-compression-and-caching.md](https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching)。
3. **压缩后重建 system prompt。** 每次压缩都会让 system prompt 失效，并从磁盘重读
   MEMORY.md 和 USER.md。会话中途写入的记忆，就在这个时刻进入 prompt
   （`agent/system_prompt.py#L808-L826`、`agent/conversation_compression.py#L3104-L3159`）。
4. **界面：同一个会话 id，聊天平台上默认静默。**
   - `in_place: true` 是默认值：会话 id 不换，压缩前的消息软归档，仍然能搜索、能恢复。
     旧行为是每次压缩换一个新 id，用 `parent_session_id` 串起来，现在已经不是默认了。
   - `progress_notices: false` 是默认值：聊天平台上看不到常规的压缩进度，只能看到失败提示和
     手动 `/compress` 的反馈；CLI 会打印 `⟳ compacting context…`。
   - 出处：[configuration.md:991、:998、:1023、:1045](https://github.com/NousResearch/hermes-agent/blob/848fc0ad8be766b9dc10fe42bd80b5fc2d45d95c/website/docs/user-guide/configuration.md#L1045)。
5. **和长期记忆、检索配合。**
   - 所有会话存在 SQLite FTS5 里，`session_search` 直接返回原文。摘要里附带找回指引和机械抽取的
     「Anchor Index」（PR 号、SHA、路径，原样不改写）。
   - 回合结束后，后台 fork 一个 agent，判断要不要写记忆，默认每 10 轮一次。
   - 记忆插件可以在 `on_pre_compress` 从即将压掉的消息里提取要点。
   - 旧的压缩前 `flush_memories` 已经删了。现在靠摘要提示词，加上压缩后重读记忆。
   - 出处：[memory.md](https://github.com/NousResearch/hermes-agent/blob/848fc0ad8be766b9dc10fe42bd80b5fc2d45d95c/website/docs/user-guide/features/memory.md)、
     `agent/background_review.py#L1-L6`、`agent/memory_provider.py#L176-L178`。

对 Lody 的启发：
- 历史和上下文分开存。
- 同一个 id 比换代链更受欢迎：Hermes 从后者改成了前者。
- 压缩后重新注入身份和记忆。
- 压缩时机放在回合边界和空闲时。
- 界面上默认不打扰用户。

## 方案

三个方案共用一个前提：Lody 的历史从不删减，界面上往上翻总能看到原文。

### 方案 A：只调原生阈值

给协调者的 agent 设一个更早的自动压缩点：Claude 用 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`，
例如 200000；Codex 用 `model_auto_compact_token_limit`。Lody 不参与触发。

- **触发**：上下文到阈值时，在回合中途由 agent 自己压缩；没有空闲时机。
- **保留**：由 agent 决定。Claude 可以在协调者目录的 CLAUDE.md 里写「Compact instructions」，
  但协调者默认是 chat 工作上下文，写在哪里不好定。
- **界面**：现有的「Compacting context / Context compacted」一行状态。
- **记忆**：无关。看板说明会被压掉，这个问题不解决。
- **跨 agent**：Claude、Codex 可以；其他 agent 各有各的配置，或者没有。
- **工作量**：很小，约 100 行。难点是把环境变量或配置只用在协调者上：今天 Role memory 绑定
  变化会重启 ACP 进程（`session-execution-service.ts`），要核实能不能按会话注入环境变量。
- **评价**：便宜。但压缩发生在协调者正在处理回报的回合中途，看板身份会被压成转述，
  也没有「整理记忆」这一步。只能当保底。

### 方案 B：同一个会话，Lody 在空闲时触发原生压缩（推荐）

协调者的 session id 永远不变，这就是 Hermes 的 `in_place`。Lody 在协调者空闲时插入两个
system 驱动的维护回合，再在压缩后的下一回合重新注入看板说明。

- **触发**（同时满足才做）：
  - 协调者空闲：没有活动回合，没有待派发，Inbox 里没有排队的结果，复用
    `operation-coordinator.ts:142-146` 的门控。
  - 空闲已持续 N 分钟（默认 10）。在回合结束钩子里用 `arm()` 计时，期间有任何新回合就取消。
    放在空闲后不久做，而不是像 Hermes 那样等用户回来再做，原因有两个：订阅账号的 Claude
    缓存 TTL 是 1 小时，压缩读整段历史能命中缓存；用户回来时也不用等。
  - `contextWindowUsage.used ≥ min(150K tokens, 窗口的 40%)`。用绝对值是因为 1M 窗口的 40% 太大。
  - 距上次压缩已有新增内容（至少多了 20K tokens），失败后冷却 1 小时。
  - 协调者没被暂停（用户按过 Stop），树没被停止协作。这和 Inbox 对 `task` 输入的受理规则
    一致（`inputAcceptance('task', paused)`）。
  - 另外在用量浮窗里加一个「立即整理」，即手动触发，不检查阈值。
- **步骤**：
  1. **整理记忆回合**（可选，见问题 3）。固定提示：「空闲整理：把还没写下来的决定、线程结论、
     用户偏好写进共享笔记和 `memory/`，更新 `MEMORY.md`；不要开线程，不要回复用户，完成后
     只回一行。」
  2. **压缩回合**：发 `/compact <协调者保留清单>`。保留清单是产品模板：
     - 要保留：看板目标和规则；每个线程的 id、当前状态、最新结论；待用户拍板的问题；
       用户最近的纠正和偏好；已做的决定和理由；还没处理的回报。
     - 可以丢：已结束线程的过程、原始回报 JSON、工具输出。
  3. **重新注入**：压缩完成后，协调者的下一回合（用户发言或 Inbox 批次都算）前面，追加一次
     **最新的** `buildBoardInstructions` 文本和 `MEMORY.md` 索引。判断依据是历史里有一个
     比上次注入更新的已完成压缩点。这对应 Hermes 压缩后重建 system prompt；顺带让改过的看板
     指令生效，但这会改动 AGENTS.md 那条「已启动的会话保持读到的版本」，见问题 4。
- **和 Inbox、委派链**：
  - 维护回合是一种新的 system 输入，不带人工收据，不带走排队的批次，不消耗也不重置自主链深度。
  - 维护回合进行期间到达的回报，被 `ready` 门控挡住，回合结束后照常投递。
  - 用户在压缩期间发言：消息照常排在后面，输入区显示「正在整理上下文」，这个状态已经有了。
- **界面**：
  - 两个维护回合不显示为用户气泡，合成**一条分隔线**：「已整理上下文 · 182K → 24K」，
    可以展开看写了哪些记忆文件。
  - 摘要正文要 Lody 声明 `session.compaction` 能力并处理 `compaction_summary_chunk` 才拿得到，
    首版不做，见问题 5。
  - 分隔线上下的原文都在，对话看起来不间断。
- **跨 agent**：
  - Claude、Codex：完整支持。
  - 不支持压缩的 agent：只做整理记忆回合，不压缩；用量浮窗提示「这个 agent 不支持整理上下文」。
    以后需要的话，再给它们加方案 C。
- **工作量**：约 900–1300 行加测试。
  - 守护进程：空闲计时和条件检查，约 300 行。
  - Inbox 和执行服务：新增「维护」输入类别，约 200 行。这部分改的是上游的编排代码，每次同步
    都可能冲突。
  - 重新注入，约 100 行。
  - 界面：分隔线、浮窗按钮、看板设置开关，约 300 行。
  - 测试：注入时钟，真实 Inbox 门控。
- **评价**：
  - 好处：界面天然连续，id 不变，所以 Inbox、回报游标、笔记权限、线程归属一概不受影响；
    利用 agent 原生的压缩质量和缓存。
  - 坏处：压缩质量不归 Lody 控制，只能通过保留清单影响；依赖适配器的 `/compact`。

### 方案 C：Lody 层换代，界面拼成一条时间线

到阈值后，旧协调者写交接摘要，Lody 开一个新的协调者 session，把看板的协调者指向新一代。

- **触发**：和 B 一样。
- **步骤**：
  1. 旧代写交接摘要到 `memory/`。格式可以照搬 Hermes 的结构化小节。
  2. Lody 用同一台机器、同一份 agent 配置新建协调者。首条消息 = 最新看板说明 + Lody 生成的交接
     事实（线程表即 overview、未决回报、上一代 id、上一代用量）+ 旧代摘要。
  3. 看板行的 `coordinatorSessionId` 改指新代，旧代只读。
- **保留**：完全由 Lody 的模板决定，各家 agent 一致。
- **界面**：协调者区域把各代历史按时间接起来，最后一代可写，代与代之间一条分隔线
  「第 3 代 · 从摘要继续」。`SessionChatInterface` 是一个会话一个界面，要新做一个
  「多会话只读前缀加当前会话」的视图。
- **记忆**：交接摘要本身就是一条看板记忆。
- **跨 agent**：所有 agent 都能用，还能顺便换 agent 或模型。
- **工作量**：约 2500 行以上，而且要动几条不变量：
  - 看板的固定协调者：`coordinatorSessionId` 现在不可变（`packages/shared/src/board.ts:24`），
    AGENTS.md 写着「never detach the fixed coordinator」。
  - 发给旧代的未完成 Operation 和排队结果要迁到新代，上游 Inbox 没有这个操作。
  - 回报游标、笔记替换权限都按协调者 id 判断。
  - 线程的 `openedBySessionId` 指向旧代。
  - agent 原生的子代理、后台任务、goal 随旧代断开；新代冷启动，没有缓存。
- **评价**：最可控、最通用，但改动面最大，「不间断」要靠拼接界面去模拟。

## 推荐

**选方案 B，A 作为保底。**
- 「不间断对话」在 B 里不用模拟：同一个会话，Lody 的历史本来就完整。
- 换代（C）的代价主要来自「协调者 id 会变」，而看板的几乎所有机制都以协调者 id 为锚：
  Inbox、回报游标、笔记权限、线程归属、归档。
- Hermes 自己也从换代链改成了同一个 id。
- B 补上了原生压缩真正缺的两件事：在合适的时机压缩（空闲、缓存还热），以及压缩后重新给出
  看板身份。

## 对 PR4（线程交接）的影响

线程和协调者的处境不同：
- 线程是在 worktree 里干活的执行者，轮数上限本身就是设计意图。换成一个干净的新一代子 Tab，
  共用目录，是合理的。
- 协调者是固定锚点，不该换 id。

所以 `boardGeneration`、`THREAD_SUPERSEDED` 和 `lody_board_thread_handoff` 只用于线程，B 不会改动它们。

可以共用的部分，建议在 PR4 里一次做成共享模块：

1. **用量策略**：一个纯函数，输入 `contextWindowUsage`、上次压缩或交接的用量、时间，输出
   「该整理 / 该提示交接 / 不动」。协调者用它决定空闲压缩；线程用它在回报和 Overview 里提示
   交接。这正是主设计「以后再做」里的「按上下文占用提示交接」，回报已经带了用量（`board.ts:225`）。
2. **续接事实生成器**：Lody 生成的事实块。线程版是目录、分支、HEAD、上一代、用量；协调者版
   （B 的重新注入）是看板说明、`MEMORY.md` 索引和线程表摘要。一个生成器，两个模板。
3. **看板说明的注入入口**：新一代的首条消息和压缩后的重新注入，都调用同一个
   `buildBoardInstructions`，并且都读当前的看板行，不读冻结值。
4. **界面分隔线**：「已整理上下文」和「第 n 代」用同一个组件，两种文案。

建议顺序：PR4 先把 1、2、3 做成共享件，交接走它们；B 作为 PR4.5 接在后面，主要增量是空闲
计时、维护输入类别和分隔线。线程默认不做空闲压缩，见问题 2。

## 需要用户拍板

1. **方案**：采用 B，即同一个会话，Lody 空闲触发原生压缩，A 作为保底？
   *默认：是。C 只在以后需要「换 agent 继续」时再考虑。*
2. **触发条件**：协调者空闲 10 分钟，且已用 ≥ min(150K, 窗口 40%)，另有手动「立即整理」；
   线程不做空闲压缩，靠 PR4 的轮数和交接加原生自动压缩？
   *默认：是。阈值放进看板设置，可调。*
3. **压缩前的整理记忆回合**：每次压缩前，先让协调者把决定和结论写进笔记和 `memory/`？
   Hermes 已经删掉了它的压缩前 flush，代价是每次多一个短回合。
   *默认：做。看板记忆是给所有成员和后来者用的，协调者本来就负责维护它。*
4. **压缩后重新注入最新的看板说明和用户指令**：这会改掉「已启动的会话保持读到的版本」这条
   不变量，改为只对协调者、并且只在压缩后生效。
   *默认：重新注入，并同步更新 `boards/AGENTS.md`。*
5. **压缩点在界面上怎么呈现**：维护回合不显示气泡，只显示一条「已整理上下文 · 前 → 后 tokens」
   分隔线；首版不展开摘要正文？
   *默认：是。摘要展开等声明 `session.compaction` 并接上 `compaction_summary_chunk` 之后再做。*

## 证据

- 意图：本文与 [design.zh.md](design.zh.md)「轮数、交接」「内置提示」「以后再做」。
- 已检查的实现（只读，未改动）：
  - 本分支 `17a23257a`，即 `origin/board-coordinator`。上文表格里列出的 `apps/cli`、
    `packages/shared`、`packages/components` 文件。
  - 子模块在主检出里，按本分支固定的提交读取：`acp-extension-claude` `2ff63b6`、
    `acp-extension-codex` `9138cf3`、`acp-extension-core` `97007e7`。
- 外部资料：
  - Hermes Agent 源码 `848fc0a` 与[文档](https://hermes-agent.nousresearch.com/docs/)。
  - Claude Code 文档 [costs](https://code.claude.com/docs/en/costs)、[model-config](https://code.claude.com/docs/en/model-config)。
  - Codex [示例配置](https://developers.openai.com/codex/config-sample)。
- 没有核实：
  - Kimi、Pi、Grok、Devin、dsh 的压缩能力。
  - Codex 压缩后保留哪些用户消息。
  - 能否只给协调者注入环境变量（方案 A）。
  - Hermes 文档里「`/new` 前自动保存记忆」的说法，代码里没有找到内置的这一步。
- 没有执行任何验证：方案都没有实现，工作量是估算。
