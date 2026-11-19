# LAN 渲染桥只授予产品界面访问权

Status: implemented
Translation: current

[English](2026-11-19-lan-renderer-bridge-authority.md)

## 摘要

允许脚本的本地 HTML 和 loopback 预览能够请求 `lody-hub:`，主进程随之附上 LAN 成员凭据。工作区 id 只能标识 hub，不能证明请求权限。桥现在要求一个每次进程启动生成、仅通过可信产品窗口 IPC 发放的随机能力密钥，验证后才转发。产品 Streams 和校时继续工作，预览脚本不能借用成员身份。

## 决策

主进程只生成一次渲染桥密钥。`LanIpc.getBridgeToken` 继承产品窗口主 frame 准入检查。follower 仅在内存中保留它，沿既有传输 token 字段发送；LAN 校时使用同一密钥。IPC 暂不可用时不发布未经认证的传输，下一次 refresh 重新读取；成功密钥只属于当前主进程和渲染进程实例。

处理器在解析 LAN 成员身份或读取请求正文前，按常数时间比较完整 bearer，然后才换成独立的成员凭据。响应只允许固定的产品来源：打包 file 页面使用 `null`，开发模式使用配置的来源。预检不请求上游，也不授予 bearer 权限。

不采用仅加预览 CSP 的修法，因为 Managed Preview 服务器也能触发同一问题。hub id 和声称的 Origin 都不是凭据。本次修复落实产品界面与不可信预览原有的隔离，不增加 LAN 线协议或凭据迁移。

## 证据与限制

`lan-hub-forward.test.mjs` 用真实 loopback 假 hub 验证预览读写被拒、产品请求通过；`ipc-channel-list.test.mjs` 经实际 LAN service 的 decorator 验证产品窗口、外来窗口和子 frame 的准入。renderer follower/clock 套件覆盖密钥交接、读取失败后的恢复，以及不把密钥写进工作区状态。headless Electron 复现使用产品 CSP、实际 HTML 处理器和 iframe sandbox：修复前两种预览来源都能访问假 hub，修复后均为 403，产品经真实 IPC 取密钥后得到 200。这不代表完整桌面或全部预览内容的安全审查。
