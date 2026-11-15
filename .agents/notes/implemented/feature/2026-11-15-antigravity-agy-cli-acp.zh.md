# Google Antigravity 改用 agy CLI 自带的 ACP 服务

Status: implemented
Translation: current

[English](2026-11-15-antigravity-agy-cli-acp.md)

## 摘要

registry 里的 Google Antigravity 条目原先运行 `agy_acp_server`。它不加载用户的 agy
插件、插件 hooks 和插件 MCP 服务，只提供 `default`、`auto_edit`、`yolo` 三种模式。
1.5.0 版是同一个服务，没有任何参数、环境变量或配置文件能打开插件。LAN fork 现在改为从
agy CLI 的 GitHub release 启动 `antigravity acp`，Lody 会话因此和本地 `agy acp` 一致：
插件 hooks 会执行，插件 MCP 服务会加载，原生 `default`/`accept-edits`/`auto`/`plan`
模式、`thought_level` 选项、Claude/GPT 模型和 agent 自己起的标题都可用。Lody 让这个运行时
自己给会话起标题，并把它的 Auto Review 模式当作原生 `auto`。代价是：对客户端传入的 MCP
服务（包括 Lody 自己的 `lody`），agy 每次调用工具都会询问，而以前由 Lody 的审查模型决定；
另外，已保存的 `yolo`、`auto_review`、`thinking_level` 选择不再通过校验。

## 发现

2026-11-15 在 macOS arm64 上测得，agy CLI 1.5.9，最小 ACP 客户端，nmem 插件每个会话只注入一次上下文：

- `agy_acp_server` 1.4.5 和 1.5.0 只从 `$GEMINI_HOME/config/hooks.json` 和受信任的
  `<cwd>/.agents/hooks.json` 读 hooks，不发现插件，也没有会话开始事件。MCP 服务只从
  `~/.gemini/config/mcp_config.json` 读取，并会在工作区根目录写入 `skills/system/run-workflow/SKILL.md`。
- `antigravity acp` 会执行插件 hooks。上下文包在第一轮就有，工具调用之后仍在；每个会话都会
  进入 nmem 线程；插件的 MCP 服务可以调用；不往工作区写任何文件。
- CLI 的 release 为 macOS、Linux、Windows 的 arm64 和 x64 各提供一个归档，里面只有一个
  可执行文件。Lody 的 registry 下载对所有条目都不校验 checksum。
- 在临时 daemon（`LODY_DATA_DIR`）上带着这次改动真跑：刷新能力时下载了该 release，报告四种
  模式、九个模型和 `thought_level`；每轮都应用了 `auto` 和 `thought_level`；agy 的标题替换了
  草稿标题，没有启动独立的标题进程；daemon 重启后 `session/load` 恢复了对话，历史没有重复；
  配额轮询写入了 Gemini 配额；创建会话时 `yolo` 和 `thinking_level` 被拒绝。
- `auto` 下，agy 批准了用户明确要求的删除工作区文件的 `rm`，以及把工作区文件 `curl` POST
  到外部主机。读取工作区外其他会话的文件前会询问；调用 `lody` 和探测用 MCP 服务的每个工具
  前都会询问，选项只有允许一次和拒绝一次。插件的 MCP 工具在 `default` 和 `auto` 下都不询问。
  在单独的 `--cli_dir_name` 设置目录里写 agy 的 `permissions.allow` 规则 `mcp(<server>/*)`
  没能免掉询问；ACP 会话到底读不读这类规则，尚未确认。

## 决策

`scripts/generate-acp-registry.mjs` 只替换 `antigravity-acp` 条目：版本取
`ANTIGRAVITY_CLI_VERSION`，各平台从该 GitHub release 下载 `agy_cli_<os>_<arch>`，
命令是 `./antigravity`（Windows 为 `.exe`）加参数 `acp`。agy 几乎每天发版，版本号需手动更新。

registry 的 Antigravity 加入 Claude/Grok 的身份兼容名单，接收不带标签的
`session_info_update` 标题。agy 按提示词的语言给每个会话起标题；独立的标题会话会多出一个
agy 会话并执行用户的 hooks，每个 Lody 会话多一条 nmem 线程和一份上下文包。

`withAntigravityAutoReview` 检查会话报告的模式。其中有 `auto` 时，它不加模式、不做审查，
已保存的 `auto_review` 以 `auto` 发出。它的审查模型是同一个可执行文件的隐藏会话，在 agy CLI
上每个被审查的会话都会执行一遍用户的 hooks。没有 `auto` 的服务仍保留合成模式，所以还在用
`agy_acp_server` 的机器在更新前行为不变。

权限档位把 agy 的 `accept-edits` 归为 `edit`，输入框用 accept-edits 的图标显示它。
`auto`、`default`、`plan` 原本已有归类。

## 备选方案

- 固定到 registry 1.5.0：否决，它是同一个不加载插件的服务。
- 在 agy CLI 的 `default` 模式上继续用 Lody Auto Review：暂时否决，因为每个被审查的会话都会
  多一个执行用户 hooks 的隐藏 agy 会话。如果 MCP 工具逐次询问的代价太大，这是可以回头采用的方案。
- 把 `auto_review` 列为原生 `auto` 的别名：能让已保存的选择继续有效。否决原因是 id 会和 agy
  自己的不一致，模式更新要做转换，而需要修改的已保存选择很少。

## 影响

- 为这个条目保存了 `yolo`、`auto_edit`、`auto_review` 或 `thinking_level` 的 Role、定时任务和会话，
  创建时会失败；继续对话时这些选择被丢弃，以 `default` 运行。请改用 `auto` 或 `accept-edits`，
  以及 `thought_level`。agy 没有按会话设置的 `yolo`，只有进程参数 `--dangerously-skip-permissions`。
- 来自 `agy_acp_server` 的会话 id 会载入为空对话，以前的 Antigravity 会话丢失 agent 侧上下文。
- 配额仍读取 `~/.gemini/antigravity-acp/acp_token.json`，见
  [Argon 配额决策](../bug-fix/2026-10-20-antigravity-argon-quota.zh.md)。只通过 agy CLI 登录的机器
  不会报告配额。
- `LODY_ANTIGRAVITY_THIRD_PARTY_MODELS` 不再影响这个条目的模型列表，继续发送 Zed 客户端身份没有影响。

## 验证

- `scripts/generate-acp-registry.test.mjs` 固定生成的条目。
- `packages/shared/tests/title-generation-defaults.test.ts` 固定标题归属。
- `apps/cli/tests/antigravity-auto-review.test.ts` 固定交给 `auto` 的行为。
- `packages/shared/tests/permission-tier.test.ts` 和 `permission-mode-face.test.ts` 固定模式档位和图标。

未验证：在桌面应用里回答权限请求、批准后实际调用 `lody` 工具、真跑 `accept-edits` 和 `plan`、
启动 Linux 和 Windows 归档。
