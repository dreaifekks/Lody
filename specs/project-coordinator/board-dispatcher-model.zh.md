# 看板：主会话分活，线程协调

Status: draft
Translation: pending

2026-10-18 用户决定（分支 `feat/board-dispatcher-model`）。它替换[看板与协调者](design.zh.md)
里「回报唤醒协调者、协调者汇总」和「线程只执行」这两部分；其余（成员资格、事件来源、
去重游标、交接、空闲整理）不变。作废的提案：`board-status-display.zh.md`（T8，未合并）。

## 场景

用户在看板主会话里说「做 A 和 B」。主会话开两个线程，写好任务说明，结束回合。线程 A
自己开调研、实现、review 子会话，结论直接写在自己的对话里。用户回到侧边栏，看到看板
那一行亮蓝点；打开看板，线程 A 那一行亮蓝点，点进去读结论，接着和线程 A 聊。主会话在
这期间一次也没有被唤醒。用户过一阵问主会话「现在怎么样了」，主会话这一回合的输入里
附带了它还没看过的看板事件摘要，再按需用 `lody_board_overview` / `lody_session_history` 查。

## 决定

### 提示：和普通会话一样

- 看板面板的线程行用侧边栏会话行同一个状态标记（`SessionRowStatusIndicator`）：等用户 ✋、
  运行中方块动画、完成后没看过蓝点（`lastMessageAt > lastReadAt`），看过就消失。已停止的
  ⊘ 只在没有这三种状态时画。不新增「完成」状态，分组规则不变。
- 侧边栏的看板行按组聚合全部成员（主会话 + 线程 + 线程的子会话，不含已归档）：任一在等
  用户 ✋，否则任一在运行动画，否则任一未读蓝点。用同一个 `SidebarRowEndSlot`，所以
  先后顺序、运行→蓝点的收拢动画也和会话行一致。
- 等用户的判定沿用看板现有的：presence 是 `requestPermission`，或者没有 presence 且
  `awaitingUserSince > lastMessageAt`。
- 维护回合（空闲整理三轮）照旧不更新 `lastMessageAt`，所以不产生未读。

### 主会话：分活，不被唤醒

- 主会话（`boardRole: 'coordinator'`）发起的 Operation（`session_create`/`session_chat`
  及 `_many`）和看板回报（`board_report`）在接受时冻结 `deliverWithNextInput: true`。
  Inbox 收到这样的结果只入队，不登记唤醒（`automatic_eligible = 0`），回合正常释放时也
  不唤醒。
- 这些排队的结果就是看板事件日志：用户（或定时任务）下一次给主会话发消息时，上游的
  human-plus-batch 把还没送达过的全部带上，送达一次就消费掉。
- 主会话正在回答时用户插话（steer）：插话只带用户的话，带不上排队的结果，所以有排队结果时
  这句话不 steer，改成排在当前回合之后的普通回合，结果随它一起送达。
- 防撑爆：排队副本里每条输出最多 1,000 个字符（25% 头 / 75% 尾，标 `truncated`），完整
  Operation 仍可用 `lody_operation_get` 读，全文在线程历史里。批次本身沿用上游上限：
  内联最多 50 条、64 KiB，其余用 `lody_operation_batch_get` 分页。
- 回报的事件来源、过滤（人工驱动的完成默认不记、孙会话的完成不单独记）、游标和去重不变。
- 主会话的 Board 指令改为：只分活，写完整任务说明后结束回合；结果由线程直接交给用户；
  不会因线程完成、失败、等人被唤醒；还没看过的事件会随用户下一句话附上；用户问起时用
  `lody_board_overview` / `lody_session_history` 查。

### 主会话里的线程卡片

- 主会话派出去的每个线程，在主会话里是一张跟着线程实时状态走的卡片：面板线程行同一个
  标记（✋ / 运行方块 / 未读蓝点 / ⊘），线程标题，然后是「agent · 机器 · 项目 · Worktree」。
  不显示回复内容，结果由线程自己交给用户；点卡片打开线程。
