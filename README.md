# @quill507/dsh-auto-approval-llm

> 为 DeepSeek Harness 的 **Auto 权限档**提供 LLM 辅助自动审批 + 超时自动兜底。

> English: [README.en.md](README.en.md)

`Auto 档` = `sandbox: danger-full-access` + `approval: ask`。本插件在 Auto 会话里充当 `approval/request` 的**唯一终结裁决者**：常规操作放行、危险/模糊操作交给「静态规则 → LLM 分类 → LLM/人工裁决 → 倒计时兜底 → 熔断」的自动管线，把「自动但安全」的吞吐做高，同时保证有人工与审计兜底。

---

📖 **工作原理详解文档站**：<https://cuddly-guacamole.github.io/dsh-auto-approval-llm/>

---

## 特性

- **静态规则 + LLM 分类器**：只读/会话/工作区常规操作直接放行；危险、外部写、凭据外泄、受保护路径直接拒绝；模糊操作交给 LLM 预分类（`tools/guard` + `tools/pre-execute`）。
- **写向量完整性加固**：含真实文件写重定向（`>`/`>>`/`>|`/`&>``）的命令段脱离只读快径；build/test 与版本探测快径仅保留给 discard sink 或工作区内常规写目标（aggressive/trustedDirs 放宽模式同样生效）；POSIX 五头 `tee`/`dd of=`/`sed -i`/`truncate`/`install` 以操作数目标参与按目标闸门——直写插件运行态文件无条件硬拒。
- **11 分类三态开关 + 信任目录双模式**：工具与 shell 命令归入 11 个类别（fileEdit / gitLocal / build / readOnly / delete / protected / privilege / networkExec / gitPush / publish / disk），设置卡逐类配 `auto` / `ask` / `deny`；**默认全部 `inherit` = 行为零变化**。危险类（delete / protected / disk 及未解锁的 privilege）LOCKED 仅接受 `ask`，误配 `auto`/`deny` 会被钳制丢弃并告警；**`privilegeAutoReview`（默认关）可解锁 privilege**——开启后特权命令（含可见内联代码如 `node -e '…'`）走分类器 + LLM 评审 + 倒计时管线；**LOCKED 转人带硬拒倒计时**——超时自动拒绝，`timeoutAction` 任何配置都无法放行（无人值守不再挂起）；`trustedDirs` 在 standard 档把常规位置扩展到显式信任目录，`categoryMode: aggressive` 则取消位置白名单——任意位置均视为常规位置（敏感名 fuse、运行态硬拒、symlink 复检等危险度门全部不动）；复合命令按「类别枚举序 + directive 取严」双轨合并；类别拒绝与 denyList 同构为终端拒绝（提权重试不可绕过）；每次类别决策全量写入 history / audit（`category-allow` / `category-deny` source）。
- **在线评审模型（可选）**：填写 API 协议、地址、模型、密钥后，审批复审直接打到你的 OpenAI / Anthropic 兼容端点；密钥存在 DSH 凭据存储里，前端只显示「已配置」，永不回显。直连三件（地址 / 模型 / 密钥）配置完整才走在线评审——保存与「测试连接」有前端预检拦下缺项，存量半配置在运行时按未配置处理、评审跟随会话模型（fail-closed 不变）。
- **人工倒计时 + 超时兜底**：低/中/高三档倒计时（默认 5/8/10 秒）；超时按 `timeoutAction` 处理（`拒绝` / `通过` / `低风险自动同意`）。关浏览器也不悬挂（host 计时器独裁）。
- **LLM 接管**：中风险且 LLM 在倒计时内给出明确结论时，客户端立即按 LLM 结论裁决，无需你点。
- **熔断**：连续 `maxConsecutiveDenials` 次或累计 `maxTotalDenials` 次被 LLM 拒绝 → 转人工、不再自动倒计时；`/approval reset` 可重置。
- **可靠的历史与审计**：内存 200 条 + `history.jsonl`，append-only `audit.jsonl`（清空留 tombstone）。
- **LLM 响应时间统计**：「最近审批记录」子卡顶部显示最近 100 次 LLM 评审的真实响应耗时（MIN/AVG/MAX，秒），并单列「超时/无响应」次数——超时与中断不混入平均值，`llm-latency.jsonl` 持久化（1MB 轮转）。
- **LLM 复审自动重试**：审查请求遇瞬时网关故障（限流 429 / 服务端 5xx / 传输中断 / 空响应；LOW 同步路径含审查超时）自动重试一次；重试只在审批窗口剩余内滚动——首次尝试保持原超时语义、绝不侵占倒计时——并尊重服务端 `Retry-After`；认证/配置类错误（401/403、NO_ADAPTER 等）绝不重发请求体与凭据；重试耗尽仍 fail-closed（转人 / 按 `timeoutAction` 兜底）。每次尝试的失败轨迹写入 `history.jsonl` / `audit.jsonl`（`attempts` 字段）与延迟统计。
- **每会话评审模式**：`/approval-mode manual|smart|unattended` 持久化；`manual` 全转人、`unattended` 自动应答；**高风险超时仍转人工/失败关闭**。
- **声明式规则**：`rulesText` 用 Claude 风格 `工具(正则) | allow|deny|human [| 字段]` 一眼看懂、实时校验。支持维度限定：行首 `[agent:main]` / `[agent:!subagent]` / `[workspace:D:/proj]`（逗号组合=AND）——规则只在指定代理身份/工作区内求值。注意：规则仅作用于进入审批链的工具调用，工作区内常规写读等静态放行路径不经规则层（见下）；解析出错时**整段 rulesText 失效**（fail-open 方向，设置卡有警示）。
- **上下文增强复审（可选开启，默认关）**：`reviewerContextFacts` 开启后，LLM 复审输入附加结构化工作区事实——目标路径存在性/类型/大小（只读元数据，绝不读内容）＋本会话最近创建的文件相对路径（最多 8 条，经脱敏与工作区过滤）。边界：工作区外目标只报存在性与类型、大小恒为 null；工作区 symlink/联接逃逸到外部时整个事实块省略；临时目录（tempRoots）文件不进 recent_creates；探测失败→事实块整体省略（fail-closed），默认关闭时复审载荷与既往逐字节一致。
- **编辑操作 diff 预览（editDiffPreview）**：开启后，进入人工审批的编辑类工具（write/edit/str_replace_editor/apply_patch）在审批面板展示目标文件的行级红绿 diff（目标仅限工作区内非受保护路径，≤1MiB/≤200 行/约 32KiB，失败自动省略）。纯展示：不参与任何裁决，不进 LLM 复审输入；默认关闭。边界：可读的工作区内非受保护目标对比现有内容出 diff；全量写类操作（`write` / `str_replace_editor` `create`）目标不可读（工作区外/受保护/新文件等）时预览「仅新内容」的全量新增 diff——素材全部来自工具参数、零读取目标文件，外部/受保护旧内容绝不因此上屏；对比类（`edit` / `str_replace` / `insert` / `apply_patch`）目标不可读时整体省略。LCS 输入 ≤1024 行/侧，单行 >200 字符省略号，输出 ≤200 行且总字节 ≤32KiB，截断带 `…truncated` 标记；语义镜像官方工具（edit/str_replace 多匹配省略、insert 按官方 0 基 splice、create 已存在省略、apply_patch 全目标顺序应用且任一失败整体省略）；diff 块内倒计时字面量被剥离，无法伪造/劫持客户端自动应答。
- **确认制学习（可选开启，默认关）**：`learningEnabled` 开启后，同一操作（以确定性签名称呼：命令模板 / 工具参数形状，不含任何原始值）在 Auto 档被人工反复确认达到阈值（`learningThreshold` 默认 3，钳制 2–10）起自动放行；**每次学习放行前仍对本次调用执行一次标准在线评审**——非干净 ALLOW 或 CRITICAL 矛盾一律回退原有人工分支。边界：仅低/中风险可学；高风险、锁定四类（delete/protected/privilege/disk）、unknown 类别与敏感路径永不参与；含变量/glob/引号或危险头命令（tee/dd/sed/truncate/install）的命令既不学也不中；同签名被人工拒绝立即清零计数；每根会话学习放行上限 50 次（恰达上限的那一次落审计告警）；条目保留 30 天、至多 100 条、按工作区隔离；任何一环失效都视同未命中回人工；设置卡「已学习条目」区块可查看（仅展示键哈希与条目骨架，不泄签名/原始值）与吊销已学条目（即时生效并落审计）。
- **DSH 原生观感的设置卡**：6 张可折叠子卡（计时器与熔断 / 在线评审模型 / 安全规则列表 / 分类开关与信任模式 / 确认制学习 / 最近审批记录），顶部「评审与接管预设」单选（标准 / 稳健 / 严格 / 自定义）一键写回 LLM 参与门槛组合，三个名单合并为「精确名单」页签编辑器，倒计时三档与熔断双阈值各并为一行；顶层开关即时保存、每卡独立 保存/放弃；非法配置值有红色横幅 +「尝试修复」。
- **DSH 双协议兼容（0.0.12）**：客户端自动应答同时支持 DSH 0.1.1-rc.2（`snapshot.pending` + `wait.respond`）与 0.1.2-alpha.1（`uiSession.pendingInteractions` + `PendingApproval.answer`）两代审批投递协议，按运行环境能力自动选用（feature-detect）；0.0.15 起仅保留新协议。

---

## 工作方式

```
工具调用
  → tools.guard        静态硬拒闸门（命中即拒，不弹窗）
  → tools/pre-execute  静态评估 + 类别开关收紧：allow 放行 / deny 拒绝 / ask 转人工或 LLM 分类器
  → approval/request   唯一终结裁决：
       声明规则 rulesText → denyList → 类别拒绝(category-deny) → allowlist → humanOnlyList →
       类别询问(category-ask) → 评审模式 → 熔断检查 → 策略硬拒(policy-deny) →
       学习放行(learned-allow，命中仍须过一次标准在线评审) → 风险分档（LOW/MEDIUM/HIGH）→ LLM 复审 + 人工倒计时
  → tools/post-execute 把「超时/规则/模型拒绝」标记喂回模型
