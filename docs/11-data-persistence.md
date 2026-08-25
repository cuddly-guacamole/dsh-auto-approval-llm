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

字段全集（<span class="lnum">index.ts:L734-752</span>）：`id` / `at` / `sessionId` / `toolName` / `outcome` / `source` / `llmDecision?` / `llmRisk?` / `llmReason?`（先脱敏）/ `attempts?`（重试时逐次失败轨迹）/ `breaker?` / `breakerReasons?` / 类别三字段 `category?` · `categoryDecision?` · `mode?`。写入走 `pushHistory`（<span class="lnum">index.ts:L797-821</span>）：llmReason 先过脱敏 → 内存窗口 200 条 → `history.jsonl` 追加、>1MB 用内存窗口重写轮转；同一条再以 `type:'decision'` 落进审计。启动时 loadHistory 恢复。

### 11.1.2 audit.jsonl（append-only，清空留墓碑）

```json
{"type":"decision","sessionId":"…",
 "toolName":"bash","outcome":"allowed-once",
 "source":"timeout-allow","llmDecision":"ESCALATE",
 "id":"hmt2rrtff_ccr1k1","at":1787305877691}
{"type":"clear","at":…,"cleared":6}
```

pushHistory 每次附带写一条 `type:'decision'`；UI 清历史只清内存+history 文件，审计只剩墓碑。`>5MiB 保尾 5000 行`。查询：`node scripts/audit-query.mjs [--last N | --tool X | --session S | --source S | --since ISO | --json]`。

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

- **键**：SHA-256(`sigVersion|kind|workspace|signature`)（<span class="lnum">learning.ts:L221-223</span>）——签名是确定性整行模板（[§18](./18-confirm-learning)），不含任何原始值。
- **骨架卫生**：模板先过 `redactSecrets` 再落盘，且只允许字符白名单、长度 ≤512（<span class="lnum">learning.ts:L64-65</span>）。
- **回收**：TTL 默认 30 天、上限默认 100 条，按 `lastAt` LRU 逐出（`evictLearning`，<span class="lnum">learning.ts:L305-315</span>）；关闭开关不清数据。
- **写入**：同步 `tmp + rename` 原子替换（`persistLearning`，<span class="lnum">learning.ts:L339-347</span>），best-effort，进程内副本兜底。
- **隔离**：查找要求 `entry.workspace === 当前工作区` 精确相等（<span class="lnum">learning.ts:L401</span>）——一个项目学到的放行资格不会带到另一个项目。

::: tip
审计刻意存普通文件而非会话 user/message 事件：**主模型永远无法把它读回来当成提示注入通道**，同时保证「清空可恢复」。
:::