# Streams 升级后的归档快照

Status: implemented
Translation: current

[English](2026-11-19-archived-streams-snapshot-upgrade.md)

## 摘要

LAN 会话归档后可能再也达不到自动上传阈值，因此需要显式上传快照。升级到 `loro-repo 0.25.1` 和 `streams-crdt 0.21.1` 后，fork 使用的快照管理器补丁入口消失，但仓库适配器补丁仍能应用。fork 在固定版本的传输层保留小范围的 `repair` 入口，由原有仓库适配器调用。显式归档仅绕过大小阈值，保留正常快照上传的安全检查，不改变线协议。

## 职责与决定

`StreamsTransportAdapter.uploadDocSnapshot` 和 `uploadFlockDocSnapshot` 负责找到已加入的房间。传输层快照管理器负责权限检查、串行执行、完整服务器游标、没有待上传本地写入、捕获版本检查，以及上传前房间仍然有效且未关闭的检查。归档修复还会拒绝正在上传或首次加入尚未完成的状态。

显式归档仅绕过字节阈值和外来写入者阈值。普通防抖上传保留上游行为。不采用运行时的 `uploadSnapshotForTesting`：它没有经过相同的快照管理器准入和捕获路径。

两个版本化补丁必须一起维护。单独重新生成仓库适配器补丁，无法发现私有传输方法已消失。归属行为测试是 [archived-session-streams.test.ts](../../../../apps/cli/src/lib/archived-session-streams.test.ts)：实际记录会话与文件索引快照，并在 hub 重启后检查保留的条目。合成流验证固定依赖组合，不证明未来私有传输 API 仍然兼容。

当前行为见 [hub 保留的数据](../../../docs/lan-host.md#what-the-hub-keeps)。
