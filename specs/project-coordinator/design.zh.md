# 看板与协调者（Board coordinator mode）

Status: draft
Translation: current

[English](design.md)

把 Claude Projects 的「一个范围里多条并行线程，由内置协调者拆任务、派线程，人随时
可以点进任意线程插话」搬进 Lody。本文描述意图、数据归属和投递保证；实现细节以各模块
的 `AGENTS.md` 为准。文末记录用户已经确认的决定（含上游 0.105.0 修订后的六项决定），
以及 PR1、PR2 的实现记录。

本版按上游 0.105.0 修订：Delivery 已删除（#1523），结果一律走 Operation Inbox 合批
唤醒；委派链上限改为 16 并新增「停止协作」（#1428）；自动 review 已删除（#1393）；
子会话有紧凑任务面板与 `REVERSE_CHAT_FORBIDDEN`（#1481）；用户手动 Stop 的结果不再
自动唤醒（#1553）。

## 场景

用户建一个看板「Lody 协调者模式」，写下目标，选 Claude Opus 当协调者。协调者读目标后
用 `lody_session_create` 开三个执行线程（两个在 devnuc 的 worktree 里改代码，一个在
n100 调研），然后结束回合。

每个线程回合结束、等人回答、失败，或者线程开的 reviewer 卡在等人，Lody 都把这件事
写成协调者的一条持久结果，由协调者的 Operation Inbox 在它空闲时合成一批送达；协调者
不必在提示里让执行 session「用 `lody_session_chat` 把结论转发回来」（上游对回头发
消息本来就拒绝：`REVERSE_CHAT_FORBIDDEN`）。用户打开看板的 Overview，看到三个线程各自
在做什么、等谁、第几轮、最新结论，点进任意一个直接在它的输入框里插话。线程里的
agent 直接面对用户，协调者不是传话中间人。用户在任一会话按 Stop，上游的规则生效：
被停的那条结果不会再自动唤醒谁。

执行线程接到第 5 轮任务时 Lody 拒绝这条消息，协调者改用交接工具开新一代，新一代共用
原来的 worktree。所有线程都能读写看板的共享笔记；每天凌晨一条定时任务把当天进展写进
笔记和 nmem。

## 概念与命名

| 概念       | 含义                                                                                   | 标识符            |
| ---------- | -------------------------------------------------------------------------------------- | ----------------- |
| 看板 Board | 一组属于同一件事的 session，带一个协调者、一份共享笔记和几条规则                        | `board`, `bd_*`   |
| 协调者     | 看板固定的一个 session，由 Lody 注入协调者提示，接收自动回报                           | `boardRole`       |
| 线程       | 看板里不是协调者的根 session（没有 `parentSessionId`）                                 | 线程 id = 根 id   |
| 代         | 线程到轮数上限后交接出的后继会话，是根 session 的子 Tab，共用目录                       | `boardGeneration` |
| 回报       | 一个成员事件，记成协调者机器上一条已完成的 `board_report` Operation，由 Inbox 合批送达 | `board_report`    |

Lody 已有的 "project" 指仓库或本地文件夹（`ProjectRef`、`['localProject', id]`、
`lody_project_list`、侧边栏「本地项目」），所以这个容器不能叫 project。本文用
「看板 / Board」，见已决定第 1 条。

## 数据模型

### 看板行

存在工作区 Flock 文档（`packages/shared/src/workspace-flock.ts`）里，新增一个行族
`['board', boardId]`，和 Agent Role 同一份文档、同一套本地落盘后再上传的写法：

```ts
type BoardMeta = {
  version: 1;
  id: BoardId;                       // 'bd_' + uuid
  name: string;                      // ≤ 80 code points
  purpose: string;                   // ≤ 4000，看板目标，也是协调者的第一条消息
  coordinatorSessionId: SessionId;
  createdAtMs: number;
  createdByUserId: string;
  rules: {
    maxRoundsPerThread: number;      // 默认 4
    reportHumanTurns: boolean;       // 默认 false，见「自动回报」
    executorConstraints: string;     // ≤ 2000，注入每个线程的第一条消息
  };
  digestScheduleId?: string;         // 每日摘要定时，见「每日摘要」
  archivedAtMs?: number;
};
```

每个工作区至多 50 个未归档看板；已归档（`archivedAtMs` 有值）的看板不计入上限。看板行
不保存成员列表：成员资格写在 session 自己的元数据上，Overview 和工具都按 `boardId`
过滤，没有第二份需要维护一致的名单。

### 成员资格

`SessionMeta`（`packages/shared/src/schema.ts`）的看板字段：

```ts
boardId?: BoardId;             // 成员资格（PR1）
boardRole?: 'coordinator';     // 协调者；线程不写（PR1）
boardGeneration?: number;      // 交接出的后继会话：2、3、…；评审类子 Tab 不写（PR1）
boardJoinedAtMs?: number;      // 手动加入看板的时刻；创建时入板的会话不写（PR3）
```

写入时机，全部在创建路径（`prepareSessionInput`，`apps/cli/src/commands/session.ts`）
或界面的两个创建入口（`session-submission.ts`）：

- 看板创建时建的协调者 session：`boardId` + `boardRole`。
- 看板成员通过 `lody_session_create` / `create_many` 开的会话：继承请求者的 `boardId`，
  不论 `useCurrentSessionAsParent` 还是独立 `workContext`，chat 类也一样。执行线程开的
  reviewer 因此自动入板，这是回报能覆盖孙会话的原因。
- 子 Tab（`parentSessionId`）：继承根的 `boardId`。
- 用户在 Overview 上「新线程」：写 `boardId`；session 的 ⋯ 菜单「加入看板 / 移出看板」
  改写 `boardId`。加入已有会话时同时写 `boardJoinedAtMs`，回报只看加入之后的状态；
  移出只改字段，不动会话。

协调者和线程都是普通 session，归档、恢复、删除、worktree 清理沿用
`specs/session-relations.md` 和 `specs/session-worktree-lifecycle.md`，看板不新增目标集。
归档看板 = 归档协调者和所有 `boardId` 相同的根 session（各自带自己的子 Tab），再写
`archivedAtMs`。

### 线程、代、子会话

```text
看板 bd_1
├─ 协调者 S0                         boardRole=coordinator
├─ 线程 A（根）                      boardId=bd_1
│   ├─ Tab A' 评审                   parentSessionId=A（执行者自己开的 reviewer）
│   └─ Tab A2 第 2 代                parentSessionId=A, boardGeneration=2
├─ 线程 B（根）                      openedBySessionId=S0
└─ 线程 C（根）                      openedBySessionId=A（线程开的独立会话，仍是线程）
```

