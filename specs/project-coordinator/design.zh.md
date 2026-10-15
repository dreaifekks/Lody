# 看板与协调者（Board coordinator mode）

Status: draft
Translation: current

[English](design.md)

把 Claude Projects 的「一个范围里多条并行线程，由内置协调者拆任务、派线程，人随时
可以点进任意线程插话」搬进 Lody。本文是首版设计，只描述意图、数据归属和投递保证；
实现细节以各模块的 `AGENTS.md` 为准。文末记录用户已经确认的决定。

## 场景

用户建一个看板「Lody 协调者模式」，写下目标，选 Claude Opus 当协调者。协调者读目标后
用 `lody_session_create` 开三个执行线程（两个在 devnuc 的 worktree 里改代码，一个在
n100 调研），然后结束回合。

每个线程回合结束、等人回答、失败，或者线程自己开的 reviewer 子会话跑完，Lody 都会在
协调者空闲时把这些事打包成一条系统回合送给它；协调者不必在提示里让执行 session
"用 lody_session_chat 把结论转发回来"。用户打开看板的 Overview，看到三个线程各自在
做什么、等谁、第几轮、最新结论，点进任意一个直接在它的输入框里插话。线程里的
agent 直接面对用户，协调者不是传话中间人。

执行线程接到第 5 轮任务时 Lody 拒绝这条消息，协调者改用交接工具开新一代，新一代共用
原来的 worktree。所有线程都能读写看板的共享笔记；每天凌晨一条定时任务把当天进展写进
笔记和 nmem。

## 概念与命名

| 概念       | 含义                                                                           | 标识符           |
| ---------- | ------------------------------------------------------------------------------ | ---------------- |
| 看板 Board | 一组属于同一件事的 session，带一个协调者、一份共享笔记和几条规则                | `board`, `bd_*`  |
| 协调者     | 看板固定的一个 session，由 Lody 注入协调者提示，接收自动回报                   | `boardRole`      |
| 线程       | 看板里不是协调者的根 session（没有 `parentSessionId`）                         | 线程 id = 根 id  |
| 代         | 线程到轮数上限后交接出的后继会话，是根 session 的子 Tab，共用目录               | `boardGeneration` |
| 回报       | Lody 在协调者空闲时送达的一条系统回合，装着成员 session 的新事件               | `board_report`   |

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

每个工作区至多 50 个未归档看板；已归档（`archivedAtMs` 有值）的看板不计入上限。看板行不保存成员列表：成员资格写在 session 自己的元数据
上，Overview 和工具都按 `boardId` 过滤，没有第二份需要维护一致的名单。

### 成员资格

`SessionMeta`（`packages/shared/src/schema.ts`）新增三个字段：

```ts
boardId?: BoardId;             // 成员资格
boardRole?: 'coordinator';     // 协调者；线程不写
boardGeneration?: number;      // 交接出的后继会话：2、3、…；评审类子 Tab 不写
```

写入时机，全部在创建路径（`prepareSessionInput`，`apps/cli/src/commands/session.ts`）：

- 看板创建时建的协调者 session：`boardId` + `boardRole`。
- 看板成员通过 `lody_session_create` / `create_many` 开的会话：继承请求者的 `boardId`，
  不论 `useCurrentSessionAsParent` 还是独立 `workContext`，chat 类也一样。执行线程开的
  reviewer 因此自动入板，这是回报能覆盖孙会话的原因。
- 子 Tab（`parentSessionId`）：继承根的 `boardId`。
- 用户在 Overview 上「新线程」：写 `boardId`；session 的 ⋯ 菜单「加入看板 / 移出看板」
  改写 `boardId`。移出只改字段，不动会话。

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
"线程状态"、`lody_session_chat` 的轮数检查都按当前代算。代是子 Tab 而不是新根，是因为
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

回报游标和回报本身放在协调者所在机器的 Operation 存储里（`operations.sqlite3`，
`apps/cli/src/orchestration/operation-store.ts`）：

