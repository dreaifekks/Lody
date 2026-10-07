# 输入区用量指示器

Status: draft
Translation: current

[English](session-usage-indicator.md)

提供商同时上报本周和五小时订阅用量时，尚无上下文用量的输入区在紧凑指示器中
显示五小时百分比。例如，本周已使用 29%、五小时已使用 11% 时，入口显示 11%。

## 显示约定

有效的上下文用量优先显示。压缩上下文时，指示器显示压缩状态。
只有调用方启用无上下文时的订阅用量显示，才使用所选提供商和模型的额度。

订阅用量优先选择有效的五小时窗口，即使其用量为 0%。不存在有效五小时窗口时，
保留已有的最长周期窗口选择。既没有有效上下文，也没有符合显示条件的订阅用量时，
隐藏指示器；正在压缩上下文除外。

详情弹层按周期从长到短显示所有有效窗口，保留提供商上报的名称和重置时间。
紧凑指示器的窗口选择独立于详情排序。

## 订阅额度显示条件

内置 Claude、Codex、Grok 和 Kimi 的显式环境变量未覆盖账号、凭证或提供商路由时，
允许显示订阅额度。工具设置、代理和单独的 `NMEM_AGENT_ID` 不应隐藏五小时或每周额度。
空值与纯空白值不算覆盖。持久化品牌标记和从环境变量推断出的提供商品牌仍隐藏额度。
Registry Antigravity 保留现有条件，其额度来自 ACP 服务自身的登录账号。

Claude 的凭证、提供商变量、OAuth token、配置目录和云认证跳过开关会隐藏额度；
单独的模型选择与云区域设置不会。Codex 的账号/配置目录、提供商选择，以及
`CODEX_`、`OPENAI_`、`LODY_CODEX_` 前缀变量会隐藏额度，无关传输和进程设置除外。
Grok 的账号存储目录、端点和密钥覆盖会隐藏额度，并保守地将 `XAI_` 视为提供商配置。
Kimi 的账号存储目录和已知提供商端点/密钥覆盖会隐藏额度，并保守地将 `MOONSHOT_`
视为旧提供商配置；普通 `KIMI_` 工具和更新设置不会隐藏额度。

这个显示判断不决定 Agent 是否需要登录，也不改变额度采集和 Provider 范围的快照归属。

## 证据

- [指示器与详情弹层](../packages/components/src/components/sessions/session-usage-popover.tsx)
- [行为测试](../packages/components/tests/session-usage-popover.test.tsx)
- [显示条件与测试](../packages/components/tests/session-usage.test.ts)
- [共享环境变量分类](../packages/shared/src/agent-authentication.ts)
- [显示条件决策](../.agents/notes/implemented/bug-fix/2026-10-07-subscription-env-eligibility.zh.md)
- [决策记录](../.agents/notes/implemented/bug-fix/2026-10-01-five-hour-usage-indicator.zh.md)
