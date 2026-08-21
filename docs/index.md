---
layout: home

hero:
  name: dsh-auto-approval-llm
  text: 工作原理详解
  tagline: 从「模型发起一次工具调用」到「一条审计记录落盘」的完整旅程 —— 每个数字、每个模块名、每个判定顺序均核对自源码。
  actions:
    - theme: brand
      text: 开始阅读
      link: /01-system-overview
    - theme: alt
      text: GitHub
      link: https://github.com/cuddly-guacamole/dsh-auto-approval-llm
---

<div class="homebadges">
  <a href="https://www.npmjs.com/package/@quill507/dsh-auto-approval-llm" target="_blank" rel="noopener"><img src="https://img.shields.io/npm/v/%40quill507%2Fdsh-auto-approval-llm?style=flat-square&color=58a6ff" alt="npm version"></a>
  <a href="https://github.com/cuddly-guacamole/dsh-auto-approval-llm/releases" target="_blank" rel="noopener"><img src="https://img.shields.io/github/v/release/cuddly-guacamole/dsh-auto-approval-llm?style=flat-square&color=3fb950" alt="GitHub release"></a>
  <a href="https://github.com/cuddly-guacamole/dsh-auto-approval-llm/blob/main/README.md" target="_blank" rel="noopener"><img src="https://img.shields.io/badge/platform-DeepSeek%20Harness-8b949e?style=flat-square" alt="platform"></a>
  <a href="https://opensource.org/licenses/BSD-3-Clause" target="_blank" rel="noopener"><img src="https://img.shields.io/badge/license-BSD--3--Clause-d29922?style=flat-square" alt="license"></a>
  <a href="https://www.typescriptlang.org/" target="_blank" rel="noopener"><img src="https://img.shields.io/badge/TypeScript-5.9-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"></a>
</div>

> 为 DeepSeek Harness 的 **Auto 权限档**提供 LLM 辅助自动审批 + 超时自动兜底。
> Auto 档 = `sandbox: danger-full-access` + `approval: ask`。本插件在 Auto 会话里充当 `approval/request` 的**唯一终结裁决者**：常规操作放行、危险/模糊操作交给「静态规则 → LLM 分类 → LLM/人工裁决 → 倒计时兜底 → 熔断」的自动管线，把「自动但安全」的吞吐做高，同时保证有人工与审计兜底。

## 核心数字

| 低/中/高 风险倒计时（默认） | 熔断：连续 \| 累计 | 预分类超时 · 评审跟随风险档 | maxArgsChars 参数截断 | HTTP 路由 | history / audit 窗口 |
|---|---|---|---|---|---|
| `5 / 8 / 10 s` | `3 \| 20` | `8 s` · `5/8/10s` | `4,000` | `10 条`（无 RPC） | `200 条 / 5000 行` |

## 章节导航

### 开始

<div class="navgrid">
  <a class="navcard" href="/dsh-auto-approval-llm/01-system-overview"><span class="nn">01</span><span class="nt">系统总览</span><span class="nd">浏览器 ↔ Host ↔ DSH 内核 ↔ LLM ↔ 落盘</span></a>
  <a class="navcard" href="/dsh-auto-approval-llm/02-tool-call-lifecycle"><span class="nn">02</span><span class="nt">一次工具调用的生命周期</span><span class="nd">五个钩子一条链</span></a>
</div>

### 核心管线

<div class="navgrid">
  <a class="navcard" href="/dsh-auto-approval-llm/03-static-engine"><span class="nn">03</span><span class="nt">静态评估引擎</span><span class="nd">src/auto/* 纯函数层</span></a>
  <a class="navcard" href="/dsh-auto-approval-llm/04-adjudicator-pipeline"><span class="nn">04</span><span class="nt">approval/request 终局裁决</span><span class="nd">唯一终结者内部</span></a>
</div>

### 决策与控制

<div class="navgrid">
  <a class="navcard" href="/dsh-auto-approval-llm/05-risk-matrix"><span class="nn">05</span><span class="nt">风险分档与倒计时矩阵</span><span class="nd">LOW/MEDIUM/HIGH × 三种动作</span></a>
  <a class="navcard" href="/dsh-auto-approval-llm/06-llm-reviewer"><span class="nn">06</span><span class="nt">LLM 评审器</span><span class="nd">reasoning-blind 双通道</span></a>
  <a class="navcard" href="/dsh-auto-approval-llm/07-human-race"><span class="nn">07</span><span class="nt">人机竞速与超时仲裁</span><span class="nd">谁说了算</span></a>
  <a class="navcard" href="/dsh-auto-approval-llm/08-breaker"><span class="nn">08</span><span class="nt">熔断器状态机</span><span class="nd">3 次连续 / 20 次累计</span></a>
</div>

### 安全与界面

<div class="navgrid">
  <a class="navcard" href="/dsh-auto-approval-llm/09-defense-in-depth"><span class="nn">09</span><span class="nt">安全纵深九层</span><span class="nd">从预设门到审计碑</span></a>
  <a class="navcard" href="/dsh-auto-approval-llm/10-client-ui"><span class="nn">10</span><span class="nt">客户端 UI 结构</span><span class="nd">设置卡 + 面板劫持 + 轮询</span></a>
  <a class="navcard" href="/dsh-auto-approval-llm/11-data-persistence"><span class="nn">11</span><span class="nt">数据与持久化</span><span class="nd">四个 JSONL 文件</span></a>
  <a class="navcard" href="/dsh-auto-approval-llm/12-config"><span class="nn">12</span><span class="nt">配置全景</span><span class="nd">28 键 schema + bundle 覆盖</span></a>
  <a class="navcard" href="/dsh-auto-approval-llm/13-http-api"><span class="nn">13</span><span class="nt">HTTP API 面</span><span class="nd">10 条路由与其信任平面</span></a>
</div>

### 工程

<div class="navgrid">
  <a class="navcard" href="/dsh-auto-approval-llm/14-code-map"><span class="nn">14</span><span class="nt">代码地图与构建发布</span><span class="nd">tsc + tsdown + patch 层</span></a>
  <a class="navcard" href="/dsh-auto-approval-llm/15-quality"><span class="nn">15</span><span class="nt">质量保障体系</span><span class="nd">113 测试 + 运行时验证</span></a>
  <a class="navcard" href="/dsh-auto-approval-llm/16-axioms"><span class="nn">16</span><span class="nt">设计公理</span><span class="nd">为什么不追求完美</span></a>
</div>