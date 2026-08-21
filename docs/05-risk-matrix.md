# 05 · 风险分档与倒计时矩阵

> *Risk tiers × timeout actions*

## 5.1　静态风险分档 `classifyStaticRisk` <span class="lnum">index.ts:L1347-1369</span>

| 档位 | 判定 | 含义 |
|---|---|---|
| LOW | `assessTool(...).decision === 'allow'` | 静态评估认为安全（工作区内读/写、只读查询、常规命令） |
| HIGH | reason 命中 `RISK_REASON_PATTERN` 或 工具名命中 `RISK_NAME_PATTERN` | destructive / external write / credential / security-boundary… |
| MEDIUM | 其余一律 | 「需要语义判断」的模糊区（含评估为 ask 的全部） |

<span class="badgeok">单一事实源</span> 风险正则集中在 `risk-tokens.ts`（NAME 匹配 delete/destroy/remove/…/credential/secret/auth 等约 30 个动词；REASON 匹配 external write/security-boundary/destructive/protected path/credential/private-key/stateful terminal）。

## 5.2　倒计时秒数 `riskSeconds` —— 默认 5 / 8 / 10

| 档位 | 默认秒数 | 来源 |
|---|---|---|
| LOW | 5 s | `THRESHOLD_DEFAULTS.lowRiskSeconds（constants.ts:L7）` |
| MEDIUM | 8 s | `…mediumRiskSeconds（L8）` |
| HIGH | 10 s | `…highRiskSeconds（L9）` |

::: warning
⚠️ 注意：**README 写的是 3/5/10，已过时**。代码当前真值是 5/8/10（重构时把默认值集中进 constants.ts，README 未同步）。若你按 README 写配置会得到与预期不同的等待时长。
:::

## 5.3　超时动作矩阵 `riskTimedOutAction` <span class="lnum">index.ts:L154-159</span>

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
|  | `high-or-below` | 全部都可接管（含 HIGH，谨慎） |

::: tip 默认姿态
全部档都送审（`low-or-above`），但只有 LOW/MEDIUM 允许 LLM 直接拍板（`medium-or-below`）—— 高危永远是人的事。
:::