# 11 · 数据与持久化
> *What lands on disk*

插件运行态共**六个文件**（<span class="lnum">paths.ts:L202</span> RUNTIME_STATE_BASENAMES 六员：`history.jsonl / audit.jsonl / approval-debug.jsonl / review-mode.json / llm-latency.jsonl / learning.json`）——这名单同时是保护对象：任何工具调用改写它们都会被静态引擎无条件硬拒。

## 11.1 四条 JSONL 的真实形态（取自本仓库现网样例）

### 11.1.1 history.jsonl（推论可搜、可清空）

```json
{"sessionId":"session-…c2a8","toolName":"bash",
 "outcome":"allowed-once","source":"timeout-allow",
 "llmDecision":"ESCALATE","id":"hmt2rrtff_ccr1k1",
 "at":1787305877691}
```

字段全集（<span class="lnum">index.ts:L949-968</span>）：`id` / `at` / `sessionId` / `toolName` / `outcome` / `source` / `llmDecision?` / `llmRisk?` / `llmReason?`（先脱敏）/ `reason?`（非 LLM 决定的原因，如 pre-execute 硬拒，同一脱敏路径）/ `attempts?`（重试时逐次失败轨迹）/ `breaker?` / `breakerReasons?` / 类别三字段 `category?` · `categoryDecision?` · `mode?`。写入走 `pushHistory`（<span class="lnum">index.ts:L1055-1085</span>）：llmReason / reason 先过脱敏 → 内存窗口 200 条 → `history.jsonl` 追加、>1MB 用内存窗口重写轮转；同一条再以 `type:'decision'` 落进审计。启动时 loadHistory 恢复。pre-execute 快路径（不经 approval/request）也落记录：`hard-deny`（策略硬拒，携带 `reason`）、`classifier-allow` / `classifier-deny`（LLM 预分类器自主裁决，携带 `llmDecision` / `llmRisk` / `llmReason`）。

### 11.1.2 audit.jsonl（append-only，清空留墓碑）

```json
{"type":"decision","sessionId":"…",
 "toolName":"bash","outcome":"allowed-once",
 "source":"timeout-allow","llmDecision":"ESCALATE",
 "id":"hmt2rrtff_ccr1k1","at":1787305877691}
{"type":"clear","at":…,"cleared":6}
```

pushHistory 每次附带写一条 `type:'decision'`；UI 清历史只清内存+history 文件，审计只剩墓碑。`>5MiB 保尾 5000 行`。查询：`node scripts/audit-query.mjs [--last N | --tool X | --session S | --source S | --since ISO | --json]`。摩擦统计（面板介入率 panel-mediated / 倒计时结算率 / 翻案交叉表 / 评审通道落定率 / 无人值守窗口判据，判定 `PASS`/`FAIL`/`VACUOUS`/`INSUFFICIENT` 并附退出码 0/1/2/3）：`node scripts/friction-report.mjs [--window N | --since ISO | --json]`。

#### 非决策观测事件

除 `decision` / `clear` 外，audit.jsonl 还承载**非决策观测事件**——只记观测事实、不改任何裁决、不进审批历史窗口与统计（`type` 见 <span class="lnum">index.ts</span> 各 `appendAuditLine` 处）：

- `result-redacted` / `mask-failed`：成功工具结果过脱敏器的命中 / 失败记录（post-execute 侧），只带 callId/toolName，永不落被掩码的原料；
- `learning-cap-reached` / `learning-revoked` / `learning-tamper`：学习放行到达会话上限告警 / 设置卡吊销单条（learning-store DELETE）/ 进程外改写 learning.json 的检测；
- `rules-context-missing`：声明规则含 deny/human 维度作用域但代理上下文（agentKind/workspaceRoot）不可得时降级人工，留一条原因记录；
- `rules-parse-error`：rulesText 解析错误——pre-execute 与 answerer 两平面 loud 报错（console.error + debugLog），审计事件按平面去重、签名变化才追加；
- `runtime-state-read`：读取插件运行态文件（结构化读工具与 shell 读）默认落审计，纯观测。
- `permission-change`：权限平面**真正移动**时落一条（宿主自身只在值变化时才追加 `permission/preset` / `sandbox/mode` / `approval/policy`），带 `actor:'user'|'plugin'`、变更后的值与**最近若干条被拒 decision 的 id 指针**（只记 id，记录本体仍归 audit）。**门控 = 每会话每平面的基线**：宿主在会话创建时会一次性播种三个平面（`pinInitialPermission`），故每个平面的**首个观测值只作基线、不记录**；基线另外在 `session/created`（含 resume 路径）与启动扫描时用 `permissionPresets.permissionState(session)` 预填，因此**恢复/续跑会话的首次切换照样会被记录**。插件自身的 `never→ask` 反制由 `pluginFlipSessions` 抑制那份被观测副本，并由插件自己写 `actor:'plugin'`（写入前复核策略仍为 `never`，早退不记）。**降级行为**：`permissionState` 在官方类型声明里是 private，插件用可选调用规避类型；若宿主改名或移除它，基线预填静默失效——退化为"只按会话内已见事件建基线"（不崩、不伪造，极端情况下少记首次切换）。动机：`approval/policy='never'` 会让官方管线在 waterfall 之前终裁，插件从此不在决策链上，故该转换需要留痕。纯观测：不进裁决、不进评审提示词、不进统计。注记：该事件的 `sessionId` 是**权限变更所属会话**的 id，而 `decision` 按**权威会话**（子代理记父 id）记账——跨表对齐请用 `recentRejectedIds` 指针，不要只按 sessionId 过滤。

