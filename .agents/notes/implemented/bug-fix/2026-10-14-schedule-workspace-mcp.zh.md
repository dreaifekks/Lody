# 定时回合保留工作区 MCP 选择

Status: implemented
Translation: current

[English](2026-10-14-schedule-workspace-mcp.md)

## 摘要

定时回合没有携带工作区 MCP 选择，Agent 因而只获得 Lody 内置 server。
Schedule definition 现在保存可选 catalog id：未设置使用当前工作区默认值，
空数组表示不加载。准备派发时将选择冻结进 prepared turn，保持重试语义。
MCP、CLI、编辑器和提议确认都传递同一字段，已有会话目的地保留会话自己的选择。
打包后的多机行为仍需部署验证。

## 决策与证据

本次扩展[机器所有的定时任务决策](../feature/2026-09-24-machine-owned-scheduled-tasks.zh.md)
和[执行设置 Spec](../../../../specs/scheduled-task-permissions.zh.md)。
daemon 复用新会话 UI 使用的 `getDefaultSelectedMcpServerIds`。
默认值在准备阶段解析，后续运行可跟随 catalog 变化而不改写 definition；
已准备的运行重试时保留冻结列表。Schedule 写入复用原 MCP CLI 的 id/name
解析器。Registry 指纹与幂等比较包含显式 MCP 选择，提议历史和确认路径
也保留该字段。Schedule definition 不存连接秘密。

只读检查发现普通 `lody_session_create` 同样缺失：dispatch config 和历史构造
均不携带 MCP id。本次按要求保持其行为不变；仅在 Schedule 准备阶段补齐，
避免隐式改变所有 Agent 创建的会话。

## 验证

行为测试覆盖 new/own 会话的 engine、SQLite、Loro 派发，显式选择、默认选择、
空数组、已有会话继承、create/edit/get 与提议名称解析、重试以及跨副本指纹。
编辑器复用 composer 菜单，Schedule stories 可交互检查。CLI/MCP 153 项、shared 25 项、UI 49 项定向测试通过；shared/CLI/UI
类型检查、根 lint、格式化、i18n、边界和文档检查通过。根 `pnpm check` 在 ACP
适配器准备阶段因 worktree 缺少子模块 Git 元数据而停止；定向检查使用本地
源码和依赖副本完成。没有派发或部署真实 Schedule。

浏览器验证确认编辑器菜单初始勾选 Mail，取消后显示未加载 MCP。

检查命令（提交前均已结束）：

```sh
pnpm --dir apps/cli exec vitest run src/lib/schedules src/mcp/lody-mcp-server.test.ts src/mcp/workspace-mcp-configure.test.ts src/lib/workspace-mcp-store.test.ts --maxWorkers=2
pnpm --dir packages/shared exec vitest run tests/schedule.test.ts --maxWorkers=2
NODE_ENV=test pnpm --dir packages/components exec vitest run tests/schedule-form.test.tsx tests/schedule-agent-defaults.test.ts tests/schedule-save-blockers.test.ts tests/schedule-write-sync.test.ts tests/attachment-add-menu.test.tsx --maxWorkers=2
pnpm --filter @lody/shared --filter @lody/components --filter lody typecheck
pnpm lint
pnpm format
pnpm run docs check
pnpm lint:i18n
pnpm check:code-collab-imports
pnpm check:platform-boundaries
pnpm check:public-boundary
pnpm check
```