线程的「当前代」= 根本身，或 `boardGeneration` 最大的子 Tab。轮数、回报里的
「线程状态」、`lody_session_chat` 的轮数检查都按当前代算。代是子 Tab 而不是新根，是因为
worktree 由根 session 拥有且随根归档清理（`session-worktree-lifecycle.md`），后继必须
共用这个目录；CLI 创建路径本来就接受 `--parent <sessionId>`（`resolveCreateContext`），
只是 MCP 面只开放了 `useCurrentSessionAsParent`。

### 共享笔记

每个看板一份 Loro 文档 `board-<id>`（流 `<ws>:bd:<id>`），容器：

- `notes`: LoroText，Markdown 正文，≤ 256 KiB；
- `meta`: `{ updatedAtMs, updatedBy }`，`updatedBy` 是 session id 或 `'user'`。

用 LoroText 而不是把正文塞进看板行，是因为 Flock 行是整值覆盖、后写赢：两个线程同时
追加会丢一条；LoroText 并发追加能合并。文档的打开/订阅仿照每条 Schedule 一份文档的
做法（`packages/shared/src/schedule-repository.ts`、`packages/components/src/hooks/use-schedules.ts`
的 `useScheduleDocument`），发现靠看板行，不另设注册表。

### 机器本地状态

回报只存在协调者所在机器的 Operation 存储里（`operations.sqlite3`，
`apps/cli/src/orchestration/operation-store.ts`），和今天的 Operation 一样不同步：

- `operations` 表里 kind = `board_report` 的一条 Operation：请求者是协调者 session，
  创建即为 `finished`，完成体装一个成员事件（见「自动回报」）；
- 它在 `inbox_results` 里的那一行，由现有的 `InboxSqlite.indexCompletion()` 在同一事务
  里写入，和普通 Operation 回执完全同构；
- `board_report_cursors(board_id, session_id, last_turn_id, last_awaiting_since,
  last_notice_id)`：每个成员上次处理到哪里。

三者在一个 `BEGIN IMMEDIATE` 事务里提交。没有 Delivery 表，也没有第二套投递状态：
领取、合批、结算、过期全部是 Inbox 的现成语义。

### 多机 / LAN 同步

| 数据                             | 位置                        | 同步方式                                        |
| -------------------------------- | --------------------------- | ----------------------------------------------- |
| 看板行、成员资格、笔记           | 工作区 / session / 看板文档 | 持久流，经 hub 同步到每个成员，离线编辑后合并   |
| 回报 Operation、Inbox 结果、游标 | 协调者机器的 SQLite         | 不同步；和今天的 Operation 一样                 |
| 线程状态                         | session 元数据 + presence   | 元数据持久同步；presence 走已有的瞬态通道，只读 |

线程可以在任何成员机器上。协调者机器观察线程靠的是同步过来的 session 文档，和今天
Operation 的回执一样（`coordinator-workflow.ts` 的 `reconcileItem` 读目标文档），不需要
新的机器间 RPC。本设计不向瞬态通道发布任何新内容，遵守 `lody-loro-sync-stack` 的限制。

## 协调者会话

### 创建

`/boards` 页「新建看板」：名字、目标、协调者的 agent（复用 Schedule 的 agent 选择控件
`schedule-agent-controls.tsx`：Agent Role 或 机器 + agent 配置 + 运行配置）、规则三项。
创建写看板行，再以目标为第一条消息创建协调者 session（工作上下文默认 chat），然后进
Overview。协调者的 agent 默认记住上一次的选择；按用户现行规则通常是 Claude Opus。

### 内置提示

今天一个回合送给 agent 的文本只有 ACP prompt 一条路：生产者冻结 `inputConfig.prompt`
（Agent Config 的 prompt + Role 前缀 + 任务），守护进程只在创建路径的 `buildPrompt`
（`apps/cli/src/session/session-execution-helpers.ts`）后面追加 MCP 工具、文件路径和
`lody-lan` 三段提醒，续接回合不追加。看板提示沿用这条路：

- 协调者第一条消息：`buildPrompt` 追加「协调者说明」；
- 线程第一条消息：`buildPrompt` 追加「线程说明」；
- 回报回合：就是上游的 Inbox 批次回合，正文是 `batchPreview` 生成的固定说明加成员
  JSON（`inbox/model.ts`），不另外注入看板文本。

协调者说明是产品模板，内容固定、按看板字段填空：

1. 身份与目标：你是看板「{name}」的协调者；目标：{purpose}。
2. 工作方式：拆任务、用 `lody_session_create` 开线程、派完结束回合等回报。回报和你
   自己派发的回执一样，作为「已完成的异步工作」批次送达，`operationKind` 为
   `board_report`，一条一个成员事件；看板里任何成员（含线程开的子会话）的失败、等人、
   通知都会这样送到，不要让执行 session 转发（上游会拒绝回头发消息）。用
   `lody_board_overview` 看全局，用 `lody_session_history` 读细节。
3. Lody 代你执行的规则：每个线程最多 {maxRoundsPerThread} 轮，到上限后
   `lody_session_chat` 会被拒绝，改用 `lody_board_thread_handoff` 交接；对当前这轮的
   补充用 `followUp: true`，不计轮数。委派链上限 16 跳，收到 `CHAIN_DEPTH_EXCEEDED`
   就停下向用户汇报；用户按过 Stop 之后，积累的回报会随用户的下一句话一起送来。
4. 执行线程的固定约束：{executorConstraints}。Lody 会自动附在每个线程的第一条消息里，
   协调者不用转述。
5. 共享笔记：`lody_board_notes_*`；结论和决定写进笔记，别只留在对话里。
6. 只向用户汇报结论和需要用户决定的事。

线程说明一段：本会话属于看板「{name}」（目标一句）；协调者 session 是 {id}；你的回合
结束、等人回答或失败时 Lody 会自动通知协调者，不必也不能转发；共享笔记工具；约束：
{executorConstraints}。你开的 reviewer 等子会话结论回来后，把结论原样写进你的回复，
不要自己按结论动手改，改哪些由协调者决定。交接出的新一代还会在前面加上交接事实
（见「交接」）。

### 产品逻辑 vs 提示

| 做成产品逻辑                                                     | 留在提示里                                        |
| ---------------------------------------------------------------- | ------------------------------------------------- |
| 成员资格继承、回报的事件来源、持久结果、Inbox 合批与唤醒         | 怎么拆任务、派给谁、交叉评审的组合                |
| 轮数统计、轮数上限拒绝、`followUp`                               | 什么算「补充」而不是新一轮（由协调者打 `followUp`） |
| 交接：子 Tab、共用目录、交接事实前缀                             | 交接说明的正文（做了什么、没解决什么）            |
| 停止协作、Inbox 暂停、用户 Stop 不唤醒、16 跳上限（全部是上游的） | 收到评审结论后筛选（例如去掉 Codex 的防御性建议） |
| 笔记文档、容量、追加/替换                                        | 笔记写什么、何时写                                |
| 每日摘要的定时与目的地                                           | 摘要的写法，写入 nmem 的命令                      |

