# 14 · 代码地图与构建发布

> *Where is everything*

## 14.1　源码树

```text
src/
├─ index.ts              宿主编排：apply()、四挂点接线、14 路由、命令、评审器、审计、学习接线  4973 行
├─ auto/                 静态评估纯函数层（26 文件，按字母序）
│    ├─ artifacts.ts     124  本会话成功创建路径登记（删除豁免依据）
│    ├─ audit.ts         141  append-only 审批审计（清空留墓碑、5MiB 保尾）
│    ├─ category.ts      827  12 类三态开关层：归类/优先级合并/指令钳制/信任目录模式
│    ├─ classifier.ts    100  预分类提示词、参数脱敏、严格响应解析
│    ├─ constants.ts     116  数值默认唯一事实源（倒计时/熔断/截断/学习族阈值）
│    ├─ decision.ts      852  纯决策函数：评审解析、人机竞速、来源标注、熔断、静态名单、host-only 键
│    ├─ dsh-classifier.ts 140  复用 ctx.llm 的低 token 分类请求（temperature 0）
│    ├─ editdiff.ts      451  编辑类工具行级 diff 预览（LCS、官方语义镜像、倒计时字面量剥离）
│    ├─ endpoint-call.ts 134  共享端点连通性探测与模型校验
│    ├─ latency.ts       159  LLM 评审耗时环形缓冲（settled/aborted 二分、1MB 轮转）
│    ├─ learning.ts      566  确认制学习：签名、计数、回收、查找、消费闸
│    ├─ loop-guard.ts    95   循环防护纯核：循环键（工具+脱敏参数哈希）、严格连续计数、fire-and-reset、阈值钳制（接线在 index.ts 的四个自动放行站点）
│    ├─ model-channel.ts 119  模型通道路由与 provider 选择
│    ├─ paths.ts         310  路径规范化、受保护/关键路径判定、受保护读取例外（Git ref 元数据）、运行态文件名单
│    ├─ permission-change.ts 130  权限平面变更观测：逐平面基线门控 + 被拒 decision 指针
│    ├─ policy.ts        574  assessTool 确定性第一遍分类（17 步）
│    ├─ probe.ts         72   工作区事实只读探针（reviewerContextFacts 的元数据来源）
│    ├─ redact.ts        207  秘密脱敏器（token/AWS/PEM/Bearer…，供参数/评审理由/骨架/结果共用）
│    ├─ retry.ts         184  LLM 复审自动重试（瞬时故障判定、预算滚动、Retry-After）
│    ├─ review-mode.ts   52   每会话评审模式持久化快照
│    ├─ risk-tokens.ts   24   HIGH 风险正则（NAME/REASON 单一事实源）
│    ├─ rules.ts         434  声明式规则解析/求值（host 与浏览器共用）
│    ├─ runtime-paths.ts 293  运行态文件唯一路径 owner（`<DSH_HOME>/auto-approval-llm/` 规范位置；目录无法创建/拒绝写入时 fail-closed——append 失败返回 undefined，由调用方拒绝裁决，不回退包根、不搬家；open 阶段错误允许同路径重试一次，写后错误不重试）
│    ├─ shell.ts         1922 bash/pwsh 词法分解 + 整行熔断 + 逐段静态分类（最大单文件）
│    ├─ symlink.ts       182  符号链接创建与目标校验
│    ├─ tool-stats.ts    94   工具调用统计收集
│    └─ trust.ts         271  web 路由信任平面（loopback/LAN 边界、Host 伪造防护、在线端点 URL 校验）
└─ client/
     ├─ index.ts         React 客户端主体 3069 行（设置卡 7 子卡/面板增强/应答 watcher 装配/浮动按钮/CSS）
     ├─ approvals/       应答模块（0.0.12 起；0.0.16 起单协议——remote 源适配 + shared 协议无关核心；rc.2 legacy/feature 已删）
     │    ├─ remote.ts       293
     │    └─ shared.ts       518
     ├─ auto-icon.ts     权限菜单图标 + Auto 风险确认弹窗 631 行
     ├─ locale.ts        zh/en 双语 550 行
     ├─ human-gate.ts    浮层「人工出手率」派生（HUMAN_SOURCES 与 scripts/friction-report 同源）
     └─ tool-chips.ts    150  工具芯片

tests/
├─ contract.test.mjs / category.test.mjs / classifier.test.mjs / redact.test.mjs
├─ editdiff.test.mjs / probe.test.mjs / history-robust.test.mjs / audit.test.mjs
├─ approvals-protocol.test.mjs / contract-devloop.test.mjs / trusted-dsh-subpaths.test.mjs / posix-platform.test.mjs
├─ friction-report.test.mjs / audit-query-format.test.mjs / permission-change.test.mjs
├─ agent-team-tools-allow.test.mjs / retired-agent-teams-spelling.test.mjs / default-allow-catalog.test.mjs / default-allow-ui.test.mjs
├─ opaque-line-target-fuse.test.mjs / changer-base-reset.test.mjs / view-reader-parity.test.mjs / cd-relative-anchor.test.mjs
├─ protected-read-credential-floor.test.mjs / protected-auto-review.test.mjs / audit-rejection-category.test.mjs
├─ docs-anchors.test.mjs / artifact-deletion-exemption.test.mjs / runtime-paths.test.mjs
├─ guard-deny-decision.test.mjs / feedback-route-write.test.mjs / history-route-clear.test.mjs
├─ runtime-write-fallback.test.mjs（规范目录拒写：open 阶段失败继续 fail-closed 不搬家、非位置类错误不重试、重试集仅含 open 阶段错误、写失败阶梯重试同一路径且无 relocation 步骤）
├─ audit-shell-symlink-guard.test.mjs（shell 操作数提取 + 收窄型逃逸裁定 + 等价拼写族 + 负向控制）
├─ perf-settings-rules-parse.test.mjs / perf-poll-backoff.test.mjs / perf-scan-throttle.test.mjs （客户端开销：单次解析、轮询退避、扫描节流）
├─ trusted-intent-window.test.mjs（授权证据窗口溢出计数：slot cap/去重/预算交互、拒因 note 两分支、trusted-intents 事件量化 overflowed 标志）/ client-human-gate.test.mjs（浮层人工出手率：与 friction-report 同源名单、空窗口不作零声称、round 边界、中英三键、bundle 装配锚）
├─ loop-guard.test.mjs（循环键稳定性/回退、严格连续+fire-and-reset 状态机、FIFO 64、阈值钳制与 resolveConfig 映射）/ loop-guard-wiring.test.mjs（四站点成对锚、allowlist 与 rule-allow 豁免负向切片、跨面标记读位置与 one-shot、pinned 形状先于 learnAttempt、门不写 history 不碰熔断、disposal/sweep 有界、audit-query 渲染）
└─ 合计 153 个 tests/*.test.mjs（node --test 全绿基线）
scripts/
├─ build.sh             （DSH 源码仓库布局）tsc 编译 src→lib
├─ clean-lib.mjs        构建前清空 lib/（tsc 不删除已删源的旧产物）
├─ gate.mjs             本地发布前门禁（类型/构建/全量测试/数字/锚点/打包冒烟/dsh 装配断言）
├─ check-anchors.mjs    docs 源码锚点校验器（符号/字面量锚；无法解析的 span 亦判失败，默认只读）
├─ check-doc-numbers.mjs 文档里的测试文件数与用例数核对器（默认只读；--observed 接实跑值）
├─ sync-doc-numbers.mjs 把各声明点按实测值就地改写（配套核对器，避免手改漏项）
├─ audit-query.mjs      审计查询 CLI（decision 行 + 按 type 渲染的观测事件行）
├─ friction-report.mjs  摩擦报告 CLI（面板介入率 / 倒计时结算率 / 翻案交叉表 / 评审通道落定率 / 无人值守窗口判据 + 退出码）
├─ mock-reviewer.mjs    本地 mock 评审器（127.0.0.1:18777，确定性 ALLOW/MEDIUM）
├─ link-dsh-deps.cjs    把 node_modules/@deepseek-ai/* 重链到已安装 dsh 的同名包（构建期类型与运行期解析同源）
└─ link-client-packs.cjs  把 client 构建期包（primitives/slots）链到 npm pack 解包目录
verify-*.mjs            3 个运行时验证脚本（verify-auth / verify-config / verify-runtime）
```

