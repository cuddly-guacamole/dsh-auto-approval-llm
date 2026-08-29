# 14 · 代码地图与构建发布

> *Where is everything*

## 14.1　源码树

```text
src/
├─ index.ts              宿主编排：apply()、四挂点接线、10 路由、命令、评审器、审计、学习接线  2922 行
├─ auto/                 静态评估纯函数层（20 文件，按字母序）
│    ├─ artifacts.ts     98   本会话成功创建路径登记（删除豁免依据）
│    ├─ audit.ts         45   append-only 审批审计（清空留墓碑、5MiB 保尾）
│    ├─ category.ts      699  11 类三态开关层：归类/优先级合并/指令钳制/信任目录模式
│    ├─ classifier.ts    75   预分类提示词、参数脱敏、严格响应解析
│    ├─ constants.ts     27   数值默认唯一事实源（倒计时/熔断/截断/学习族阈值）
│    ├─ decision.ts      722  纯决策函数：评审解析、人机竞速、来源标注、熔断、静态名单、host-only 键
│    ├─ dsh-classifier.ts 94  复用 ctx.llm 的低 token 分类请求（temperature 0）
│    ├─ editdiff.ts      448  编辑类工具行级 diff 预览（LCS、官方语义镜像、倒计时字面量剥离）
│    ├─ latency.ts       114  LLM 评审耗时环形缓冲（settled/aborted 二分、1MB 轮转）
│    ├─ learning.ts      445  确认制学习：签名、计数、回收、查找、消费闸
│    ├─ paths.ts         213  路径规范化、受保护/关键路径判定、运行态文件名单
│    ├─ policy.ts        370  assessTool 确定性第一遍分类（17 步）
│    ├─ probe.ts         72   工作区事实只读探针（reviewerContextFacts 的元数据来源）
│    ├─ redact.ts        96   秘密脱敏器（token/AWS/PEM/Bearer…，供参数/评审理由/骨架/结果共用）
│    ├─ retry.ts         185  LLM 复审自动重试（瞬时故障判定、预算滚动、Retry-After）
│    ├─ review-mode.ts   52   每会话评审模式持久化快照
│    ├─ risk-tokens.ts   13   HIGH 风险正则（NAME/REASON 单一事实源）
│    ├─ rules.ts         370  声明式规则解析/求值（host 与浏览器共用）
│    ├─ shell.ts         1224 bash/pwsh 词法分解 + 整行熔断 + 逐段静态分类（最大单文件）
│    └─ trust.ts         101  web 路由信任平面（loopback/LAN 边界、Host 伪造防护、在线端点 URL 校验）
└─ client/
     ├─ index.ts         React 客户端主体 2347 行（设置卡 6 子卡/面板增强/双协议 watcher 装配/浮动按钮/CSS）
     ├─ approvals/       双协议应答模块（0.0.12，shared 协议无关核心 253 行 / legacy rc.2 源适配 179 / remote alpha.1 源适配 123 / feature 协议探测 21）
     ├─ auto-icon.ts     权限菜单图标 + Auto 风险确认弹窗 624 行
     └─ locale.ts        zh/en 双语 354 行

tests/
├─ contract.test.mjs         250 例（host 纯函数契约：含评审重试/确认制学习/类别层/diff 预览/上下文探针各族）
├─ category.test.mjs         101 例（类别层专测：归类/优先级/LOCKED 钳制/复合命令合并/信任目录模式）
├─ editdiff.test.mjs          33 例（diff 边界与官方语义镜像）
├─ contract-devloop.test.mjs  19 例（开发闭环回归）
└─ probe.test.mjs              9 例（工作区事实探针边界）

                              合计 412 例（node --test 全绿基线）
scripts/
├─ build.sh             （DSH 源码仓库布局）tsc 编译 src→lib
├─ audit-query.mjs      审计查询 CLI
├─ mock-reviewer.mjs    本地 mock 评审器（127.0.0.1:18777，确定性 ALLOW/MEDIUM）
└─ link-client-packs.cjs
verify-*.mjs            3 个运行时验证脚本（verify-auth / verify-config / verify-runtime）
```

## 14.2　构建 → 产物

**host（tsc）**：`src/index.ts + src/auto/*` → `lib/index.js + lib/auto/*`。本机为 npm 全局安装、无 packages/vendor 布局，build.sh 探针会失败 → 直接 `node_modules/.bin/tsc -p tsconfig.json`。

**client（tsdown）**：`src/client/index.ts` → `lib/client.js`（CJS / browser platform），banner 包 `window.__ModuleLoader__.load({id, factory})`；声明依赖（react/slots/primitives/runtime）外部化，其余打包。文件头保留 dsh-auto-mode 的 MIT 致谢。

**bundle 层（patch.yml）**：权限预设（auto = danger-full-access + approval ask，**禁飙到 never**）+ 装包配置覆盖（`autoSwitchPolicyToAsk:true`；`humanOnlyList` 保持代码默认空）。

**exports**：`.`（lib/index.js + types）、`./client`（lib/client.js + types contact）、`./package.json`；peerDeps 全覆盖（cordis ≥4<5、dsh-llm/dsh-tools ≥0.1.0-rc.0<2、schemastery ^3.18.0）── 0.1.1-rc.1 兼容性已验。