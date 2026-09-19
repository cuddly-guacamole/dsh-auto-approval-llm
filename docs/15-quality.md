# 15 · 质量保障体系

> *1798 tests · runtime proofs*

## 15.1　契约测试覆盖地图（按主题归纳）

| 领域 | 测什么（关键断言摘要） |
|---|---|
| 评审解析 | parseReview 收 fenced/裸 JSON；非法 decision/risk_level/垃圾/长 reason 全拒（fail-closed）；lowRiskReviewOutcome 四则（ALLOW/DENY/ESCALATE/failure）；ALLOW+CRITICAL 升级 |
| 人机竞速 | raceHumanDecision 四分支（人先答/超时/allow 动作/LLM claim 抢占非超时/两者 claimed=false）；来源标注 approvalSource 真值表 |
| 熔断 | breakerTripped 双轨（0 停用）；applyBreaker（human 清零 / llm-deny 自增 / advisory 不增 / 静态名单绕过不计数） |
| 静态名单 | staticListDecision 优先级 deny>allow>humanOnly、精确名；熔断互斥（bypasses a tripped breaker） |
| 声明规则 | parseRulesText（作用域/注释/逐行错误/ReDoS 拒绝/锚定 git-push 匹配命令文本而非 JSON 信封）；evaluateRules 首条命中 |
| 路径/文件熔断 | hardDenyReason（apply_patch 缺目标 fail-closed、workspace 内放行）；isCriticalPath（shell rc、.env） |
| shell 熔断 | 提权（sudo/doas/su/pkexec/runuser/runas/gsudo、brace group、VAR= 前缀、operator 拼接）；exfil（curl/wget/.dsh/.env、动态 home 拼写）；find 破坏性；date 时钟写（-s/--set 及缩写/融合拼写）终裁；只读判定不过多拦 |
| 类别层 | category.test.mjs 110 例：归类、优先级合并取严、LOCKED 四类钳制、unknown/harnessInternal 恒 inherit、信任目录模式与敏感名熔丝 |
| 确认制学习 | contract 内 learning 族：签名剪枝（dynamic/glob/quoted/冒号形参/危险头命令）、confirmActionFor 三态、learnGateEligible 双门、evict TTL/LRU、lookup 工作区隔离、cap 状态 |
| diff 预览 | editdiff.test.mjs 34 例：LCS 边界、官方语义镜像、倒计时字面量剥离、不可读目标省略规则 |
| 探针 | probe.test.mjs 12 例：temp-root/工作区外拒绝、recent-creates 上限与去旧 |
| 重试 | review retry 族：瞬时故障判定、预算滚动、Retry-After、认证错误不重发 |
| 脱敏 | sanitizeClassifierText/Arguments/ReviewReason（AWS/PEM/sk-/Bearer）；description 在注入边界脱敏 |
| 信任/传输 | isTrustedFetchRequest（回环权威接受、非 HTTP scheme 视作载波回环、LAN 白名单、空白名单=特权、cross-site/cross-origin 拒）；validateReviewerBaseUrl 明文 http 回环栅栏 |
| 并发/一致性 | createKeyedMutex（同键原子无丢失更新/异键并发/异常保链）；exports↔产物一致性 |
| 摩擦报告/审计渲染 | friction-report.test.mjs：翻案方向（ESCALATE 与 classifier 判定均不可翻案）、空转护栏（无带方向的 LLM 判定 → `VACUOUS`，纯 classifier 窗口不得判通过）、窗口按**最后活动时间**取最近 N 个会话（长命会话不被挤掉）、撤销按时间入窗、失败码直方图（`attempts[].code`，非数组不抛）、参数校验与退出码映射（PASS 0 / FAIL 1 / VACUOUS 2 / INSUFFICIENT 3）；audit-query-format.test.mjs：decision 行形状逐字不变、非决策行按 type 分派并保留真实载荷（`files`/`plane`+`count`+`errors`/`key`/`allows` 等）、`at` 缺失降级为 `?`、参数校验 |
| 权限变更观测 | permission-change.test.mjs：三种权限平面事件读成 `{scope,to}`（`permission/preset` / `sandbox/mode` / `approval/policy`，含 `never`↔`ask` 双向）、畸形与邻近事件不误判、被拒 decision 的 id 指针（最新优先/上限/仅 rejected）、装配锚钉「每一处 `permission-change` 都落在 `appendAuditLine(` 之后且不在 `pushHistory(` 内」 |
| 审计轮转与测试隔离 | audit.test.mjs：`auditRotateContent` 双上界收敛（>5000 行取尾、长行再按字节回扫、单超长行整体保留）、原子替换无 tmp 残留、替换被阻断时原文件不受损、以及**默认审计路径锚定**（`auditFilePath()` 默认必须是 `runtime/audit.jsonl`）。轮转契约要写多兆字节夹具，故全部经测试接缝跑在 scratch 路径上：一旦指向 live 文件，快照/还原会删掉运行中进程在窗口内追加的行，还原 rename 还可能输给并发写入（Windows EPERM）而让 live 位置留下近乎空文件、真实线索困在 `.bak-test` 孤儿里 —— 跑一次测试即可清空审批审计 |
| 内置放行面 | agent-team-tools-allow.test.mjs：Agent Teams 九个真实工具全部落静态放行面（`assessTool`→allow 且 `classifierEligible:false`）与 `harnessInternal` 标签（任何 category 键都收紧不了）；**全六族**跨副本不变式（读取编译后的 policy/category/constants，逐族比对成员，故任何一族新增名字都被覆盖，只有这两个族被覆盖时会漏掉其余四族）；**负向**锚定「近似名不得同车放行」（子串/家族/大小写变体）与「包内非工具标识符永不入列」（systemPrompt section id、事件名）；以及「**风险升级显式例外表**」——集合成员在风险正则之前返回，故命中 `RISK_NAME_PATTERN` 的名字其升级通道被静默关闭，新名字必须显式登记理由否则测试失败（另配一条反向用例防止正则本身失效）；default-allow-catalog.test.mjs 钉 catalog→policy 单向，本文件补 policy→catalog 方向 |
| 客户端开销 | perf-settings-rules-parse.test.mjs（声明规则每次渲染只解析一次）/ perf-poll-backoff.test.mjs（`nextPollDelayMs` 表驱动 + 阳性上界封顶 + 故障期次线性增长 + 恢复即回基准 + 负向「延迟恒正」）/ perf-scan-throttle.test.mjs（可注入时钟的 trailing 节流：合并、**尾随不丢**、dispose 取消、锚定 `@ts-nocheck` 的 auto-icon 编译产物真带接线） |
| 授权证据窗口与人工出手率 | trusted-intent-window.test.mjs：4 条证据窗口的溢出计数（slot cap 后重复候选=去重不计、独有候选=溢出计、inbox 先入、逐文本截断与预算的交互、经超长问题答案触达预算的真实路径、被拒文本重复出现计双）、拒因 note 的零/非零两分支与措辞纪律（无 retry/approve 字面、无 dangling 值）、deny 落点结构锚、trusted-intents 事件量化 `overflowed` 标志进去重签名、audit-query 对该字段的渲染与缺字段静默 / client-human-gate.test.mjs：人工来源名单与 `scripts/friction-report.mjs` **运行时 import 逐项相等**、空窗口判 vacuous 不作零声称、缺 source/非字符串 source 只进分母、round 边界、中英三键齐备且文案带窗口限定、bundle 装配锚（派生调用 + 三个浮层状态键） |
| 循环防护 | loop-guard.test.mjs：循环键稳定（对象键序无关、工具名入键、缺参数回退工具级键）、严格连续状态机（`a→a→b→a` 永不触发、count===threshold 恰触发一次、fire-and-reset 人工放行不买豁免）、有界 64（最近最少更新者先淘汰：重触的键存活、被淘汰的是次旧键）、阈值钳制（1→2 带 warned、非数值=关、floor 在钳制前）/ loop-guard-wiring.test.mjs：**恰四个**自动放行站点被门控（src+编译产物双计）、allowlist 与 rule-allow 通道负向切片零命中、跨面标记读位于 deny 终局之后且先于 static allow、one-shot 读即删、pinned 形状恰三处且先于 `learnAttempt`（无 takeover handle、无 learnable、reject 钉死）、门函数体无 pushHistory/无熔断、disposal 与 sweep 有界、audit-query 渲染 `consecutive`/`threshold` |