- `board_report_cursors(board_id, session_id, last_reported_user_turn_id,
  last_reported_awaiting_since, last_reported_notice_id)`；
- 回报是 `operations` 表里 kind = `board_report` 的一条已完成 Operation，加同一事务里的
  `deliveries` 行。

### 多机 / LAN 同步

| 数据                     | 位置                       | 同步方式                                    |
| ------------------------ | -------------------------- | ------------------------------------------- |
| 看板行、成员资格、笔记   | 工作区 / session / 看板文档 | 持久流，经 hub 同步到每个成员，离线编辑后合并 |
| 回报游标、回报 Operation | 协调者机器的 SQLite         | 不同步；和今天的 Operation 一样               |
| 线程状态                 | session 元数据 + presence  | 元数据持久同步；presence 走已有的瞬态通道，只读 |

线程可以在任何成员机器上。协调者机器观察线程靠的是同步过来的 session 文档，和今天
Operation 的回执一样（`reconcileItem` 通过 `getOrCreateSessionDoc` 读目标文档），不需要
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
- 回报回合：回报本身就是系统回合的 `inputConfig.prompt`（同 `completionText`），开头带
  一段固定说明，不另外注入。

协调者说明是产品模板，内容固定、按看板字段填空：

1. 身份与目标：你是看板「{name}」的协调者；目标：{purpose}。
2. 工作方式：拆任务、用 `lody_session_create` 开线程、派完结束回合等回报；回报自动
   送达，包括线程开的子会话，不要让执行 session 转发；用 `lody_board_overview` 看全局，
   用 `lody_session_history` 读细节。
3. Lody 代你执行的规则：每个线程最多 {maxRoundsPerThread} 轮，到上限后
   `lody_session_chat` 会被拒绝，改用 `lody_board_thread_handoff` 交接；线程在跑自动
   review 时 `lody_session_chat` 会被拒绝，等回报；对当前这轮的补充用 `followUp: true`，
   不计轮数。
4. 执行线程的固定约束（原样转给线程）：{executorConstraints}。
5. 共享笔记：`lody_board_notes_*`；结论和决定写进笔记，别只留在对话里。
6. 只向用户汇报结论和需要用户决定的事。

线程说明一段：本会话属于看板「{name}」（目标一句）；协调者 session 是 {id}；你的回合
结束、等人回答或失败时 Lody 会自动通知协调者，不必转发；共享笔记工具；约束：
{executorConstraints}。交接出的新一代还会在前面加上交接事实（见「交接」）。

### 产品逻辑 vs 提示

| 做成产品逻辑                                                   | 留在提示里                                           |
| -------------------------------------------------------------- | ---------------------------------------------------- |
| 成员资格继承、回报的事件来源与投递、批次合并                   | 怎么拆任务、派给谁、交叉评审的组合                   |
| 轮数统计、轮数上限拒绝、`followUp`                             | 什么算"补充"而不是新一轮（由协调者打 `followUp`）    |
| 交接：子 Tab、共用目录、交接事实前缀                           | 交接说明的正文（做了什么、没解决什么）               |
| 自动 review 期间拒绝 agent 消息，review 结束作为事件回报       | 收到评审结论后筛选（例如去掉 Codex 的防御性建议）    |
| 笔记文档、容量、追加/替换                                      | 笔记写什么、何时写                                   |
| 每日摘要的定时与目的地                                         | 摘要的写法，写入 nmem 的命令                         |

Agent Role 偏好（哪类任务用哪个模型）和「只 commit 不 push」这类约束不进代码：前者继续
放在 nmem 的 agent 规则里，后者放在看板的 `executorConstraints` 文本里，用户可改。

## 自动回报

### 事件来源

全部来自同步到协调者机器的 session 文档，对看板里除协调者以外的每个成员（含子 Tab）：

