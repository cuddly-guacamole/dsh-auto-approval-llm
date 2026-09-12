# 12 · 配置全景
> *59 keys, one source of truth*

### 全部配置键（src/index.ts Config schema Z.object 原文）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 总开关 |
| `autoSwitchPolicyToAsk` | false | 仅 auto+override=never 时自动翻 ask（bundle 覆盖为 true）；设置卡可配（「高级」子卡，即时保存） |
| `debug` | false | 写 approval-debug.jsonl + [debug] 日志 |
| `classifierSource` | session | 快速判断通道模型来源：session · preset(DSH 模型) · endpoint(共享端点) |
| `classifierProvider / classifierModel` | '' | preset 档成对必填 |
| `classifierReasoning` | '' | 快速判断通道推理强度：'' 跟随 adapter 默认；显式值（off/minimal/low/medium/high/xhigh/max）作为 dsh reasoningEffort 转发，模型不支持时 loud fail 不静默 |
| `classifierTimeoutMs` | 8000 | 分类器超时（100–60000ms） |
| `classifierMaxOutputTokens` | 1024 | 分类器输出上限（64–4096） |
| `reviewerSource` | session | 深度评审通道模型来源：session · preset(DSH 模型) · endpoint(共享端点) |
| `reviewerProvider / reviewerModel` | '' | preset 档成对必填 |
| `reviewerReasoning` | '' | 深度评审通道推理强度（语义同 classifierReasoning） |
| `reviewerMaxTokens` | 2048 | 深度评审输出上限（256–16384） |
| `endpointUrl / endpointModel / endpointProtocol` | ''/''/openai | 共享自定义端点（两通道 endpoint 源共用）；openai · anthropic |
| `timeoutAction` | reject | reject · allow · low-risk-allow |
| `llmReviewScope` | low-or-above | 哪些档送审 |
| `llmTakeoverScope` | medium-or-below | 哪些档可接管（取值 `low` / `medium-or-below` / `high-or-below`；schema 接受 `high-or-below` 但行为与 `medium-or-below` 等同——HIGH 分支从不把控制权交给 LLM，高风险恒落人工，选它不会带来 HIGH 自动化） |
| `defaultReviewMode` | smart | manual · smart · unattended |
| `lowRiskSeconds` | 5 | min 1 |
| `mediumRiskSeconds` | 8 | min 1 |
| `highRiskSeconds` | 10 | min 1 |
| `safetyPrompt` | '' | 拼接进评审 system，即时热生效 |
| `allowlist / denyList / humanOnlyList` | [] | 精确工具名 |
| `rulesText` | '' | 声明式规则，优先于内置列表 |
| `rulesDryRun` | false | 只记不罚；仅 YAML 可配（设置卡无此控件） |
| `maxConsecutiveDenials` | 3 | 0=关闭 |
| `maxTotalDenials` | 20 | 0=关闭 |
| `maxArgsChars` | 4000 | 参数取回截断 |
| `notifyUser` | true | 「模型通过」通知进会话 |
| `onboardingMessageEnabled` | true | 首次 Auto 会话向 agent 注入一次性英文引导消息（上下文声明，非用户横幅）；关掉后不再注入 |
| `autoModeNoticeEnabled` | true | 自动审批模式进入/退出时向 agent 注入英文上下文声明（独立开关） |
| `showSessionPanel` | auto | on/auto/off（客户端消费）；控件同时承载审批状态 |
| `breakerAntiHijackMs` | 0 | 熔断弹窗防误点（客户端消费）；仅 YAML 可配（设置卡无此控件） |
| `panelDelayMs` | 3000 | 倒计时审批先只在会话标题栏控件上显示状态、推迟官方审批面板出现的时长（毫秒，0–10000，0=立即出现）；host 消费（决定何时 `next()`）；设置卡可配 |
| `workspaceRoot / dshHome / tempRoots` | ''/''/[] | 路径根（DSH_HOME 默认保护；host-only） |
| `reviewMaxRetries` | 1 | LLM 审查首次失败后的额外重试次数（0-2；0=单次，1=默认；滚动剩余预算，见 src/auto/retry.ts）——**仅 YAML 可配**（设置卡无此控件） |
| `reviewWaitSeconds` | 5 | 每次 LLM 评审尝试的等待时间（秒，1–10）；官方通道 TTFB 慢时调大，建议不超过低风险倒计时 |
| `redactResults` | false | 开启后把成功工具结果也过一遍脱敏器再喂回模型（post-execute 侧） |
| `reviewerContextFacts` | false | 上下文增强复审：给评审输入附加结构化工作区事实（只读元数据）；host-only 键：仅 settings.yaml 可配（设置卡无此控件） |
| `editDiffPreview` | false | 编辑类工具进人工审批时展示行级红绿 diff（纯展示，不参与裁决） |
| `rejectGuidance` | true | 拒绝引导：被拒时向 agent 注入白名单式短说明（来源/类别枚举，不含工具名与自由文本），减少盲目重试；同调用去重 + 60s 限 5 条，fail-closed。v0.0.17 起官方拒绝检测只认结构化错误形状（error.message/isError/官方 Error: 前缀）——read/grep 等成功工具输出里出现的 "user rejected tool" 字面量不再误触发（此前 13 次幽灵注入根因） |
| `maintenanceDshPaths` | [] | host-only 键：DSH_HOME 中供运维维护的子目录（绝对路径数组）。其内 guard 的 DSH_HOME 硬拒只对**非运行态文件**放宽（技能/配置/文档）；插件运行态文件（history/audit/learning…）在其内仍恒拒，shell 写向量仍恒拒，fenced 子树（sessions/plugins/credentials*）不可指名。仅 patch/YAML 可配 |
| `categoryPolicy` | {} | 11 类三态开关 `{类别: auto\|ask\|deny}`；未配置=inherit 行为零变化；未知键 warn+丢弃（resolveConfig），LOCKED 类仅收 ask（privilege 在 `privilegeAutoReview=true`、protected 在 `protectedAutoReview=true` 时例外，可收 auto/deny） |
| `categoryMode` | standard | standard/aggressive：信任目录模式。standard 常规位置=工作区 ∪ trustedDirs；aggressive 取消位置白名单（任意位置均视为常规位置；危险度门与敏感名 fuse 不动） |
| `privilegeAutoReview` | false | 特权类别解锁开关（默认关=fail-closed）：开启后 privilege 可设 auto/ask/deny 并进入 LLM 评审管线；delete/protected/disk 不受影响仍锁 ask |
| `protectedAutoReview` | false | 受保护类别解锁开关（默认关=fail-closed）：解除 `protected` 的锁定钳制。解除后**未显式配置**的受保护调用不再被恒拒倒计时钉死，而落常驻人工询问——类别询问在 pre-execute 即返回，**评审器仍不会被问到**，须人工作答；把该类别显式设为 `auto` 才会自动放行。**两档的实际差别（易踩）**：关（默认）= LOCKED，落**恒拒倒计时**，`highRiskSeconds`（默认 10s）后自动拒绝、`timeoutAction` 任何配置都无法放行（无人盯守不会挂起）；开且未显式配置 = **status-less 询问，不发布倒计时状态、永不自动结算**，因此无人盯守时该询问**会一直等下去**（人不在就不会有任何结果）——这是拿「自动拒绝」换「等真人」，需要无人值守可用时须配合 `categoryPolicy.protected` 显式配置。**凭据读取地板**：敏感文件名/目录与关键路径的**读取**（含写头读源）被结构化判定为 `credentialRead` 并保持锁定，本键只解锁非凭据的工作区元数据（`.git`/`.vscode` 等）；地板按类别层视角生效，opaque 行为已登记残余面（见 docs/17）；shell 的 junction 逃逸已有复检（见 docs/03 §3.4，裁定比结构化读者窄）；凭据树的**写入**本就硬拒且不受本键影响。删除/磁盘不受影响仍锁 ask。**与本键无关的固定例外**：`.git/HEAD` 与 `.git/refs/**` 的**读取**是一处不可配置的打开（无凭据内容），`read`/`grep`/`glob`/`view` 四种读者与 shell 读命令都不再询问；`.git/config`、`.git/hooks/**`、`.git/objects/**`、`.gitmodules` 与一切**写入/创建**仍在 `protected` |
| `trustedDirs` | [] | 额外信任目录根（绝对路径数组）：非绝对路径/凭据树/home/critical 内的条目 warn+丢弃后归一化 |
| `trustedDshSubpaths` | [] | 允许 Auto 会话写入的 DSH_HOME 子目录（绝对路径数组，host-only）。默认空=DSH_HOME 整树恒拒；列出的子树获得与插件自身开发区同级的放行，请只写最窄目录。**开口只服务结构化工具（edit/write 等）；shell 写向量对 DSH_HOME 一律恒拒，不随开口放开。**六道清洗全部 warn+丢弃：非绝对路径、不在 DSH_HOME 内、等于 DSH_HOME 本身、覆盖 fenced 子树（`sessions` / `plugins` / `credentials*`）、归一化后落入 critical 树。**注意**：技能文件内容会作为指令注入 agent 上下文，放开 `skills` 等于允许 agent 改写自身行为约束且持久生效——只在明确需要时开启。插件运行态文件（history/audit/learning…）的恒拒与本键正交，不受影响 |
| `learningEnabled` | false | 确认制学习总开关：默认关（铁律），开启后同一操作被人工反复确认才可能自动放行（§18） |
| `learningThreshold` | 3 | 触发学习放行所需的人工确认次数；保存时钳入 [2,10]（clampLearningThreshold），越界值由 resolveConfig 发 warn（<span class="lnum">index.ts:L"clamping learningThreshold"</span>） |
| `directHumanEnabled` | false | 直接人工通道：agent 可调用 `dsa_request_user` 把后续操作路由给人工而非 LLM 分类器；默认关=零行为差异。工具仅在开启时于启动注册（工具集不可热换——开启需重启），审批通道读取实时，关掉立即停用已注册工具 |
| `slashCommandsEnabled` | false | 命令面板注册 `/approval-mode` `/approval-reset` `/approval-reset-all`（评审模式查看/设置 + 熔断重置）。默认关=零命令表面积。命令集不可热换——仅在开启时于启动注册（开启需重启）；每个 handler 读取该开关实时，运行中关掉立即停用已注册命令 |
| `<span class="badgeok">host-only ×14</span>` | — | workspaceRoot / dshHome / tempRoots / **trustedDirs** / **trustedDshSubpaths** / maintenanceDshPaths / classifierTimeoutMs(8s,100-60000) / classifierMaxOutputTokens(1024,64-4096) / maxArgsChars / notifyUser / **reviewerContextFacts** / **rulesDryRun** / **breakerAntiHijackMs** / **reviewMaxRetries**（<span class="lnum">decision.ts:LHOST_ONLY_KEYS</span>；preserveHostKeys 回填，卡片保存不抹掉）。**归属不变量**：没有设置卡控件的键必须在此名单内——否则下一次任意卡片保存（整命名空间 replace）会把它从 settings.yaml 物理删除并静默回落默认（<span class="lnum">settings-key-ownership.test.mjs:L"no silent-delete gap"</span>） |

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

