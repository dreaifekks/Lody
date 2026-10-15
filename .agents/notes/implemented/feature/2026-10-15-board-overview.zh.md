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

## 验证与限制

行为测试覆盖规范化、目录事件、状态优先级、MCP 创建继承、界面子 Tab 继承以及真实 atoms
驱动的 Overview 更新。受影响包全套测试通过：shared 1528、CLI 4012（跳过 1）、components 5348。全仓类型检查、
lint/i18n/边界检查、格式与文档检查通过。聚合 CI 运行退出 143 后，已分别完成受影响包测试。
Storybook 列表与状态行在桌面、390px 宽度通过浏览器检查；真实 LAN 派发仍需手工验证。PR1 不包含回报观察者、看板 MCP 工具、笔记文档、轮数拒绝或摘要。
