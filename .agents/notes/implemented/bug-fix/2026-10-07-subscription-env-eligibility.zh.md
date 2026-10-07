# 无关环境设置不再隐藏订阅额度

Status: implemented
Translation: current

[English](2026-10-07-subscription-env-eligibility.md)

## 摘要

添加 `NMEM_AGENT_ID=lody` 后两个订阅额度窗口都消失，因为显示条件拒绝所有非空环境变量字典。
现在改为共享的、按 Agent 区分的认证和路由判断，忽略空白值、代理和工具设置。
持久化/推断品牌标记和 Antigravity 保留现有行为。Grok 官方 runtime 不公开认证实现，
旧 Moonshot 变量也缺乏明确依据，因此采用保守的提供商前缀规则；这些命名空间将来出现
无关变量时，仍可能被过度分类。

## 决策与依据

[显示 Spec](../../../../specs/session-usage-indicator.zh.md) 定义这次行为变化。
`hasBuiltinEnvAuthRouting` 位于现有共享认证工具旁，不改变交互登录要求或 daemon 额度上报。
它扩展[新会话订阅显示](2026-09-28-session-tab-rate-limit-ring.zh.md)，
保留 [Provider 范围快照](2026-09-30-provider-rate-limit-isolation.zh.md)。

- Claude 复用 `hasBuiltinEnvAuthentication` 及其 `CLAUDE_ENV_AUTH_KEYS`。
  CLI 的 `CLAUDE_AUTH_ROUTING_KEYS` 额外列出云认证跳过开关，纳入判断。
  模型选择（`ANTHROPIC_MODEL`、默认模型、小型/快速模型、子 Agent 模型）和
  `CLOUD_ML_REGION` 不纳入：CLI 也明确将模型选择排除在认证/路由意图触发条件之外。
  固定版本 Claude 适配器的 `paths.ts`、`auth-status.ts` 和提供商缓存键支持纳入
  `CLAUDE_CONFIG_DIR`、`CLAUDE_CODE_OAUTH_TOKEN` 及其文件描述符。
- Codex 与现有账号 profile 校验器共享 `isCodexAuthRoutingEnvKey`。
  覆盖 `HOME`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA`、`XDG_CONFIG_HOME`、
  `MODEL_PROVIDER`、`DEFAULT_AUTH_REQUEST`，以及不区分大小写的 `CODEX_`、`OPENAI_`、
  `LODY_CODEX_` 前缀。校验器更广的传输/进程保护及拒绝空白受保护键的行为保留。
- Grok 固定版本适配器把 env 转发给官方 runtime，其合成探测脚本
  `scripts/probe-session-fork.mjs` 使用 `GROK_HOME` 隔离存储。公开适配器源码
  无法建立官方 runtime 的完整认证列表，因此保守匹配 `XAI_`，以及 `GROK_API_KEY`
  和 `GROK_BASE_URL`；同时纳入 `GROK_HOME`。`GROK_PATH` 和
  `GROK_DISABLE_AUTOUPDATER` 仍属于普通 runtime 设置。
- Kimi 固定版本的 `packages/kosong/src/providers/kimi.ts` 使用 `KIMI_API_KEY` 和
  `KIMI_BASE_URL`；`apps/kimi-code/src/cli/sub/acp.ts` 将登录绑定到 `KIMI_CODE_HOME`。
  `packages/node-sdk/src/config/env-model.ts` 定义 `KIMI_MODEL_API_KEY`、
  `KIMI_MODEL_BASE_URL` 和 `KIMI_MODEL_PROVIDER_TYPE`。v2 提供商定义还暴露 OpenAI、
  Anthropic、Google Gemini 和 Vertex 的密钥/base URL 对，均纳入判断。
  固定版本源码未建立 `MOONSHOT_` 的处理依据，因此对该前缀采用保守规则。
  全量匹配 `KIMI_` 会再次让更新、缓存、遥测和模型调节等无关设置隐藏额度。

## 验证

现有 shared 认证和 components 会话用量测试覆盖非空账号/路由覆盖、空白值、
无关设置、Agent 隔离、品牌以及未改变的 Antigravity 行为。
shared 测试还检查 Codex profile 更严格的环境变量边界仍然保留。
shared 全量测试通过 116 个文件、1424 项；最终认证测试重跑通过 76 项。
components 用量、弹层和提供商重新认证测试通过 3 个文件、47 项。
两个包的类型检查（`tsgo --noEmit`）、类型感知 lint、仓库格式化、文档检查和
public boundary 检查通过。额外的 components 全量运行在目标检查通过后停止，
不宣称完成 components 全量覆盖。

`pnpm check` 在仓库级检查前停止，因为 worktree 缺少 fork 补丁步骤所需的
已初始化子模块 Git 元数据。固定版本的公开子模块源码及本地构建的 Core/DSH 契约
足以完成受影响范围的检查。未执行手动应用界面验证。
