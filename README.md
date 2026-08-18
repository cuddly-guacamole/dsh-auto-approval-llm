# dsh-auto-approval-llm

> 为 DeepSeek Harness 的 **Auto 权限档**提供 LLM 辅助自动审批 + 超时自动兜底。

> English: [README.en.md](README.en.md)

`Auto 档` = `sandbox: danger-full-access` + `approval: ask`。本插件在 Auto 会话里充当 `approval/request` 的**唯一终结裁决者**：常规操作放行、危险/模糊操作交给「静态规则 → LLM 分类 → LLM/人工裁决 → 倒计时兜底 → 熔断」的自动管线，把「自动但安全」的吞吐做高，同时保证有人工与审计兜底。

---

## 特性

- **静态规则 + LLM 分类器**：只读/会话/工作区常规操作直接放行；危险、外部写、凭据外泄、受保护路径直接拒绝；模糊操作交给 LLM 预分类（`tools/guard` + `tools/pre-execute`）。
- **在线评审模型（可选）**：填写 API 协议、地址、模型、密钥后，审批复审直接打到你的 OpenAI / Anthropic 兼容端点；密钥存在 DSH 凭据存储里，前端只显示「已配置」，永不回显。
- **人工倒计时 + 超时兜底**：低/中/高三档倒计时（默认 3/5/10 秒）；超时按 `timeoutAction` 处理（`拒绝` / `通过` / `低风险自动同意`）。关浏览器也不悬挂（host 计时器独裁）。
- **LLM 接管**：中风险且 LLM 在倒计时内给出明确结论时，客户端立即按 LLM 结论裁决，无需你点。
- **熔断**：连续 `maxConsecutiveDenials` 次或累计 `maxTotalDenials` 次被 LLM 拒绝 → 转人工、不再自动倒计时；`/approval reset` 可重置。
- **可靠的历史与审计**：内存 200 条 + `history.jsonl`，append-only `audit.jsonl`（清空留 tombstone）。
- **每会话评审模式**：`/approval-mode manual|smart|unattended` 持久化；`manual` 全转人、`unattended` 自动应答（高风险仍转人）。
- **声明式规则**：`rulesText` 用 Claude 风格 `工具(正则) | allow|deny|human [| 字段]` 一眼看懂、实时校验。
- **DSH 原生观感的设置卡**：4 张可折叠子卡（计时器与熔断 / 在线评审模型 / 安全规则列表 / 最近审批记录），顶层开关即时保存、每卡独立 保存/放弃/恢复默认；非法配置值有红色横幅 +「尝试修复」。

---

## 工作方式

```
工具调用
  → tools.guard        静态硬拒闸门（命中即拒，不弹窗）
  → tools/pre-execute  静态评估：allow 放行 / deny 拒绝 / ask 交给 LLM 分类器
  → approval/request   唯一终结裁决：
       声明规则 rulesText → denyList/allowlist → humanOnlyList → 评审模式 →
       熔断检查 → 风险分档（LOW/MEDIUM/HIGH）→ LLM 复审 + 人工倒计时
  → tools/post-execute 把「超时/规则/模型拒绝」标记喂回模型
```

- **LOW**：不送评审则静默放行；送评审时按 LLM 结论（ALLOW/DENY）直接裁决；LLM 无法决定（ESCALATE）转人工。
- **MEDIUM**：弹面板 + 倒计时，同时并行跑 LLM；`llmTakeoverScope` 覆盖且 LLM 给出明确结论 → 立即跟随；否则只显示建议。
- **HIGH**：弹面板 + 倒计时，LLM 只给建议不接管；超时严格按 `timeoutAction`。
- 所有「需要人」的场景都委托官方面板显示倒计时；**超时标记唯一作者是 host 计时器**，客户端只上报 outcome，伪造不了。

---

## 安装

当前以本地注入 / 开发装配为主（尚未发布 npm）：

```bash
# 本地开发构建
DSH_CHECKOUT=<dsh 源码 checkout> bash scripts/build.sh   # 编译 host → lib/
npx tsdown                                               # 构建 client bundle → lib/client.js

# 注入器环境（dsh-super-injector）
dev_inject_plugin <本目录>
```

