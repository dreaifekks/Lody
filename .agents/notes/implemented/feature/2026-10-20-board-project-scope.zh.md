# 看板项目范围

Status: implemented
Translation: current

[English](2026-10-20-board-project-scope.md)

## 摘要

看板里的 agent 原来能在任何项目里开会话，一个围绕某个仓库的看板没法把线程留在那里。现在看板行
可以写明它涉及的项目：成员的启动提示列出这些项目和在其中开会话用的 workContext，agent 想在
其他项目里开会话会以 `BOARD_PROJECT_OUT_OF_SCOPE` 被拒。chat、父会话下的 Tab、用户手动开的
线程都不受限；没设范围的看板照旧覆盖全部项目。由于同一个仓库在每台机器上的本地项目 id 都不同，
选择器按名称合并项目，存下所有机器上的那几对；以后别的机器加了同一个仓库，要用户再勾一次才
进范围。已有单元测试、组件测试和 Storybook 故事；还没在局域网里用真实 agent 跑过。

## 决定与职责

意图写在[看板设计](../../../../specs/project-coordinator/design.zh.md)的「看板上下文 › 项目范围」
和已决定第 16–19 条；用户在 2026-10-20 确认。

- **数据。** `BoardMeta.context?.projects` 里是 `{ kind: 'local', machineId, localProjectId,
  name }` 或 `{ kind: 'github', repoFullName }`（`packages/shared/src/board.ts`）。缺省或为空
  表示全部项目，所以字段出现之前的看板行不用迁移。`boardProjectScope` 返回收窄后的列表或
  `undefined`；`isProjectInBoardScope` 对本地项目按机器 + id 精确匹配，对仓库按名称匹配（和
  GitHub 一样不分大小写）。设计里本地项目可选的 `githubRepoFullName` 没做：目前没有地方读它。
- **提示。** `buildBoardInstructions` 只在范围收窄时给协调者和线程加同一段：每个项目的机器 id
  和准确的 `workContext`（本地项目再带 `machineId`，否则本地 create 会落在调用者的机器上）、
  拒绝码，以及 chat 和 `useCurrentSessionAsParent` 不受限。不解析机器名：提示路径上没有读机器的
  链路，而 `lody_session_create` 要的正是 id。
- **检查。** `assertBoardProjectInScope`（`apps/cli/src/lib/board-directory.ts`）在
  `resolveCreateContext` 确定了目标机器和项目之后运行，条件是调用会话带 `boardId`、没用父会话、
  选了项目。它和看板目录一样用 `readSyncedBoard` 读看板行，所以 catalog 副本早于看板的 daemon 也
  能读到。放在这里就同时覆盖了 `lody_session_create`、`lody_session_create_many`、旧的等待式
  create，以及看板会话终端里的 `lody session create`；持久化的 create 在 Operation 被接受之前检查。MCP 层把这个
  错误映射成自己的码，而不是 `COMMAND_REJECTED` / `INVALID_ITEM`；批量创建时只有那一项失败。
- **界面。** `BoardProjectScopePicker` 是一个带勾选行的 `Menu`（`@lody/ui`），放在新建对话框
  协调者控件旁的插槽里，以及「设置 › 通用」。行由 `buildBoardScopeOptions`
  （`board-project-scope.ts`）生成：可见的本地项目按名称合并，GitHub 仓库来自
  `useWorkspaceGitHubRepositories`，另外保留范围里已经没人看得到的项目，方便取消勾选。只有部分
  机器在范围里的行显示部分勾选标记，勾一下补齐缺的那几对。「+ 新线程」加了普通的项目选择和
  worktree 勾选（`ProjectRefSelector`、`WorktreeCheckboxPill`），像普通新会话一样在该项目里开
  线程，不按范围过滤。选择器不给 GitHub 仓库指定分支，所以创建前先向 GitHub 查默认分支
  （`githubFetchDefaultBranch`），和新对话落地页一致。

## 考虑过的方案

- **「+ 新线程」也按范围过滤**，即最初的设计。用户否决：手动开的线程不需要限制，过滤只会逼人
  先去设置里改范围。
- **每个项目名只存一条。** 显示更简单，但名称不能确定目录，检查时得猜是哪台机器上的那份。存
  机器 + id 让检查精确，合并只发生在选择器里。
- **新机器上的同名项目自动加入。** 否决：同名不等于同一个仓库，范围会悄悄变大。

## 局限

- 旧客户端保存看板设置会丢掉 `context`，和 `instructions` 一样；所有写看板行的客户端必须同一
  版本（不做兼容层）。
- 线程只记得开局时读到的范围；之后的改动只通过 create 检查生效。
- 没在真实 agent 和局域网成员之间验证过；对话框和设置只在 Storybook 和组件测试里看过。