| 事件           | 证据（`SessionMeta` / 历史）                                                                  |
| -------------- | --------------------------------------------------------------------------------------------- |
| `finished`     | 最新的 user turn 已有 `isTerminalAssistantEntry` 的 assistant 行，且比游标新                  |
| `failed`       | user turn `status === 'failed'`，或同回合的 `chat_failed` 系统行                              |
| `cancelled`    | user turn `status === 'canceled'`                                                             |
| `waiting_user` | `awaitingUserSince` 新设置：权限请求、提问、自动 review 到终态                                 |
| `notice`       | `agentNotice.id` 变化（线程调用了 `lody_notify_user`）                                        |

每条事件带：session id、标题、机器、当前代、轮数 n/上限、`contextWindowUsage`、起因
（`author.kind`：agent 派发还是人输入）、assistant 文本的 32 KiB 尾重预览（同 Operation
item 的 `output`）、`waiting_user` 时的请求摘要。

### 观察者与投递

观察者是 `LodyOperationCoordinator`（`apps/cli/src/orchestration/operation-coordinator.ts`）
里新增的看板分支，只在协调者 session 所在机器的 Host-lease Worker 里跑，和 Delivery
一样以 `meta.machineId === this.machineId` 为界：

```text
成员 session 文档变化 ──▶ wake（提示）──▶ 按级别扫描看板成员，和游标比对
                                              │ 有新事件，且协调者处于空闲边界
                                              ▼
                     一条已完成的 Operation(kind=board_report) + Delivery（同一事务，游标同时前移）
                                              │ 现有 Delivery 管道：claim → 写系统回合 → continueSession
                                              ▼
                     协调者历史里一张「看板回报」卡 + 一次 agent 唤醒
```

空闲边界 = 没有进行中的回合、没有待派发的用户消息、没有待送的 Delivery，就是
`deliverIfRunnable` 今天的判断。回报只在这个边界成形，所以：

- 协调者忙时事件只是在文档里积累，它的回合一结束，下一次扫描把所有新事件打成一批，
  一次唤醒；不做定时器、不做计数阈值。
- 用户给协调者的消息永远先走（pending users win idle boundaries），回报排在后面。
- 回报是 Operation，于是 claim / 两次尝试 / uncertain / 8 小时过期 / `lody_operation_list`
  可见，全都是现成的。

一批里的事件数不设上限，预览按完成体 64 KiB 的现有规则头尾截断，截断的让协调者用
`lody_session_history` 读全文。游标在同一事务里前移，重复扫描不会重报。

### 去重与边界

- 协调者自己用 `lody_session_create` / `chat` 派出的回合，回执已经由那条 Operation 送达，
  回报跳过仍处于 active Operation 目标集里的 `(sessionId, userTurnId)`；完成后再出现的
  新回合照常回报。
- 人在线程里输入的回合完成不唤醒协调者（默认 `reportHumanTurns: false`），只进
  Overview 和每日摘要；`waiting_user`、`failed`、`notice` 不分起因都报。原因：用户插话
  是在接管线程，每次插话都唤醒协调者既费 token 又反客为主。开关按看板。
- 线程跑自动 review 期间，回报不向线程发任何东西，所以 review 不会被打断；review 到
  终态时引擎本来就写 `awaitingUserSince` 和交接文本，这一条作为 `waiting_user` 回报。
- 协调者被归档或移出看板：观察者停下，游标保留。

### 链深度

回报回合的 `chainDepth` = 这批事件里各回合 `inputConfig.chainDepth` 的最大值 + 1，
走现有的 `LODY_MAX_CHAIN_DEPTH = 32`。一次「协调者派发 → 线程完成 → 回报唤醒」是
两跳，所以没有人说话时协调者最多自主唤醒 16 次；此后回报仍写成卡片进历史，但带
`continuation.reason = CHAIN_DEPTH_EXCEEDED` 不再唤醒。用户给协调者发任何一句话，深度
回到 0（人的回合深度为 0），下一个空闲边界继续。Overview 显示「自主链 n/32」。
是否给看板单独的预算，见已决定第 3 条。

