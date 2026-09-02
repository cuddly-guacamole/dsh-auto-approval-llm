# 07 · 人机竞速与超时仲裁

> *Who decides what*

枪声一响，三方赛跑：**人**（点官方面板按钮）、**宿主倒计时**（唯一权威作者）、**LLM 结论**（scope 内可抢占）。`raceHumanDecision`（<span class="lnum">decision.ts:L100-141</span>）是仲裁器：

<ol class="seq">
  <li><span class="who">启动 <code>raceHumanDecision(() =&gt; next(), {seconds, action}, handle)</code></span><div class="cap">把「求人」委托给官方 ApprovalPanel（<code>next()</code>），同时宿主开一个 <code>setTimeout(seconds*1000)</code>。</div></li>
  <li><span class="who">超时先到</span><div class="cap">宿主 tap 时钟：记录规范文案 <code>[dsh-auto-approval-llm] no response: auto-approved / auto-rejected (Ns)</code>（文案<b>永远宿主生成</b>），按 timeoutAction 结案 <code>allowed-once | rejected</code>，<code>timedOut=true</code>。关闭的标签页/headless 永远挂不死审批。</div></li>
  <li><span class="who">人先答</span><div class="cap">面板 outcome 结案，<code>timedOut=false</code>。</div></li>
  <li><span class="who">LLM 抢先（仅 MEDIUM+scope 内）</span><div class="cap"><code>handle.claim('allowed-once'|'rejected')</code>：清定时器、<code>claimed=true</code>、立即结案 —— 这就是「LLM 接管」的唯一可信信号。</div></li>
</ol>

## 7.1　诚实来源标注 `approvalSource` <span class="lnum">decision.ts:L158-175</span> —— 谁决定，就标谁

| 条件 | source 标签 |
|---|---|
| 宿主倒计时到期 | `timeout-allow / timeout-deny` |
| LLM 接管（claim） | `llm-allow / llm-deny` |
| 客户端自动应答（resolvedCallIds 防重） | `auto-allow / auto-deny` |
| 真实人工点击 | `human-allow / human-deny` |
| 请求被取消/会话销毁 | `abort → 永远 action=reject（不假装有人决定过）` |
| 声明规则（G1）/静态名单（G2） | `rule-deny / rule-allow`、`denyList-deny / allowlist-allow` |
| 策略层无条件硬拒（运行态文件等） | `policy-deny → 立即 rejected，无倒计时、不计熔断、不发布 review-status` |
| **pre-execute 快路径静态硬拒**（`assessTool` → deny，`[auto-mode hard deny]`） | `hard-deny`（携带 `reason`）——不经 approval/request，无倒计时、不计熔断 |
| **LLM 预分类器自主放行**（fast path） | `classifier-allow → allowed-once`（携带 `llmDecision` / `llmRisk` / `llmReason`） |
| **LLM 预分类器自主拒绝**（fast path） | `classifier-deny → rejected`（同上）——`ask` 不在此列，交给 answerer 记终局 |

> 末三行来自 **tools 层快路径**（`tools.guard` / `tools/pre-execute`，不经 `approval/request`），故没有 `approvalSource`，落的是 history / audit 的 `source` 字段（PR #4，2026-09-02）。

::: danger 防张冠李戴
仅仅存在一份 advisory 评审结论（表明 LLM 看过）**绝不允许**把这次决议标成 `llm-*`。只有 `claimed`（宿主侧竞速被抢占）才算 LLM 接管。同理，advisory 拒绝 **不会**计入熔断 —— 熔断只认「LLM 真正拍板的拒绝」。
:::

## 7.2　反重标的四重防线（防止客户端/迟到 ACK 篡改决议性质）

| 机制 | 作用 |
|---|---|
| `resolvedCallIds（TTL 30s）` | 宿主已结案的 callId；迟到的 FEEDBACK ACK 无法再把它 relabel 成「no response: auto-*」 |
| `FEEDBACK 双重门` | 只有当 `!decisionFeedback.has && !resolvedCallIds.has` 才写 timeoutFeedback；客户端只能传 outcome∈{allowed-once,rejected}，其余强制 rejected |
| `outcome 白名单` | 超时标记唯一作者是宿主计时器，客户端只上报 outcome |
| `answer-once Set` | 客户端 `answeredApprovals` 保证同一审批只答一次、不双写 |

## 7.3　follow 阶段与 TTL 家族

**ReviewStatus 状态机**：`countdown`（倒计时中）→ `follow`（已结案，等客户端收敛面板）。follow 保留 `FOLLOW_STATE_TTL_MS = 120_000`（覆盖 Chrome 后台标签节流 ≥1min），客户端 `followSweep` 每秒清扫。

| 定时器 | 值 |
|---|---|
| `FOLLOW_STATE_TTL_MS` | 120 s |
| `RESOLVED_TTL_MS` | 30 s |
| `AUTO_ANSWERED_TTL_MS` | 60 s |
| `feedback 表 TTL / 上限` | 60 s / 256 条 |
| `followSweep 周期` | 1 s |
| `客户端 poll 频率` | 500 ms |