# 独立显示 Antigravity Argon 额度

Status: implemented
Translation: current

[English](2026-10-20-antigravity-argon-quota.md)

## 摘要

Antigravity Pro 提供独立的 Argon 周额度，但模型名称匹配会选中更长的 Gemini 名称，Provider 行也只显示一个分组。
Daemon 现在把 `gemini-argon-wtu` 映射为共享的 `argon` 额度 ID 和 Argon 标签。
会话用量为 Argon 模型优先选择独立额度；若不存在该桶，则使用 Gemini，适用于 Ultra。
Provider 行同时显示 Gemini 和 Argon；紧凑视图已有独立分行及窗口标签，无需修改。

## 决定与证据

脱敏三组响应包含 `gemini-argon-wtu-weekly`、周窗口及剩余比例 `0.5653113126754761`，映射为已用 43.5%。
显式 ID 避免 Gemini/Argon 名称重叠及 Provider 选择受输入顺序影响。
其他 Gemini 模型只选 Gemini。Provider 行与会话用量仍排除 Claude/GPT 额度，其他 Provider 不变。
本次扩展[订阅额度显示条件](2026-10-07-subscription-env-eligibility.zh.md)，不改变凭证、端点、轮询或 Provider 隔离。
实现职责见 [CLI 库索引](../../../../apps/cli/src/lib/README.md#provider-quota)。

现有 CLI、session-usage 和 provider-row 测试覆盖映射、模型选择、Ultra 合并桶及 Argon 排在首位的输入。
Storybook Pro/compact 场景用于核对渲染标签。验证使用 fixture，不访问真实 Google 额度或账号凭证。
