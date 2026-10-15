# 基于 Operation Inbox 的看板自动回报

Status: implemented
Translation: current

[English](2026-10-16-board-inbox-reports.md)

## 摘要

看板协调者需要收到成员的新状态，同时避免回头聊天和重复的评审完成通知。
PR3 把成员事件记为已完成 Operation，所有唤醒和合批都复用上游 Inbox。
原生观察器维护订阅和事件游标，既有事务负责持久接受。孙会话完成由父成员原样带回，
后续改哪些由协调者决定。

## 决定与证据

本次接续 [PR2](2026-10-15-board-tools-notes.zh.md) 和用户确认的六条
[Inbox 修订决定](../../../../specs/project-coordinator/design.zh.md#已决定inbox-修订)。
替代已失效的 Delivery 版 PR3，不沿用它的调度器。

触发来自看板目录、成员元数据或历史变化。现有 Host-lease 协调器拥有观察器、Scope
订阅和合并 reconcile；只重读脏成员文档。普通 Operation 先 reconcile，故其回执可以
覆盖重复成功/失败，包括保留的已完成根。超时/取消根不会永久遮蔽尚未完成的目标。
观察器排除协调者自身、已归档成员和入板前状态。人工完成和孙会话完成被过滤时也推进
游标；等待事件按回合身份去重，不依赖时间戳精度。

一个同步 SQLite 事务提交已完成 Operation、Inbox 索引和游标，失败全部回滚；现有
activity 退避重试仍保留的脏成员。观察失败不阻止普通 Inbox 唤醒。Scope 取消结束观察；
暂停/停止协作只让结果按上游受理规则继续排队。没有新增传输所有者、定时管道或 Delivery
状态。现有 Session/Loro Promise 适配器仍是适配器，本次不宣称迁移了它们的生命周期。

事件 ID 散列后符合既有 Operation 字符/长度契约，退役 ID 仍阻止重放。已完成行保留
schema 必需的 deadline 字段，但不进入 deadline 调度。浅 Loro/Roost 目录暴露 system
驱动配置，只读取选中的输入和输出正文。链上限水位只是观察证据，不是新调度规则；
稳定的历史通知呈现上限，自身不驱动 agent。

界面复用紧凑结果行和实时标题。线程提示要求原样回复子会话结论，等待协调者筛选修改。
轮数、交接、每日摘要和看板级停止均不在 PR3 内。

## 验证与限制

行为套件使用真实 Mirror 导入和 `repo.watch`、显式 reconcile 屏障及注入时钟，覆盖
事务回滚/重启/退役、Inbox 忙碌/人工/暂停/停止/深度行为、回执覆盖、人工/孙会话过滤、
加入/归档、合并唤醒和拥有生命周期的重试。组件用例覆盖混合批次、导航、实时标题、
system 驱动深度和停止状态重置；发送给 ACP 的实际启动载荷也覆盖 reviewer 指令。

使用启用原生 TypeScript stripping 的官方 Node 22.22.1，完整 `pnpm check` 通过：
CLI 4806 项通过、1 项跳过，shared 1741 项、components 5849 项、Electron 303 项通过。
包含全仓类型检查、lint/Effect lint、i18n 和全部边界守卫；`pnpm format`、
`pnpm format:check`、`pnpm run docs check` 也通过。Playwright 在 1440px 和 390px 下
核对合成 InboxReports 场景：状态标签都位于视口内，小屏没有横向溢出，截图保存在仓库外。
跨机器同步和真实 agent 行为仍需 LAN 验证，合成测试不代表这些运行环境已验证。
