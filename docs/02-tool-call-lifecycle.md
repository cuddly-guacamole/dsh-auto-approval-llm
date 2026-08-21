# 02 · 一次工具调用的完整生命周期

> *One tool call, end to end*

模型每次想干一件事，都会经过**五段钩子**。下面的时序即一次**中风险 bash 调用**的标准旅程（各步骤数字均可在代码定位）：

<ol class="seq">
  <li><span class="who">① 模型 → DSH</span><div class="cap">模型发出工具调用（如 `bash`、`write`、`apply_patch`、`web_fetch`）。</div></li>

  <li><span class="who">② 同步硬拒闸门 · `ctx.tools.guard()` <span class="lnum">index.ts:L1450-1456</span></span>
    <div class="cap">不是事件，而是 tools 服务的**同步注册守卫**：`isAutoExecution` 后先 `hardDenyReason`（凭据物质 / 受保护路径 / shell 熔断），再 `symlinkEscapeReason`（realpath 逃逸工作区）。命中即返回原因字符串 → 直接拒，**不弹窗**。</div></li>

  <li><span class="who">③ 静态评估 · `tools/pre-execute` <span class="lnum">index.ts:L1458-1487</span></span>
    <div class="cap">`assessTool` → `deny`（硬拒 `[auto-mode hard deny]`）/ `allow`（直接放行）/ `ask`。若 `classifierEligible`，交给 LLM 预分类器（`classifier.classify`）再定 `allow | deny | ask`；分类器不可用 → 一律向人工（`classifier unavailable`）。</div></li>

  <li><span class="who">④ 终局裁决 · `approval/request` <span class="lnum">index.ts:L1792-2089（prepend+global）</span></span>
    <div class="cap">本插件的**核心决策管线**（详见 [§04](./04-adjudicator-pipeline)）：声明规则 → 名单 → 评审模式 → 熔断 → 风险分档 → LLM 复审 + 人工倒计时。产出 `allowed-once` 或 `rejected`，或委托官方面板走人工竞速。</div></li>

  <li><span class="who">⑤ 执行与产物登记 · `tools/result` <span class="lnum">index.ts:L1489-1492</span></span>
    <div class="cap">`artifacts.settle`：把本会话**成功创建**的文件登记进 `ArtifactRegistry`（后续删除该文件时可豁免）——入参 `plannedCreates` 来自评估阶段的 `artifacts.plan`。</div></li>

  <li><span class="who">⑥ 喂回模型 · `tools/post-execute` <span class="lnum">index.ts:L1513-1523（global）</span></span>
    <div class="cap">若这次工具结果 `isError` 且有超时/决策标记（`timeoutFeedback` / `decisionFeedback`），注入 `{kind:'block', feedback}` —— 让模型知道「不是因为命令错，而是被审批挡下（超时 / 规则 / 模型拒绝）」。</div></li>

  <li><span class="who">⑦ 通知冲刷 · `step/end` <span class="lnum">index.ts:L414-444</span></span>
    <div class="cap">`flushNotices`：把「✅ Model approved」这类通知写进会话日志（`notifyUser` 开启时）；已看到 tool/result 的才写（否则在 tool-calls 序列中间插入用户消息会破坏 OpenAI 消息序列 → 只打控制台）。</div></li>
</ol>

::: tip 注意
②③ 在 `approval/request` 之前就把「无争议放行 / 明显拒绝」消化掉，只有真正的模糊区（ask）才进入审批面板 + LLM 复审，吞吐与安全兼得。
:::