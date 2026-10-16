# Agent 与 CLI 写入的回合记录工作区 MCP 选择

Status: implemented
Translation: current

[English](2026-10-17-agent-session-workspace-mcp.md)

## 摘要

通过 `lody_session_create`、`lody_session_chat`、它们的批量版本以及
`lody session create/chat` 打开或继续的会话，启动时不带任何工作区 MCP server：
这些回合没有记录 `mcpServerIds`，而 dispatch 把缺失的选择当成 `[]`。现在这些写入方
按桌面输入框的方式记录选择：新会话继承发起回合的明确选择（包括明确的 `[]`），
否则使用工作区 `enabledByDefault` 的 server；继续对话沿用目标会话最近一次的选择，
没有就用默认值，从不使用发送方的选择。MCP Operation 在接受时按目标冻结选择，
目录或历史之后变化，恢复时结果也不变。工具没有新增 MCP 参数。

## 问题与证据

`commands/session.ts` 的 `buildCliHistoryInputConfig` 从不写 `mcpServerIds`，
所以 CLI 和 MCP 会话工具写的回合都没有这个字段。dispatch watcher 把缺失的选择
补成 `[]`（`session-dispatch-watcher.ts`），ACP 启动时只加载被选中的目录 server，
于是 agent 只拿到 Lody 内置 server。这个遗漏出自上游引入按回合 MCP 选择的提交；
定时任务此前已单独修复（[定时任务笔记](2026-10-14-schedule-workspace-mcp.zh.md)）。

存储语义有三种状态：缺失表示“没有表态”（输入框此时预选 `enabledByDefault`），
`[]` 表示“不加载”。回合到达运行中的 agent 时这个区别已经丢失：活动调用上下文
携带的是派发后的配置，缺失已变成 `[]`。因此创建时按 `sourceTurnId` 从发起方
已存储的历史中读取驱动回合，只有读不到该回合时才回退到调用上下文的配置
（终端调用方没有回合，得到默认值）。

## 决定

- 共用 helper `lib/session-mcp-selection.ts`：保留已表态的选择，否则从工作区目录读取
  `enabledByDefault` server。定时任务也改用它。和输入框一样，默认值可以来自本机的
  目录副本：目录同步失败只记日志，不拒绝回合；这与“只用默认值的操作不要求确认
  目录新鲜度”的规则一致。
- 创建（MCP）：工具在校验前解析选择，作为 `ResolvedTurnDispatchConfig.mcpServerIds`
  传入；有效创建配置把它带进 `targetDispatchConfigs`，`prepareSessionInput` 写到回合上。
  批量创建对所有条目只解析一次。
- 创建（CLI、旧 Operation 重放）：调用方没有提供时由 `prepareSessionInput` 解析，
  来源依次是冻结的继承输入配置、发起会话最近记录的选择，最后是默认值。
- 继续对话：目标会话最近的选择（`resolveSessionConversationConfig`，与输入框同源），
  否则默认值。MCP 对话 Operation 现在保存 `targetDispatchConfigs: [{ mcpServerIds }]`，
  daemon 重放时原样传入，已接受的对话不再重新读取目标会话。
- `FrozenConfigSchema` 会去掉目标配置中的未知字段，因此显式声明 `mcpServerIds`。
- 定时任务发往已有对话时，如果该对话从未记录过选择，现在回退到工作区默认值
  （之前是 `[]`），这也是该对话输入框显示的内容。

未采用：去掉 dispatch watcher 的 `?? []`。这样能让三种状态穿过 dispatch，但会影响
所有读取派发配置的运行时代码，而且本身并不能让 agent 写的回合带上选择。

## 验证

- CLI 命令测试：冻结的选择直接写入，不读取目录；发起方的 `['x']`、`[]` 和未表态
  分别得到 `['x']`、`[]` 和默认值；对话解析沿用目标会话最近的回合，没有时用默认值。
- 使用真实 MCP server、SQLite 存储和 Loro 历史的 MCP 测试：创建继承发起方的选择、
  冻结，并在默认值变化后原样重放；对话使用目标会话而不是发送方的选择、冻结并重放。
  边界 mock 测试覆盖调用上下文中“缺失”与 `[]` 的混淆，以及批量逐条冻结。
- Operation 存储往返保留 `mcpServerIds`，包括明确的 `[]`。

没有在多机 LAN 上用真实 agent 会话验证。目标机器缺少所选 server 的环境变量时，
仍按现有逻辑告警并跳过。
