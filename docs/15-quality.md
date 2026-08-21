# 15 · 质量保障体系

> *113 tests · runtime proofs*

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
| 脱敏 | sanitizeClassifierText/Arguments/ReviewReason（AWS/PEM/sk-/Bearer）；description 在注入边界脱敏 |
| 信任/传输 | isTrustedRequest（loopback Host 要真回路对端、LAN 白名单、空白名单=特权、cross-site/cross-origin 拒） |
| 并发/一致性 | createKeyedMutex（同键原子无丢失更新/异键并发/异常保链）；exports↔产物一致性 |

## 15.2　验收命令与运行时证据

::: tip 本地验收（npm 全局 dsh、无源码仓库布局时）

```bash
node_modules/.bin/tsc -p tsconfig.json   # 类型（policy/shell/paths 不再 @ts-nocheck）
node_modules/.bin/tsdown                  # 客户端 bundle
node --test "tests/**/*.test.mjs"        # 113/113 全绿
```

:::

::: tip 运行时验证（重启 dsh 后，Playwright/HTTP 硬证据）

```bash
node verify-auth.mjs            # 伪造 Host/cross-site/cross-origin → 403
node verify-config.mjs          # GET /settings 捕获基线
node verify-mock-reviewer.mjs   # 127.0.0.1:18777 mock 评审器（确定性 ALLOW/MEDIUM）
node verify-config-set.mjs      # 下发 mock 评审配置
# 审批链路：approval-debug.jsonl 的 request→review→follow→resolve 时间线
```

:::

::: warning 已知欠账
① 第三轮重构（a9fadf5）后的**重启 + Playwright 运行时硬证据**尚未补（低风险等价改动、113 测试全绿，用户偏好「先提交、运行时延后」）；② `timeoutNotice` 文案说「再失败 N 次熔断移交」，但评审失败路径实际**不计**熔断 —— 文案与行为不一致（安全无害，属文案瑕疵）；③ README 中倒计时 3/5/10 与代码 5/8/10 不一致；④ T-P2-5「上帝文件拆分」（两个 2100+ 行文件）暂缓。
:::