`decision` 侧新增：`tools/guard` 熔丝拒绝（硬拒 / symlink 逃逸）也会以 `source:'guard'`、`outcome:'rejected'`（reason 随行）经 pushHistory 落一条终局 decision 记录——审计写入失败不软化拒绝，调用仍被拒。

### 11.1.3 review-mode.json（每会话评审模式）

```json
{
  "session-…c2a8": "manual",
  "session-5fb…e3a2b": "unattended"
}
```

只存非默认（≠smart）的会话；原子 tmp+rename；损坏非致命。会话销毁自动删键，文件不会无限变大。

### 11.1.4 approval-debug.jsonl（仅 debug=true）

```json
{"at":…,"ev":"request","callId":"…","toolName":"bash","sessionKey":"…"}
{"at":…,"ev":"review","callId":"…","decision":"ESCALATE",
 "risk":null,"startAt":…,"tookMs":14,"scope":"medium"}
{"at":…,"ev":"resolve","callId":"…","outcome":"allowed-once",
 "timedOut":true,"source":"timeout-allow","auto":false,
 "seconds":8,"elapsedMs":8011,"requestToResolveMs":8014,
 "llmDecision":"ESCALATE"}
```

事件点：request / review / follow / review-error / resolve。用来回答「LLM 到底看没看、看了多久、说了什么」——区分超时误标与真实延迟。>1MB 保尾 2000 行。

### 11.1.5 llm-latency.jsonl（评审耗时遥测，与历史分离）

```json
{"at":1787480239339,"tookMs":1928,"settled":true}
{"at":…,"tookMs":8011,"settled":false,"attempts":2}
```

独立于审批历史：历史记「裁决事实」，耗时是性能遥测——被打断的调用（倒计时超时/网络失败/解析失败/无路由）没有历史记录可挂，回写就会伪造裁决。所以它住自己的环形缓冲（内存 200 条，<span class="lnum">latency.ts:L47</span>）+ 同款 append+轮转文件（>1MB 重写，<span class="lnum">latency.ts:L109</span>），损坏行跳过。样本二分：`settled=true` 才是真响应时间；`aborted` 是等待上限，**永不混入 MIN/AVG/MAX**（UI 汇总窗口最近 100 条，单列「超时/无响应」计数）。

## 11.2 learning.json（确认制学习条目）

```json
{"version":1,
 "entries":{"<sha256>":{"sigVersion":1,"workspace":"C:\\ws\\proj",
   "kind":"shell-bash","skeleton":"git push --force-with-lease <in:path>",
   "count":3,"firstAt":…,"lastAt":…}}}
```

- **键**：SHA-256(`sigVersion|kind|workspace|signature`)（<span class="lnum">learning.ts:L248-250</span>）——签名是确定性整行模板（[§18](./18-confirm-learning)），不含任何原始值。
- **骨架卫生**：模板先过 `redactSecrets` 再落盘（<span class="lnum">learning.ts:L225/L242</span>），且只允许字符白名单、长度 ≤512（`SKELETON_MAX`，<span class="lnum">learning.ts:L68</span>）。
- **回收**：TTL 默认 30 天、上限默认 100 条，按 `lastAt` LRU 逐出（`evictLearning`，<span class="lnum">learning.ts:L387-397</span>）；关闭开关不清数据。
- **写入**：同步 `tmp + rename` 原子替换（`persistLearning`，<span class="lnum">learning.ts:L423</span>），best-effort，进程内副本兜底。
- **隔离**：查找要求 `entry.workspace === 当前工作区` 精确相等（lookupLearning 门，<span class="lnum">learning.ts:L514-522</span>）——一个项目学到的放行资格不会带到另一个项目。

::: tip
审计刻意存普通文件而非会话 user/message 事件：**主模型永远无法把它读回来当成提示注入通道**，同时保证「清空可恢复」。
:::