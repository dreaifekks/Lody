# 删除 Lody 的 Antigravity Auto Review

Status: implemented
Translation: current

[English](2026-11-19-antigravity-auto-review-removal.md)

## 摘要

Lody 给 Antigravity 加的 Auto Review 模式让 agy 以 `default` 运行，用自己的规则和一个隐藏的
Gemini Flash 审查会话判断每个权限请求，原因是 agy 自己的 `auto` 在没有网络的沙箱里跑命令。
在 agy CLI 1.5.9 上实测：agy 的 `read_url(<域名>)` 规则让沙箱里的命令直接访问指定主机，不经审查；
其余命令的审查也能由允许规则免去询问用户。因此 Lody 删掉 Auto Review，只保留 agy 自己的模式和
按会话的 `yolo`；存为 `auto_review` 的会话、Role 和定时以 agy 的 `auto` 运行。在 `auto` 下，授权
主机以外的联网命令仍要等 agy 自己审查约 20–40 秒，Lody 这边没有设置能去掉；信得过的联网任务用 `yolo`。

本记录部分取代 [agy CLI 决策](../feature/2026-11-15-antigravity-agy-cli-acp.zh.md)，运行时、标题、
YOLO 和 HTTP MCP 的决策仍由它负责。

## 发现

2026-11-19 用最小 ACP 客户端在 `auto` 下测 agy CLI 1.5.9，一台是装了允许 agy 创建 user
namespace 的 AppArmor profile 的 Linux x86_64，一台是 macOS arm64。规则写在
`~/.gemini/config/config.json` 的 `userSettings.globalPermissionGrants` 下。

- 没有授权时沙箱没有网络。加 `read_url(example.com)`、`read_url(github.com)` 后，`curl` 立刻能访问
  这些主机及其子域名，不经审查；`raw.githubusercontent.com` 要 `read_url(githubusercontent.com)`。
  两条都加上后，`git ls-remote` 访问 GitHub 在两台机器的沙箱里都能跑。只放行 80 和 443 端口，
  拒绝 IP 地址，`read_url(*)` 放开所有主机。`userSettings.sandboxAllowNetwork` 不起作用。
- 在沙箱里失败的命令会提出到沙箱外运行，客户端收到任何东西之前先由 agy 的审查判断：`git push`
  用了 21–23 秒，macOS 上的 `lody-lan`（沙箱挡住了 daemon 的 Unix socket）用了 38 秒。有匹配的
  `command(<词前缀>)` 允许规则时随后直接运行，不问人；没有时审查升级为询问用户。允许规则不会跳过审查
  （一条 `rm` 有规则 6 秒，没有规则 12 秒且询问），全局 PreToolUse hook 回 `auto_approve` 也不会（19 秒）。
- ACP 权限请求只有单次允许和单次拒绝；回答后 `config.json`、`settings.json` 都没有变化。
- `accept-edits` 和 `default` 下，允许列表里的命令立刻在沙箱外运行；其他命令立刻询问。
- 配置成 IP 地址加端口的 `nmem` CLI 在沙箱里跑不了；nmem 的 MCP 工具在 `mcp(...)` 允许规则下 0.7 秒完成。
  Linux 上 `lody-lan` 靠 agy CLI 决策里记录的 `read_file` 授权在沙箱里运行。

## 决策

删除 `auto_review` 模式、它的规则和审查进程。`antigravity-acp-stream.ts` 只保留按会话的 `yolo` 和
Streamable HTTP MCP 能力修补，其余原样透传 agy 的模式。`auto` 下的批准交给 agy：每台机器的 agy
规则授权沙箱命令需要的主机（`read_url`），放行审查后不该再问人的联网命令（`command(git push)`，
强制推送仍为 `ask`），nmem 走它的 MCP 工具。

已保存的选择经同一个映射读取，`migrateLegacyAntigravityModeId`（`auto_review` → `auto`，没有别的
agent 用这个 id）：Role 运行配置、会话配置读取函数（`resolveSessionConversationConfig`、
`resolveSessionAcpRuntimeConfig`）和定时到会话的边界（`resolveScheduleAgentRunConfig`）读的时候映射，
菜单、继承的轮次和定时运行都用 `auto`，能通过普通的能力校验。定时定义及其指纹保留原值。冻结为
`auto_review` 的轮次（排队或带签名的输入）不改写，由流包装层以 `auto` 发给 agy。权限档位表为这些
冻结轮次保留 `auto_review` → `auto`。

## 备选方案

- 为联网工作保留 Auto Review。它的审查是每个被审会话多一个隐藏的 agy 对话，会执行用户的
  hooks（每次多一个 nmem 线程和上下文包），还在 agy 自己的审查之外多花 Gemini Flash 额度。
  它存在的理由是沙箱没有网络，现在由已知主机的 `read_url` 授权和其余情况用 `yolo` 解决。
- 在 Lody 里批准 agy 的沙箱外请求：省不了时间，agy 在请求到达客户端之前已经审查过。
- `read_url(*)`：沙箱命令能访问所有主机；选择了逐个列出主机。
- 把 nmem 用主机名放在 443 端口的 HTTPS 上（例如 `tailscale serve`），它的 CLI 就能在沙箱里跑。
  没有做：MCP 工具已经覆盖这个用途。
- 把 `auto_review` 列为别名模式，agy CLI 决策已经否决：读时映射让这个 id 不出现在菜单里，
  已保存的选择照样可用。

## 影响

- `auto` 下，授权主机以外的联网命令每次要等一次 agy 审查（约 20–40 秒）；有允许规则时随后直接运行，
  否则询问用户。macOS 上每次 `lody-lan` 都这样离开沙箱。
- agy 规则是各机器的用户配置，不在仓库里。
- 旧构建缓存的 Provider 能力在刷新前仍列出 Auto Review；选它会以 `auto` 运行。
- agy 不提供 `auto` 的机器（没装 AppArmor profile 的 Linux）会像拒绝其他 `auto` 一样拒绝映射后的选择。

## 验证

- `apps/cli/tests/antigravity-acp-stream.test.ts`：提供的模式、YOLO 和被拒绝的切换、HTTP MCP，
  以及已保存的 `auto_review` 在启动、恢复和切换时让 agy 以 `auto` 运行。
- `packages/shared/tests/agent-role.test.ts`、`session-input.test.ts`：Role 和会话读取把
  `auto_review` 映射成 `auto`。
- `apps/cli/src/lib/schedules/schedule-session-preparation.test.ts`：存为 `auto_review` 的定时
  （`modeId` 或 `mode` 选项）以 `auto` 准备它的轮次。
- `packages/shared/tests/permission-tier.test.ts` 保留它的档位。

未验证：带这个改动的 Lody 构建在真实机器上运行（只跑了 agy 本身和 fixture），以及旧 Auto Review
会话在桌面输入框里的表现。
