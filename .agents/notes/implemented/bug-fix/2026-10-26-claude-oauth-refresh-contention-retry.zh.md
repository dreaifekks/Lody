# Claude 输掉 OAuth 刷新竞争时重发 prompt

Status: implemented
Translation: current

[English](2026-10-26-claude-oauth-refresh-contention-retry.md)

## 摘要

共用一份 `~/.claude` 登录的多个 Claude Code 进程在锁里刷新 OAuth 令牌。别的进程拿着锁时新启动的进程第一次请求就失败，报 "Failed to refresh OAuth token: another Claude Code process is refreshing it…"，适配器转成 ACP `-32603`。Lody 以前把它当致命内部错误，杀掉 agent、记轮次失败，机器上闲置 Claude 会话多时定时任务就这样丢了。现在只要这一轮还没有工具调用、没有被引导（steer）、也不是 Inbox 输入，就在 30、60、120 秒后对同一个 agent 重发同一个 prompt；全部失败时照旧记失败，消息里写明重试了几次。另有一处适配器修复：没人回答的 confirmWithUser 问题（`confirm_<uuid>`）不再把已经结束的轮次判成 "ended without returning results"。

## 决定和依据

- 证据（homenucserver，2026-10-18 至 10-26）：四次定时 `new_session` 在启动几秒内这样失败；约 18 个闲置 Claude Code 进程共用凭证。ACP 会话建好后 `connection.prompt` 被拒，轮次记为 `acp_internal_error`，进程被强杀。之后对同一 ACP 会话 `loadSession` 成功，agent 本身没坏。
- 识别：`isClaudeOAuthRefreshContentionError` 要求 `-32603` 加竞争那句原文。Claude Code 2.1.305 还有一个磁盘满的刷新失败，前缀同样是 `Failed to refresh OAuth token:`，但不会自己好，所以只看前缀不够。登录过期仍是 `acp_auth_required`，不重试；LAN 现有的失败推送已经会通知手机。
- 位置：重试放在可见轮次共用的 `prompt` 步骤里，`startSession`（所有定时 `new_session`）和 `continueSession` 都覆盖，等待期间 Stop 照常中断 owner fiber。没选在定时层重跑：派发之后 Schedule 账本从不换 Session 或 Turn 重试，再开一轮还会重复用户消息。
- 同一个 agent，不重建：错误来自一条 result 消息，Claude Code 进程仍在流式模式，下一次请求会重新读赢家写好的令牌。退役再恢复只多一次 `loadSession`，解决不了任何问题。
- 输出判断：Claude Code 把失败的请求显示成一条合成的助手消息，适配器会转给 Lody（Lody 没声明 AIR session-failure 能力），所以「没有输出」在这里从不成立。判断改为「这一轮没有工具调用」（`hasToolCallInTurn`，缓冲到 `tool_call` 或 `tool_call_update` 时记下）：没有工具调用说明失败的是这一轮第一次模型请求，什么都没执行。steer 会换轮次 id，重试随之停止；Inbox 输入保持原有的永不重试规则。

## confirm_ 工具调用（10-22 两次失败）

Claude Code 的 `confirmWithUser`（比如 "safeguards flagged this session" 之后）通过 `canUseTool` 发问，工具是 `AskUserQuestion`，id 是合成的 `confirm_<uuid>`；它从不为这个 id 发 `tool_use` 或 `tool_result`。适配器把这个 id 记成前台工具调用，定时任务里没人回答（Lody 20 分钟后取消问题）、Claude 正常结束轮次时，适配器就以 "Claude ended the turn without returning results for tool calls: confirm_…" 判失败。fork 补丁 `patches/submodules/acp-extension-claude/0003-confirm-with-user-not-a-tool-call.patch` 把这类 id 和同样只走权限回调的 `SandboxNetworkAccess` 一样处理。触发提问的安全标记来自服务商，读安全资料的定时 prompt 仍可能触发。

## 没做的

- 定时启动抖动：工作区每 15 秒评估一次到期定时，在一次评估里把多个交接错开要改串行引擎。有了重试，同一分钟撞车会自己恢复。
- 回收闲置 Claude Code 进程：空闲计时器已经会回收会话；进程少了只能降低概率，消除不了竞争。

## 验证

- `apps/cli/tests/session-execution-service.test.ts`（Claude OAuth refresh contention）：第二次成功时轮次正常完成；假时钟下间隔正好 30/60/120 秒，最终失败写明重试 3 次；有工具调用的轮次、auth-required 错误、磁盘满文本都不重试。
- `acp-error-classification.test.ts`：竞争不算 auth；磁盘满和登录文本不匹配。
- 适配器 `incomplete-tools.test.ts`：没人回答的 `confirm_` 问题不再让轮次失败（去掉补丁会失败）。
- 没有在真机上验证；homenucserver 下次撞上竞争时，daemon 日志会出现 "lost the OAuth refresh race" 警告。