交叉评审没有产品逻辑：执行线程自己开 reviewer 子会话（普通的 `lody_session_create`，
`useCurrentSessionAsParent: true`），reviewer 的结果通过它自己的回执唤醒执行线程。
Agent Role 偏好（哪类任务用哪个模型）和「只 commit 不 push」这类约束不进代码：前者继续
放在 nmem 的 agent 规则里，后者放在看板的 `executorConstraints` 文本里，用户可改。

## 自动回报

一句话：观察者把成员的新状态写成协调者的一条已完成 Operation，Inbox 决定什么时候、
以什么深度、合成多大一批送给协调者；看板不再有自己的投递管道。

### 事件来源

全部来自同步到协调者机器的 session 文档，对看板里除协调者以外的每个成员（含子 Tab
和线程开的独立会话）。先找成员的「最新驱动回合」：最新的 user turn，或者带
`inputConfig.chainDepth` 的 system 回合（续接、Inbox 批次、定时都是 system 驱动），再取
它之后的第一条 assistant 行。只看 user turn 会漏掉系统驱动的回合，于是「执行者按
review 改完」永远不会回报。

| 事件           | 证据（`SessionMeta` / 历史）                                                     | 起因过滤                                   |
| -------------- | -------------------------------------------------------------------------------- | ------------------------------------------ |
| `finished`     | 驱动回合之后的第一条 assistant 行已到终态（`isTerminalAssistantEntry`），且比游标新 | 驱动回合 `author.kind === 'human'` 时默认不报 |
| `failed`       | 驱动回合 `status === 'failed'`，或同回合的 `chat_failed` 系统行                  | 不分起因都报                               |
| `waiting_user` | `awaitingUserSince` 新设置且晚于驱动回合：权限请求、提问                         | 不分起因都报；同一驱动回合只报一次         |
| `notice`       | `agentNotice.id` 变化（成员调用了 `lody_notify_user`）                           | 不分起因都报                               |

人工过滤用 `author.kind !== 'human'`，不用 `=== 'agent'`：system 起因的回合不是人，
不能被误静音。`reportHumanTurns` 打开时人工驱动的 `finished` 也报。`cancelled` 不作为
自动回报事件（见「已决定：Inbox 修订」第 3 条）：用户在成员上按 Stop 的结果按 #1553 不能自动唤醒，而
跨机器只能从同步文档看到「取消了」，分不清是谁取消的；协调者自己的
`lody_operation_cancel` 它已经知道。取消只进 Overview。

每条事件带：成员 session id、标题、机器、当前代、`contextWindowUsage`、起因
（`author.kind`）、assistant 文本的 32 KiB 尾重预览（同 Operation item 的 `output`：
25% 头 / 75% 尾）、`waiting_user` 时的请求摘要、`notice` 的正文。成员从加入看板
（`boardJoinedAtMs`）之前留下的状态不报：手动加入已有会话时游标初始化为加入时刻之后。

### 观察者

观察者是 `LodyOperationCoordinator` / `coordinator-workflow.ts` 里新增的看板分支，只在
协调者 session 所在机器的 Host-lease Worker 里跑，以 `meta.machineId === this.machineId`
为界；线程在哪台机器无关，所以跨机不会两边各报一次。协调者自己不在观察范围内，不会
自己触发自己。

- 成员集合靠事件维护，不靠全量扫描：订阅工作区目录的 `board` 行族，以及 session 文档的
  `doc-metadata` 事件（字段 `boardId`、`isArchived`、`awaitingUserSince`、`agentNotice`、
  `lastMessageAt`、`collaborationStopped`，和 `message-handler.ts` 订阅
  `collaborationStopped` 同一个 `repo.watch` 入口）；成员的历史变化由各自文档的订阅
  标脏。
- 唤醒合并：同一时刻最多一个 reconcile 在跑、一个在排队；一次 reconcile 只重读标脏
  的成员，已归档的成员跳过。否则流式输出每导入一次就触发一次全工作区扫描。
- 观察者在协调者 Operation 的 reconcile 之后、同一轮里跑，所以协调者自己派发的回合，
  其回执一定先于去重检查可见。
- 它不判断协调者是否空闲：事件一经确认就写成结果，空闲、忙、暂停、停止都交给 Inbox。
  旧设计里「空闲边界前后各判一次」的逻辑不再需要。

### 持久结果与交给 Inbox 的接口

一个事件 = 一条 Operation，走 `operation-store.ts` 新增的 `acceptBoardReport()`，一个
`BEGIN IMMEDIATE` 事务里做三件事：

1. 插入 `operations` 行：`kind = 'board_report'`，`requesterSessionId` = 协调者，
   `ownerMachineId` = 本机，`state = 'finished'`，`items: []`，完成体
   `{ type: 'result', value: { items: [], boardReport: { boardId, events: [event] } } }`
   （`OperationResultSchema` 新增可选 `boardReport`，`LodyOperationKind` 新增
   `board_report`）；`initiatorChainDepth` 和 `frozenContinuationConfig.inputConfig` 取
   协调者最新驱动回合的 `inputConfig`（含 `chainDepth`），和上游续接回合用的配置同源。
2. 调现有的 `inbox.indexCompletion()`：写 `inbox_results`，协调者空闲、未暂停、没有已
   接受的输入时顺手登记一个 pending intent。这一步没有看板特例。
3. 前移该成员的游标。

Operation id 是确定性的：`board:<成员 id>:<驱动回合 id>:<事件>`，`waiting_user` 和
`notice` 再拼上 `awaitingUserSince` / `agentNotice.id`。`operations` 主键
`(requester_session_id, operation_id)` 和 `operation_retired_ids` 触发器因此天然实现
「接收的协调者 + 源事件」去重，重启、重复扫描、七天过期后都不会二次接受。完成体受
现有 64 KiB 上限约束（`assertCompletionBound`），截断的让协调者用 `lody_session_history`
读全文。

### 合批与链深度

批次全部是上游的：

- 协调者空闲时，第一条可唤醒的结果就登记 intent；忙时结果只是排队，回合正常释放
  （`release()`）时登记一个 intent。`prepare()` 领取时快照水位、冻结当时所有未消费
  未领取的结果为一批，领取之后到的结果等下一批。不做定时器、不做计数阈值。