## 14.2　构建 → 产物

**host（tsc）**：`src/index.ts + src/auto/*` → `lib/index.js + lib/auto/*`。本机为 npm 全局安装、无 packages/vendor 布局，build.sh 探针会失败 → 直接 `node_modules/.bin/tsc -p tsconfig.json`。

**client（tsdown）**：`src/client/index.ts` → `lib/client.js`（CJS / browser platform），banner 包 `window.__ModuleLoader__.load({id, factory})`；声明依赖（react/slots/primitives/runtime）外部化，其余打包。文件头保留 dsh-auto-mode 的 MIT 致谢。

**bundle 层（patch.yml）**：权限预设（auto = danger-full-access + approval ask，**禁飙到 never**）+ 装包配置覆盖（`autoSwitchPolicyToAsk:true`；`humanOnlyList` 保持代码默认空）。

**exports**：`.`（lib/index.js + types）、`./client`（lib/client.js + types contact）、`./package.json`；peerDeps 全覆盖（cordis ≥4.0.1<5、dsh-llm/dsh-tools ≥0.1.5-rc.2<2、schemastery ^3.18.0）── 0.1.5-rc.2 兼容性已验（0.0.16 起只保留单协议契约线，下限随宿主换代同步提高；rc.2 相对 rc.1 在插件接触的全部官方包上 lib 产物逐字节一致）。