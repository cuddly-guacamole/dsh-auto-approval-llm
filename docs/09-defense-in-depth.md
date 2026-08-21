# 09 · 安全纵深九层
> *Defense in depth*

::: tip 安全纵深 · 九层循环
**L1 预设门（权限来源）**：只有 Auto 预设的权威会话（递归上溯 subagent 父链）才进管线；`autoSwitchPolicyToAsk` 可把 auto+override=never 的会话在 `agent/created` 时翻回 ask。bundle 里这块默认开启。

**L2 同步硬拒闸门**：`ctx.tools.guard()`：凭据物质、受保护/关键/设备命名空间路径、shell 提权熔断 —— 命中即拒且不弹窗（比弹窗还要快、还要狠）。

**L3 symlink 逃逸守卫**：文本在工作区内 ≠ 真实在工作区内。realpath 最深祖先解析，快捷方式指出去就硬拒。

**L4 用户策略优先**：声明规则（rulesText）→ denyList/allowlist/humanOnlyList —— 管理员显式终裁在熔断/LLM 之前，且**不经过**熔断（有意隔离）。

**L5 reasoning-blind 评审**：评审只见工具身份 + 脱敏参数 + ≤4 条直接用户消息 + 工作区事实；`req.reason`、工具输出、assistant 散文一律不进评审上下文（防提示注入/防被模型自述牵着走）。

**L6 fail-closed 结论**：解析任何偏差都 throw → 拒绝/转人；ESCALATE 一律转人（不被 timeoutAction=allow 吞掉）；ALLOW+CRITICAL 矛盾也转人；评审失败不计熔断但也不放行。

**L7 诚实来源**：决议注明谁定的（timeout/llm/auto/human/abort）；advisory ≠ 接管；cancelled 永不假装人决定过。

**L8 传输与密钥**：`isTrustedRequest`：Host 头可伪造 → 回环 Host 强制真实对端也回环；白名单 Host 才准入；`sec-fetch-site:cross-site` 拒、Origin 须同源。在线评审密钥存 DSH 凭据库、按次解析、前端只显「已配置」；明文 http 仅限回环。

**L9 可审计**：history + append-only audit（清空留墓碑）；审计存普通文件，**主模型无法把审计读回来当注入通道**；调试时序 `approval-debug.jsonl` 可区分「LLM 太慢」与「误标超时」。
:::