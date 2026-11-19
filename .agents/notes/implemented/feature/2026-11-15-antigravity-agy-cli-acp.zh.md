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
自己给会话起标题，并在 agy 自己的 `auto` 旁边提供它的 Auto Review 模式（agy 的终端沙箱没有网络）。代价是：对客户端
传入的 MCP 服务（包括 Lody 自己的 `lody`），除非有 agy 的允许规则覆盖，agy 每次调用工具都会询问；
另外，已保存的 `auto_edit`、`thinking_level` 选择不再通过校验。agy 只能让整个进程跳过权限询问，
所以 Lody 的 `yolo` 模式用 `--dangerously-skip-permissions` 启动该会话的 agy，某一轮切入或切出
YOLO 时重启它。

下文所述的 Lody Auto Review 已于 2026-11-19 删除，已保存的选择以 agy 的 `auto` 运行，见
[删除决策](../simplification/2026-11-19-antigravity-auto-review-removal.zh.md)。

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
  没能免掉询问。更正：ACP 会话会读 agy 共享配置里的允许规则，见下面 2026-11-18 的测量。

2026-11-18 测得，agy CLI 1.5.9，Linux x86_64（Ubuntu 24.04 和 26.04）与 macOS arm64，经由 Lody 会话
和最小 ACP 客户端：

- 两台 Linux 机器的 `kernel.apparmor_restrict_unprivileged_userns` 都是 1，agy 只报告 `default`、
  `accept-edits`、`plan`，没有 `auto`；它的 changelog 说，在禁止非特权 user namespace 的 Linux 上，
  需要终端沙箱的选项不提供。那里运行的是 Lody 合成的 Auto Review。
- `~/.gemini/config/config.json` 里 `userSettings.globalPermissionGrants.allow` 下的允许规则，
  例如 `command(lody-lan session list)`（按词前缀匹配）和 `mcp(lody/lody_session_status_many)`，
  对 ACP 会话生效。Linux 上一个会话执行 `lody-lan` 命令、调用 `lody` 和 nmem 的 MCP 工具，没有一个
  权限请求到达 Lody。macOS 的 `auto` 下，MCP 工具不再询问。
- macOS 的 `auto` 下，`lody-lan` 在 agy 的终端沙箱里失败（"operation not permitted"）；agy 对
  "在沙箱外执行"的审查约 40 秒没有结论，之后允许规则放行，没有询问用户。
- Lody Auto Review 下，每条 `lody-lan … > <scratch>/out.json` 都被当作修改 agent 配置而询问用户：
  agy 让 agent 把临时文件放在本会话目录 `~/.gemini/antigravity-cli/brain/<会话 id>/`，而规则把整个
  `~/.gemini/antigravity-cli/` 都算作 agent 配置。这个会话 id 就是 ACP session id。
- devNuc 装上允许 agy 使用 user namespace 的 AppArmor 配置后，agy 报出 `auto`。给
  `~/.lody-oss/session-bin`、`~/.lody-oss/run`、`~/.lody-oss/workspace-catalog.json`、node 目录和
  `~/.local/share/lody-lan` 加 `read_file(<路径>)` 授权后，四条 `lody-lan` 命令在沙箱里直接执行、没有询问。
  沙箱只有回环网卡，开 `userSettings.sandboxAllowNetwork` 也一样：`nmem`、按域名或按 IP 的 `curl`
  都失败，联网命令要走 agy 的沙箱外审查，再问用户。
- 加 `--dangerously-skip-permissions` 并用 `default` 时，macOS 上 `lody-lan` 立即执行。changelog 说
  这个参数只跳过工具权限询问，系统命令黑名单照样拦截，显式的 deny 规则仍然有效。

## 决策

运行时、配额及会话权限边界记录在[草稿契约](../../../../specs/antigravity-runtime.zh.md)。

新 Provider 使用上游托管的内置 Antigravity，由 `antigravity-runtime-manifest.json`
固定到 agy 1.5.10。启动参数为 `acp --process-per-session --disable-telemetry`，
禁用自动更新；`antigravityPath` 可指定用户维护的可执行文件。已有 registry Provider 在
`setting.ts` 保留 fork 已使用的 agy 1.5.9 GitHub 分发，从新建列表隐藏，不改写身份或已存会话。

registry 的 Antigravity 加入 Claude/Grok 的身份兼容名单，接收不带标签的
`session_info_update` 标题。agy 按提示词的语言给每个会话起标题；独立的标题会话会多出一个
agy 会话并执行用户的 hooks，每个 Lody 会话多一条 nmem 线程和一份上下文包。

`withAntigravityAutoReview` 在会话报告的模式里加上 `auto_review`，选它时 agy 以 `default`
运行；agy 自己的 `auto` 原样透传。agy 的沙箱适合 `lody-lan` 和工作区内的工作，Lody Auto Review
能放行联网命令，所以由会话或 Role 二选一。它的审查模型是同一个可执行文件的隐藏会话，每个被审查的
会话都会执行一遍用户的 hooks。

