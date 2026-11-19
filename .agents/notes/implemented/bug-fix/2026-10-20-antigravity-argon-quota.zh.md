# 独立显示 Antigravity Argon 额度

Status: implemented
Translation: current

[English](2026-10-20-antigravity-argon-quota.md)

## 摘要

Antigravity 提供包括 Argon 在内的独立模型组配额。内置和已有 registry Provider 现在都通过
选中的 agy 可执行文件运行 `--print /usage --output-format json`，保留全部具名周窗口与
五小时窗口；不解析旧 ACP 凭据，也不直接请求 Cloud Code。下方保留的旧 reader 测量说明，
为什么不能退回旧端点或把各组虚构成一个总额度。

## 旧直接读取器的决定与证据

脱敏三组响应包含 `gemini-argon-wtu-weekly`、周窗口及剩余比例 `0.5653113126754761`，映射为已用 43.5%。
显式 ID 避免 Gemini/Argon 名称重叠及 Provider 选择受输入顺序影响。
其他 Gemini 模型只选 Gemini。Provider 行与会话用量仍排除 Claude/GPT 额度，其他 Provider 不变。
本次扩展[订阅额度显示条件](2026-10-07-subscription-env-eligibility.zh.md)，不改变凭证、轮询频率或 Provider 隔离。
实现职责见 [CLI 库索引](../../../../apps/cli/src/lib/README.md#provider-quota)。

审查发现，逐条 upsert 会在切换为不含独立桶的账号后保留 Argon。
旧 Poller 当时通过 workspace 和 machine 的 `replaceRateLimits` 为每个 config 提交一份完整结果。
Machine 沿用额度队列，写入当前分组并删除同 config、同 CLI 类型下本次缺失的 key，随后 flush 并标记 dirty。
Claude/Codex 的增量写入不变。成功返回空数组会清空该快照；返回 null 或抛错则保留原值。

现有 CLI、session-usage 和 provider-row 测试覆盖映射、模型选择、Ultra 合并桶及 Argon 排在首位的输入。
Storybook Pro/compact 场景用于核对渲染标签。验证使用 fixture，不访问真实 Google 额度或账号凭证。
旧 Poller 测试使用真实内存 LoroRepo 和 MachineDocument，覆盖 Pro→Ultra 替换、其他 config/type 隔离、空快照，
以及未登录或失败时保留旧值、恢复后替换。

## 历史测量：请求主机和 User-Agent

首版沿用正式主机和不带版本的 `antigravity` User-Agent。2026-10-20 用同一账号实测，这个请求只返回 Gemini 和 Claude/GPT 两组，
每个窗口都是剩余 100%、重置恰好在七天后：这是一个从未开始的窗口，不是账号的用量。同一账号的 agy `/usage` 显示真实的 Gemini 用量和 Argon 组。
agy 调用的 daily 主机（`daily-cloudcode-pa.googleapis.com`）在 User-Agent 写明带版本的客户端时两者都会返回：
`antigravity/cli/<version> <os>/<arch>` 和 `antigravity/hub/3.0.0` 可以；`antigravity/hub/2.9.1` 有真实 Gemini 用量但没有 Argon；
`antigravity/agy/<version>` 和不带版本的写法只返回 Claude/GPT。OS/arch 部分不影响结果。
已移除的 reader 曾向 daily 主机发送 `antigravity/cli/1.4.2 <os>/<arch>`。版本门槛由 Google 决定且没有文档，以后的 Antigravity 版本可能需要更新版本号。
CodexBar 出于同样原因从这个主机读取额度。

## 当前配额读取边界

内置和已有 registry 条目都启动 agy。配额不以 ACP prompt 发送 `/usage`，也不建立配额对话。
`queryLocalAcpRateLimits` 用所选启动环境运行 print 模式，校验 `num_turns: 0`，在同一个
Provider 快照保留全部分组。存在额外 ACP 参数或 Magpie 路由时仍不支持配额读取，避免悄悄
丢弃账户选择参数。旧 `lib/antigravity-quota.ts` reader 及其测试已移除。
见 [agy CLI 决策](../feature/2026-11-15-antigravity-agy-cli-acp.zh.md)。

设置页与 composer 对 builtin 和旧 registry Provider 都优先读取原生 `antigravity`
额度行，保留 agy 的全部窗口标签。成功且非空的查询沿用额度队列，替换同 Provider/type
快照并删除过时的 `gemini`、`argon`、`third-party` 行。队列打开 Flock 后、写入或删除前，
再次检查查询 revision 未变且持久化 Provider 配置完全一致；其他 Provider 和其他类型不受影响。
空结果或失败保留缓存，取代上文旧 Poller 的空结果清除行为。现有 machine-document 套件覆盖
manager 参数传递、范围限定和等待期间发生 push／配置变化／删除的竞态。

旧 registry 的能力 sourceVersion 增加 `+agy-usage:1`，即使 agy 二进制版本未变，
旧的不含额度查询能力的 catalog 也会重新探测。Zed 身份仍是独立后缀和 registry 专属设置；
builtin agy 无需 Claude/GPT 开关。`NMEM_AGENT_ID` 等普通工具变量遵循共享的
[账号环境策略](2026-10-25-subscription-quota-environment.zh.md)，账号、home／配置发现及
代码加载覆盖仍排除。
