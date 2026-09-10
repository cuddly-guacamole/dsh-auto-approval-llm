# 14 · 代码地图与构建发布

> *Where is everything*

## 14.1　源码树

```text
src/
├─ index.ts              宿主编排：apply()、四挂点接线、14 路由、命令、评审器、审计、学习接线  4534 行
├─ auto/                 静态评估纯函数层（25 文件，按字母序）
│    ├─ artifacts.ts     104  本会话成功创建路径登记（删除豁免依据）
│    ├─ audit.ts         94   append-only 审批审计（清空留墓碑、5MiB 保尾）
│    ├─ category.ts      751  11 类三态开关层：归类/优先级合并/指令钳制/信任目录模式
│    ├─ classifier.ts    95   预分类提示词、参数脱敏、严格响应解析
│    ├─ constants.ts     112  数值默认唯一事实源（倒计时/熔断/截断/学习族阈值）
│    ├─ decision.ts      842  纯决策函数：评审解析、人机竞速、来源标注、熔断、静态名单、host-only 键
│    ├─ dsh-classifier.ts 140  复用 ctx.llm 的低 token 分类请求（temperature 0）
│    ├─ editdiff.ts      451  编辑类工具行级 diff 预览（LCS、官方语义镜像、倒计时字面量剥离）
│    ├─ endpoint-call.ts 134  共享端点连通性探测与模型校验
│    ├─ latency.ts       153  LLM 评审耗时环形缓冲（settled/aborted 二分、1MB 轮转）
│    ├─ learning.ts      566  确认制学习：签名、计数、回收、查找、消费闸
│    ├─ model-channel.ts 119  模型通道路由与 provider 选择
│    ├─ paths.ts         257  路径规范化、受保护/关键路径判定、运行态文件名单
│    ├─ permission-change.ts 130  权限平面变更观测：逐平面基线门控 + 被拒 decision 指针
│    ├─ policy.ts        401  assessTool 确定性第一遍分类（17 步）
│    ├─ probe.ts         72   工作区事实只读探针（reviewerContextFacts 的元数据来源）
│    ├─ redact.ts        207  秘密脱敏器（token/AWS/PEM/Bearer…，供参数/评审理由/骨架/结果共用）
│    ├─ retry.ts         185  LLM 复审自动重试（瞬时故障判定、预算滚动、Retry-After）
│    ├─ review-mode.ts   56   每会话评审模式持久化快照
│    ├─ risk-tokens.ts   24   HIGH 风险正则（NAME/REASON 单一事实源）
│    ├─ rules.ts         407  声明式规则解析/求值（host 与浏览器共用）
│    ├─ shell.ts         1414 bash/pwsh 词法分解 + 整行熔断 + 逐段静态分类（最大单文件）
│    ├─ symlink.ts       120  符号链接创建与目标校验
│    ├─ tool-stats.ts    94   工具调用统计收集
│    └─ trust.ts         271  web 路由信任平面（loopback/LAN 边界、Host 伪造防护、在线端点 URL 校验）
└─ client/
     ├─ index.ts         React 客户端主体 3058 行（设置卡 7 子卡/面板增强/应答 watcher 装配/浮动按钮/CSS）
     ├─ approvals/       应答模块（0.0.12 起；0.0.16 起单协议——remote 源适配 + shared 协议无关核心；rc.2 legacy/feature 已删）
     │    ├─ remote.ts       294
     │    └─ shared.ts       518
     ├─ auto-icon.ts     权限菜单图标 + Auto 风险确认弹窗 632 行
     ├─ locale.ts        zh/en 双语 496 行
     └─ tool-chips.ts    150  工具芯片

tests/
├─ contract.test.mjs / category.test.mjs / classifier.test.mjs / redact.test.mjs
├─ editdiff.test.mjs / probe.test.mjs / history-robust.test.mjs / audit.test.mjs
├─ approvals-protocol.test.mjs / contract-devloop.test.mjs / trusted-dsh-subpaths.test.mjs / posix-platform.test.mjs
├─ friction-report.test.mjs / audit-query-format.test.mjs / permission-change.test.mjs
├─ agent-team-tools-allow.test.mjs / default-allow-catalog.test.mjs / default-allow-ui.test.mjs
└─ 合计 987 例（node --test 全绿基线）
scripts/
├─ build.sh             （DSH 源码仓库布局）tsc 编译 src→lib
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

**exports**：`.`（lib/index.js + types）、`./client`（lib/client.js + types contact）、`./package.json`；peerDeps 全覆盖（cordis ≥4.0.1<5、dsh-llm/dsh-tools ≥0.1.5-rc.1<2、schemastery ^3.18.0）── 0.1.5-rc.1 兼容性已验（0.0.16 起只保留 rc.1 契约线，下限随宿主换代同步提高）。