204 个测试文件，合计 **1798 例**（node --test 全绿基线）。

## 15.2　验收命令与运行时证据

::: tip 发布前门禁（单命令）

```bash
npm run gate   # 清构建产物 → 类型 → 构建 → 全量测试 → 数字/锚点 → 打包冒烟 → 装配断言
```

`scripts/gate.mjs` 在类型/构建/全量测试之外再加三步：把打包出的 tarball 解到临时目录，按 dsh 的方式加载 `lib/index.js` 与 `lib/client.js`（断言注册 id 与 factory）；用刚跑完的实跑用例数核对文档数字；跑 `dsh --profile web --dump-config` 断言 loader 树里仍有本插件 entry。**只有"本机没装 dsh"才 WARN 跳过该步；dsh 在但 dump-config 失败或挂死（装配坏）仍判失败**。任一步失败即非零退出并打印失败步骤。

:::

::: tip 本地验收（npm 全局 dsh、无源码仓库布局时）

```bash
node_modules/.bin/tsc -p tsconfig.json   # 类型（policy/shell/paths 不再 @ts-nocheck）
node_modules/.bin/tsdown                  # 客户端 bundle
node --test "tests/**/*.test.mjs"        # 1798/1798 全绿
```

:::

::: tip 宿主下限线（0.1.5-rc.2 / 0.1.6-alpha.1 / 0.1.6-alpha.2）

