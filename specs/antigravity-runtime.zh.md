# Antigravity 运行时与配额归属

Status: draft
Translation: current

[English](antigravity-runtime.md)

新 Antigravity Provider 使用 Lody 固定版本的托管 agy CLI，禁用遥测与自动更新。
配置 `antigravityPath` 时使用用户自己的可执行文件。已有 `registry/antigravity-acp`
Provider 继续通过 fork 的 agy CLI 分发运行，但从新建列表隐藏。过渡不得改写 Provider
身份、对话 ID 或用户数据，也不得把 fork 的旧 Provider 退回不支持插件的旧 ACP 服务。

两种身份都用选中的可执行文件与账户环境，通过 `agy --print /usage --output-format json`
读取配额，不产生模型轮次或 ACP 配额对话，保留全部具名模型组和窗口。daemon 不再读取旧
ACP token 或直接请求 Cloud Code。不得丢弃不支持的启动参数后读取另一个账户的配额。

除 `yolo` 外，Lody 不在 agy 的模式之外再加权限模式：`auto` 下的批准由 agy 的沙箱和审查
负责，按本机的 agy 权限规则放行。Lody 原有的 Auto Review 已删除；存为它的会话、Role 和
定时以 agy 原生 `auto` 运行。两种身份都应用 HTTP MCP 能力修补。标题由 agy 生成，Lody
不得为此再建一个对话。只有选择 `yolo` 的会话追加 `--dangerously-skip-permissions`；切入或
切出时只替换该会话的 agy 进程。Provider 级跳过设置隐藏，其已存 override 不影响启动，因此
并行的 `auto` 会话不会继承免批。上游 schema 与协议字段可以保留兼容。

## 证据

- [运行时与兼容](../apps/cli/src/agent/README.md#managed-antigravity)
- [归属决策](../.agents/notes/implemented/feature/2026-11-15-antigravity-agy-cli-acp.zh.md)
- [删除 Auto Review](../.agents/notes/implemented/simplification/2026-11-19-antigravity-auto-review-removal.zh.md)
- [配额边界测试](../apps/cli/src/agent/acp-runner.test.ts)

本草稿表达意图。实际运行时启动、真实账户配额和跨机器行为仍需集成验证，fixture 覆盖本身
不能证明这些行为。
