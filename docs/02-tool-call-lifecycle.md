# 02 · 一次工具调用的完整生命周期

> *One tool call, end to end*

模型每次想干一件事，都会经过**五段钩子**。下面的时序即一次**中风险 bash 调用**的标准旅程（各步骤数字均可在代码定位）：

<ol class="seq">
  <li><span class="who">① 模型 → DSH</span><div class="cap">模型发出工具调用（如 `bash`、`write`、`apply_patch`、`web_fetch`）。</div></li>

  <li><span class="who">② 同步硬拒闸门 · <code>ctx.tools.guard()</code> <span class="lnum">index.ts:L2271-2278</span></span>
    <div class="cap">不是事件，而是 tools 服务的**同步注册守卫**：`isAutoExecution` 后先 `hardDenyReason`（凭据物质 / 受保护路径 / shell 熔断），再 `symlinkEscapeReason`（realpath 逃逸工作区）。命中即返回原因字符串 → 直接拒，**不弹窗**。这一层只做硬拒，永不挂类别分类。</div></li>

  <li><span class="who">③ 静态评估 + 类别收紧 · <code>tools/pre-execute</code> <span class="lnum">index.ts:L2279-2401</span></span>
    <div class="cap">`assessTool` → `deny`（硬拒 `[auto-mode hard deny]`，**落 `hard-deny` 历史记录 + debug 行**）/ `allow`（直接放行）/ `ask`。中间还有一层**类别收紧**（<span class="lnum">index.ts:L2332-2352</span>）：三态开关配成 `deny` 的类别在这里终端拒绝、配成 `ask` 的无条件跳过 classifier 快径直接转人工（详见 [§17](./17-category-switches)）。之后若 `classifierEligible`，交给 LLM 预分类器（`classifier.classify`）再定 `allow | deny | ask` —— 快路径的放行/拒绝各自落 `classifier-allow` / `classifier-deny` 历史记录（`ask` 除外，留待 answerer 记终局）；分类器不可用 → 一律向人工（`classifier unavailable`）。</div></li>

  <li><span class="who">④ 终局裁决 · <code>approval/request</code> <span class="lnum">index.ts:L2894-3341（prepend+global）</span></span>
    <div class="cap">本插件的**核心决策管线**（详见 [§04](./04-adjudicator-pipeline)）：声明规则 → 名单 → 类别开关 → 评审模式 → 熔断 → 策略硬拒 → 学习放行 → 风险分档 → LLM 复审 + 人工倒计时。产出 `allowed-once` 或 `rejected`，或委托官方面板走人工竞速。</div></li>

  <li><span class="who">⑤ 执行与产物登记 · <code>tools/result</code> <span class="lnum">index.ts:L2402-2405</span></span>
    <div class="cap">`artifacts.settle`：把本会话**成功创建**的文件登记进 `ArtifactRegistry`（后续删除该文件时可豁免）——入参 `plannedCreates` 来自评估阶段的 `artifacts.plan`。同一事件也是通知队列的「已执行」标记点：只决定**该不该发**通知，不决定位置（见 ⑦）。</div></li>

  <li><span class="who">⑥ 喂回模型 · <code>tools/post-execute</code> <span class="lnum">index.ts:L2433-2463（global）</span></span>
    <div class="cap">若这次工具结果 `isError` 且有超时/决策标记（`timeoutFeedback` / `decisionFeedback`），注入 `{kind:'block', feedback}` —— 让模型知道「不是因为命令错，而是被审批挡下（超时 / 规则 / 模型拒绝）」。另有独立一段**结果脱敏**（<span class="lnum">index.ts:L2444-2456</span>）：`redactResults` 开启时，成功结果同样过一遍脱敏器并记审计——喂回模型的文本不夹带秘密。</div></li>

  <li><span class="who">⑦ 通知投递 · agent inbox（<code>agent.inject</code>） <span class="lnum">index.ts:L829-896（watchNotices 内 L890 的 step/end 分流）</span></span>
    <div class="cap">「✅ Model approved」「已学习放行」与 first-use onboarding 通知**不再直写会话日志**：队列在 `tools/result`（L859-866）只标记「该工具确实执行了」，`step/end`（L890）时把已执行的通知交给 `agent.inject`（<span class="lnum">index.ts:L704</span>）送入 agent inbox —— driver 在**最近的 step 边界**认领，因此消息**不可能**插进 assistant `tool_calls` 与 `tool/result` 之间（OpenAI 兼容 provider 会拒收整个会话）。未产生结果（拒绝/取消）的通知仅落控制台，不进会话。**权衡**：inject 不唤醒空闲 driver、可能错过已认领的批次、会话销毁时丢弃 pending —— 通知可能延迟到下一次交互甚至丢失；这是「宁可晚/丢，绝不插错位置」的有意取舍（`notifyUser` / `onboardingMessageEnabled` 可关）。</div></li>
</ol>

::: tip 注意
②③ 在 `approval/request` 之前就把「无争议放行 / 明显拒绝」消化掉，只有真正的模糊区（ask）才进入审批面板 + LLM 复审，吞吐与安全兼得。
:::