它的规则把本会话自己的 agy 会话目录算作工作区，那里的临时文件按工作区内的修改审查。其他会话的
目录和 `~/.gemini/antigravity-cli/` 的其余部分仍会询问。

YOLO 是 Lody 加进 agy 模式列表的模式，沿用旧服务的 id，已保存的 Role 和会话因此重新通过校验。
驱动这一轮的选择是 `yolo` 的会话，用 `--dangerously-skip-permissions` 启动 agy
（`antigravityLaunchArgs`），以 `default` 运行，包装层把当前模式报告为 `yolo`。Lody 本来就是
每个会话一个 agy 进程，所以这个参数对内置和 registry Antigravity 都按会话生效，
不会重启同 Provider 的其他会话。某一轮切入或切出 YOLO 时，先退役该会话的 agent，
再启动一个载入原对话的替代进程（会话执行服务里的 `antigravityYoloChanged`）。运行中的一轮里，
需要换进程的模式切换会被报错拒绝，不会发给 agy。

权限档位把 agy 的 `accept-edits` 归为 `edit`，输入框用 accept-edits 的图标显示它。
`auto`、`default`、`plan` 原本已有归类；`yolo` 是 `full`，带警告图标。

发布 Provider 能力时，只把包装层虚拟的 `yolo`、`auto_review` 当前值还原成底层的
`default`，再写入共享能力快照及各模型配置行；当前会话仍显示自己的选择，选项列表不变。
否则无关的新会话、Role 或定时会从共享缓存继承另一会话的免批策略。原生模式按 agent 的报告保留。

## 备选方案

- 固定到 registry 1.5.0：否决，它是同一个不加载插件的服务。
- agy 有 `auto` 时把已保存的 `auto_review` 以 `auto` 发出：省掉隐藏的审查会话。已放弃，因为 agy
  的沙箱没有网络，这样选择就变成按机器而不是按 Role。
- 把 `auto_review` 列为原生 `auto` 的别名：能让已保存的选择继续有效。否决原因是 id 会和 agy
  自己的不一致，模式更新要做转换，而需要修改的已保存选择很少。
- 上游 LodyAI/Lody#2796 的 Provider 级跳过开关会让该 Provider 的全部会话绕过审批，
  包括选择 `auto` 或 `auto_review` 的会话。fork 隐藏入口并忽略已存 runtime override；
  schema 和协议字段保留兼容，但只有本会话选择 `yolo` 才添加启动参数，内置与已有 registry
  Provider 都遵守这一边界。
- `antigravity acp --process-per-session` 在一个父进程里为每个 ACP 会话起一个 agy worker；Lody 本来
  就是每个会话一个进程，而且这个参数仍属于父进程。
- agy 的 `always-proceed` 工具执行策略（它的 Turbo 预设）作用于整台机器上的所有 agy 会话，不是 ACP 模式。
- 只靠允许规则，只能覆盖列出的命令和工具。它们仍作为 YOLO 以外会话的按机器配置。

## 影响

- 为这个条目保存了 `auto_edit` 或 `thinking_level` 的 Role、定时任务和会话，创建时会失败；继续对话时
  这些选择被丢弃，以 `default` 运行。请改用 `accept-edits` 和 `thought_level`。
- 每个 Auto Review 会话多一个执行用户 hooks 的隐藏 agy 会话。
- 会话切入或切出 YOLO，要在下一条消息时重启一次 agy。在一轮进行中切换，从下一条消息起生效。
- 来自 `agy_acp_server` 的会话 id 会载入为空对话，以前的 Antigravity 会话丢失 agent 侧上下文。
- 内置和旧 registry 配额都用选中的 agy 可执行文件运行 `--print /usage --output-format json`，
  保留账户环境和全部返回分组；不启动模型轮次或 ACP 配额会话，不读旧 token，也不直接请求 Cloud Code。
  见 [配额决策](../bug-fix/2026-10-20-antigravity-argon-quota.zh.md)。
- `LODY_ANTIGRAVITY_THIRD_PARTY_MODELS` 不再影响这个条目的模型列表，继续发送 Zed 客户端身份没有影响。

## 验证

- `scripts/generate-acp-registry.test.mjs` 验证新建列表排除旧条目；
  `apps/cli/src/agent/acp-runner.test.ts` 覆盖两种身份的 print 模式配额。
- `packages/shared/tests/title-generation-defaults.test.ts` 固定标题归属。
- `apps/cli/tests/antigravity-acp-stream.test.ts` 固定 YOLO 模式和启动参数，以及被拒绝的切换。
- `apps/cli/tests/session-execution-service-startup-part-2.test.ts` 固定某一轮切换 YOLO 时的重启。
- `packages/shared/tests/permission-tier.test.ts` 和 `permission-mode-face.test.ts` 固定模式档位和图标。

未验证：在桌面应用里回答权限请求、批准后实际调用 `lody` 工具、真跑 `accept-edits` 和 `plan`、
启动 Windows 归档，以及经由 Lody 构建跑 YOLO 会话（只探测过 agy 进程本身）。