发布（待做）：

```bash
dsh plugin --profile web add dsh-auto-approval-llm
```

> 提示：本插件依赖 DSH 的 `auto` 权限预设（`danger-full-access` + `approval: ask`），并作为 `approval/request` 的唯一终结者——**不要与其他审批类插件（如 dsh-approval-llm / dsh-auto-review）同时启用**。

---

## 快速开始

1. 确保会话/预设处于 **Auto 档**（`auto` 预设）。
2. 到 设置 → 插件 → 自动审批，按需配置；默认即可工作（空配置 = 静态规则 + 会话模型评审 + 拒绝式超时兜底）。
3. 想让审批走你自己的模型：在「在线评审模型」卡填 协议 / API 地址 / 模型名称 / API 密钥 → 保存 → 测试连接。
4. 嫌中风险弹窗频繁或超时漏拦：调大「中风险倒计时」，或把「超时动作」改为 `拒绝` / `低风险自动同意`。

---

## 界面预览

在 Auto 权限预设下使用（`设置 → 通用设置 → 权限 → Auto`；Read Only / Workspace Write / Auto / Full access）：

![Auto 权限预设](assets/permission-auto-preset.png)

设置卡总览——顶层开关即时保存，右侧为可折叠子卡：

![设置卡总览](assets/settings-overview.png)

计时器与熔断——三档倒计时、熔断防劫持与双熔断阈值：

![计时器与熔断](assets/settings-timers-breaker.png)

在线评审模型——API 协议 / 地址 / 模型 / 密钥（密钥前端不可见）：

![在线评审模型](assets/settings-online-reviewer.png)

安全规则列表——安全 Prompt / 白黑名单 / 声明规则 / 规则干跑：

![安全规则列表](assets/settings-safety-rules.png)

审批面板——倒计时贴在超时自动执行的动作上（此处 `超时动作=低风险自动同意` → 中风险超时自动**拒绝**，「拒绝」按钮带倒计时、「允许一次」保持干净）：

![审批面板 · 拒绝倒计时](assets/approval-panel-countdown-reject.png)

会话审批统计——会话标题栏「自动审批」按钮弹层：总计/通过/拒绝/超时/熔断 + 最近记录：

![会话审批统计](assets/session-stats.png)

---

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 总开关 |
| `autoSwitchPolicyToAsk` | false | 仅 Auto 预设且 override=never 时自动切 ask |
| `timeoutAction` | `reject` | 倒计时超时动作：`reject` 拒绝 / `allow` 全部通过 / `low-risk-allow` 仅低风险放行 |
| `llmReviewScope` | `medium-or-above` | LOW/MEDIUM/HIGH 哪些档送 LLM 复审 |
| `llmTakeoverScope` | `medium-or-below` | 哪些档允许 LLM 结论直接接管 |
| `defaultReviewMode` | `smart` | 每会话评审模式默认：人工 / 智能 / 无人值守 |
| `lowRiskSeconds` / `mediumRiskSeconds` / `highRiskSeconds` | 3 / 5 / 10 | 三档倒计时（秒） |
| `breakerAntiHijackMs` | 0 | 熔断弹窗按钮防误点禁用时长，0 不启用 |
| `maxConsecutiveDenials` | 3 | 连续 LLM 拒绝熔断阈值，0 关闭 |
| `maxTotalDenials` | 20 | 累计拒绝熔断阈值，0 关闭 |
| `reviewerProtocol` | `openai` | 在线评审协议：`openai`(chat/completions) / `anthropic`(messages) |
| `reviewerBaseUrl` | '' | 在线评审 API 地址；非空才走在线评审，空则跟随会话模型 |
| `reviewerModel`（＋旧 `reviewerProvider`） | '' | 在线评审模型名（旧 Provider 路由保留兼容，不再 UI 暴露） |
| `safetyPrompt` | '' | 附加给评审模型的额外策略（保存即热生效） |
| `allowlist` / `denyList` / `humanOnlyList` | [] | 工具名精确匹配 |
| `rulesText` | '' | 声明式规则（优先于内置列表执行） |
| `rulesDryRun` | false | 规则干跑：只记命中不执法 |
| `maxArgsChars` | 4000 | 取回工具参数的最大长度 |
| `notifyUser` | true | 「模型通过」通知进会话 |
| `showSessionPanel` | `off` | 会话标题栏按钮：关 / 仅Auto / 开 |
| `aiButtonPosition` | `header` | 按钮位置：标题栏 / 悬浮 |
| `workspaceRoot` / `dshHome` / `tempRoots` | ''/''/[] | 路径根（DSH_HOME 默认保护） |
| `classifierTimeoutMs` / `classifierMaxOutputTokens` | 8000 / 1024 | 分类器超时与输出上限 |
| `debug` | false | 调试模式：写 `approval-debug.jsonl` 与 `[debug]` 日志 |