### 失败与离线

协调者机器离线时事件留在文档里，机器回来后一次扫描补报。线程机器离线时它的文档不
更新，自然没有事件。Operation 的 Delivery 失败语义（`DELIVERY_ATTEMPTS_EXHAUSTED`、
`DELIVERY_EXECUTION_UNCERTAIN`）原样适用；回报写入失败不前移游标。

## 轮数、交接、自动 review 保护

### 轮数

轮数不是计数器，从当前代的历史推导：`role: 'user'` 且 `author.kind === 'agent'` 的回合数，
减去标了 `followUp` 的。人输入的回合不计。`lody_session_chat` 新增 `followUp?: true`，
写进该 user turn 的 `inputConfig.boardFollowUp`。

`lody_session_chat` / `chat_many` 的目标是看板线程、轮数 ≥ `maxRoundsPerThread` 且没有
`followUp` 时，在接受 Operation 之前拒绝：`THREAD_ROUND_LIMIT`，消息里给出线程当前代
的 id、轮数和交接工具名。目标是已有后继代的旧代时拒绝 `THREAD_SUPERSEDED`，消息里给
当前代 id。人从界面发消息不受限制。

### 交接

`lody_board_thread_handoff({ threadId, prompt })`，协调者可用：

1. 在线程根下建一个子 Tab（走 CLI 的 `--parent` 路径），同一台机器、同一目录，运行配置
   继承上一代最后一回合（`resolveSessionTurnDispatchDefaults` 的冻结输入），
   `boardGeneration = 上一代 + 1`，`boardId` 继承；
2. 第一条消息 = 交接事实（Lody 生成：目录、分支、HEAD、上一代 session id、第几代、
   上一代的 `contextWindowUsage`）+ 协调者写的 `prompt`；
3. 返回新 session id。轮数从 0 起算。

### 自动 review 保护

目标线程的 `autoReview` 运行文档处于非终态时，`lody_session_chat` 拒绝
`THREAD_UNDER_AUTO_REVIEW`（retryable），因为人类输入会暂停 review，agent 消息也会。
Overview 行显示「自动 review 中」。判断复用 review-automation 自己的运行状态谓词，不
另写一套。

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
│ 协调者  Claude Opus 5.5 · devnuc        空闲 · 自主链 7/32 · 每日摘要 04:00   [打开]  │
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
才打开它的 session 文档，显示最后一条 assistant 文本的尾部（最新结论）和最后一条 user
turn 的首行（在做什么）；不展开不读文档，和归档页的预览一个思路。子 Tab 缩进在线程
下面；线程开的独立会话用现有的 opened-by 树缩进。

状态推导（共享 helper，渲染端和 `lody_board_overview` 同一份）：

| 显示          | 来源                                                                 |
| ------------- | -------------------------------------------------------------------- |
| 运行中 / 启动中 / 收尾中 | presence（`sessionLiveStatusAtomFamily`），不用 `SessionMeta.status` |
| 等你回答      | presence 为 `requestPermission`，或无 live 状态且 `awaitingUserSince` 晚于 `lastMessageAt`                                              |
| 自动 review 中 | `autoReview` 运行文档非终态                                           |
| 失败          | 当前代最后一个 user turn `failed`，或 `chat_failed`                    |
| 空闲 · 等协调者 | 空闲且最后一个 user turn 是 agent 派发的                              |
| 空闲          | 其余                                                                 |

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

用协调者会话做目的地，是因为它已经有看板工具、不需要给 Schedule 定义加字段，而且
Schedule 的回合深度为 0，每天顺便把自主链重置一次。代价是协调者上下文每天多一回合。

## MCP 工具

