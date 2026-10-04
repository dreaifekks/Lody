<p align="center">
  <img src="./site-docs/public/icon-mac.png" width="128"/>
</p>
<h1 align="center">Lody LAN</h1>
<p align="center">
  <a href="./README.md">English</a> | <b>简体中文</b>
</p>
<p align="center">
  <b>不需要账号，只给你自己的机器用的 Lody。</b>
</p>
<p align="center">
  <a href="https://github.com/LodyAI/Lody">Lody</a> 的个人 fork，通过你自己托管的 hub 把多台机器连在一起。
</p>
<p align="center">
  <a href="https://github.com/dreaifekks/Lody/releases/tag/lan-latest"><b>下载</b></a>
  |
  <a href="./.agents/docs/lan.md"><b>LAN 的工作方式</b></a>
  |
  <a href="https://github.com/LodyAI/Lody"><b>上游 Lody</b></a>
</p>

## 这是什么

Lody LAN 基于开源的 Lody 桌面应用和 CLI，让同一个人的多台机器不需要 Lody 账号、也不依赖托管服务就能协同工作。它不是 Lody 团队出品，也不由他们维护。它跟随上游发布：每个构建的版本号是 `<上游版本>-lan.<n>`，桌面应用和服务器都从本仓库的[滚动发布](https://github.com/dreaifekks/Lody/releases/tag/lan-latest)自我更新，不会被上游版本替换。

Lody 的大部分功能和上游一致：通过 ACP 接入 Agent、worktree、diff、终端、浏览器预览、Roles 和 CLI。依赖 Lody 服务器的部分被替换或者缺失，详见[与 Lody 的差异](#与-lody-的差异)。

## 开始使用

一个 LAN 就是你自己托管的 hub 加上打开它的邀请：持有邀请的每台机器都能看到其他机器的项目，并在上面运行 Agent。一台机器可以加入多个 LAN，在每个 LAN 里都是同一台机器、同一个名字。会话的终端开在运行该会话的机器上，不管你在哪台机器上用桌面应用；消息附带的图片和文件也会送到那台机器。成员之间通过各自连接 hub 的地址的 8789 端口互连。如果那台机器开着 SSH 服务并允许桌面这台机器登录，会话所在的文件夹还能在桌面这边的编辑器里通过 SSH 打开。

在一台服务器上托管 LAN，这台服务器同时成为第一个成员：

```bash
curl -fsSL https://github.com/dreaifekks/Lody/releases/download/lan-latest/install.sh | bash -s -- up
```

命令会打印一个邀请。在另一台服务器上用它加入，或者粘贴到桌面应用的 **Settings > LAN**：

```bash
curl -fsSL https://github.com/dreaifekks/Lody/releases/download/lan-latest/install.sh | bash -s -- join lody-lan://…
```

macOS、Windows 和 Linux 的桌面安装包附在[滚动发布](https://github.com/dreaifekks/Lody/releases/tag/lan-latest)里。`lody-lan lan --help` 列出查看、改名、迁移和退出 LAN 的命令，[LAN 的工作方式](.agents/docs/lan.md)解释其余部分。

**Settings > LAN** 还会列出各个 LAN 能连到的机器，以及每台机器的构建版本和 Agent 运行时。新构建也从这里安装：服务器可以从桌面或用 `lody-lan lan update <机器>` 让它自我更新，桌面应用则在侧边栏提示自己的更新。构建跟随构建它的那个仓库的发布，所以 fork 这个 fork 的人会跟随他们自己的发布。

从托管版 Lody 迁过来？在 **Settings > LAN** 的机器菜单里，或者在服务器上运行 `lody-lan hosted import`，可以读取托管版 Lody 在那台机器上配置的 Agent、MCP 服务、Roles 和项目，并加到那台机器的安装里。不会向任何地方发送数据，托管版也保留原有配置；[导入说明](.agents/docs/hosted-import.md)列出了不会带过来的内容。两个桌面应用可以同时安装。

## 与 Lody 的差异

### 新增的功能

| 功能               | Lody LAN 中的情况                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LAN                | 自建 hub 和它的邀请取代账号；一台机器可以加入多个 LAN                                                                                                         |
| 其他机器的终端     | 成员之间直接连接，用 LAN 凭证加密，不经过 hub                                                                                                                 |
| 消息附带的文件     | 直接送到运行该会话的机器                                                                                                                                      |
| 其他机器的文件夹   | 别的成员上的会话文件夹，可以在本机编辑器里通过 SSH 打开                                                                                                       |
| 机器与更新         | Settings > LAN 列出所有机器及其构建版本；任一成员都能更新服务器，桌面应用自我更新                                                                             |
| 手机提醒           | hub 用你自己的 APNs 密钥（`lody-lan lan push setup`）向注册过的 iOS 客户端推送提醒和实时活动，并可以在实时活动里直接审批权限请求                              |
| Pull Request       | PR 面板、合并、评论、PR 驱动的自动归档以及自动 review 与合并都在本地可用，用 hub 保存的一个 GitHub token（`lody-lan lan github setup`），或者本机的 `gh` 登录 |
| 原生会话           | Lody 会话会补上在 Lody 之外写进对应 Claude 或 Codex 会话的轮次                                                                                                |
| 托管配置导入       | 读取托管版 Lody 在某台机器上的配置                                                                                                                            |
| hub 迁移与热备     | `lody-lan lan take-over` 把 hub 迁到另一台服务器；热备服务器保存一份副本，hub 长时间离线时自动接管；Settings > LAN 会标出两者                                 |
| 其他机器上的 Agent | 会话里的 Lody 工具可以在同一 LAN 的其他机器上创建并驱动会话                                                                                                   |
| 用量               | 每台机器记录自己的 Agent 用量；Settings > AI Usage 向所有成员收集，按模型和按机器展示                                                                         |
| Shell 和端口       | `lody-lan lan shell <机器>` 在成员上开 shell，`lody-lan lan forward <机器> <端口>` 访问它的端口，都走成员直连                                                 |

### 实现方式不同的功能

| 方面           | Lody                              | Lody LAN                                                                  |
| -------------- | --------------------------------- | ------------------------------------------------------------------------- |
| 身份           | Lody 账号、团队和工作空间         | 持有 LAN 邀请的就是成员；所有成员视为同一个用户；邀请不能原地更换         |
| 同步           | Lody 的服务器                     | 你的 hub：单节点 SQLite；热备服务器每十分钟复制一次，hub 长时间离线时接管 |
| 机器之间的请求 | Lody 的服务器                     | 机器之间直接连接；连不上时经 hub 排队，最多等两分钟                       |
| 附件           | 上传到所有设备都能读取的存储      | 留在运行会话的机器上；其他成员能看到卡片，但打不开                        |
| GitHub 凭证    | Lody 的 GitHub App 和你关联的账号 | hub 为整个 LAN 保存一个 token；Agent 只在本机没有 `gh` 登录时才用它       |
| PR 面板刷新    | GitHub webhook                    | 面板打开时轮询：CI 每 15 秒，review 和评论每分钟                          |
| 手机和网页端   | Lody 的 iOS、Android 和网页应用   | 这些应用需要 Lody 账号，连不上 LAN；手机通过 hub 接收提醒                 |
| 更新           | Lody 的更新服务                   | 本仓库的滚动发布；上游的更新器保持关闭                                    |

### 暂不可用的功能

- 与团队共享，以及会话的公开分享链接。
- GitHub App 相关：仓库注册、Settings > GitHub、在云端克隆的仓库，以及以你关联的 GitHub 身份操作。
- 远程预览：Agent 在其他机器上启动的开发服务器，不能在本机的浏览器面板里打开；可以用 `lody-lan lan forward <机器> <端口>` 转发到本机访问。
- Settings > Machines 和快捷指令的机器选择；改由 Settings > LAN 列出机器。
- 在桌面应用里托管 LAN，因为桌面应用不包含 hub。
- 计费、Bug 报告上传和遥测，这些按设计关闭。

## 路线图

- **走向点对点：** 机器之间的请求已改走直连通道，hub 可以用 `lody-lan lan take-over` 迁移，长时间离线时由热备服务器自动接管。每个成员都保存一份 GitHub token、APNs 密钥和手机注册信息，hub 不在时 PR 和提醒照常可用。剩下的：手机在 hub 迁移后自动跟随。hub 保留为中转，暂存离线成员还没收到的内容。
- **待补的功能：** 浏览器面板里的远程预览，基于 `lody-lan lan forward` 已经能访问的端口。

## 与 Lody 共有的功能

下面几节介绍 Lody LAN 从上游保留下来的功能。其中提到团队、账号下的工作空间，或者手机和网页应用的地方，请先看[与 Lody 的差异](#与-lody-的差异)。

### 通过 CLI 使用 Lody

CLI 不只是用来连接机器的后台进程。你可以从终端或脚本注册本地项目；查看工作空间、机器、已关联的仓库和 Agent 配置；创建 Session、发送消息、读取历史和状态；以及归档或恢复 Session。支持 `--json` 的命令还可以把 Lody 工作空间中的数据接入你自己的工具。

```bash
npx lody session create --workspace my-team --agent-config codex \
  --repo owner/repo "修复失败的测试"

npx lody session list --workspace my-team
```

完整命令请查看 [CLI 文档](https://lody.ai/zh/docs/cli)。

### 让 Agent 跨对话协调工作

Lody 为 Agent 提供创建或复用其他对话、读取状态和历史、追加指令、取消运行中任务以及取回结果的工具。这样，一个对话就可以承担协调者的角色：你可以先与主 Agent 一起分析 Bug，再让它把调查、实现和测试分别交给多个并行对话。

每个子对话仍然拥有独立的历史和任务状态，Lody 同时会保留它与发起对话之间的关系。你或 Agent 也可以通过 `@` 引用其他对话，把不同 Session 中的工作联系起来。

### 在同一个工作空间中查看代码和运行结果

#### 隔离并行任务的代码改动

为不同 Session 创建独立的 Git worktree，让多个 Agents 并行工作而不会混在同一个工作目录中。你可以在标签页中同时打开多个对话、文件、Diff、终端和 Preview，也可以把一个 Session 派生为新的对话或 worktree，探索另一种解决方案。

#### 在工作发生的地方查看改动

在对话旁浏览项目文件，查看单轮或整个 Session 的 Diff。你还可以添加行级评论、跟踪 Pull Request 和 CI 状态，并让 GitHub Review 讨论留在产生这些改动的 Agent 附近。

<p align="center">
  <img src="./site-docs/public/_docs-assets/PR-panel.png" alt="在 Agent 对话旁查看 Pull Request 和 CI 状态" width="100%" />
</p>

#### 向 Agent 提供视觉反馈

在 Session 中打开正在运行的网页应用，切换不同的响应式视口，并把针对具体元素的视觉批注直接发回给 Agent。

<p align="center">
  <img src="./site-docs/public/_docs-assets/20260507-preview.png" alt="在网页 Preview 中添加批注并发送给 Agent" width="100%" />
</p>

### 更多内置能力

- **Agent Roles** — 与团队共享可复用的 Agent、模型、权限和默认指令配置。
- **附件** — 从桌面端、移动端、网页端或 CLI 发送文件和图片，并接收 Agent 生成的文件。
- **Session 管理** — 搜索、置顶、归档、派生和整理对话，同时保留完整历史。
- **桌面工具** — 使用内置终端、命令面板、自定义快捷键，也可以在外部编辑器中打开文件。
- **移动端控制** — 接收通知、批准权限请求、查看 Diff，并通过 iOS 实时活动跟踪正在进行的工作。
- **用量信息** — 查看上下文、Token 和额度使用情况，以及机器和 Agent 的资源占用。

<p align="center">
  <img src="./site-docs/public/_docs-assets/20260611-island.png" alt="通过 iPhone 实时活动批准 Agent 的权限请求" width="60%" />
</p>

## 发布

推送 `v<上游版本>-lan.<n>` 形式的 tag，会构建桌面应用和 CLI 包，并替换[滚动发布](https://github.com/dreaifekks/Lody/releases/tag/lan-latest)。`node scripts/lan-release.mjs version` 会打印下一个版本号。`dev-v<上游版本>-lan.<n>` 形式的 tag 可以从任意分支以同样方式构建，替换的是 `lan-dev` 预发布，只有从它安装的机器会跟随（`lan-release.mjs version --channel dev`）。上游自带的 `Release` 工作流只接受 `vX.Y.Z` 形式的正式版本 tag，在本仓库已停用。

## 仓库结构

- `apps/cli` — 连接机器并运行 Coding Agents；`src/lib/lan` 是 hub 和 LAN 相关功能
- `apps/electron` — 桌面应用
- `packages/components` — 工作空间共享 UI
- `packages/ui` — Base UI 基础组件与 StyleX 设计令牌
- `packages/platform` — 平台能力与集成
- `packages/shared` — 共享 Schema、协议与工具
- `scripts/lan` — 随每次发布一起发布的安装脚本
- `site-docs` — 上游的官网、文档与博客

开发环境配置请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。
