# 13 · HTTP API 面

> *Client ↔ Host 的唯一通道*

**没有 RPC**：客户端是静态 bundle（非动态 Cordis Package），无法用 `host.call`，全部走同源 fetch。统一 `responseJson`（no-store + nosniff），body 强制 application/json ≤64KB，写操作全部带 `expectedRevision` 乐观并发。

| 路由 | 方法 | 用途 | 信任平面 |
|---|---|---|---|
| `/feedback` | POST | 客户端上报 outcome（auto:true）+ approval 完成 ACK | trustedHosts |
| `/settings` | GET/POST | 配置快照 {value,revision,writable,applies,configError} / 更新（preserveHostKeys） | <span class="badgeerr">特权 [ ] 仅回环</span> |
| `/reviewer-credential` | GET/POST/DELETE | 密钥 {configured,writable}，永不回显 value | <span class="badgeerr">特权 [ ] 仅回环</span> |
| `/history` | GET/DELETE | 记录查询（逆序）/ 清空（仅清内存+history，审计留墓碑） | trustedHosts |
| `/history/export` | GET | attachment 下载 approval-history.json | trustedHosts |
| `/models` | GET | `?provider=` 列可用模型 {id,name} | trustedHosts |
| `/test` | POST | 在线端点连通性探针（https 外网放行 + 公网地址强制 + fake-ip 豁免，8s 超时 max_tokens:1，非 2xx 带回错误摘要；空草稿密钥回退已存凭据）；模型库校验 modelFound | <span class="badgeerr">特权 [ ] 仅回环</span> |
| `/session-mode` | GET | 查会话权限 preset（mode） | trustedHosts |
| `/review-status` | GET | 单审批 countdown/follow 状态；callId 走 `x-auto-approval-call-id` 头（防 URL/devtools 泄漏） | trustedHosts |
| `/stats` | GET | 会话统计 {mode, reviewMode, counts{total,allow,deny,timeout,breaker}, breaker{…tripped}} | trustedHosts |

::: tip 「特权平面」是什么意思
settings / reviewer-credential / test 三个配置域传 `[]`（空白名单）→ 强制**仅回环同源**（Host 头须回环 + TCP 对端须真回环）。LAN 用户即使进了白名单也**不能**改配置或读密钥状态。其余查询路由走 `trustedHosts`（webRuntime 配置 → `--trusted-host` → 绑定 0.0.0.0 时枚举的 LAN IPv4）。
:::