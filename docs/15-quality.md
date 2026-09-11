# 15 · 质量保障体系

> *935 tests · runtime proofs*

## 15.1　契约测试覆盖地图（按主题归纳）

| 领域 | 测什么（关键断言摘要） |
|---|---|
| 评审解析 | parseReview 收 fenced/裸 JSON；非法 decision/risk_level/垃圾/长 reason 全拒（fail-closed）；lowRiskReviewOutcome 四则（ALLOW/DENY/ESCALATE/failure）；ALLOW+CRITICAL 升级 |
| 人机竞速 | raceHumanDecision 四分支（人先答/超时/allow 动作/LLM claim 抢占非超时/两者 claimed=false）；来源标注 approvalSource 真值表 |
| 熔断 | breakerTripped 双轨（0 停用）；applyBreaker（human 清零 / llm-deny 自增 / advisory 不增 / 静态名单绕过不计数） |
| 静态名单 | staticListDecision 优先级 deny>allow>humanOnly、精确名；熔断互斥（bypasses a tripped breaker） |
| 声明规则 | parseRulesText（作用域/注释/逐行错误/ReDoS 拒绝/锚定 git-push 匹配命令文本而非 JSON 信封）；evaluateRules 首条命中 |
| 路径/文件熔断 | hardDenyReason（apply_patch 缺目标 fail-closed、workspace 内放行）；isCriticalPath（shell rc、.env） |
| shell 熔断 | 提权（sudo/doas/su、brace group、VAR= 前缀、operator 拼接）；exfil（curl/wget/.dsh/.env、动态 home 拼写）；find 破坏性；只读判定不过多拦 |
| 类别层 | category.test.mjs 70 例：归类、优先级合并取严、LOCKED 四类钳制、unknown/harnessInternal 恒 inherit、信任目录模式与敏感名熔丝 |
| 确认制学习 | contract 内 learning 族：签名剪枝（dynamic/glob/quoted/冒号形参/危险头命令）、confirmActionFor 三态、learnGateEligible 双门、evict TTL/LRU、lookup 工作区隔离、cap 状态 |
| diff 预览 | editdiff.test.mjs 33 例：LCS 边界、官方语义镜像、倒计时字面量剥离、不可读目标省略规则 |
| 探针 | probe.test.mjs 9 例：temp-root/工作区外拒绝、recent-creates 上限与去旧 |
| 重试 | review retry 族：瞬时故障判定、预算滚动、Retry-After、认证错误不重发 |
| 脱敏 | sanitizeClassifierText/Arguments/ReviewReason（AWS/PEM/sk-/Bearer）；description 在注入边界脱敏 |
| 信任/传输 | isTrustedRequest（loopback Host 要真回路对端、LAN 白名单、空白名单=特权、cross-site/cross-origin 拒）；validateReviewerBaseUrl 明文 http 回环栅栏 |
| 并发/一致性 | createKeyedMutex（同键原子无丢失更新/异键并发/异常保链）；exports↔产物一致性 |
| 摩擦报告/审计渲染 | friction-report.test.mjs：翻案方向（ESCALATE 与 classifier 判定均不可翻案）、空转护栏（无带方向的 LLM 判定 → `VACUOUS`，纯 classifier 窗口不得判通过）、窗口按**最后活动时间**取最近 N 个会话（长命会话不被挤掉）、撤销按时间入窗、失败码直方图（`attempts[].code`，非数组不抛）、参数校验与退出码映射（PASS 0 / FAIL 1 / VACUOUS 2 / INSUFFICIENT 3）；audit-query-format.test.mjs：decision 行形状逐字不变、非决策行按 type 分派并保留真实载荷（`files`/`plane`+`count`+`errors`/`key`/`allows` 等）、`at` 缺失降级为 `?`、参数校验 |
| 权限变更观测 | permission-change.test.mjs：三种权限平面事件读成 `{scope,to}`（`permission/preset` / `sandbox/mode` / `approval/policy`，含 `never`↔`ask` 双向）、畸形与邻近事件不误判、被拒 decision 的 id 指针（最新优先/上限/仅 rejected）、装配锚钉「每一处 `permission-change` 都落在 `appendAuditLine(` 之后且不在 `pushHistory(` 内」 |
| 审计轮转与测试隔离 | audit.test.mjs：`auditRotateContent` 双上界收敛（>5000 行取尾、长行再按字节回扫、单超长行整体保留）、原子替换无 tmp 残留、替换被阻断时原文件不受损、以及**默认审计路径锚定**（`auditFilePath()` 默认必须是 `runtime/audit.jsonl`）。轮转契约要写多兆字节夹具，故全部经测试接缝跑在 scratch 路径上：一旦指向 live 文件，快照/还原会删掉运行中进程在窗口内追加的行，还原 rename 还可能输给并发写入（Windows EPERM）而让 live 位置留下近乎空文件、真实线索困在 `.bak-test` 孤儿里 —— 跑一次测试即可清空审批审计 |
| 内置放行面 | agent-team-tools-allow.test.mjs：Agent Teams 九个真实工具全部落静态放行面（`assessTool`→allow 且 `classifierEligible:false`）与 `harnessInternal` 标签（任何 category 键都收紧不了）；**全六族**跨副本不变式（读取编译后的 policy/category/constants，逐族比对成员，故任何一族新增名字都被覆盖，只有这两个族被覆盖时会漏掉其余四族）；**负向**锚定「近似名不得同车放行」（子串/家族/大小写变体）与「包内非工具标识符永不入列」（systemPrompt section id、事件名）；以及「**风险升级显式例外表**」——集合成员在风险正则之前返回，故命中 `RISK_NAME_PATTERN` 的名字其升级通道被静默关闭，新名字必须显式登记理由否则测试失败（另配一条反向用例防止正则本身失效）；default-allow-catalog.test.mjs 钉 catalog→policy 单向，本文件补 policy→catalog 方向 |

73 个测试文件，合计 **1092 例**（node --test 全绿基线）。

## 15.2　验收命令与运行时证据

::: tip 本地验收（npm 全局 dsh、无源码仓库布局时）

```bash
node_modules/.bin/tsc -p tsconfig.json   # 类型（policy/shell/paths 不再 @ts-nocheck）
node_modules/.bin/tsdown                  # 客户端 bundle
node --test "tests/**/*.test.mjs"        # 1043/1043 全绿
```

:::

::: tip 运行时验证（重启 dsh 后，Playwright/HTTP 硬证据）

```bash
node scripts/verify-auth.mjs      # 伪造 Host/cross-site/cross-origin → 403
node scripts/verify-config.mjs    # GET /settings 捕获基线
node scripts/mock-reviewer.mjs    # 127.0.0.1:18777 mock 评审器（确定性 ALLOW/MEDIUM）
node scripts/verify-runtime.mjs   # 端到端运行时验证（配置下发 + 审批链路时间线）
# 审批链路：approval-debug.jsonl 的 request→review→follow→resolve 时间线
```

:::