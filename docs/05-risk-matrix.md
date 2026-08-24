# 05 · 风险分档与倒计时矩阵

> *Risk tiers × timeout actions*

## 5.1　静态风险分档 `classifyStaticRisk` <span class="lnum">index.ts:L1631-1659</span>

| 档位 | 判定 | 含义 |
|---|---|---|
| LOW | `assessTool(...).decision === 'allow'` | 静态评估认为安全（工作区内读/写、只读查询、常规命令） |
| HIGH | reason 命中 `RISK_REASON_PATTERN` 或 工具名命中 `RISK_NAME_PATTERN` | destructive / external write / credential / security-boundary… |
| DENY | `assessTool(...).decision === 'deny'`（`riskFromAssessment`，<span class="lnum">decision.ts:L436-440</span>） | 静态引擎判死（凭据/受保护/插件运行态目标），走策略层终端拒绝 |
| MEDIUM | 其余一律 | 「需要语义判断」的模糊区（含评估为 ask 的全部） |

返回形状除 `risk` 外可携带 `reason? / assessment? / category? / directive? / mode?`——类别标签与指令随风险一次算出，供决策序的类别层与审计字段复用。

<span class="badgeok">单一事实源</span> 风险正则集中在 `risk-tokens.ts`（NAME 匹配 delete/destroy/remove/…/credential/secret/auth 等约 30 个动词；REASON 匹配 external write/security-boundary/destructive/protected path/credential/private-key/stateful terminal）。

## 5.2　倒计时秒数 `riskSeconds` —— 默认 5 / 8 / 10

| 档位 | 默认秒数 | 来源 |
|---|---|---|
| LOW | 5 s | `THRESHOLD_DEFAULTS.lowRiskSeconds（constants.ts:L7）` |
| MEDIUM | 8 s | `…mediumRiskSeconds（L8）` |
| HIGH | 10 s | `…highRiskSeconds（L9）` |

::: tip 单一事实源
倒计时（5/8/10）、熔断（3/20）、截断（4000）等数值默认值**唯一**集中在 `src/auto/constants.ts` 的 `THRESHOLD_DEFAULTS`；host schema、host 回退、客户端草稿/重置均引用同一常量。查默认值以代码（constants.ts）为准，README 仅为速查（已同步 5/8/10）。
:::

## 5.3　超时动作矩阵 `riskTimedOutAction` <span class="lnum">index.ts:L286-291</span>

「没人回答，倒计时走完」之后做什么，由 **timeoutAction × 风险档 × 是否 unattended** 三方决定：

| 配置 \ 风险 | LOW | MEDIUM | HIGH | 说明 |
|---|---|---|---|---|
| `reject（默认）` | <span class="rk-high">拒绝</span> | <span class="rk-high">拒绝</span> | <span class="rk-high">拒绝</span> | 拿不准就「不做」—— fail-closed 基线 |
| `low-risk-allow` | <span class="rk-low">放行</span> | <span class="rk-high">拒绝</span> | <span class="rk-high">拒绝</span> | 只放行低风险，中高危仍拒 |
| `allow` | <span class="rk-low">放行</span> | <span class="rk-low">放行</span> | <span class="rk-low">放行</span> | 用户显式「全放」—— 强烈不建议 |
| `unattended 模式` | <span class="rk-low">放行</span> | <span class="rk-low">放行</span> | <span class="rk-high">转人/拒绝</span> | 无人值守：**HIGH 永不自动放行**，覆盖 timeoutAction |

## 5.4　LLM 参与范围（两个施力点）

| 配置 | 取值 | 含义 |
|---|---|---|
| `llmReviewScope`<br><span class="pr-gray badgeok">哪些档送 LLM 复审</span> | `low-or-above（默认）` | 全部档都送 |
|  | `medium-or-above` | 仅 MEDIUM + HIGH |
|  | `high` | 仅 HIGH |
| `llmTakeoverScope`<br><span class="pr-purple badgeok">哪些档允许 LLM 结论直接接管</span> | `medium-or-below（默认）` | LOW + MEDIUM 可被 LLM 结论直接结案 |
|  | `low` | 仅 LOW |
|  | `high-or-below` | 与 `medium-or-below` 等价：HIGH 永远只建议、不接管（高危由人/超时兜底）。该取值保留仅为兼容旧配置，不建议新用 |

::: tip 默认姿态
全部档都送审（`low-or-above`），但只有 LOW/MEDIUM 允许 LLM 直接拍板（`medium-or-below`）—— 高危永远是人的事。`high-or-below` 并不放开 HIGH 接管：HIGH 分支只有建议、没有人/超时以外的决议方。
:::