- 用户给协调者的消息永远先走：人工输入到达时已准备好的自动批次被取代，排队的结果随
  人工输入一起送达（human-plus-batch）。
- 批次正文 `batchPreview` 内联最多 50 条、64 KiB，其余让协调者用
  `lody_operation_batch_get` 分页读（128 KiB 一页）。
- 批次深度 `batchDepth`（`inbox/model.ts`）：自动批次 = max(配置的 `chainDepth`，各
  成员的 `chain_depth`) + 1；人工或定时（`task`）批次 = 该输入自己的深度（通常 0）。
  自动批次深度 ≥ 16（`LODY_MAX_CHAIN_DEPTH`，`inbox/sqlite.ts` 的领取检查）时 intent 记
  为 `depth_limited`，不领取；结果留在队列里，等用户下一句话以深度 0 带走。

回报行的 `chain_depth` 取协调者当时最新驱动回合的深度（已决定：Inbox 修订第 1 条）。这样每次自主
唤醒恰好加一跳，用户或定时回合之后回到 0 再数，孙会话的事件不额外消耗跳数，而且和
协调者自己派发的回执（`initiatorChainDepth` = 派发时的深度）在常见情形下一致。从用户
的一句话起算，协调者最多自主唤醒 15 次（深度 1–15），第 16 次被 Inbox 拦下。协调者在
深度 15 仍可派发（上游只拒绝 ≥ 16 的发起者），被派发的成员在 16 不能再派。

Overview 的协调者行显示「自主链 n/16」，n 取协调者最新驱动回合的 `chainDepth`。到上限
时观察者在协调者历史写一张幂等的 `board_chain_limit` 系统通知：
「自主链已到上限，说一句话继续」，一次链一张；Overview 据此显示「已停止」。

### 去重

三层，都不依赖内存状态：

1. 游标：每个成员只报比 `board_report_cursors` 新的驱动回合 / 等待时刻 / 通知 id；被
   过滤掉的（人工驱动、已被回执覆盖）也前移游标，所以以后打开 `reportHumanTurns` 不会
   回放旧事件。
2. Operation id：同一成员、同一驱动回合、同一事件只能被接受一次（主键 + 退役 id）。
3. 回执覆盖：`finished` / `failed` 的 `(sessionId, userTurnId)` 若是协调者自己任何一条
   `session_create` / `session_chat`（含 `_many`）Operation 的目标，不论该 Operation 仍
   active 还是已完成仍保留，都不再报：那条回执本身会送达。只查 active 会在它完成后的
   下一次扫描重报。`waiting_user` 和 `notice` 没有对应的回执，照常报。已超时或被取消
   的根下尚未完成的目标不会被永久遮蔽：它们的终态回合比游标新，照常报。

回报是成员状态向上的唯一通道。提示里不要求、也不能依赖成员转发：被协调者的 chat 唤醒
的那个回合里，成员对协调者的 `lody_session_chat` 会被 `REVERSE_CHAT_FORBIDDEN` 拒绝；
孙会话（reviewer）的结果先唤醒它的父成员，父成员随后的完成由观察者补上。孙会话自己
的 `finished` 不单独回报，避免每轮评审唤醒协调者两次；`failed` / `waiting_user` /
`notice` 仍回报。父成员收到子会话结论后原样写进回复，不自行修改，由协调者筛选要改的项。

### 停止与暂停

全部复用上游，看板不加规则，只写明范围：

- 停止协作（`collaborationStopped`）：用户在会话的「相关会话」里停止整棵树时，界面给根
  和所有后代写 `collaborationStopped`（`readSessionOperationTargets(…, 'collaboration')`
  先沿 `parentSessionId` / `openedBySessionId` 爬到根，再收集后代），守护进程取消正在跑
  的回合并保留待处理输入（`reconcileCollaborationStops`）。对看板的影响：协调者所在的树
  被停时，Inbox 不会为它启动任何批次（`launchInboxBatch` 检查
  `isSessionCollaborationStopped`），它的 MCP 派发被 `COLLABORATION_STOPPED` 拒绝；观察者
  照常把成员事件写成结果，恢复协作后由上游的停止语义决定是否以及何时送达
  （`specs/session-orchestration.md`「User-controlled conversation-tree stop」）。
- 上游的停止范围是会话树：协调者开的线程及其后代。看板允许手动加入不相关的根会话，
  它们不在协调者的停止范围内，仍会继续跑，事件照常进队列。首版只做会话树停止，看板级
  的「停止全部成员」不做（已决定：Inbox 修订第 6 条）。
- Inbox 暂停：用户在协调者上按 Stop（Inbox v2 客户端带 `cancelId` / `pauseInbox`）时
  `pause()` 把会话标为 paused，取消排队的输入，释放已准备批次的领取；结果仍在队列
  里。暂停期间不登记 intent；只有新的、受信任的人工输入（`humanInputReceipts`）能清除
  暂停，并把积累的结果一起带走。agent 的 chat、定时回合、回报都清不掉暂停。
- 成员上的用户 Stop（#1553）：被手动停掉的目标在协调者的 Operation 回执里是
  `cancelled` + `cancellationReason: 'user_stop'`，`operationInboxCompletion` 把它从自动
  受理里滤掉，全部目标都被停时连结果都不可唤醒。观察者不报 `cancelled`，所以不会从另一
  条路把它变成唤醒。

### 失败与离线

- 协调者机器离线时事件留在文档里，机器回来后观察者按「最新状态」补报，不重建中间的
  事件流：一个成员离线期间变了三次，只报最后一次。线程机器离线时它的文档不更新，自然
  没有事件。
- 回报写入失败（SQLite 忙、事务失败）时三件事一起回滚，游标不前移，下一次唤醒重试，
  重试走 `coordinator-activity` 已有的有界退避，不加新的定时器。
- 结果不会因为守护进程停机太久被静默丢弃：`inbox_results` 里未消费的行不过期，pending
  intent 持久化并在启动扫描时恢复（`repo.pending`）；回报 Operation 创建即完成，没有
  deadline；已消费的载荷七天后清理，但历史里的批次卡片留下。
- 批次提交后模型是否收到不确定（`unknown` 结算）时，上游不重新合批，历史卡片标「模型
  投递不确定」。看板不补发：Overview 和 `lody_board_overview` 始终是当前状态的真相，
  协调者下一次被唤醒时可以自己看。
- 协调者被归档、移出看板或看板归档：观察者停下，游标和已有结果保留；永久删除会话时
  `deleteSession` 连同 Inbox 行一起删。

## 轮数、交接

### 轮数

轮数不是计数器，从当前代的历史推导：`role: 'user'` 且 `author.kind === 'agent'` 的回合数，
减去标了 `followUp` 的。人输入的回合和 system 驱动的回合（Inbox 批次、定时、续接）不计。
`lody_session_chat` 新增 `followUp?: true`，写进该 user turn 的 `inputConfig.boardFollowUp`。

