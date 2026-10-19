# LAN fork 合入上游 0.106.0

Status: implemented
Translation: current

[English](2026-10-19-lan-upstream-0-106-merge.md)

## 摘要

LAN fork 在 `0180ed40f` 上通过 merge 合入截至 `76aa567ac` 的 13 个上游提交，
保留 fork 历史。上游的调度、资源清理和会话修复与 LAN、Board 行为并存。
之后的 Role、Repo/Streams 和 residency 改动不属于本次范围；子模块指针和发布
workflow 不变。

## 合并决策

- 保留 fork 的 32 KiB 完成预览和 64 KiB 总上限，同时纳入上游提交前撤回 Inbox
  执行和资源恢复规则。预览大小是有意保留的 fork 差异，不属于清理修复。
- 在原执行测试套件中同时保留 Board 用例、上游访问重试和已结束输入的用例。
- 在 fork 会话布局内接入上游待发送消息 hook、本地消息锚定和轮次实时计时。
  保留 GitHub 发送者头像、Board 头部控件、可见性与文件导航及 Agent Surface provider。
- 两份语言文件保留双方全部 key 和 fork 文案。共有 key 遵循各自上游文件的顺序，
  fork 独有 key 保留相对顺序。
- 13 个提交均无补丁等价的已合入版本。上游轮次计时与 Board 整棵线程树完成状态、
  LAN Live Activities 互补；权限布局与 Role 权限限制互补。Roost 待发送行继续遵循
  已有平台边界，LAN 不启用 Roost 历史写入。

## 验证

使用官方 Node，最终 `pnpm check`、`pnpm format:check` 和 `pnpm run docs check`
全部通过。CLI：4,902 通过、1 跳过；components：5,972 通过；shared：1,750 通过；
UI：299 通过。类型检查构建适配器前先应用 fork 补丁。结果随合并汇报；静态检查
和测试不代表已部署 LAN 或 Electron 端到端验证。独立只读审查通过与两个父提交的
差异检查是否丢失 fork 行为。

基准执行测试用固定的 2026-10-12 时钟创建数据库，却用真实时钟重新打开。保留期
经过后，打开时的清理删除了被断言的批次。临时恢复完整基准源码后复现了同一失败；
两次打开现共用 fixture 时钟，生产环境的保留期和重放行为不变。
