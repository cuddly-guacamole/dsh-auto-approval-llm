# 14 · 代码地图与构建发布

> *Where is everything*

## 14.1　源码树

```text
src/
├─ index.ts           宿主编排：apply()、事件接线、10 路由、命令、评审器、审计  ≈ 2189 行
├─ auto/              静态评估纯函数层（§03 已列 13 文件）                        ≈ 3280 行
│    ├─ policy.ts  assessTool 第一次分类       shell.ts  bash/pwsh 分析（最大 862 行）
│    ├─ decision.ts 纯决策函数 520 行          paths.ts 路径保护 185 行
│    └─ rules.ts/classifier.ts/dsh-classifier.ts/trust.ts/artifacts.ts/audit.ts/review-mode.ts/constants.ts/risk-tokens.ts
└─ client/
     ├─ index.ts      React 客户端主体 2170 行（设置卡/面板增强/轮询/浮动按钮/CSS）
     ├─ auto-icon.ts  权限菜单图标 + Auto 风险确认弹窗 451 行
     └─ locale.ts     zh/en 双语 262 行

tests/
├─ contract.test.mjs        100 例（host 纯函数契约）
└─ contract-devloop.test.mjs 13 例（开发闭环回归）
scripts/
├─ build.sh         （DSH 源码仓库布局）tsc 编译 src→lib
├─ audit-query.mjs   审计查询 CLI
└─ link-client-packs.cjs
verify-*.mjs         4 个运行时验证脚本（auth 边界 / 配置捕获 / 配置下发 / mock 评审器）
```

## 14.2　构建 → 产物

**host（tsc）**：`src/index.ts + src/auto/*` → `lib/index.js + lib/auto/*`。本机为 npm 全局安装、无 packages/vendor 布局，build.sh 探针会失败 → 直接 `node_modules/.bin/tsc -p tsconfig.json`。

**client（tsdown）**：`src/client/index.ts` → `lib/client.js`（CJS / browser platform），banner 包 `window.__ModuleLoader__.load({id, factory})`；声明依赖（react/slots/primitives/runtime）外部化，其余打包。文件头保留 dsh-auto-mode 的 MIT 致谢。

**bundle 层（patch.yml）**：权限预设（auto = danger-full-access + approval ask，**禁飙到 never**）+ 装包配置覆盖（`autoSwitchPolicyToAsk:true`、`humanOnlyList:[bash]`）。

**exports**：`.`（lib/index.js + types）、`./client`（lib/client.js + types contact）、`./package.json`；peerDeps 全覆盖（cordis ≥4<5、dsh-llm/dsh-tools ≥0.1.0-rc.0<2、schemastery ^3.18.0）── 0.1.1-rc.1 兼容性已验。