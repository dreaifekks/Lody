# 用独立 macOS 应用测试本地 LAN fork

Status: implemented
Translation: current

[English](2026-10-18-mac-local-test-build.md)

## 摘要

以前查看桌面修改需要发布 dev 版本或启动开发服务器。现在本地 arm64 构建会产出 Lody Test，拥有独立的桌面身份、数据根目录和 CLI host 端口。构建期开关使 Finder 启动也能隔离，无需依赖调用者的环境变量。测试安装初始为空，因为加入 LAN 会共享可写数据，并不是只读预览。

## 决定

CI 的 dev 通道只把发布标记改成 `lan-dev`，产品名和应用 ID 仍是 Lody OSS。因此仅重命名应用不能隔离存储和 CLI。打包版本还会忽略 `LODY_ELECTRON_USER_DATA_DIR`。

`scripts/mac-local-test-build.sh` 选择专用的构建期测试配置，复用正常构建、打包及原生依赖探针，关闭证书签名、公证、发布和版本更新标记。保留现有的本机运行 ad-hoc 签名钩子。启动阶段在应用模块打开存储之前设置短 CLI 数据路径和 `LODY_LOCAL_CLI_HOST_PORT`；打包桌面仍使用正常的单实例锁。默认构建保持原样。测试配置也隔离 URL 协议注册及 userData 外的桌面存储。

端口选择不能开启 E2E 模式：它还会让 Codex 能力探测使用并删除 `<cwd>/.codex`，Finder 启动时 cwd 为 `/`，因此失败。共享 TS/CJS 端点解析器使用已有端口校验读取专用覆盖变量，测试版 bootstrap 清除 `LODY_E2E`。Codex 保持正常的凭据和主目录行为。

脚本把最新 `origin/lan-hub` 合入专用克隆的当前分支，不重置本地工作，并保留缓存。Renderer 仍全量构建。替换产物前必须退出正在运行的 Lody Test。

## 数据与验证

不复制已安装版本的配置、机器身份或 LAN 凭据。用户可以通过设置以新身份加入 LAN，但之后使用的是实时可写目录，包括启动时的协调写入。迁移实验优先使用独立 LAN。见[用法与路径](../../../../DEV.md#local-macos-test-application)。

桌面身份回归测试、307 条 Electron 测试、类型检查、lint、边界检查、arm64 原生打包探针及真实打包启动通过。拆分端口开关后，17 条 host/profile 测试和 11 条 Codex 环境测试通过，包括 TS/CJS 一致性与工作目录为根目录的能力探测情形。完整仓库检查在两条未修改的 CLI 用例失败：inbox 恢复用例独立复跑通过，speculative-worktree 所有权用例仍失败。该失败不属于本次修改范围。文档检查为 0 错误、71 告警。未测试证书签名、公证及真实 LAN 兼容性。