> 顶层开关（启用/切换策略/超时动作/评审·接管范围/默认模式/按钮显示与位置）改动即保存；每张子卡有独立的 保存/放弃修改 按钮（安全规则列表另有 恢复默认）。host-only 键（workspaceRoot 等）用 patch/YAML 配置，设置卡保存不会抹掉它们。

---

## 评审模式与命令

- `/approval-mode`　查看当前会话评审模式
- `/approval-mode manual|smart|unattended`　设置（持久化）
- `/approval reset`　重置熔断计数与在途审批状态

---

## 数据文件（均在插件根目录）

| 文件 | 语义 |
|---|---|
| `history.jsonl` | 审批历史（内存窗口 200 条 + 落盘；>1MB 轮转）。删除文件不触发重载、不清内存窗口，下一条裁决会自动重建 |
| `audit.jsonl` | append-only 审计（清空留 `clear` tombstone） |
| `review-mode.json` | 每会话评审模式快照 |
| `approval-debug.jsonl` | 仅调试模式开启时写入：评审/审批时序（decision/risk/tookMs/outcome/source），>1MB 轮转 |

数据查询：`node scripts/audit-query.mjs [--last N|--tool X|--session S|--source S|--since ISO|--json]`

---

## 安全设计要点

- **唯一终结者**：同一 approval 只有一个裁决者（prepend + global），避免双弹窗/双写/审计断裂。
- **fail-closed**：评审器超时/垃圾/失败 → 拒绝或转人；ESCALATE 一律转人，不被 `timeoutAction=allow` 自动放行；reviewer 失败不计入熔断。
- **reasoning-blind**：评审只看 工具名 + 结构化脱敏参数 + 有界直接用户消息（唯一授权证据）+ 工作区事实，剥离评审者的自述与工具输出。
- **密钥不出 host**：在线评审密钥存 DSH 凭据，每操作解析、前端仅显「已配置」。
- **倒计时按钮规则**：倒计时只贴在「会超时自动执行」的那个按钮上——`timeoutAction=通过` → 超时自动通过，「允许一次」倒计时、拒绝按钮干净；`timeoutAction=拒绝` / `低风险自动同意` → 中/高风险超时自动拒绝，「拒绝」按钮倒计时（低风险自动同意时仅低风险超时通过）。中风险默认 5 秒偏紧，建议按需调大。

---

## 致谢

本项目在设计与实现中参考/移植了以下开源项目，谨此致谢它们的作者与社区：

- **[@nanmicoder/dsh-auto-mode](https://github.com/NanmiCoder/dsh-auto-mode)** —— Auto 档 + 静态规则 → LLM 分类器 → 人工 的核心审批管线：受保护路径、静态评估、shell 安全解析、LLM 预分类等策略移植自该项目，并在 `src/auto/` 中重写为独立实现（移除该项目也可正常工作）。
- **[@anionex/dsh-vision-toolkit](https://github.com/Anionex/dsh-vision-toolkit)** —— 设置界面范式：在线模型（API 协议 / 地址 / 模型 / 密钥，密钥存 DSH 凭据、前端不可见）、红色报错横幅与修复按钮、「复用 DSH 原生 CSS 与 UI primitives」的做法。

---

## 版本 / 发布

- 当前：`0.0.1`（未发布 npm）。
- 语义：BSD-3-Clause。