```bash
npm run test:host-lines               # 每条承诺线各装一次
npm run test:host-lines -- --line rc2 # 只跑最低支持线
```

`scripts/test-host-lines.mjs` 在 `os.tmpdir()` 前缀里按精确版本装出 peer 并集承诺的每条宿主线，再把编译后的判定层驱动到该线真实的 `permission-presets` 服务上：断言每个 `@deepseek-ai/dsh-*` 恰为目标版本、能力探测落该线档位（rc.2 = legacy，0.1.6-alpha.1 / 0.1.6-alpha.2 = modern）、同签名迁移在真实包上通过、`dfa+never` 原样保留；装错线或读错档位即红（含同前缀内的反向对照）。安装前缀只落在 `os.tmpdir()`，不触碰仓库 `node_modules`。该入口需要 npm registry 访问，故列为发版前手工步骤，不并入离线的 `npm run gate`；新增宿主线时在 `HOST_LINES` 加一行；同一 tuple 内上游发布更高预发布版时，首次安装后把浮高的传递 `dsh-*` 一并写进 `overrides` 二次安装，保证整树落在目标线。`session` 与 `sessionProjections` 状态机是测试桩；权限服务类与投影注册/`apply` 来自真实包。

:::

::: tip 运行时验证（重启 dsh 后，Playwright/HTTP 硬证据）

```bash
node scripts/verify-auth.mjs                          # 载波组合栅栏：回环无会话→401；伪造 Host/cross-site/cross-origin→403
node scripts/verify-auth.mjs --url '<startup-url>'    # 换启动令牌后回环→200（启动 URL 只在操作者终端传入）
node scripts/verify-config.mjs --url '<startup-url>'  # GET /settings 捕获基线（web 载体需会话）
node scripts/mock-reviewer.mjs                        # 127.0.0.1:18777 mock 评审器（确定性 ALLOW/MEDIUM）
node scripts/verify-runtime.mjs --url '<startup-url>' # 端到端运行时验证（配置下发 + 审批链路时间线）
# 审批链路：approval-debug.jsonl 的 request→review→follow→resolve 时间线
# web 载体在插件 handler 之前先做 Host/Origin 栅栏 + 会话认证：无会话回环→401；
# --url/--cookie-file 由操作者终端提供会话，插件自身判定由 trusted-fetch-request 单测钉
```

:::