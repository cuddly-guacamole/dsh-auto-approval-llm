# 16 · 演进时间线
> *How it got here*

| 阶段 | 内容 |
|---|---|
| 移植 | 核心审批管线移植自 `@nanmicoder/dsh-auto-mode`（MIT）并在 `src/auto/` 重写为独立实现（移除它也能跑）；设置界面范式参考 `@anionex/dsh-vision-toolkit`。 |
| B1 / B2 / B3 | 声明式规则（rulesText）· append-only 审计（audit.jsonl）· 每会话评审模式（review-mode.json）。 |
| P0 重构 `083be21` | policy.ts / shell / paths 去 `@ts-nocheck` 进入 typecheck；风险正则去重为单一事实源（risk-tokens.ts）；删除死代码（detectConflicts / reviewerDecidable / isLowRisk）。 |
| P1+P2 重构 `a9fadf5` | sessionModelRoute / resolveModelRoute 统一路由；`THRESHOLD_DEFAULTS` 集中阈值；`staticListDecision` 纯函数＋熔断隔离契约测试；timeoutNotice 重命名消遮蔽；approvalState 注册表聚合清理；build.sh 注释；exports↔产物一致性测试。113/113 全绿（dsh 0.1.1-rc.1 下复验）。 |
| 兼容验证 | dsh 0.1.1-rc.1 发布后逐项核对 peerDependencies 与调用 API 签名一致，无需改文件，基线复验全绿。 |

::: tip 3 个子代理独立分析（架构/正确性安全/可维护性）+ 第二轮交叉验证
整个重构周期的安全检查方式：**3 个子代理独立分析（架构/正确性安全/可维护性）+ 第二轮交叉验证** —— 结论是「fail-closed 安全内核已稳固，无需为安全强制重构」，只做了可维护性/一致性技术债清理。
:::