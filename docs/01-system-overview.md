# 01 · 系统总览

> *System Overview*

这是一个挂在 **DeepSeek Harness** 上的 Cordis 插件：在 **Auto 权限预设**（`sandbox: danger-full-access` + `approval: ask`）下，充当 `approval/request` 的**唯一终结裁决者**。两面：**宿主端**（Node 进程，决策与安全）＋ **浏览器端**（Web GUI，设置与面板交互）。

**图例**

- 放行 / 常态
- 拒绝 / fail-closed
- LLM / 模型侧
- 数据落盘

### 四个执行平面

**🖥️ 浏览器（client.js）**

- 注入 DSH Web GUI：设置卡、会话标题栏统计、审批按钮增强
- 所有通信走 **HTTP fetch**（`same-origin`），**无 RPC**
- 不产决策，只「观察 + 转达 + 显示」

**🧠 宿主插件（src/index.ts）**

- 约 80% 的裁决逻辑：静态评估、熔断、倒计时、LLM 复审
- 通过 `approval/request` 等事件与 DSH 内核接线
- 定时器唯一作者 —— 超时标记不可伪造

**🔌 DSH 内核 + LLM**

- 提供 `tools`/`approval`/`permissionPresets`/`settings` 等服务
- 评审可走**会话模型**（`ctx.llm.stream`）或**在线端点**（OpenAI/Anthropic 兼容）
- 官方 ApprovalPanel 是唯一的人工交互面

### 数据太平面（所有文件都在插件根目录）

| 文件 | 语义 | 写入方 |
| --- | --- | --- |
| `history.jsonl` | 审批历史（有界内存窗口 200 条 + 落盘，>1MB 轮转） | 宿主 pushHistory |
| `audit.jsonl` | append-only 审计，清空留 tombstone，>5MB 保尾 5000 行 | 宿主 appendAuditLine |
| `review-mode.json` | 每会话评审模式快照（smart 不落盘，原子 tmp+rename） | 宿主 persistReviewModes |
| `approval-debug.jsonl` | 仅 `debug=true` 时写入的评审时序，>1MB 保尾 2000 行 | 宿主 debugLog（request/review/follow/resolve） |
| `llm-latency.jsonl` | LLM 评审耗时遥测（环形缓冲 200 条，>1MB 轮转；与审批历史分离） | 宿主 pushLatencySample |
| `learning.json` | 确认制学习条目（SHA-256 键、TTL 30 天/100 条上限，原子 tmp+rename） | 宿主 persistLearning |

以上六个文件同属运行态保护名单（<span class="lnum">paths.ts:L202</span>），任何工具调用都改不了它们。

::: tip 唯一终结者
`approval/request` 以 `{prepend:true, global:true}` 注册（<span class="lnum">index.ts:L2379</span>，options 行 <span class="lnum">index.ts:L2794</span>）—— 对命中的 ask，本插件就是最终裁决，不会开第二个弹窗、不会双写、不会让审计断裂。
:::