`lody_session_chat` / `chat_many` 的目标是看板线程、轮数 ≥ `maxRoundsPerThread` 且没有
`followUp` 时，在接受 Operation 之前拒绝：`THREAD_ROUND_LIMIT`，消息里给出线程当前代
的 id、轮数和交接工具名。目标是已有后继代的旧代时拒绝 `THREAD_SUPERSEDED`，消息里给
当前代 id。两条检查排在上游的 `COLLABORATION_STOPPED`、`CHAIN_DEPTH_EXCEEDED`、
`REVERSE_CHAT_FORBIDDEN` 之后。人从界面发消息不受限制。

### 交接

`lody_board_thread_handoff({ threadId, prompt })`，协调者可用：

1. 在线程根下建一个子 Tab（走 CLI 的 `--parent` 路径），同一台机器、同一目录，运行配置
   继承上一代最后一回合（`resolveSessionTurnDispatchDefaults` 的冻结输入），
   `boardGeneration = 上一代 + 1`，`boardId` 继承；
2. 第一条消息 = 交接事实（Lody 生成：目录、分支、HEAD、上一代 session id、第几代、
   上一代的 `contextWindowUsage`）+ 协调者写的 `prompt`；
3. 返回新 session id。轮数从 0 起算。

线程根被用户停止协作时（`isSessionCollaborationStopped(root)`）交接拒绝
`COLLABORATION_STOPPED`，和上游对派发的处理一致：只有用户能恢复。

## Overview 页面

### 入口与路由

侧边栏导航加「看板」（`LoroSidebarNavKey` 增 `'boards'`，与 Schedules 并列），路由
`/boards`（看板列表，含新建）和 `/boards/$boardId`（Overview），`WORKSPACE_ROUTE_CHILD_SEGMENTS`
加 `boards`。首版不改侧边栏的会话分组：线程仍在各自机器 / 项目组里，看板页是全局视图。
移动端按 Schedules 的做法渲染同一页面。

### 信息结构

```text
┌ 看板 · Lody 协调者模式                                       [笔记] [设置] [归档看板] ┐
│ 目标：把 Claude Projects 的协调者模式搬进 Lody，首版四项……                             │
│ 协调者  Claude Opus 5.5 · devnuc        空闲 · 自主链 7/16 · 每日摘要 04:00   [打开]  │
├────────────────────────────────────────────────────────────────────────────────────┤
│ 线程 4                                                                  [+ 新线程]  │
│   ◌  PR1 数据模型            astra · mba · Lody/worktree      运行中        2/4  3 分钟前 │
│      └ 评审 (sol)                                              完成          —   10 分钟前 │
│   ●  PR2 回报机制            sol · devnuc · Lody/worktree     等你回答      4/4  1 小时前 │
│   ○  调研 Loro 同步 · 第 2 代 opus · n100 · chat                空闲 · 等协调者 1/4  昨天 │
│   ✗  UI 草图                 gemini · mba · chat               失败          2/4  2 小时前 │
│      最新结论：Flash 画不出可用的草图，建议换 Codex astra 直接写 Storybook……（展开）     │
│ 已归档 2 ▸                                                                           │
└────────────────────────────────────────────────────────────────────────────────────┘
```

每行：状态标记、标题、agent（`lastModel` / agent 配置）· 机器 · 工作上下文、状态文字、
轮数 n/上限（有代时标「第 k 代」）、最近活动；行尾沿用侧边栏的 PR / diff 图标。展开一行
才打开它的 session 文档，显示最后一条 assistant 文本的尾部（最新结论）和最新驱动回合
的首行（在做什么）；不展开不读文档，和归档页的预览一个思路。子 Tab 缩进在线程
下面；线程开的独立会话用现有的 opened-by 树缩进。

状态推导（共享 helper，渲染端和 `lody_board_overview` 同一份）：

| 显示                     | 来源                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| 运行中 / 启动中 / 收尾中 | presence（`sessionLiveStatusAtomFamily`），不用 `SessionMeta.status`                        |
| 等你回答                 | presence 为 `requestPermission`，或无 live 状态且 `awaitingUserSince` 晚于 `lastMessageAt` |
| 已停止                   | `collaborationStopped`（本会话或祖先）                                                      |
| 失败                     | 当前代最新驱动回合 `failed`，或 `chat_failed`                                               |
| 已取消                   | 当前代最新驱动回合 `canceled`                                                               |
| 空闲 · 等协调者          | 空闲且最新驱动回合不是人输入的                                                              |
| 空闲                     | 其余                                                                                        |

协调者行多显示「自主链 n/16」和「已停止」。Inbox 暂停没有同步到文档的证据，Overview
不显示，和上游一致。

### 回报在对话里的呈现

协调者历史里一个批次就是上游的 `operation_completion_batch` 系统回合：标题「N 条已完成
的任务结果」，成员逐条用 `OperationCompletionView` 渲染；创建类回执已经是紧凑任务面板
（`CreatedSessionList` / `operation_progress`，一行一个会话，五行可滚动）。看板回报不做
第二套卡片：`operationKind === 'board_report'` 的成员渲染成同一套紧凑行，一事件一行：
成员标题（订阅现有标题）· 事件标签 · 摘要首行，点击进会话。需要新增的只有两个状态
标签「等你回答」「通知」，因为现有行的状态词表只有创建/运行/成功/失败/取消。不做可展开
的结论预览：人看结论点进会话，协调者从批次正文读；一处事实只画一次。旧 PR3 的
`board-report-card.tsx` 不沿用。

### 动作

点行进入 session（现有导航，带 `?tab=` 定位当前代）；输入框就在那里，这就是插话。
行的 ⋯ 菜单：打开、移出看板、归档。页面头：笔记（右侧面板）、设置（名字、目标、规则、
协调者的 agent、每日摘要）、归档看板。协调者行的「打开」进协调者会话。
资源状态不画任何东西：没有事件的行只有标题和时间。

## 共享笔记

- Overview 的「笔记」面板：Markdown 编辑（textarea）+ 预览切换，预览复用 plan review
  面板的渲染；保存写 LoroText。
- 工具：`lody_board_notes_get`；`lody_board_notes_append({ text, heading? })` 追加一节，
  标题默认「{日期} · {session 标题}」；`lody_board_notes_replace({ text })` 整体替换。
  线程默认只追加；替换给协调者和人用（替换是删后插，和并发追加合并后追加的内容会落在
  末尾，可接受）。