- 卡片的次要色 14px ✓ 表示线程所在的整棵树已跑完：家族范围与线程列表的
  `boardThreadFamilies` 一致，包括线程、openedBy 会话及 Tab。所有成员都不在
  running／initializing／finalizing 或等待用户，相关机器全部在线（在线即收到了新心跳；本地工作区的 presence 同步状态一直是 idle，所以不另看同步状态）；
  线程本身有 `lastMessageAt` 且已读。家族等待 > 家族工作 > 线程自身未读 > ✓；
  子会话未读不影响线程的 ✓，家族成员只参与活动、等待和停止等状态判断。可由元数据
  推导的停止、失败、取消仍不亮。线程元数据未加载或没有看板归属时，不显示标记。
  不再要求创建 Operation succeeded 或目标回合 ID 匹配，后续追问、回执或定时回合
  跑完后同样可以亮 ✓。只读可见元数据和现有 presence 派生 atom，不获取成员文档。
  元数据无法识别 agent 报错的失败轮次，这类回合结束后也可能亮 ✓；它表示跑完，
  不证明成功。列表行仍不显示完成勾。侧边模式仅打开本看板成员；其他看板和普通会话
  按原页面路径跳转。
- 随用户消息一起交给主会话的结果，在主会话界面上只显示一行「这条消息附上了 N 条线程更新」，
  不再展开成一张张回执卡。内容照样进了 agent 的上下文。

### 线程：协调者

- 线程第一条消息追加的说明改为协调者式：线程对任务负责到底、直接向用户汇报，用户可以
  直接和它接着聊；需要时用 `lody_session_create` 在自己名下开子会话（调研、实现、review、
  视觉核对），结果回来后自己决定改什么，把 reviewer 结论原样写进回复并说明怎么处理的；
  小事自己做。子会话的结果照旧通过线程自己的 Inbox 唤醒线程。
- 委派链上限 16 跳照旧，收到 `CHAIN_DEPTH_EXCEEDED` 就停止委派、向用户汇报剩下的事。
- 看板设置里的那段文字改名「线程说明」，不为空时以 `Thread rules from the Board settings`
  附在后面；为空时不再输出空的 `Executor constraints:` 标题。数据字段仍是
  `rules.executorConstraints`，不迁移。

## 待确认

1. **用户直接和线程对话的完成要不要记进主会话的事件日志。** 默认沿用 `reportHumanTurns`
   （默认关）：不记。理由：用户自己看过了，主会话问起时可以查历史。打开设置就记。
2. **摘要的粒度。** 默认一条事件一条记录、输出截到 1,000 字符，按发生先后排，超过 50 条
   或 64 KiB 的让主会话分页读。没有做「每个线程只留最新一条」的合并。
3. **主会话自己派发的回执也不唤醒。** 主会话派完活就不再被自动叫醒，哪怕派发失败（例如
   目标机器离线）也要等用户下一句话才看到。这是「只分活」的直接结果；失败本身在线程或
   Overview 上可见。
4. **定时任务（每日摘要）的回合也会带走排队的事件。** 这是上游 human/task 批次的行为，
   默认保留。
5. 升级前已经排队、还没送达的回报仍按旧规则唤醒一次，不做迁移。
6. **有排队结果时，对主会话的插话变成排队的下一回合**，而不是插进正在跑的回合。代价是这句
   话要等当前回合结束才被处理；好处是结果一定随它送达。没有排队结果时插话照旧。

## 证据

- 实现：`apps/cli/src/orchestration/inbox/sqlite.ts`（`indexCompletion`）、
  `apps/cli/src/orchestration/board-report-workflow.ts`、`apps/cli/src/mcp/lody-mcp-server.ts`
  （四处 Operation 接受）、`apps/cli/src/session/session-execution-helpers.ts`
  （`buildBoardInstructions`）、`packages/components/src/components/boards/`
  （`board-threads.ts`、`board-thread-list.tsx`、`board-sidebar-section.tsx`）、
  `apps/cli/src/session/session-execution-service.ts`（插话改排队）。线程列表是一个扁平的
  带 key 列表，线程换组时行不重新挂载，运行→蓝点的收拢动画才放得出来。
- 测试：`apps/cli/src/orchestration/inbox/inbox.test.ts`、
  `apps/cli/tests/session-execution-helpers.test.ts`、`packages/components/tests/board-overview.test.tsx`。
