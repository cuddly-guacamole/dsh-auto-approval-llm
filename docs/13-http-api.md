# 13 · HTTP API 面

> *Client ↔ Host 的唯一通道*

**没有 RPC**：客户端是静态 bundle（非动态 Cordis Package），无法用 `host.call`，全部走同源 fetch。统一 `responseJson`（no-store + nosniff），body 强制 application/json ≤64KB，写操作全部带 `expectedRevision` 乐观并发。全站共 **14 条 `/_dsh/auto-approval-llm/*` 路由**（host 常量 <span class="lnum">index.ts:LFEEDBACK_ROUTE</span>；client 引用 <span class="lnum">client/index.ts:LSETTINGS_ROUTE</span>、<span class="lnum">client/approvals/shared.ts:LFEEDBACK_ROUTE</span>），每条入口第一行都过 `isTrustedRequest` 闸门，不存在无设防的「普通」路由。

| 路由 | 方法 | 用途 | 信任平面 |
|---|---|---|---|
| `/feedback` | POST | 客户端上报 outcome（auto:true）+ approval 完成 ACK | <span class="badgeerr">特权 [ ] 仅回环</span> |
| `/settings` | GET/POST | 配置快照 {value,revision,writable,applies,configError} / 更新（preserveHostKeys） | <span class="badgeerr">特权 [ ] 仅回环</span> |
| `/reviewer-credential` | GET/POST/DELETE | 端点密钥 {configured,writable}，永不回显 value | <span class="badgeerr">特权 [ ] 仅回环</span> |
| `/test` | POST | 在线端点连通性探针（https 外网放行 + 公网地址强制 + fake-ip 豁免，8s 超时 max_tokens:1，非 2xx 带回错误摘要；空草稿密钥回退已存凭据）；模型库校验 modelFound | <span class="badgeerr">特权 [ ] 仅回环</span> |
| `/providers` | GET | provider 目录 {id,name}（模型来源 picker 下拉） | <span class="badgeerr">特权 [ ] 仅回环</span> |
| `/llm-models` | GET | `?provider=` 列某 provider 的模型 {provider,id,name} | <span class="badgeerr">特权 [ ] 仅回环</span> |
| `/reasoning-efforts` | GET | `?provider=&model=` 列该模型的 reasoning efforts + defaultEffort（无 resolveModel 支持返回空列表） | <span class="badgeerr">特权 [ ] 仅回环</span> |
| `/history` | GET/DELETE | 记录查询（逆序）/ 清空（仅清内存+history，审计留墓碑） | trustedHosts |
| `/llm-latency` | DELETE | 清空 LLM 延迟遥测窗口 + 文件（不动审批历史；与 history DELETE 互不清） | trustedHosts |
| `/tool-stats` | GET | 精确名单页签的候选工具统计（最近工具 chips） | trustedHosts |
| `/learning-store` | GET/DELETE | 已学习条目列表（键哈希+脱敏骨架+计数）/ 吊销单条（即时生效，落 `learning-revoked` 审计） | trustedHosts |
| `/review-status` | GET | 单审批 countdown/follow 状态；callId 走 `x-auto-approval-call-id` 头（防 URL/devtools 泄漏）。可选 `x-auto-approval-wait-ms` 进入**长轮询**：held 至该 ask 的 `revision` 变化或预算（上限 20s）用尽，客户端断开即释放。状态对象带单调 `revision`、`expiresAt`（宿主时钟）与 `remainingMs`（按宿主时钟算出的剩余），可选带 `category?`（类别层闭集标签，供该 ask 的终局审计记录署名） | trustedHosts |
| `/session-review-status` | GET | 会话级发现：列出该会话当前全部待审（`{callId, phase, action, seconds, remainingMs, revision, source?}[]`）；sessionId 走 `x-auto-approval-session-id` 头，缺失返 400。官方面板被 `panelDelayMs` 推迟期间，客户端靠它渲染芯片/胶囊 | trustedHosts |
| `/reveal-approval` | POST | 提前放行被推迟的官方面板（「现在查看」）；callId 走 `x-auto-approval-call-id` 头。未知或已结算的 ask 返 `{ok:true,value:{revealed:false}}`，不伪造面板 | trustedHosts |
| `/session-mode` | GET | 查会话权限 preset（mode）；本进程无该会话 live agent 时同样返 **200 + `mode: null`**（会话在历史里但 agent 尚未实例化属正常状态，不以错误状态表达——与 `/stats` 同口径，也避免浏览器对失败请求的不可抑制记录） | trustedHosts |
| `/stats` | GET | 会话统计 {mode, reviewMode, counts{total,allow,deny,timeout,breaker}, breaker{…tripped}}；sessionId 走 `x-auto-approval-session-id` 头 | trustedHosts |

::: tip 「特权平面」是什么意思
settings / reviewer-credential / feedback / test 与模型目录三路由（providers / llm-models / reasoning-efforts）传 `[]`（空白名单）→ 强制**仅回环同源**（Host 头须回环 + TCP 对端须真回环）。前四者是「能改状态或驱动 host 发请求」的配置域——LAN 用户即使进了白名单也**不能**改配置、读密钥或把 host 当 SSRF 探针；后三者与消费它们的设置卡同处回环平面，LAN 设备不可读取模型目录。其余 9 条查询路由走 `trustedHosts`（webRuntime 配置 → `--trusted-host` → 绑定 0.0.0.0 时枚举的 LAN IPv4）。早前文档列过的 `/models` 已退役（代码注释 <span class="lnum">index.ts:LLLM_MODELS_ROUTE</span>「Named llm-models (not /models) so the retired /models route…」→ 拆为 providers + llm-models）、`/history/export` 从未实现，均不在上表。
:::