- 和 nmem 的边界：Lody 不读写 nmem。笔记是看板内、界面可见的工作记录；长期记忆由 agent
  用自己的 nmem 工具写（每日摘要就是这么做）。memory provider 今天只管身份和环境变量
  （`NMEM_AGENT_ID`），没有 recall / save，不扩。
- 不做共享文件夹：线程分布在多台机器，文件夹要么单机要么要新同步机制，放到以后。

## 每日摘要

看板设置里的开关。打开时通过现有的 Schedule 命令服务建一条 Schedule：cron 每天一次
（时间可选，默认 04:00 Asia/Tokyo，和用户的一天切分一致），目的地 `existing_session` =
协调者 session，prompt 固定模板：读 `lody_board_overview` 和笔记，把当天的进展、结论、
未决问题写成一节追加到笔记，并存入 nmem。看板行记 `digestScheduleId`；关掉开关或归档
看板时暂停它。

用协调者会话做目的地，是因为它已经有看板工具、不需要给 Schedule 定义加字段。定时回合
的深度为 0，进入 Inbox 时是 `task` 类输入：它会把当时排队的结果以深度 0 一起带走，
于是每天顺便把自主链数一次。代价是协调者上下文每天多一回合。

摘要必须遵守停止和暂停：

- 定时回合没有人工收据（`humanInputReceipts`），Inbox 按 `task` 受理；协调者处于暂停时
  `inputAcceptance('task', paused)` 直接拒绝（`session-execution-service.ts` 的
  `inbox-paused`），暂停不会被清除。PR5 不得给摘要回合伪造人工收据。
- 协调者的树被停止时，派发把回合标为取消并保留输入，上游已有。
- PR5 在 handoff 前检查目的地是否已暂停或已停止，并把跳过的运行记为 skipped，
  避免被拒绝的回合悬在历史里「待处理」。PR3 仅记录此决定，不实现摘要。

## MCP 工具

看板工具只列给 `boardId` 有值的 session：agent 启动时把 `boardId` 随 `x-lody-mcp-board-id`
头 / `LODY_MCP_BOARD_ID` 环境变量交给 lody MCP 服务器决定是否注册；守护进程端每次调用
再按 session 当前元数据校验成员资格（`BOARD_NOT_MEMBER`）。全部是 Session 工具，经
`session/call-tool` 进守护进程，不开第二个写者。

### 新增

| 工具                        | 谁用   | 作用                                                |
| --------------------------- | ------ | --------------------------------------------------- |
| `lody_board_get`            | 成员   | 看板名、目标、规则、协调者 id、自己的角色           |
| `lody_board_overview`       | 成员   | 所有线程的状态行（同 Overview），≤ 100 条，≤ 64 KiB |
| `lody_board_notes_get`      | 成员   | 笔记全文                                            |
| `lody_board_notes_append`   | 成员   | 追加一节                                            |
| `lody_board_notes_replace`  | 协调者 | 整体替换                                            |
| `lody_board_thread_handoff` | 协调者 | 开下一代，见「交接」                                |

### 修改

- `lody_session_create` / `create_many`：无新参数；目标继承 `boardId`。回复里带
  `boardId`。
- `lody_session_chat` / `chat_many`：新增 `followUp?: true`；新增拒绝
  `THREAD_ROUND_LIMIT`、`THREAD_SUPERSEDED`。上游的 `COLLABORATION_STOPPED`、
  `CHAIN_DEPTH_EXCEEDED`、`REVERSE_CHAT_FORBIDDEN` 原样适用，排在前面。
- `lody_session_list`：新增过滤 `boardId`（接受 `'current'`）。
- `lody_operation_get/list`：kind 多一种 `board_report`；`lody_operation_batch_get` 不改，
  批次里的看板成员和普通成员一样分页。

Agent Role / Schedule 写入的权限档位上限不变；看板工具只写 Lody 自己的数据。

## 分步实现计划

每步独立可合并、可验证，顺序即依赖。PR1、PR2 已实现（见文末记录），这里只列和新机制
有出入的地方。

### PR1 看板、成员资格、Overview（只读）—— 已实现

- 实现内容见「PR1 已实现」。和本版的出入：Overview 的链深度显示上限按 16（代码里的
  `/32` 文案随 PR3 改）；状态推导的「最新 user turn」改成「最新驱动回合」随 PR3 一起改。

### PR2 协调者提示、看板工具、笔记 —— 已实现

- 实现内容见「PR2 已实现」。和本版的出入：提示文本里「回报尚未实现、请显式汇报」的
  占位随 PR3 换成上面的协调者/线程说明；没有自动 review 相关文案。

### PR3 基于 Inbox 的自动回报

- `packages/shared`：`session-orchestration.ts` 的 `LodyOperationKind` 加 `board_report`，
  `OperationResultSchema` 加可选 `boardReport`（`BoardReportEventSchema`，一条一事件）；
  `schema.ts` 加 `boardJoinedAtMs`；`board.ts` 加纯函数：`readLatestDrivingTurn`、事件
  推导、`boardReportOperationId`。
- `apps/cli/src/orchestration/operation-store.ts`：`board_report_cursors` 表；
  `acceptBoardReport()`（插入已完成 Operation + `inbox.indexCompletion()` + 游标，一个
  `BEGIN IMMEDIATE`）；`boardCoveredTargets()`（查 `operations` 任何状态的目标）；
  `inbox/sqlite.ts` 的 `MemberRow.operation_kind` 枚举加 `board_report`。
- `apps/cli/src/orchestration/coordinator-workflow.ts` / `operation-coordinator.ts`：
  看板分支（目录与 `doc-metadata` 订阅、脏成员集合、单飞 reconcile、事件推导、去重、
  接受）；在这里查 `depth_limited` intent 并写幂等系统通知。
  `operation-model.ts` 不改调度语义就不动；改了就补轨迹。
- `apps/cli/src/mcp/lody-mcp-server.ts`：`lody_operation_get/list` 接受新 kind。
- `session-execution-helpers.ts` `buildPrompt`：协调者/线程说明换成本版文本。
- `packages/components`：`OperationCompletionView` 的 `board_report` 分支（紧凑行 + 两个
  标签）；Overview 协调者行「自主链 n/16」「已停止」；`boards/AGENTS.md`；locale。
- 测试（注入时钟、真实 Mirror / `repo.watch` 订阅、显式 reconcile 屏障，
  `operation-coordinator.test.ts` + `operation-store.test.ts`）：忙时积累、释放后一批；
  人工输入以深度 0 带走排队结果；暂停中不登记 intent、下一句人工输入带走；停止的树不
  启动批次；成员被用户 Stop 不产生事件；孙会话 `waiting_user` 到达；回执覆盖去重（含
  已完成仍保留的 Operation）；`reportHumanTurns` 开关且关着时游标仍前移；system 驱动
  （续接）的完成被报；同一驱动回合多次权限请求只报一次；深度 15 → 16 时
  `depth_limited`；重启后结果与 intent 都在；游标写入注入失败时整笔回滚；已归档成员跳过；
  `boardJoinedAtMs` 之前的状态不报；流式导入不触发全量扫描（订阅计数）；孙会话
  `finished` 不产生回报，父成员续接完成后会回报。

