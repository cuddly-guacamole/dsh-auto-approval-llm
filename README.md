<div align="center">

# @quill507/dsh-auto-approval-llm

**为 DeepSeek Harness 的 Auto 权限档提供 LLM 辅助自动审批 + 超时自动兜底**

*常规操作静态放行 · 危险与模糊操作走 LLM 评审 + 人工倒计时 · 默认 fail-closed*

[![npm](https://img.shields.io/npm/v/@quill507%2Fdsh-auto-approval-llm?style=flat-square&label=npm&labelColor=454a54)](https://www.npmjs.com/package/@quill507/dsh-auto-approval-llm)
[![downloads](https://img.shields.io/npm/dm/@quill507%2Fdsh-auto-approval-llm?style=flat-square&labelColor=454a54)](https://www.npmjs.com/package/@quill507/dsh-auto-approval-llm)
![DSH](https://img.shields.io/badge/DSH-%3E%3D0.1.5--rc.2-4c6ef5?style=flat-square&labelColor=454a54)
[![license](https://img.shields.io/badge/license-BSD--3--Clause-d29922?style=flat-square&labelColor=454a54)](https://opensource.org/licenses/BSD-3-Clause)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

[文档站](https://cuddly-guacamole.github.io/dsh-auto-approval-llm/) · [English](https://github.com/cuddly-guacamole/dsh-auto-approval-llm/blob/main/README.en.md) · [Issues](https://github.com/cuddly-guacamole/dsh-auto-approval-llm/issues)

</div>

`Auto 档`（machine value `auto-approval`；host 显示名 `Auto approval`；中文客户端显示 `自动审批`）= `sandbox: danger-full-access` + `approval: ask`。本插件在本档会话里充当 `approval/request` 的**唯一终结裁决者**：常规操作经静态规则直接放行，危险/模糊操作走「静态规则 → LLM 分类 → LLM/人工裁决 → 倒计时兜底 → 熔断」，全程保留人工与审计兜底。宿主 `>= 0.1.6` 的 `auto` 归上游 `@deepseek-ai/dsh-experimental-auto-review`（Auto review / EXP），；本插件只接管 `auto-approval` 档、上游只接管 `auto` 档（按 derived preset 判档），两者**作用于不同档位、可同时启用**。

---

## 特性

1. **静态规则 + LLM 分类器** —— 只读/会话/工作区常规操作直接放行；危险、外部写、凭据外泄、受保护路径直接拒绝；模糊操作交 LLM 预分类。
2. **写向量完整性加固** —— 含真实文件写重定向的命令段脱离只读快径；POSIX `tee` / `dd of=` / `sed -i` / `truncate` / `install` 以操作数目标参与按目标闸门；直写插件运行态文件无条件硬拒。
3. **12 分类三态开关 + 信任目录双模式** —— 每类可配 `auto` / `ask` / `deny`，**默认全部 `inherit` = 行为零变化**；危险类（delete / protected / disk）锁定为 `ask`；`trustedDirs` 与 `categoryMode` 控制「常规位置」范围。→ [docs/17](https://github.com/cuddly-guacamole/dsh-auto-approval-llm/blob/main/docs/17-category-switches.md)
4. **双通道模型来源** —— 快速判断与深度评审各可独立选择：跟随会话模型（默认）/ DSH 已配置模型 / 自定义端点。端点密钥存 DSH 凭据存储，前端只显示「已配置」、永不回显。
5. **分级倒计时 + 超时兜底 + LLM 接管** —— 低/中/高三档倒计时（默认 5 / 8 / 10 秒）；超时按 `timeoutAction`（拒绝 / 通过 / 低风险自动同意）结算；中风险下 LLM 在窗口内给出明确结论即接管。关浏览器也不悬挂（host 计时器独裁）。
6. **熔断与循环防护** —— 连续/累计被 LLM 拒绝达阈值则转人工（`/approval-reset` 重置）；**循环防护**（默认关）把「被自动放行面连续放行的同一调用」转为钉死拒绝倒计时。
7. **声明式规则 `rulesText`** —— `工具(正则) | allow|deny|human [| 字段]`，支持 `[agent:…]` / `[workspace:…]` 维度限定；解析出错时整段失效（设置卡有警示）。
8. **确认制学习**（默认关）—— 同一签名被人工反复确认达阈值后自动放行，**每次放行前仍过一次标准在线评审**；条目可查看与吊销。→ [docs/18](https://github.com/cuddly-guacamole/dsh-auto-approval-llm/blob/main/docs/18-confirm-learning.md)
9. **编辑 diff 预览 + 上下文增强复审**（均默认关）—— 审批面板展示目标文件行级红绿 diff；复审输入可附加结构化工作区事实。均为纯展示 / 只读元数据，不进任何自动应答路径。
10. **可审计、可观测** —— `history.jsonl` + append-only `audit.jsonl`；LLM 评审真实耗时统计；瞬时网关故障自动重试一次（认证类错误不重发凭据）。

---

## 工作方式

```mermaid
flowchart TD
    A["模型发起工具调用"] --> B["② tools.guard：同步硬拒闸门<br/>凭据 / 受保护路径 / shell 熔断 / symlink 逃逸"]
    B -->|"命中"| X["拒绝结案"]
    B -->|"通过"| C["③ tools/pre-execute：静态评估 + 类别收紧"]
    C -->|"deny"| X
    C -->|"allow"| Y["放行执行"]
    C -->|"ask"| D{"LLM 预分类器快径"}
    D -->|"allow"| Y
    D -->|"deny"| X
    D -->|"不确定"| E["④ approval/request：唯一终结裁决<br/>规则 → 名单 → 类别 → 评审模式 → 熔断 → 学习 → 风险分档"]
    E -->|"LOW / LLM 接管"| Y
    E -->|"MEDIUM / HIGH"| G["人工面板 + 倒计时<br/>LLM 复审并行，超时按 timeoutAction"]
    G -->|"允许一次"| Y
    G -->|"拒绝 / 超时"| X
    Y --> H["⑥ tools/post-execute：结果与拒绝理由回灌模型"]
    X --> H
```

- **LOW**：不送评审则静默放行；送评审时按结论裁决；ESCALATE 转人工。
- **MEDIUM**：面板 + 倒计时并行跑 LLM；`llmTakeoverScope` 覆盖且结论明确 → 立即跟随。
- **HIGH**：面板 + 倒计时，LLM 只给建议；超时严格按 `timeoutAction`。
- 超时标记的唯一作者是 host 计时器，客户端只上报 outcome，伪造不了。

> 完整五段钩子时序（含 ⑤ 产物登记、⑦ 通知投递）见 [docs/02 · 一次工具调用的完整生命周期](https://github.com/cuddly-guacamole/dsh-auto-approval-llm/blob/main/docs/02-tool-call-lifecycle.md)；两层静态面经宿主 `tools/pre-execute` 瀑布征询生效，对端监听的短路形态见 [docs/09 · 可达性前提](https://github.com/cuddly-guacamole/dsh-auto-approval-llm/blob/main/docs/09-defense-in-depth.md)。

---

## 安装

**前置**：会话/预设处于 **Auto 档**（machine value `auto-approval` = `danger-full-access` + `approval: ask`，用 `/permission auto-approval` 切换）；DSH `0.1.5-rc.2`+；Node `^22.19.0 || >=24.0.0`。

兼容窗口：宿主 `>= 0.1.6` 上 `auto` 是上游 `@deepseek-ai/dsh-experimental-auto-review`（Auto review / EXP）的保留名，本插件只定义/接管 `auto-approval`，两者**分档并存、可同时启用**；宿主 `< 0.1.6` 时本插件 gate 仍接受旧机器值 `auto` 别名，但 shipped patch 只定义 `auto-approval`。移除触发 = 最低支持宿主提升到 0.1.6 系列（rc 可用）。

```bash
dsh plugin --profile web add @quill507/dsh-auto-approval-llm
```

- 安装后**重启 dsh**，host 侧才生效。
- **只作用于 Auto 档**（其他权限档不介入）；切换用 `/permission auto-approval`。本插件是 `auto-approval` 档 `approval/request` 的唯一终结者 —— **同一档位不要再叠加第二个审批裁决者**；上游 `@deepseek-ai/dsh-experimental-auto-review` 的 `auto`（Auto review / EXP）是另一个档位，两者可同时启用。
- **平台**：Windows + Git Bash 为主开发/测试基线；macOS / Linux / WSL 代码已适配但无真实用户验证；Android 原生环境不支持。→ [docs/19](https://github.com/cuddly-guacamole/dsh-auto-approval-llm/blob/main/docs/19-platform-support.md)
- **反馈**：到 [GitHub Issues](https://github.com/cuddly-guacamole/dsh-auto-approval-llm/issues) 报告，注明平台、dsh 版本、插件版本、复现命令与预期行为。
- 本地开发：`npx tsc -p tsconfig.json` + `npx tsdown`，以 `link:` 加载（host 改动需重启，client 改动自动热载）。→ [docs/14](https://github.com/cuddly-guacamole/dsh-auto-approval-llm/blob/main/docs/14-code-map.md)

### 从旧 `auto` 档升级

- **同签名门槛**：所有宿主只迁移 `raw preset = auto` 且 `sandbox = danger-full-access` 且 `approval = ask` 的存量会话；其它 `auto` 签名（含 `danger-full-access + never`）一律不迁移并告警。
- **迁移时机**：归档会话不处理，只在 resume 进入 live 时懒迁移（`session/created` prepend）；插件加载时对已 live 会话做一次启动扫描，`agent/created` 兜底。迁移只重写 durable raw identity（`permission/preset`），**不写旋钮、不调用 `permissionPresets.set()`**。
- **自有档 spec enforcement**：`auto-approval` 会话的 effective-never（`approval: never`，或 `approval: null` + base policy `never`）由插件写回 `ask`（`preset-spec-restore` 审计）；不会再翻转上游 `auto`。
- **fail-closed**：宿主 `>= 0.1.6` 且未装上游 auto-review、且该存量会话在 `permissionPresets` 服务构造期已 live（插件来不及先迁移）时，宿主 pin 会先于插件拒绝该会话——**会话打不开，不是静默放行**。处置：停 dsh → 用可选离线迁移工具或手工导出/导入 → 再启动；也可在 profile 保留上游 auto-review 层。该 boot 期缺口在插件侧无法自动修复。
- 官方权限选择器的风险确认只覆盖宿主内置的 `danger-full-access`；自定义 `auto-approval` 档由插件客户端自行弹确认。

---

## 快速开始

1. 把会话/预设切到 **Auto 档**：`/permission auto-approval`。
2. 打开侧边栏 插件 → auto-approval-llm 配置页（更早的宿主线仍在 设置 → 插件 → 自动审批）。**默认配置即可工作**（常规操作静态放行；模糊操作走会话模型评审；超时按 `timeoutAction` 兜底，默认拒绝）。
3. 想让审批走指定模型：在「在线评审模型」卡把通道来源设为「DSH 模型」并从列表选，或选「自定义端点」填协议 / 地址 / 模型 / 密钥 → 保存 → 测试连接。
4. 嫌弹窗频繁：调大「中风险倒计时」，或把「超时动作」改为 `拒绝` / `低风险自动同意`。

> **会话命令**（默认不注册）：`/approval-mode` 查看当前会话模式、`/approval-mode manual|smart|unattended` 设置、`/approval-reset` 与 `/approval-reset-all` 重置熔断 —— 需在设置卡开启 `slashCommandsEnabled` 并重启。

---

## 界面预览

![设置卡总览](https://raw.githubusercontent.com/cuddly-guacamole/dsh-auto-approval-llm/main/assets/settings-overview.png)

![审批面板](https://raw.githubusercontent.com/cuddly-guacamole/dsh-auto-approval-llm/main/assets/approval-panel-countdown-reject.png)

![会话审批统计](https://raw.githubusercontent.com/cuddly-guacamole/dsh-auto-approval-llm/main/assets/session-stats.png)

其余界面的结构说明（计时器与熔断 / 安全规则列表 / 分类开关与信任模式 / 确认制学习 / 在线评审模型 / 权限预设）见 [docs/10 · 客户端 UI](https://github.com/cuddly-guacamole/dsh-auto-approval-llm/blob/main/docs/10-client-ui.md)。

---

## 配置项

下表只列常用键；**全部键、完整语义与裁决例外见 [docs/12 · 配置全景](https://github.com/cuddly-guacamole/dsh-auto-approval-llm/blob/main/docs/12-config.md)**。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | answerer 总开关：关=本插件不再终结 approval/request（静态硬拒与 guard 仍生效） |
| `timeoutAction` | `reject` | 超时动作：拒绝 / 通过 / 仅低风险放行（删除与磁盘恒拒，不受此键影响） |
| `llmReviewScope` | `low-or-above` | 哪些风险档送 LLM 复审 |
| `llmTakeoverScope` | `medium-or-below` | 哪些档允许 LLM 结论直接接管 |
| `lowRiskSeconds` / `mediumRiskSeconds` / `highRiskSeconds` | 5 / 8 / 10 | 三档倒计时（秒） |
| `defaultReviewMode` | `smart` | 每会话评审模式：manual / smart / unattended |
| `maxConsecutiveDenials` / `maxTotalDenials` | 3 / 20 | 熔断阈值（0 关闭） |
| `loopDetectionThreshold` | 0 | 循环防护阈值（0 = 关；仅 YAML 可配） |
| `rulesText` | '' | 声明式规则（支持 `[agent:…]` / `[workspace:…]`） |
| `allowlist` / `denyList` / `humanOnlyList` | [] | 工具名精确匹配名单 |
| `classifierSource` / `reviewerSource` | `session` | 两通道模型来源：session / preset / endpoint |
| `endpointUrl` / `endpointModel` / `endpointProtocol` | '' / '' / `openai` | 共享自定义端点（不再维护但保留） |
| `categoryPolicy` / `categoryMode` / `trustedDirs` | `{}` / `standard` / [] | 分类三态、位置模式与信任目录 |
| `privilegeAutoReview` / `protectedAutoReview` | false | 分别解锁 privilege / protected（差别见 docs/17） |
| `learningEnabled` / `learningThreshold` | false / 3 | 确认制学习开关与阈值（2–10） |
| `editDiffPreview` / `reviewerContextFacts` | false | diff 预览 / 上下文增强复审（仅 YAML 可配）；`editDiffPreview` 计划 0.1.6-rc.1 退役（官方轨迹视图已有同类 diff） |
| `slashCommandsEnabled` / `directHumanEnabled` | false | 注册 `/approval-*` 命令 / 直接人工通道（agent 可把操作路由给人；均需重启生效） |
| `debug` / `redactResults` / `notifyUser` | false / false / true | 调试日志 / 结果脱敏 / 通过通知进会话 |

> 设置卡为可折叠子卡 + 顶层开关即时保存，非法配置值有红色横幅 +「尝试修复」→ [docs/10](https://github.com/cuddly-guacamole/dsh-auto-approval-llm/blob/main/docs/10-client-ui.md)。host-only 键（`workspaceRoot`、`trustedDirs`、`trustedDshSubpaths`、`maintenanceDshPaths`、`rulesDryRun`、`breakerAntiHijackMs`、`reviewMaxRetries` 等）用 patch / YAML 配置，设置卡保存不会抹掉；「高级」子卡把它们连同**当前生效值**列为只读清单（无控件），并说明 DSH_HOME 写入的操作者开口与没有开口的族。

---

## 数据文件

规范位置：`<DSH_HOME>/auto-approval-llm/`（**刻意放在插件包目录之外** —— npm 升级会替换整个包目录）。

| 文件 | 语义 |
|---|---|
| `history.jsonl` | 审批历史（内存窗口 200 条 + 落盘，>1MB 轮转） |
| `audit.jsonl` | append-only 审计：decision + clear 墓碑 + 非决策观测事件 |
| `review-mode.json` | 每会话评审模式快照 |
| `llm-latency.jsonl` | LLM 真实响应耗时统计（最近 100 次，>1MB 轮转） |
| `approval-debug.jsonl` | 仅调试模式开启时写入的评审/审批时序 |
| `learning.json` | 学习条目（SHA-256 签名键 + 脱敏骨架；TTL 30 天，按工作区隔离） |

目录不可写时 **fail-closed**：审计闸拒绝全部裁决并打印一次性告警，不回退、不迁移。查询 `node scripts/audit-query.mjs`；只读摩擦报告 `node scripts/friction-report.mjs`。→ [docs/11](https://github.com/cuddly-guacamole/dsh-auto-approval-llm/blob/main/docs/11-data-persistence.md)

---

## 安全模型摘要

- **唯一终结者**：命中本插件档（`auto-approval`）的 approval 由本插件终结（prepend + global），不双弹窗、不双写；上游 auto-review 的 `auto` 档与本档互不接管，可并存。
- **fail-closed**：评审超时 / 垃圾 / 失败 → 拒绝或转人；ESCALATE 一律转人，不被 `timeoutAction=allow` 自动放行。
- **reasoning-blind**：评审只看工具名 + 结构化脱敏参数 + 有界直接用户消息（唯一授权证据）+ 工作区事实。
- **密钥不出 host**：在线评审密钥存 DSH 凭据，每操作解析，前端仅显「已配置」。
- **审计不可手改**：append-only，清空留 tombstone；`tools/guard` 的硬拒也先落审计再拒绝（审计失败不软化拒绝）。
- **超时标记唯一作者是 host 计时器**，客户端只上报 outcome，伪造不了。

---

## 已知局限

- **对端插件短路时，静态两层与 guard 均不被征询**：另一插件若在 `tools/pre-execute` 瀑布先行返回非决策对象且不带 `reason`，宿主直接派发执行 —— 这是插件侧无法启动期自检的形态。→ [docs/09](https://github.com/cuddly-guacamole/dsh-auto-approval-llm/blob/main/docs/09-defense-in-depth.md)
- **循环防护不是安全边界**：只防「卡死空转」，微调参数即可绕过。
- **`rulesText` 解析出错 = 整段失效**（fail-open 方向）；设置卡有警示但不阻断保存。
- **`protectedAutoReview` 开启且类别未显式配置**时，受保护询问为无倒计时人工询问、**永不自动结算** —— 无人值守会一直等。
- **凭据物质不受解锁开关影响**：`.env` / `.npmrc` 这类读取即便开启 `protectedAutoReview` 仍保持锁定（方向偏严，可能误拒）。
- **opaque 行**（含 `(` / `{` / `$(` / heredoc 的复合命令）在类别层归为 `unknown`：既不被解锁、也不进凭据读取地板，即不额外收紧也不额外放宽。
- **diff 预览涉及的旧内容会随会话 approval/asked 日志明文持久化**（官方契约 log-only、模型上下文不可见）。
- **非 Windows 平台未经真实用户验证**。

---

## 致谢

- **代码衍生**：[@nanmicoder/dsh-auto-mode](https://github.com/NanmiCoder/dsh-auto-mode)（MIT License）—— 核心审批管线移植自该项目并在 `src/auto/` 重写为独立实现；MIT 版权与许可声明随源文件及编译产物 `lib/auto/*.js`、`lib/client.js` 保留。
- **设计范式参考**：[@anionex/dsh-vision-toolkit](https://github.com/Anionex/dsh-vision-toolkit)。
- **机制对标**：[@moon09300731/dsh-approval-gate](https://github.com/moon09300731/dsh-approval-gate)（确认制学习）、[@a903067276-rgb/dsh-perm-guard](https://github.com/a903067276-rgb/dsh-perm-guard)（分类三态 + 信任目录）、[@PerryLink/dsh-permission-rules](https://github.com/PerryLink/dsh-permission-rules)（规则维度限定）。
- **贡献者**：[@daveycodez](https://github.com/daveycodez)、[@MikotoMyWife](https://github.com/MikotoMyWife)。

---

## 许可

BSD-3-Clause ｜ [LICENSE](https://github.com/cuddly-guacamole/dsh-auto-approval-llm/blob/main/LICENSE)
