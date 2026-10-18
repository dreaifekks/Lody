# 看板定时任务

Status: draft
Translation: current

[English](board-schedules.md)

2026-10-18 用户提出（分支 `feat/board-schedules`，叠在[看板调度模型](board-dispatcher-model.zh.md)上）。
它补上[看板与协调者](design.zh.md)里留给以后的「定时」一块；「每日摘要」那一节（发进主会话）
不在这次范围里。

## 场景

用户在看板面板的「定时」页点「新建」，写「每天 09:00 汇总昨天合进 lan-hub 的提交」，
选 agent 和机器，保存。第二天 09:00，Lody 在这台机器上开一个看板线程跑这一轮；以后每天都
发进同一个线程，线程里攒着历次结果。线程跑完亮蓝点，看板行跟着亮；主会话不被唤醒，用户
下次和主会话说话时，这一轮的结果作为看板事件附在输入里。用户也可以直接对主会话说「每天
x 点让某线程做 y」，主会话用 `lody_schedule_*` 工具带 `boardId` 建出同样的定时。

## 决定

### 属于看板，不进全局列表

- 定时定义多一个可选字段 `boardId`，Registry 行也带上它。有 `boardId` 的定时只在那个看板的
  面板里出现：查看、新建、编辑、暂停、恢复、删除、立即运行都在那里。全局定时列表不显示它；
  会话里的「定时任务」来源链接打开所属看板的「定时」页。
- 看板定时就是普通定时：同一个定义文档、Registry 执行门、主机本地 SQLite 账本、触发规则
  （manual / once / interval / cron + 时区）、错过和重叠策略、Agent / Role / MCP 选择、权限
  档上限、执行槽位。没有第二个调度器。
- 看板已归档或不存在时，到点的运行不交出去，按可恢复的配置问题处理（`BOARD_UNAVAILABLE`），
  不占用槽位；看板恢复后照常运行。不额外改写定义（不自动暂停）。

### 发进哪个线程

目的地沿用现有三种，多了看板约束：

- **专用线程（默认，`own_session`）**：第一次运行时创建，之后每次都发进它。线程是这个看板的
  普通成员（`boardId`，没有 `boardRole`），所以有看板说明、共享目录和看板工具，出现在线程列表
  里。
- **每次开新线程（`new_session`）**：每轮一个新线程。
- **已有线程（`existing_session`）**：用户在面板里挑一个本看板的线程（不能是主会话），对应
  「让某线程做 y」。规则和现在一样：必须在定时的机器上、由定时的 Agent 驱动、属于同一个人。

### 线程被归档

现在发进已归档会话的定时回合永远不跑，还一直占着同机同 Agent 的执行槽位，卡住别的定时。
这次在交出去之前就拦住，对看板定时和普通定时都生效：

- **专用线程被归档**：这一轮改发进新的专用线程。专用线程的 id 仍由定时 id + `epoch` 推出，
  再加一个序号：从 0 开始，跳过已归档的那几个，取第一个不存在或未归档的。只在准备这一轮时
  决定一次并冻结，重试不会再换线程，也不用存额外状态、不用改写定义。面板里显示的「这个定时的
  线程」取 `scheduleId` 相同的最新未归档会话。
- **已有线程被归档**：这一轮作为可恢复的配置问题挡住（`SESSION_UNAVAILABLE`），不占槽位，
  在面板和定时页上能看到原因；用户恢复线程或改目的地即可。
- 已经准备好、还没交出去的那一轮，若线程在这期间被归档，这一轮直接记失败，不再发进去。

### 结果怎么回到看板

- 结果走看板现有路径：线程自己的 `lastMessageAt` 前进，线程行和看板行亮蓝点。
- 定时触发的回合在线程里完成或失败时，记成看板事件（来源 `schedule`），不受「记录用户直接
  对话」（`reportHumanTurns`）开关影响：用户没有亲眼看过这一轮。即使目标是子线程也记，
  因为定时没有父级 Operation 回执。和其他事件一样冻结
  `deliverWithNextInput`，主会话不被唤醒，下一次人工或定时输入时附带。
- 线程按[调度模型](board-dispatcher-model.zh.md)是负责人：定时那一轮里它照样可以开子会话。

### 主会话通过 MCP 管理

- 现有 `lody_schedule_create` / `update` / `propose` 多一个可选 `boardId`；`list` 可以按
  `boardId` 过滤，返回的每一行带 `boardId`。`get` / `pause` / `resume` 不变。没有新工具。
- 调用者是看板成员时，`boardId` 只能是它自己的看板；不是看板成员的会话不能写看板定时。
  `existing_session` 必须是该看板的线程。权限档上限和提议卡片规则不变（权限不够就提议，
  用户在卡片上确认）。
- 主会话的看板说明里加一句：要定期做的事，用带 `boardId` 的定时交给线程，默认专用线程。

## 待确认

1. **全局列表完全不显示看板定时。** 选了「不显示」而不是「带标记显示」：一条定时只有一个
   管理入口，全局列表不用为看板加一列。代价是在全局页找不到它们；`lody_schedule_list` 仍能
   列出全部。
2. **主会话不能当目的地。** 用户要的是线程来跑；发进主会话就是 design 里的「每日摘要」，
   它会把排队事件一起带走、主会话上下文每天多一回合，留到做摘要时再定。
3. **已有线程被归档时挡住而不是自动换新线程。** 用户明确挑的线程，换成别的会让结果落到
   意外的地方；专用线程本来就是「这个定时的」，所以自动换。
4. **看板归档时定时不自动暂停**，只是到点不跑（每轮记一次配置问题，24 小时后按现有调度器记 `skipped / DISPATCH_EXPIRED`）。
   好处是恢复看板就恢复，不用记得再打开；代价是归档期间每轮都留一条过期记录。这里沿用现有调度器的过期语义，不另加失败状态。
5. **定时回合的完成一律记成看板事件**，即使用户之后打开线程看过。主会话下次会多读到这些
   摘要（每条截到 1,000 字符）。
6. 旧版本客户端不认识 `boardId`，会拒绝这类定义、不列也不跑；fork 内所有机器同版本，不做
   兼容层。

## 证据

- 现有定时：`packages/shared/src/schedule-types.ts`（定义、目的地）、
  `packages/shared/src/schedule-registry.ts`（`scheduleOwnSessionId`、`scheduleRunIds`）、
  `apps/cli/src/lib/schedules/`（`schedule-workspace.ts` 的 `resolveTarget` / `prepare`、
  `schedule-run-preparation.ts` 的 `destinationSessionProblem`、`schedule-store.ts`、
  `schedule-command-service.ts`）、`apps/cli/src/mcp/schedule-tools.ts`、
  `packages/components/src/components/schedules/`。
- 看板：`packages/shared/src/board.ts`（`deriveBoardReports` 的 `reportHumanTurns` 过滤）、
  `apps/cli/src/orchestration/board-report-workflow.ts`、
  `packages/components/src/components/boards/board-panel-view.tsx`（面板标签页）。
- 已归档会话卡住定时：2026-10-16 实际发生（排查记录在个人笔记，不在仓库）。
- 实现与验证：[Agent Note](../../.agents/notes/implemented/feature/2026-10-18-board-schedules.zh.md)。