看板工具只列给 `boardId` 有值的 session：agent 启动时把 `boardId` 随 `x-lody-mcp-board-id`
头 / `LODY_MCP_BOARD_ID` 环境变量交给 lody MCP 服务器决定是否注册；守护进程端每次调用
再按 session 当前元数据校验成员资格（`BOARD_NOT_MEMBER`）。全部是 Session 工具，经
`session/call-tool` 进守护进程，不开第二个写者。

### 新增

| 工具                          | 谁用         | 作用                                                        |
| ----------------------------- | ------------ | ----------------------------------------------------------- |
| `lody_board_get`              | 成员         | 看板名、目标、规则、协调者 id、自己的角色                   |
| `lody_board_overview`         | 成员         | 所有线程的状态行（同 Overview），≤ 100 条，≤ 64 KiB          |
| `lody_board_notes_get`        | 成员         | 笔记全文                                                    |
| `lody_board_notes_append`     | 成员         | 追加一节                                                    |
| `lody_board_notes_replace`    | 协调者       | 整体替换                                                    |
| `lody_board_thread_handoff`   | 协调者       | 开下一代，见「交接」                                        |

### 修改

- `lody_session_create` / `create_many`：无新参数；目标继承 `boardId`。回复里带
  `boardId`。
- `lody_session_chat` / `chat_many`：新增 `followUp?: true`；新增拒绝
  `THREAD_ROUND_LIMIT`、`THREAD_SUPERSEDED`、`THREAD_UNDER_AUTO_REVIEW`。
- `lody_session_list`：新增过滤 `boardId`（接受 `'current'`）。
- `lody_operation_get/list`：kind 多一种 `board_report`。

Agent Role / Schedule 写入的权限档位上限不变；看板工具只写 Lody 自己的数据。

## 分步实现计划

每步独立可合并、可验证，顺序即依赖。

### PR1 看板、成员资格、Overview（只读）

- `packages/shared`：`board.ts`（`BoardMeta`、规范化、状态推导 helper）、
  `workspace-flock.ts` 加 `board` 行族、`schema.ts` 加三个字段、`workspace-route.ts` 加段。
- `apps/cli/src/commands/session.ts`：`prepareSessionInput` 接受 `boardId/boardRole/boardGeneration`；
  `apps/cli/src/mcp/lody-mcp-server.ts`：create 继承 `boardId`，`session_list` 过滤。
- `packages/components`：`/boards` 与 `/boards/$boardId` 路由与页面、新建看板对话框
  （复用 `schedule-agent-controls.tsx`）、导航项、实验开关「看板」
  （`experimental-features-setting.tsx`，Experimental · Sessions）、locale 文案。
- 测试：shared 规范化与状态推导；`lody-mcp-server.test.ts` 加继承用例（含
  `useCurrentSessionAsParent` 与独立 `workContext`）；页面行模型用真实 atoms 的组件测试，
  按 `archive-list-virtual-rows.test.tsx` 的方式。

### PR2 协调者提示、看板工具、笔记

- Overview「+ 新线程」和会话菜单「加入看板 / 移出看板」。

- `session-execution-helpers.ts` `buildPrompt`：协调者说明、线程说明（按 `boardRole`）。
- 看板文档 `board-<id>`：shared 读写（仿 `schedule-repository.ts`），CLI 侧打开与容量；
  components 侧 `useBoardDocument`（仿 `useScheduleDocument`）和笔记面板。
- MCP：`lody_board_get/overview/notes_*`，`lody-mcp-http-protocol.ts` 加 board 头，
  `agent-client.ts` 传递，`session-tool-router` 注册。
- 测试：`buildPrompt` 输出；工具经守护进程路由的行为测试（成员 / 非成员 / 容量）；
  笔记并发追加的合并（两个 LoroText 副本）。

### PR3 自动回报

- `operation-store.ts`：`board_report` kind、`board_report_cursors` 表、
  `acceptFinishedReport()`（Operation + Delivery + 游标，一个 `BEGIN IMMEDIATE` 事务）。