### PR4 轮数、交接

- shared：轮数推导 helper（agent 作者的 user turn，减 `followUp`；人工与 system 驱动不
  计）；`inputConfig.boardFollowUp`。
- MCP：`lody_session_chat` 的两个拒绝，排在上游三个之后；`lody_board_thread_handoff`
  （走 `--parent` 路径，交接事实前缀，`boardGeneration`，根被停止时拒绝）。
- Overview：轮数、代。
- 测试：历史 → 轮数（含 followUp、人输入、Inbox 批次回合）；拒绝顺序；交接创建的 Tab
  共用目录并继承运行配置；根 `collaborationStopped` 时交接拒绝；旧代 `THREAD_SUPERSEDED`。

### PR5 每日摘要与收尾

- 看板设置开关 → Schedule 创建 / 暂停（`schedule-command-service.ts`）；`existing_session`
  目的地指向协调者；固定 prompt；归档看板暂停定时。
- 暂停与停止：不给摘要回合加人工收据；handoff 前检查目的地，在
  `schedule-run-preparation.ts` 的目的地检查旁加「协调者已暂停 / 已停止 → skipped」。
- 文档：`.agents/docs/experimental.md` 加「看板」一节；本 Spec 更新证据；Agent Note；
  `apps/cli/src/orchestration/README.md` 加看板回报一节。
- 测试：命令服务建出的定义（cron、目的地、prompt）；关掉开关后暂停；摘要回合进入已暂停
  的协调者不清除暂停且不执行；进入已停止的树被取消并保留输入。
- 真实 LAN 上跑一遍：协调者在 devnuc、线程在 mba 和 n100，看回报、交接、笔记、Stop。

## 风险

- 唤醒成本：每个空闲边界一次唤醒，线程多时协调者几乎不闲。缓解靠 Inbox 合批、不报人
  输入的回合、不单独报孙会话的完成；如果仍然太吵，下一步是按看板的最小唤醒间隔。
- 链深度：15 次自主唤醒后停住，夜里无人时可能停在半路，而且上游在上限处不写历史。先
  用 Overview 和幂等系统通知把它显示出来，再决定要不要单独预算。
- 批次结算 `unknown` 时上游不重发，协调者可能漏看一批；Overview 是真相，摘要和下次
  唤醒能补。
- Inbox 暂停没有同步证据，Overview 看不出协调者被按过 Stop。
- Overview 展开行要打开 session 文档；线程上限 100，一次只展开少数几行。
- 笔记整体替换和并发追加的合并结果可能把追加的内容放到末尾，不丢但位置不直观。
- 旧版本成员：不认识 `board` 行族的构建会丢弃该行（`parseWorkspaceFlockRow` 丢弃未知键），
  不认识 `boardId` / `boardJoinedAtMs` 的构建照常显示 session；回报只在协调者机器上，
  要求那台机器运行带 Inbox v2 和 `board_report` 的构建。
- 协调者的 agent 若是 Codex：按用户现行规则它不适合当协调者（派完不停）；创建时不拦，
  提示里不特殊处理。

## 已决定

以下八项由用户确认（第 3 条已按上游 0.105.0 改）；完整 Spec 仍为 draft。

1. 名字用「看板 / Board」，不用 Project。
2. 用户直接在线程里插话，那一轮完成后默认不唤醒协调者，只进 Overview 和每日摘要；单个看板可开启 `reportHumanTurns`。
3. 委派链上限跟上游，用 `LODY_MAX_CHAIN_DEPTH = 16`，不另做看板预算；Overview 显示深度和上限。
4. 后继会话是线程根的子 Tab，共用 worktree。
5. 每日摘要直接送入协调者会话。
6. 首版侧边栏不按看板分组，只增加看板导航和页面。
7. 轮数上限默认 4，按 agent 派发的 user turn 计，`followUp` 不计。
8. 协调者不强制 Claude，记住上次选择。

另外已定：自动 review 已随上游删除，设计里不再有 `THREAD_UNDER_AUTO_REVIEW`、自动
review 保护和对应的状态；交叉评审用普通的 reviewer 子会话。不合入上游的全局委派提示
（`adff308b`），协调者的做法只放在看板提示里。

## 已决定：Inbox 修订

用户已确认以下六项；完整 Spec 仍为 draft。

1. 回报行深度取协调者当时驱动回合的深度（方案 B）。每次自主唤醒加一跳，人工输入后归零，孙会话事件不额外消耗跳数。
2. 孙会话（reviewer 等）的 `finished` 不单独回报，由父成员被唤醒后的回复带回结论；`failed` / `waiting_user` / `notice` 仍回报。线程提示明确要求原样写入子会话结论，不自行按结论修改，改哪些由协调者决定。
3. `cancelled` 不回报，只进 Overview；避免绕过用户 Stop 不唤醒的规则。
4. 自主链到 16 时写幂等的 `board_chain_limit` 系统通知，一次链一张，提示用户说一句话继续；Overview 显示「已停止」。
5. 每日摘要在 handoff 前检查目的地暂停/停止，跳过的运行记为 skipped（方案 A）。PR5 实现，PR3 仅更新文档。
6. 首版不做看板级停止（方案 A）；沿用会话树停止，手动加入的独立根不在范围内。「停止全部看板成员」列入以后再做。

## 以后再做

- 侧边栏按看板分组、看板里的会话从机器 / 项目组里隐去。
- Overview 与协调者对话的分栏视图。
- 共享文件夹（需要跨机器文件同步）。
- 按上下文占用（`contextWindowUsage`）提示交接，而不只是轮数。
- 看板级的最小唤醒间隔或自主预算；看板级停止。
- 回报事件推送到手机（复用 `lody_notify_user` 的推送路径）。
- 看板模板（预设协调者 agent、规则、线程 Role 组合）。

## 证据

意图：本文。已检查的实现（设计依据，未改动）：

