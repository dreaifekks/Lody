# Product-only authority for the LAN renderer bridge

Status: implemented
Translation: current

[中文](2026-11-19-lan-renderer-bridge-authority.zh.md)

## Abstract

Local HTML with scripts and loopback previews could fetch `lody-hub:` while main attached a LAN member bearer. A workspace id identifies a hub, but establishes no request authority. The bridge now requires a random process-lifetime capability delivered only through trusted product-window IPC before it forwards any request. Product Streams and clock reads keep working; preview scripts cannot borrow membership.

## Decision

Main creates the renderer capability once. `LanIpc.getBridgeToken` inherits the product-window main-frame admission check. The follower keeps the returned token only in memory, and its existing transport token field carries it to every request. LAN clocks use that same token. An unavailable IPC read does not publish an unauthenticated transport, and the next refresh retries; successful capabilities live only as long as this main/renderer instance.

The handler checks the complete bearer in constant time before resolving a hub or reading its request body. It then substitutes the separate member credential. Responses use the fixed product origin, including `null` for packaged file origins and the configured development origin. Preflight sends no upstream request and grants no bearer authority.

A preview CSP alone was rejected because the same flaw affected Managed Preview servers. Hub ids and claimed Origin headers are not credentials. This repair enforces the existing separation between product UI and untrusted preview content; it adds no LAN wire format or credential migration.

## Evidence and limits

`lan-hub-forward.test.mjs` uses real loopback hubs to check denied reads/writes and accepted product requests. `ipc-channel-list.test.mjs` exercises the actual LAN service through decorator admission for trusted windows, foreign windows and subframes. Renderer follower/clock suites cover token delivery and recovery without copying the secret into workspace state. A headless Electron reproduction uses the product CSP, actual HTML-preview handler and iframe sandbox: both preview origins reached the fake hub before the repair and receive 403 afterwards; the product obtains its token through real IPC and receives 200. This is not a broader desktop or preview-content security audit.