- `operation-coordinator.ts`：看板分支（成员订阅、级别扫描、空闲边界、去重、链深度）。
- shared：`OperationCompletionContent.continuation.reason.code` 加 `CHAIN_DEPTH_EXCEEDED`；
  `session-orchestration.ts` 的 kind 联合；回报卡片渲染（`operation_completion` 按 kind 分支）。
- `operation-model.ts`：加回报的调度语义与轨迹。
- 测试：`operation-coordinator.test.ts` 新增场景（注入时钟、真实 Mirror 订阅）：忙时积累
  一批唤醒一次；用户消息优先；孙会话完成到达；Operation 目标去重；`reportHumanTurns`；
  链深度封顶后只写卡片；协调者离线后补报。`operation-store.test.ts` 事务与游标。

### PR4 轮数、交接、自动 review 保护

- shared：轮数推导 helper；`inputConfig.boardFollowUp`。
- MCP：`lody_session_chat` 的三个拒绝；`lody_board_thread_handoff`（走 `--parent` 路径，
  交接事实前缀，`boardGeneration`）。
- Overview：轮数、代、自动 review 中。
- 测试：历史 → 轮数（含 followUp、人输入）；拒绝路径；交接创建的 Tab 共用目录并继承
  运行配置；对着一份非终态 review 运行文档的拒绝。

### PR5 每日摘要与收尾

- 看板设置开关 → Schedule 创建 / 暂停（`schedule-command-service.ts`）；`existing_session`
  目的地指向协调者。
- 文档：`.agents/docs/experimental.md` 加「看板」一节；本 Spec 更新证据；Agent Note。
- 测试：命令服务建出的定义（cron、目的地、prompt）；关掉开关后暂停。
- 真实 LAN 上跑一遍：协调者在 devnuc、线程在 mba 和 n100，看回报、交接、笔记。

## 风险

- 唤醒成本：每个空闲边界一次唤醒，线程多时协调者几乎不闲。缓解靠批次合并和不报人输入
  的回合；如果仍然太吵，下一步是按看板的最小唤醒间隔。
- 链深度：16 次自主唤醒后停住，夜里无人时可能停在半路。先用 Overview 把它显示出来，再
  决定要不要单独预算。
- Overview 展开行要打开 session 文档；线程上限 100，一次只展开少数几行。
- 笔记整体替换和并发追加的合并结果可能把追加的内容放到末尾，不丢但位置不直观。
- 旧版本成员：不认识 `board` 行族的构建会丢弃该行（`parseWorkspaceFlockRow` 丢弃未知键），
  不认识 `boardId` 的构建照常显示 session；回报只在协调者机器上，要求那台机器先升级。
- 协调者的 agent 若是 Codex：按用户现行规则它不适合当协调者（派完不停）；创建时不拦，
  提示里不特殊处理。

## 已决定

以下八项由用户在 PR1 实现任务中明确确认；完整 Spec 仍为 draft。

1. 名字用「看板 / Board」，不用 Project。
2. 用户直接在线程里插话，那一轮完成后默认不唤醒协调者，只进 Overview 和每日摘要；单个看板可开启 `reportHumanTurns`。
3. 自主链首版沿用现有 32 跳，Overview 显示深度和上限。
4. 后继会话是线程根的子 Tab，共用 worktree。
5. 每日摘要直接送入协调者会话。
6. 首版侧边栏不按看板分组，只增加看板导航和页面。
7. 轮数上限默认 4，按 agent 派发的 user turn 计，`followUp` 不计。
8. 协调者不强制 Claude，记住上次选择。

## 以后再做

