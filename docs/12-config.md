# 12 · 配置全景
> *41 keys, one source of truth*

### 全部配置键（src/index.ts Config schema Z.object 原文）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 总开关 |
| `autoSwitchPolicyToAsk` | false | 仅 auto+override=never 时自动翻 ask（bundle 覆盖为 true） |
| `debug` | false | 写 approval-debug.jsonl + [debug] 日志 |
| `reviewerProvider / reviewerModel` | '' | 显式在线模型名（必须成对） |
| `reviewerProtocol` | openai | openai(chat/completions) · anthropic(messages) |
| `reviewerBaseUrl` | '' | 在线端点；空=跟随会话模型 |
| `timeoutAction` | reject | reject · allow · low-risk-allow |
| `llmReviewScope` | low-or-above | 哪些档送审 |
| `llmTakeoverScope` | medium-or-below | 哪些档可接管 |
| `defaultReviewMode` | smart | manual · smart · unattended |
| `lowRiskSeconds` | 5 | min 1 |
| `mediumRiskSeconds` | 8 | min 1 |
| `highRiskSeconds` | 10 | min 1 |
| `safetyPrompt` | '' | 拼接进评审 system，即时热生效 |
| `allowlist / denyList / humanOnlyList` | [] | 精确工具名 |
| `rulesText` | '' | 声明式规则，优先于内置列表 |
| `rulesDryRun` | false | 只记不罚 |
| `maxConsecutiveDenials` | 3 | 0=关闭 |
| `maxTotalDenials` | 20 | 0=关闭 |
| `maxArgsChars` | 4000 | 参数取回截断 |
| `notifyUser` | true | 「模型通过」通知进会话 |
| `showSessionPanel` | off | on/auto/off（客户端消费） |
| `breakerAntiHijackMs` | 0 | 熔断弹窗防误点（客户端消费） |
| `aiButtonPosition` | header | header/floating（客户端消费） |
| `reviewMaxRetries` | 1 | LLM 审查首次失败后的额外重试次数（0-2；0=单次，1=默认；滚动剩余预算，见 src/auto/retry.ts）——**普通键**，安全规则卡可改 |
| `redactResults` | false | 开启后把成功工具结果也过一遍脱敏器再喂回模型（post-execute 侧） |
| `reviewerContextFacts` | false | 上下文增强复审：给评审输入附加结构化工作区事实（只读元数据）；host-only 键，设置卡开关不改变其生效值 |
| `editDiffPreview` | false | 编辑类工具进人工审批时展示行级红绿 diff（纯展示，不参与裁决） |
| `categoryPolicy` | {} | 11 类三态开关 `{类别: auto\|ask\|deny}`；未配置=inherit 行为零变化；未知键 warn+丢弃（resolveConfig），LOCKED 四类仅收 ask |
| `categoryMode` | standard | standard/aggressive：信任目录模式。standard 常规位置=工作区 ∪ trustedDirs；aggressive 取消位置白名单（任意位置均视为常规位置；危险度门与敏感名 fuse 不动） |
| `trustedDirs` | [] | 额外信任目录根（绝对路径数组）：非绝对路径/凭据树/home/critical 内的条目 warn+丢弃后归一化 |
| `learningEnabled` | false | 确认制学习总开关：默认关（铁律），开启后同一操作被人工反复确认才可能自动放行（§18） |
| `learningThreshold` | 3 | 触发学习放行所需的人工确认次数；保存时钳入 [2,10]（clampLearningThreshold），越界值由 resolveConfig 发 warn（<span class="lnum">index.ts:L254-261</span>） |
| `<span class="badgeok">host-only ×9</span>` | — | workspaceRoot / dshHome / tempRoots / **trustedDirs** / classifierTimeoutMs(8s,100-60000) / classifierMaxOutputTokens(1024,64-4096) / maxArgsChars / notifyUser / **reviewerContextFacts**（<span class="lnum">decision.ts:L224-234</span>；preserveHostKeys 回填，卡片保存不抹掉）。注意 reviewMaxRetries **不在**此名单——它是可被设置卡修改的普通键 |

### 三处设计亮点

::: tip 默认值单一事实源
所有数值默认集中在 `src/auto/constants.ts` 的 `THRESHOLD_DEFAULTS`，host schema、host 回退、客户端草稿/重置三处引用同一常量 —— 改一处全同步。
:::

::: tip host-only 键保护
浏览器设置卡不渲染这些键；`preserveHostKeys` 在保存时把它们从当前值回填进提交对象，正则配置永不被卡片保存抹掉。
:::

::: tip 热更新
`settings/updated` → `resolveConfig` + `rebuildClassifier`；配置非法 → 跑安全默认 + 设置卡红色横幅 +「尝试修复」（剔除非法键回存）。
:::

::: warning bundle 层覆盖
（cordis.patch.yml）：装包即生效的一处与代码默认不同 —— `autoSwitchPolicyToAsk: true`（默认关）。`humanOnlyList` 保持代码默认空列表：bash 回归正常管线（静态评估 → LLM 审查 → 人工兜底），不再被强制永远人工决定。
:::

### 评审模式与命令

| 命令 | 行为 |
|---|---|
| `/approval reset` | 清熔断双计数器 + denialLog + 全部 7 张 approvalState 表；不动持久策略 |
| `/approval-mode` | 查/设当前会话评审模式（manual/smart/unattended，持久化，smart 不落盘=默认） |