::: warning 容易误解的六件事
1. **模型来源是每通道 3 档显式开关，半配 fail-closed**。`classifierSource` / `reviewerSource` 各自决定该通道走哪条：`session`（跟随会话模型）、`preset`（DSH 已配置模型，`*Provider`+`*Model` 成对）、`endpoint`（共享端点配置）。显式选了 `preset`/`endpoint` 却配置不全 → 快照层 fail-loud（`{failure}`），**绝不静默回落会话模型**（用户以为用了指定模型实际没有 = 被契约测试钉死的反模式）；仅 `session` 源携带残留垃圾值才静默清洗。端点缺密钥同样 fail-closed（debug 记 `reviewer-incomplete`）。评审路由可用性门是单一 `reviewerRouteAvailable` 谓词（覆盖三源），learning 门与主管线共用（<span class="lnum">index.ts:reviewerRouteAvailable</span>）。
2. **`timeoutAction` 的 legacy 枚举迁移分支不可删**（`llm-low-risk-only` → `reject`，<span class="lnum">index.ts:L"timeoutAction === 'llm-low-risk-only'"</span>）：resolveConfig 是全有全无闸门——删掉映射后旧值走 throw，启动路径整库回落 patch 默认（<span class="lnum">index.ts:L"persisted config invalid, running defaults"</span>；热更新路径则保留旧 config），不是只重置这一个键。
3. **移除顶层配置键后，旧 settings.yaml 的残留键被静默忽略**：残留键不会被剥离，而是随解析结果原样透传进运行时配置、只是再没有任何代码读取它——无警告无报错（`{...raw}` 透传 <span class="lnum">index.ts:L"...raw"</span> 起；Config schema <span class="lnum">index.ts:L"export const Config"</span> 起）；弃用公告只能靠文档，不会有迁移提示。
4. **`safetyPrompt` 与 `rulesText` 分工不同**：前者拼进评审 system 提示词，保存即热生效（<span class="lnum">index.ts:L"assembleReviewerSystem(config.safetyPrompt, config.rulesText)"</span>）；后者是声明式执法规则，先于内置 allowlist/denyList 终局裁决 allow/deny/human（<span class="lnum">index.ts:L"B1 declared rules"</span>）。
5. **`reviewerProvider` 键名已复活（2026-09-05 用户拍板）**：作为深度评审通道 `preset` 档的 provider 键与 `reviewerModel` 成对。它不再是「在线路由的 provider」——在线/自定义端点由共享 `endpointUrl`/`endpointModel`/`endpointProtocol` 承载，两通道 `endpoint` 源共用一份；`endpointProtocol` 默认 openai 保留 anthropic。旧 `reviewerBaseUrl` / `reviewerProtocol` / 2 档 `classifierModelSource` / `reviewerModelSource` 等键已由新体系取代（未发版直接换代，无兼容层）。
6. **`showSessionPanel` / `breakerAntiHijackMs` 是纯客户端呈现键**：host 裁决路径从不读取，改它们不影响任何审批结论。
:::

### 评审模式与命令

> 默认**不注册**：需在设置卡开启「注册 /approval-mode /approval-reset /approval-reset-all 命令」（`slashCommandsEnabled`）并重启；运行中关闭开关，已注册命令立即停用（handler 实时守卫）。

| 命令 | 行为 |
|---|---|
| `/approval-reset` | 清熔断双计数器 + denialLog + 全部 7 张 approvalState 表（当前会话作用域）；不动持久策略 |
| `/approval-reset-all` | 同上但作用于全部会话 |
| `/approval-mode` | 查/设当前会话评审模式（manual/smart/unattended，持久化，smart 不落盘=默认） |