- Inbox 与回执：`apps/cli/src/orchestration/inbox/model.ts`（`batchDepth`、`batchPreview`）、
  `inbox/sqlite.ts`（`indexCompletion`、`requestAutomatic`、`prepare` 的 16 跳检查、`accept`、
  `pause`、`release`、`cleanupExpired`）、`inbox/rules.ts`（`operationInboxCompletion`、
  `user_stop`）、`inbox/service.ts`、`operation-store.ts`（`finish`、退役 id）、
  `coordinator-workflow.ts`（`reconcileItem`、`writeOperationProgress`）、
  `operation-coordinator.ts`（`launchInboxBatch`）、`apps/cli/src/orchestration/AGENTS.md`
  与 `README.md`、`specs/session-orchestration.md`。
- 停止与暂停：`packages/shared/src/session-operation-targets.ts`
  （`readSessionOperationTargets`、`isSessionCollaborationStopped`）、
  `apps/cli/src/session/session-execution-service.ts`（`cancelSession`、
  `reconcileCollaborationStops`、`acceptInboxHumanInput`、`inbox-paused`）、
  `apps/cli/src/lib/message-handler.ts`（`collaborationStopped` 订阅）、
  `packages/components/src/hooks/use-session-actions.ts`（`setTreeCollaborationStopped`）。
- 链与回头消息：`packages/shared/src/session-orchestration.ts`（`LODY_MAX_CHAIN_DEPTH`）、
  `apps/cli/src/mcp/lody-mcp-server.ts`（`resolveInvokingTurnContext`、`reverseChatError`、
  `readInvokingChatSender`）。
- 提示组装：`apps/cli/src/session/session-execution-helpers.ts`（`buildPrompt`）、
  `apps/cli/src/commands/session.ts`（`prepareSessionInput`、`resolveCreateContext`、
  `assertSupportedParentDepth`）、`apps/cli/src/lib/lan/lan-session-command.ts`、
  `apps/cli/src/mcp/lody-mcp-http-protocol.ts`、`agent-surface-tools.ts`。
- 状态信号：`apps/cli/src/lib/message-handler.ts`（`finalizeACPState`、权限请求写
  `awaitingUserSince`）、`apps/cli/src/lib/agent-notice.ts`、`packages/shared/src/schema.ts`
  （`SessionMeta`、`cancelRequest`、`getPendingUserTurnActivationId`）、`packages/shared/src/presence.ts`。
- 定时：`apps/cli/src/lib/schedules/schedule-run-preparation.ts`（`existing_session`）、
  `schedule-command-service.ts`、`apps/cli/src/lib/schedules/AGENTS.md`。
- 工作区文档与同步：`packages/shared/src/workspace-flock.ts`、`schedule-repository.ts`、
  `schedule-registry.ts`、`.agents/docs/lan.md`、`.agents/docs/workspace-catalog-durability.md`、
  `.claude/skills/lody-loro-sync-stack/SKILL.md`。
- 界面：`packages/components/src/routes/$workspaceName/_auth/`、`loro-app-sidebar.tsx`、
  `atoms/doc-meta.ts`、`atoms/presence.ts`、`components/archive/`、`components/schedules/`、
  `components/boards/`、`components/ai-gui/view.tsx`（`OperationCompletionBatchView`）、
  `components/ai-gui/created-session-list.tsx`、`.agents/docs/sessions-live-status.md`、
  `.agents/docs/experimental.md`。
- 关系与生命周期：`specs/session-relations.md`、`specs/session-worktree-lifecycle.md`、
  `specs/agent-role-memory.md`。
- 旧 PR3 实现 `08c5c26e0`（建在已删除的 Delivery 上，只作参考）及其 review 结论。

## PR1 已实现

PR1 已实现：看板 Flock 行、三项成员元数据、CLI/MCP 与界面子 Tab 继承、
`session_list` 看板筛选、实验开关、创建对话框、桌面/移动入口和只读 Overview。
实现细节和检查记录见 [PR1 Agent Note](../../.agents/notes/implemented/feature/2026-10-15-board-overview.zh.md)。
PR1 完成时 PR2–PR5 尚未实现。Overview 的「+ 新线程」以及会话 ⋯ 菜单中的
「加入看板 / 移出看板」不在 PR1 内，安排到 PR2 实现。

PR1 与最初文件分工的调整：界面创建并不经过 CLI `prepareSessionInput`，因此还必须在
`packages/components/src/lib/session-submission.ts` 的两个创建入口继承成员资格。
看板沿用共享 catalog room，不新建订阅。未展开的线程只显示 presence 和元数据能证明的状态；
失败、等待协调者和最新消息随展开读取，协调者默认展开以显示自主链。
轮数、代际切换按 PR4 计划保留。跨设备上限和创建同现有目录一样不是分布式事务。

## PR2 已实现

PR2 增加 Overview 的新线程、桌面和移动端会话菜单的加入/移出操作、角色提示、五个
看板 MCP 工具和共享笔记面板。新线程复用创建看板的 Agent/Role 选择与正常会话接受
流程，以 chat 为工作上下文；不会改写记住的协调者选择。手动成员操作只改选中的会话，
不级联修改已有子 Tab；Tab 创建时的继承保持 PR1 行为。固定协调者不提供移出操作。

提示在 `buildPrompt` 的创建路径追加，续接回合不重复追加。此阶段明确告知 agent：
Board 自动回报、轮数拒绝和交接尚未实现；已有 Operation 回执照常工作，其余事件需
约定显式汇报。完整「内置提示」中依赖 PR3/PR4 的承诺留待对应实现，避免让协调者等待
尚不存在的通知。已有会话加入看板后，工具列表在下次 ACP 建立时更新；移出后的工具
调用立即按当前元数据拒绝。

`lody_board_overview` 使用和折叠 UI 行相同的元数据/presence 状态，不批量打开会话
文档；失败和最新结论通过 `session_history` 按需读取。回复至多 100 行、64 KiB，
超出时返回 `truncated`。代际和轮数仍留给 PR4。

笔记采用 `board-<id>` 的原生 LoroText，shared 共用读写与 UTF-8 容量检查，CLI
在守护进程的现有 repo 打开/同步，渲染端仅在面板打开时订阅并支持 textarea/Markdown
预览。容量 256 KiB 是每次本地写入的上限，不是跨机器全局锁；两个合规追加合并后
可能超限，保留全部内容并拒绝继续增长，协调者或用户可通过替换缩减。文档发现仍靠
看板行，不新增注册表。长期记忆、自动回报、交接、轮数限制、每日摘要未纳入本 PR。

实现与验证：[PR2 Agent Note](../../.agents/notes/implemented/feature/2026-10-15-board-tools-notes.zh.md)。

PR2 评审修正：目录和笔记同步失败仅记录警告，创建和工具调用继续使用本地副本；
本地持久化成功即完成写入，上传仍在后台进行。协调者身份与默认笔记标题使用调用上下文的
session id，不要求稀疏元数据包含 id。线程约束由 Lody 在首条消息注入一次，协调者不重复转述。