- 侧边栏按看板分组、看板里的会话从机器 / 项目组里隐去。
- Overview 与协调者对话的分栏视图。
- 共享文件夹（需要跨机器文件同步）。
- 按上下文占用（`contextWindowUsage`）提示交接，而不只是轮数。
- 看板级的最小唤醒间隔或自主预算。
- 回报事件推送到手机（复用 `lody_notify_user` 的推送路径）。
- 看板模板（预设协调者 agent、规则、线程 Role 组合）。

## 证据

意图：本文。已检查的实现（设计依据，未改动）：

- 回执与投递：`apps/cli/src/orchestration/operation-coordinator.ts`（`reconcileItem`、
  `deliverIfRunnable`、`writeCompletionTurn`、`completionText`）、`operation-store.ts`、
  `packages/shared/src/session-orchestration.ts`、`apps/cli/src/orchestration/AGENTS.md`。
- 提示组装：`apps/cli/src/session/session-execution-helpers.ts`（`buildPrompt`）、
  `apps/cli/src/commands/session.ts`（`prepareSessionInput`、`resolveCreateContext`、
  `assertSupportedParentDepth`）、`apps/cli/src/lib/lan/lan-session-command.ts`、
  `apps/cli/src/mcp/lody-mcp-server.ts`（`resolveMcpSessionCreate`、`resolveInvokingTurnContext`、
  `sessionSummaryForMcp`）、`apps/cli/src/mcp/lody-mcp-http-protocol.ts`、`agent-surface-tools.ts`。
- 状态信号：`apps/cli/src/lib/message-handler.ts`（`finalizeACPState`、权限请求写
  `awaitingUserSince`）、`apps/cli/src/lib/review-automation/create-review-automation.ts`
  （`notifyNeedsUser`）、`apps/cli/src/lib/agent-notice.ts`、`packages/shared/src/schema.ts`
  （`SessionMeta`、`getPendingUserTurnActivationId`）、`packages/shared/src/presence.ts`。
- 工作区文档与同步：`packages/shared/src/workspace-flock.ts`、`schedule-repository.ts`、
  `schedule-registry.ts`、`apps/cli/src/lib/schedules/AGENTS.md`、`.agents/docs/lan.md`、
  `.agents/docs/workspace-catalog-durability.md`、`.claude/skills/lody-loro-sync-stack/SKILL.md`。
- 界面：`packages/components/src/routes/$workspaceName/_auth/`、`loro-app-sidebar.tsx`、
  `loro-sidebar.tsx`、`atoms/doc-meta.ts`、`atoms/presence.ts`、`components/archive/`、
  `components/schedules/`、`hooks/use-schedules.ts`、`.agents/docs/sessions-live-status.md`、
  `.agents/docs/components-sidebar-session-tree.md`、`.agents/docs/experimental.md`。
- 关系与生命周期：`specs/session-relations.md`、`specs/session-worktree-lifecycle.md`、
  `specs/session-orchestration.md`、`specs/agent-role-memory.md`。

PR1 已实现：看板 Flock 行、三项成员元数据、CLI/MCP 与界面子 Tab 继承、
`session_list` 看板筛选、实验开关、创建对话框、桌面/移动入口和只读 Overview。
实现细节和检查记录见 [PR1 Agent Note](../../.agents/notes/implemented/feature/2026-10-15-board-overview.zh.md)。
PR2–PR5 尚未实现，前文对应段落仍表示未来意图。Overview 的「+ 新线程」以及
会话 ⋯ 菜单中的「加入看板 / 移出看板」不在 PR1 内，明确安排到 PR2 实现。

PR1 与最初文件分工的调整：界面创建并不经过 CLI `prepareSessionInput`，因此还必须在
`packages/components/src/lib/session-submission.ts` 的两个创建入口继承成员资格。
看板沿用共享 catalog room，不新建订阅。未展开的线程只显示 presence 和元数据能证明的状态；
失败、等待协调者和最新消息随展开读取，协调者默认展开以显示自主链。
轮数、代际切换和自动 review 状态按 PR4 计划保留。跨设备上限和创建同现有目录一样不是分布式事务。
