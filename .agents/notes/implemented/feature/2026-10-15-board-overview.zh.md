# 看板成员资格与首版 Overview

Status: implemented
Translation: current

[English](2026-10-15-board-overview.md)

## 摘要

并行会话需要一个能一起查看协调者和工作进度的地方，同时保留原有侧边栏分组。
PR1 在工作区目录增加看板行，成员资格只写在各个 session 上。CLI 和界面创建路径
都会继承成员资格；只读 Overview 复用 presence，仅展开行时读取会话历史。
回报、笔记和交接仍是后续工作，因此保存的规则暂不控制执行。

## 决定与证据

[设计](../../../../specs/project-coordinator/design.zh.md) 将功能分为五步，本次只实现 PR1。
`workspace-flock.ts` 规范化看板行，现有 catalog room 和 writer 负责本地持久化与后续上传。
创建时先写看板行，再接受协调者的首条消息；接受失败时移除看板行。50 个看板上限是
本地目录检查，不是在离线设备之间做分布式预留。

`prepareSessionInput` 覆盖 CLI/MCP，界面另有 `session-submission.ts` 入口，两个界面创建
路径都必须继承父会话的看板。角色与代数只能显式指定，不跟随继承。
MCP 列表的看板筛选也参与游标身份计算。

Overview 复用 opened-by 树与子 Tab。未展开行通过 presence/元数据确认运行和等待用户状态；
失败与等待协调者状态随展开读取。协调者默认展开，以显示链深度。轮数、代际与 review
界面属于 PR4。这保留了设计要求的按需读文档边界，不另加历史摘要缓存或打开全部成员文档。

创建复用 Schedule 的 Agent 控件与既有 session 接受流程，保留 Agent/Role 选择、提示组装、
MCP 默认选择和运行配置。每台设备的实验开关只隐藏导航与页面，不抹除成员资格或停止会话。

## 评审修正

后续修正让实时 presence 优先于等待标记；陈旧的等待标记在 `lastMessageAt`
更新后失效，不改变 daemon 的标记生命周期。子 Tab 只继承父会话的成员资格，包括
父会话没有看板的情况；准备元数据时也不能从绑定选项回填调用者的看板。

创建复用共享提示拼接函数，上限只在写入前检查一次且排除已归档看板。
Overview 在列表层按机器获取 localProject 目录。集成测试通过 `resolveCreateContext`
真实创建会话；行测试使用 Loro 支持的 ConversationView，区分当前失败回合/通知与
旧失败之后的新派发。新线程和加入/移出操作在 Spec 中明确安排到 PR2。

## 验证与限制

评审修正后，受影响包全套测试通过：shared 1529、CLI 4013（跳过 1）、components 5352。
新增 CLI 集成用例通过 `createSessionResult` 和 `resolveCreateContext`；Overview 的历史
用例使用真实 Loro reader。lint/i18n/边界、格式和文档检查通过。

递归全仓 typecheck 已完成。components 的项目映射类型注解修正后复跑通过；其余包通过，
仅 CLI 保留 11 个既有 voice/prompt 报错。`acp-extension-core` 从 `src` 提供类型，而当前
干净检出没有应用仓库已有的 voice/prompt 补丁。两个补丁的 `git apply --check` 均通过，
本次没有改这些源码或 CLI agent 文件。正常的 adapter 准备流程会应用补丁；本次按允许的
已知检查限制保留子模块不变。

原 PR1 浏览器检查覆盖桌面与 390px 列表/状态行预览；真实 LAN 派发仍需手工验证。
PR1 不包含回报观察者、看板 MCP 工具、笔记文档、轮数拒绝或摘要。

## 后续变化

只读的 Overview 页、展开才读文档的行和「看板」导航项，已在 2026-10-16 由协调者页面上的
看板侧面板取代，见[看板主界面](2026-10-16-board-home.zh.md)。上文的成员资格和创建流程不变。
