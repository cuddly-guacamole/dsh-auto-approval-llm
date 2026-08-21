# 11 · 数据与持久化
> *What lands on disk*

## 11.1 四条 JSONL 的真实形态（取自本仓库现网样例）

### 11.1.1 history.jsonl（推论可搜、可清空）

```json
{"sessionId":"session-…c2a8","toolName":"bash",
 "outcome":"allowed-once","source":"timeout-allow",
 "llmDecision":"ESCALATE","id":"hmt2rrtff_ccr1k1",
 "at":1787305877691}
```

字段：`id` / `at` / `sessionId` / `toolName` / `outcome` / `source` / `llmDecision?` / `llmRisk?` / `llmReason?`（先脱敏）/ `breaker?` / `breakerReasons?`。内存窗口 200 条，落盘 >1MB 用内存窗口重写轮转；启动时 loadHistory 恢复。

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

::: tip
审计刻意存普通文件而非会话 user/message 事件：**主模型永远无法把它读回来当成提示注入通道**，同时保证「清空可恢复」。
:::