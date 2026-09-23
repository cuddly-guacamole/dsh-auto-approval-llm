# 09 · 安全纵深九层
> *Defense in depth*

::: tip 安全纵深 · 九层循环
**L1 预设门（权限来源）**：只有处于本插件档的权威会话（递归上溯 subagent 父链）才进管线。判据是 durable raw identity（`permissionPresets.permissionState().preset`，不读会被 approval override 折叠掉的 `current()`）：承诺两条宿主线 —— `0.1.7-alpha.2` 完整支持、`0.1.5-rc.2` 只登记安装兼容（插件在该线能装能加载，但**不接管 `auto` 档**：`gatePresetNames()` 仍只含 `auto-approval`、`isGatedSession("auto")` 为 false、同签名迁移 `skipped` 且零 audit 写入），只认 `auto-approval`（旧机器值 `auto` 别名已随下限抬升移除；shipped patch 只定义 `auto-approval`）。`session/created` prepend、启动 live 扫描与 `agent/created` 对存量同签名 `auto + danger-full-access + ask` 做懒迁移（只重写 raw identity，不写旋钮、不调 `set()`）；自有档的 effective-never（`approval: never`，或 `approval: null` 且 base policy `never`）由插件写回 `ask`（`preset-spec-restore` 审计），**该 spec-restore 路径不碰上游 `auto`**。同签名 `auto` 迁移对持有者一视同仁：modern host 上上游 auto-review 持有的同签名 `auto` 也会被改写（旋钮不变，应答主体从上游换成本插件）。上游 `@deepseek-ai/dsh-experimental-auto-review` 只接管 `auto` 档（按 derived preset 判档），与本插件的 `auto-approval` 档互不接管，可同时启用。

**L2 同步硬拒闸门**：`ctx.tools.guard()`：凭据物质、受保护/关键/设备命名空间路径、shell 提权熔断 —— 命中即拒且不弹窗（比弹窗还要快、还要狠）。

**L3 symlink 逃逸守卫**：文本在工作区内 ≠ 真实在工作区内。realpath 最深祖先解析，快捷方式指出去就硬拒。

**L4 用户策略优先**：声明规则（rulesText）→ denyList/allowlist/humanOnlyList —— 管理员显式终裁在熔断/LLM 之前，且**不经过**熔断（有意隔离）。

**L5 reasoning-blind 评审**：评审只见工具身份 + 脱敏参数 + ≤4 条直接用户消息 + 工作区事实；`req.reason`、工具输出、assistant 散文一律不进评审上下文（防提示注入/防被模型自述牵着走）。

**L6 fail-closed 结论**：解析任何偏差都 throw → 拒绝/转人；ESCALATE 一律转人（不被 timeoutAction=allow 吞掉）；ALLOW+CRITICAL 矛盾也转人；评审失败不计熔断但也不放行。

**L7 诚实来源**：决议注明谁定的（timeout/llm/auto/human/abort）；advisory ≠ 接管；cancelled 永不假装人决定过。

**L8 传输与密钥**：`isTrustedFetchRequest`：载波层已先行做主机／Origin／会话校验，插件再按 Host 权威（缺失时退回请求 URL）判定——回环权威准入，非 HTTP scheme 视作载波回环，白名单 Host 才准入；`sec-fetch-site:cross-site` 拒、Origin 须同源。在线评审密钥存 DSH 凭据库、按次解析、前端只显「已配置」；明文 http 仅限回环。

**L9 可审计**：history + append-only audit（清空留墓碑）；审计存普通文件，**主模型无法把审计读回来当注入通道**；调试时序 `approval-debug.jsonl` 可区分「LLM 太慢」与「误标超时」。
:::

## 可达性前提：本插件静态面只在宿主 `tools/pre-execute` 瀑布未被对端短路时生效

L2（guard）与 L4 的 pre-execute 静态面（声明规则 / denyList / 类别收紧）都不是宿主主动调用的函数，而是注册在宿主 `tools/pre-execute` 瀑布上的监听器；宿主在 allow 决策处逐个征询。**宿主假设（换代复查；按 `dsh-tools@0.1.6-alpha.1` 逐行核对）**：waterfall 兜底 `{kind:'allow'}`（`lib/index.js:3220`）；`gate.kind==='ask'` → serviceAsk，否则 `decision = gate`（`:3221`）；`const denialReason = decision.kind === "allow" ? this.guardReason(exec) : decision.reason`（`:3236`）——**guard 只在 `kind==='allow'` 时求值**；`denialReason !== undefined` → 结构化 `isError`（`:3238-3252`）；否则 `next({kind:'dispatch', exec})`（`:3258-3259`）。

对端监听器（任何注册在同一瀑布的其他插件）有三种返回形态：

1. **返回 `undefined`**（不接 `next`）→ 宿主读 `gate.kind` 抛 TypeError → 宿主 catch → **fail-closed（不执行）**；
2. **返回非决策对象且无 `reason`**（如 `{}`）→ `denialReason === undefined` → **直落 dispatch：本插件 pre-execute 与 guard 两层全灭，工具被执行**（fail-open）；
3. **返回 `{kind:'allow'}` 或调用 `next()`** → guard 正常求值，本插件静态面生效。

形态 2 的前提是另一插件注册在同一瀑布且先行短路。**插件侧无法启动期自检**（如实写明）：cordis `4.0.2` 无监听器枚举 API（ctx mixin 只有 `on/once/parallel/emit/serial/bail/waterfall`；监听器只存 `EventsService._hooks`，公开的 `internal/listener` 只给注册观测，无法回答「是否调用 next」——callback 是 `reflect.bind` 的 Proxy、`once()` 用 `function(...args)` 包装，arity 既假阳又假阴）；唯一真探法（合成 exec 派发）会**真实执行对端监听器**（如 `dsh-hooks-claude-code` 的 PreToolUse 用户钩子、`dsh-hooks-codex`、`dsh-tool-jobs`）并在 `dsh-tools/lib/invariant.js` 留下悬空阶段项。⇒ 判定「瀑布是否被对端短路」需要宿主提供枚举/报告接口（登记 backlog）。