```

- **LOW**：不送评审则静默放行；送评审时按 LLM 结论（ALLOW/DENY）直接裁决；LLM 无法决定（ESCALATE）转人工。
- **MEDIUM**：弹面板 + 倒计时，同时并行跑 LLM；`llmTakeoverScope` 覆盖且 LLM 给出明确结论 → 立即跟随；否则只显示建议。
- **HIGH**：弹面板 + 倒计时，LLM 只给建议不接管；超时严格按 `timeoutAction`（unattended 下 HIGH 超时仍转人工/失败关闭）。
- **LLM 复审自动重试**：审查请求遇瞬时故障（429 / 5xx / 传输 / 空响应等）自动重试一次；重试受审批窗口剩余约束（不挤占倒计时）、尊重 `Retry-After`、认证/配置类错误不重发凭据；失败轨迹记入 `attempts` 审计。
- 所有「需要人」的场景都委托官方面板显示倒计时；**超时标记唯一作者是 host 计时器**，客户端只上报 outcome，伪造不了。

---

## 安装

已发布 npm（`@quill507/dsh-auto-approval-llm`），直接安装：

```bash
dsh plugin --profile web add @quill507/dsh-auto-approval-llm
```

本地开发构建 / 注入：

```bash
npx tsc -p tsconfig.json   # 编译 host → lib/
npx tsdown                 # 构建 client bundle → lib/client.js
```

以 `link:` 依赖在 web profile 加载本仓库后：host 改动重新编译并重启 dsh 生效；client 改动重建后浏览器自动热载。

> 提示：本插件依赖 DSH 的 `auto` 权限预设（`danger-full-access` + `approval: ask`），并作为 `approval/request` 的唯一终结者——**不要与其他审批类插件（如 dsh-approval-llm / dsh-auto-review）同时启用**。

---

## 快速开始

1. 确保会话/预设处于 **Auto 档**（`auto` 预设）。
2. 到 设置 → 插件 → 自动审批，按需配置；默认即可工作（空配置 = 静态规则 + 会话模型评审 + 拒绝式超时兜底）。
3. 想让审批走你自己的模型：在「在线评审模型」卡填 协议 / API 地址 / 模型名称 / API 密钥 → 保存 → 测试连接。
4. 嫌中风险弹窗频繁或超时漏拦：调大「中风险倒计时」，或把「超时动作」改为 `拒绝` / `低风险自动同意`。

> 📚 工作原理详解文档站：<https://cuddly-guacamole.github.io/dsh-auto-approval-llm/>

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

分类开关与信任模式——标准/激进两种位置模式、特权命令允许 LLM 审查开关与各类别独立三态覆盖：

![分类开关与信任模式](assets/settings-categories-trust.png)

确认制学习——同一签名累计 N 次真实人工确认后自动放行（每次放行前仍经一次在线评审），支持查看与吊销已学习条目：

![确认制学习](assets/settings-learning.png)

审批面板——倒计时贴在超时自动执行的动作上（此处 `超时动作=低风险自动同意` → 中风险超时自动**拒绝**，「拒绝」按钮带倒计时、「允许一次」保持干净）：

![审批面板 · 拒绝倒计时](assets/approval-panel-countdown-reject.png)

会话审批统计——会话标题栏「自动审批」按钮弹层：总计/通过/拒绝/超时/熔断 + 最近记录：

![会话审批统计](assets/session-stats.png)

---

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 总开关 |
| `autoSwitchPolicyToAsk` | false | 仅 Auto 预设且 override=never 时自动切 ask；设置卡已撤下，仅 YAML 配置 |
| `timeoutAction` | `reject` | 倒计时超时动作：`reject` 拒绝 / `allow` 全部通过 / `low-risk-allow` 仅低风险放行（**锁定类别除外**：删除/受保护/磁盘/未解锁提权恒拒，不受此键影响） |
| `llmReviewScope` | `low-or-above` | LOW/MEDIUM/HIGH 哪些档送 LLM 复审 |
| `llmTakeoverScope` | `medium-or-below` | 哪些档允许 LLM 结论直接接管 |
| `defaultReviewMode` | `smart` | 每会话评审模式默认：人工 / 智能 / 无人值守 |
| `lowRiskSeconds` / `mediumRiskSeconds` / `highRiskSeconds` | 5 / 8 / 10 | 三档倒计时（秒） |
| `breakerAntiHijackMs` | 0 | 熔断弹窗按钮防误点禁用时长，0 不启用；设置卡已撤下，仅 YAML 配置 |
| `maxConsecutiveDenials` | 3 | 连续 LLM 拒绝熔断阈值，0 关闭 |
| `maxTotalDenials` | 20 | 累计拒绝熔断阈值，0 关闭 |
| `reviewerProtocol` | `openai` | 在线评审协议：`openai`(chat/completions) / `anthropic`(messages) |
| `reviewerBaseUrl` | '' | 在线评审 API 地址；非空才走在线评审，空则跟随会话模型。三件齐备（地址＋模型名＋已配置密钥）才启用直连；缺任一自动跟随会话模型 |
| `reviewerModel` | '' | 在线评审模型名；连同 `reviewerBaseUrl` 与已配置密钥三件齐备才启用直连（`reviewerProvider` 已于 2026-08-26 退役：classifier 恒跟随会话模型） |
| `safetyPrompt` | '' | 附加给评审模型的额外策略（保存即热生效） |
| `allowlist` / `denyList` / `humanOnlyList` | [] | 工具名精确匹配 |
| `rulesText` | '' | 声明式规则（优先于内置列表执行；支持 `[agent:main|subagent|名]`、`[workspace:路径]` 维度前缀，逗号组合=AND；解析错误=整段失效） |
| `rulesDryRun` | false | 规则干跑：只记命中不执法；设置卡已撤下，仅 YAML 配置 |
| `maxArgsChars` | 4000 | 取回工具参数的最大长度 |
| `notifyUser` | true | 「模型通过」通知进会话 |
| `showSessionPanel` | `off` | 会话标题栏按钮：关 / 仅Auto / 开 |
| `aiButtonPosition` | `header` | 按钮位置：标题栏 / 悬浮 |
| `workspaceRoot` / `dshHome` / `tempRoots` | ''/''/[] | 路径根（DSH_HOME 默认保护） |
| `classifierTimeoutMs` / `classifierMaxOutputTokens` | 8000 / 1024 | 分类器超时与输出上限 |
| `reviewMaxRetries` | 1 | LLM 复审失败后的额外重试次数（0 单次 / 1 默认 / 2 上限；仅瞬时故障重试——限流·5xx·传输·空响应，LOW 同步含超时——重试窗口受审批倒计时剩余约束，认证/配置错误不重试） |
| `autoModeNoticeEnabled` | true | 自动审批模式进入/退出时向 agent 注入英文上下文声明（独立开关） |
| `onboardingMessageEnabled` | true | 首次 Auto 会话向 agent 注入一次性英文引导消息（上下文声明，非用户横幅）；关掉后不再注入 |
| `reviewWaitSeconds` | 5 | 每次 LLM 评审尝试的等待时间（秒，1–10）；官方通道 TTFB 慢时调大（直连 DeepSeek 实测 266ms–4.9s），建议不超过低风险倒计时 |
| `debug` | false | 调试模式：写 `approval-debug.jsonl` 与 `[debug]` 日志 |
| `reviewerContextFacts` | false | 仅 YAML 可配（设置卡无此控件）。上下文增强复审：给 LLM 复审输入附加结构化工作区事实（目标存在性/类型/大小 + 本会话最近创建文件，最多 8 条）；默认关（载荷与既往一致）。边界：工作区外只报存在性/类型不报大小；tempRoots 文件不入 recent_creates；探测失败整体省略 |
| `editDiffPreview` | false | 编辑类工具（write/edit/str_replace_editor 非 view/apply_patch）进入人工审批时，面板展示目标文件行级红绿 diff。纯展示：不参与裁决、不进 LLM 复审输入；失败自动省略。边界：可读的工作区内非受保护目标对比现有内容；全量写类（write/create）目标不可读（外部/受保护/新文件）预览仅新内容全量新增（零读目标文件）；对比类（edit/str_replace/insert/apply_patch）目标不可读整体省略；≤1MiB（lstat 不跟随 + 读后字节复核，防 junction 逃逸）；LCS ≤1024 行/侧、单行 ≤200 字符省略、输出 ≤200 行且 ≤32KiB（截断带 `…truncated`）；语义镜像官方（多匹配/已存在/越界 → 省略）；diff 块内倒计时字面量剥离防伪造 |
| `categoryPolicy` | `{}` | 11 类三态开关：`{类别: auto\|ask\|deny}`，缺省 `inherit` = 保持既往行为；delete/protected/disk（及未开启 `privilegeAutoReview` 时的 privilege）LOCKED 仅可 `ask`（其余值 warn+丢弃）；harnessInternal/unknown 无键不可配 |
| `privilegeAutoReview` | false | 特权类别解锁开关（默认关=fail-closed）：开启后 privilege 可设 auto/ask/deny 并走分类器 + LLM 评审 + 倒计时管线；delete/protected/disk 不受影响仍锁 ask |
| `categoryMode` | `standard` | 信任目录模式：`standard` 常规位置=workspace ∪ `trustedDirs`；`aggressive` 取消位置白名单，任意位置视为常规（敏感名 fuse、运行态硬拒、symlink 复检等危险度门不动；切换时 UI 明示放开范围） |
| `trustedDirs` | [] | host-only 键：额外信任目录根（绝对路径数组），作为 standard 档位置白名单成员与两档共用的 symlink 复检区成员；凭据段/home/dshHome/critical 路径排除；仅 patch/YAML 可配，设置卡保存不会抹掉 |
| `trustedDshSubpaths` | [] | host-only 键：允许 Auto 会话写入的 DSH_HOME 子目录（绝对路径数组）。默认空 = DSH_HOME 整树恒拒（`edit`/`write`/`apply_patch`/`str_replace_editor` 四路一致）；列出子树后该树获得与插件开发区同级放行，仅 patch/YAML 可配。清洗规则：非绝对路径、DSH_HOME 之外、等于 DSH_HOME 本身、覆盖 `sessions`/`plugins`/`credentials*`、归一化后落入 critical 树的条目全部 warn+丢弃。**开启前请知情**：技能文件会作为指令注入 agent 上下文，放开 `skills` = 允许 agent 持久改写自身行为约束；插件运行态文件（history/audit/learning…）恒拒与本键正交，不受影响 |
| `learningEnabled` | false | 确认制学习：同一操作被人工反复确认达阈值后自动放行（命中仍须过一次标准在线评审）；默认关 = 零行为差异。高风险/锁定四类/unknown/敏感路径永不参与；每根会话学习放行上限 50 次 |
| `learningThreshold` | 3 | 触发学习放行所需的人工确认次数（保存时钳入 2–10）；同签名操作被人工拒绝即清零计数 |

> 顶层开关（启用/超时动作/评审·接管范围/默认模式/按钮显示与位置）改动即保存；每张子卡有独立的 保存/放弃修改 按钮（安全规则列表另有 恢复默认）。host-only 键（workspaceRoot 等）用 patch/YAML 配置，设置卡保存不会抹掉它们。
>
> 设置卡子卡分组（仅标签，不移动控件）：计时器与熔断 / 安全规则列表 / 分类开关与信任模式 / 确认制学习 四卡带「安全底线」标签（倒计时秒数是决策窗口，属安全项）；在线评审模型与最近审批记录不加标签。

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
| `learning.json` | 确认制学习条目：SHA-256 签名键 + 脱敏模板骨架；TTL 30 天 / 至多 100 条按最近使用回收，tmp+rename 原子写，按工作区隔离（关闭开关不清数据） |

数据查询：`node scripts/audit-query.mjs [--last N|--tool X|--session S|--source S|--since ISO|--json]`

---

## 安全设计要点

- **唯一终结者**：同一 approval 只有一个裁决者（prepend + global），避免双弹窗/双写/审计断裂。
- **fail-closed**：评审器超时/垃圾/失败 → 拒绝或转人；ESCALATE 一律转人，不被 `timeoutAction=allow` 自动放行；reviewer 失败不计入熔断。
- **reasoning-blind**：评审只看 工具名 + 结构化脱敏参数 + 有界直接用户消息（唯一授权证据）+ 工作区事实，剥离评审者的自述与工具输出。
- **密钥不出 host**：在线评审密钥存 DSH 凭据，每操作解析、前端仅显「已配置」。
- **倒计时按钮规则**：倒计时只贴在「会超时自动执行」的那个按钮上——`timeoutAction=通过` → 超时自动通过，「允许一次」倒计时、拒绝按钮干净；`timeoutAction=拒绝` / `低风险自动同意` → 中/高风险超时自动拒绝，「拒绝」按钮倒计时（低风险自动同意时仅低风险超时通过）。中风险默认 8 秒偏紧，建议按需调大。
- **diff 预览只进人工面板**：编辑类 diff 文本只追加到 ask reason（人工面板可见），绝不进入 review payload / REVIEWER_SYSTEM（reasoning-blind）、不进 history/audit；diff 块内若含倒计时字面量会在注入前剥离，客户端也只解析隐藏后的文本——改不了任何自动应答路径。受保护/密钥文件（.env 等）不读旧内容（对比类整体省略；全量写类仅预览工具参数里的新内容，外层/受保护旧内容绝不上屏）；但旧内容与 tool arguments 一样随会话 approval/asked 日志明文持久化（官方契约 log-only、模型上下文不可见），与既有参数暴露面同级。

---

## 致谢

本项目在设计与实现中参考/移植了以下开源项目，谨此致谢它们的作者与社区：

- **[@nanmicoder/dsh-auto-mode](https://github.com/NanmiCoder/dsh-auto-mode)** —— Auto 档 + 静态规则 → LLM 分类器 → 人工 的核心审批管线：受保护路径、静态评估、shell 安全解析、LLM 预分类等策略移植自该项目，并在 `src/auto/` 中重写为独立实现（移除该项目也可正常工作）。
- **[@anionex/dsh-vision-toolkit](https://github.com/Anionex/dsh-vision-toolkit)** —— 设置界面范式：在线模型（API 协议 / 地址 / 模型 / 密钥，密钥存 DSH 凭据、前端不可见）、红色报错横幅与修复按钮、「复用 DSH 原生 CSS 与 UI primitives」的做法。

---

## 版本 / 发布

- 安装：`dsh plugin --profile web add @quill507/dsh-auto-approval-llm`
- 许可证：BSD-3-Clause。
