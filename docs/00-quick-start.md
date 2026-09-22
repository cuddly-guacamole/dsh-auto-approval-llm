# 快速开始
> *从装到生效*

## 这一页给谁

- 已经决定装这个插件，想先把它跑起来、再决定要不要读机制细节的人。
- 判定顺序、状态机、审计形态不在本页：末节「继续读」给出入口。

## 前置条件

| 项 | 要求 |
|---|---|
| 权限档 | **Auto 档**（machine value `auto-approval`，host 名 `Auto approval`）= `sandbox: danger-full-access` + `approval: ask`；其他档本插件不介入 |
| DSH | `0.1.7-alpha.1` 或更高（`auto` 档归上游 `@deepseek-ai/dsh-experimental-auto-review`，本插件只接管 `auto-approval`、两者可同开；旧机器值 `auto` 别名已随下限抬升移除） |
| Node | `^22.19.0 || >=24.0.0` |
| 共存 | 本插件是 `auto-approval` 档 `approval/request` 的唯一终结裁决者 —— 同一档位不要再叠第二个审批插件；上游 `@deepseek-ai/dsh-experimental-auto-review`（`auto`，Auto review / EXP）是另一个档位，可同时启用 |

> 从旧机器值 `auto` 升级：只迁移 `auto + danger-full-access + ask` 同签名存量会话（**上游 auto-review 持有的同签名 `auto` 也会被改写：旋钮不变、应答主体从上游换成本插件**）；归档不处理，resume 时懒迁移。无上游且无法迁移的存量会话打不开 = 文档化的 fail-closed（迁移口径见仓库 README「从旧 `auto` 档升级」）。

## 安装

```bash
dsh plugin --profile web add @quill507/dsh-auto-approval-llm
```

安装后**重启 dsh**：host 侧的审批链路在进程启动时接线，不重启不生效。

## 30 秒验证

1. 把会话或预设切到 **Auto 档**：`/permission auto-approval`。
2. 打开侧边栏 插件 → auto-approval-llm 配置页，确认表单出现（更早宿主线：设置 → 插件 → 自动审批）；默认配置即可工作（`enabled` 默认开）。
3. 让 agent 执行一条只读命令（例如 `ls`）：常规操作走静态放行，审批面板不出现。
4. 让 agent 执行一条静态规则看不明白的调用（例如含变量拼接的动态命令）：应出现官方审批面板与倒计时，或由 LLM 评审接管。

落盘侧的证据：`<DSH_HOME>/auto-approval-llm/history.jsonl` 记录每次裁决，`audit.jsonl` 同刻追加对应 `decision` 行。面板、倒计时与终裁的对应关系见 [07 · 人机竞速与超时仲裁](./07-human-race)。

## 常用改动

- 让评审走指定模型：设置 →「在线评审模型」卡，通道来源选「DSH 模型」或「自定义端点」（协议 / 地址 / 模型 / 密钥），保存后测试连接。
- 弹窗频繁：调大「中风险倒计时」，或把「超时动作」改成「拒绝」/「低风险自动同意」。
- 逐键语义、默认值与 host-only 键：[12 · 配置全景](./12-config)。

## 卸载

```bash
dsh plugin --profile web remove @quill507/dsh-auto-approval-llm
```

运行态数据**不在包目录里**，卸载不会删除它。规范位置是 `DSH_HOME`（默认 `~/.dsh`）下的 `auto-approval-llm/`，共六个文件：`history.jsonl`、`audit.jsonl`、`approval-debug.jsonl`、`review-mode.json`、`llm-latency.jsonl`、`learning.json`。需要一并清理时手工删除该目录。

只清界面里的记录，不必删文件：审批历史用「历史」卡的「清空历史」按钮（`history.jsonl` 清空、审计只留墓碑），学习条目用「确认制学习」卡的「吊销」按钮。`/approval-reset` / `/approval-reset-all` 是另一回事——它们只清熔断计数器与在途审批状态，不动持久化数据（需在设置卡开启 `slashCommandsEnabled` 并重启）。

## 继续读

- 五个钩子一条链：[02 · 一次工具调用的生命周期](./02-tool-call-lifecycle)
- 静态判定顺序：[03 · 静态评估引擎](./03-static-engine)、[08 · 熔断器状态机](./08-breaker)
- 数据落盘形态：[11 · 数据与持久化](./11-data-persistence)
- 平台边界与反馈渠道：[19 · 平台支持与反馈](./19-platform-support)
- 面向用户的任务层（特性全表、界面预览、配置表、反馈）：[README](https://github.com/cuddly-guacamole/dsh-auto-approval-llm/blob/main/README.md)
