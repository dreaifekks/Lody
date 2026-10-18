# 看板定时与归档目的地交付

Status: implemented
Translation: current

[English](2026-10-18-board-schedules.md)

## 摘要

看板的周期性工作需要一个对结果负责的线程，而主会话继续保持被动。现在看板归属贯穿普通
定时的持久化、权限检查、准备和共用 UI。准备阶段跳过已归档的专用线程，并把选定 id 与
准备结果原子写入账本；冻结后的目标被归档则在交付前失败并释放槽位。回合级定时来源使结果
成为被动看板事件，同时保留授权执行的人工身份。实现有确定性测试覆盖；打包桌面、真实
Agent 和 LAN 定时尚未验收。

## 决定与职责

本次扩展[机器所有的定时任务](2026-09-24-machine-owned-scheduled-tasks.zh.md)和
[看板回报](2026-10-16-board-inbox-reports.zh.md)的决定。
[看板定时 Spec](../../../../specs/project-coordinator/board-schedules.zh.md)与
[调度模型](../../../../specs/project-coordinator/board-dispatcher-model.zh.md)保持 draft。

- 定义、镜像 map、Registry、草稿和提议元数据都保留可选 `boardId`。它参与可执行指纹和
  幂等重放比较。MCP 用当前调用者成员资格同时校验旧看板与新看板；UI/CLI 沿用人工写入。
- 专用 id 的序号 0 保留原结果；准备阶段选择第一个不存在或未归档的会话。账本在同一事务
  写 `prepared` 与 `sessionId`，不把异步工作塞进规划事务。持久化后的重试即使发现较早序号
  已恢复，也继续使用冻结 id。
- worker 负责交付前检查和恢复。看板或未准备的已有会话不可用时，等待且不消耗尝试、不保留
  槽位；冻结的会话不可用则结束本轮。dispatch pointer 仍是移交普通 Session watcher 的边界，
  已交付工作不重定向、不回滚。关闭时的所有权保持不变。
- `_lodyScheduleId` 只写入该轮用户输入，镜像字段保持普通字符串，历史 parser/normalizer
  保留它。author 和 userId 不变，回报使用 `origin: schedule`。定时发进子线程也产生回报，
  因为它没有给父线程的 Operation 收据。普通人工续聊仍受 `reportHumanTurns` 控制。
- `SchedulesWorkspace` 接受看板范围和导航回调。看板封装共用列表、表单和操作，面板宽度下
  切换列表/编辑页；全局列表排除看板定时。提议卡片与来源链接在桌面、移动布局均进入所属
  看板的「定时」页。

## 取舍

第二套调度器会重复执行所有权；可写的“当前线程”字段会增加同步竞态。准备阶段按序号选定
能保留现有 run/turn 身份，也无需新增持久游标。会话级标记会把后续人工回合误认成定时，
所以来源跟随每条输入。

Spec 原文将 24 小时配置过期称为“失败”。现有引擎实际记为 `skipped / DISPATCH_EXPIRED`，
现已在 Spec 明确，保留既有重试期限和状态机。

Effect feature/fix 评估：本次是在现有 Promise 准备/命令引擎上新增纯派生和字段。
Repo、Session 准备与账本尚无完整 native Effect 能力链；迁移 worker 会引入无关生命周期
所有者，因此没有加局部包装或新 runtime。已有 native Board report workflow 直接消费
本次改变的纯派生函数。

## 验证

所属套件覆盖归档序号选择、重试/重启身份、配置阻塞和槽位释放、真实 Session 准备的成员
归属、MCP 成员权限和 Registry 过滤、提议保留、穿过真实历史 writer 与被动 Inbox 的看板
回报，以及 UI 范围/目的地选择。Storybook 覆盖看板列表和专用线程编辑器。

使用官方 Node v22.23.3，`pnpm check` 通过：CLI 4,879（另有 1 个既有跳过）、组件
5,897、shared 1,745、Electron 306 个测试，以及类型、lint、i18n 和边界检查。
`pnpm format` 通过；shared/components 没有 format script，因此也对本次改动显式运行了
格式化。`pnpm run docs check` 为 0 错误、71 条既有告警。stories 类型检查通过，视觉检查
按用户安排交由另一个 reviewer。没有在真实工作区创建定时，也没有自行开 reviewer、push、
PR、tag 或发布。
