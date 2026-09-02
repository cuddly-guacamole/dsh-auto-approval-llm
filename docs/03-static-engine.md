# 03 · 静态评估引擎
> *src/auto —— 不依赖数据库的纯判定*

host 编排在 `src/index.ts`，真正「长脑子」的静态规则引擎在 `src/auto/`。三者移植自 @nanmicoder/dsh-auto-mode（MIT），并在本项目重写为独立实现。

| 文件 | 行 | 职责 |
|---|---|---|
| `constants.ts` | 27 | 数值阈值默认值**唯一事实源**：5/8/10s、3/20、4000、8s/1024，及学习族（阈值 3/TTL 30d/100 条/会话放行帽 50） |
| `risk-tokens.ts` | 13 | HIGH 风险正则（NAME/REASON），供分类器与 policy 共用，防漂移 |
| `paths.ts` | 213 | 路径规范化（Windows 命名空间/NT 别名折叠、~ 展开、win32 小写）、受保护/关键路径判定、运行态文件名单 |
| `shell.ts` | 1016 | Bash/PowerShell 词法分解（sticky 正则状态机）＋ 整行熔断 ＋ 逐段静态分类 |
| `policy.ts` | 370 | 每次工具调用的确定性第一遍分类 `assessTool`（推断型、保留类型检查） |
| `rules.ts` | 370 | Claude-Code 风格声明规则解析/求值（纯函数，host 与浏览器共用） |
| `classifier.ts` | 75 | 预分类提示词、参数脱敏、严格响应解析 |
| `dsh-classifier.ts` | 94 | 复用 `ctx.llm` 做低 token 分类请求（temperature 0） |
| `decision.ts` | 722 | 纯决策函数：评审解析、人机竞速、来源标注、熔断状态机、静态名单 |
| `trust.ts` | 101 | web 路由信任平面（loopback/LAN 边界、Host 伪造防护、在线端点 URL 校验） |
| `artifacts.ts` | 98 | 本会话成功创建路径的内存出处登记（删除豁免依据） |
| `audit.ts` | 45 | append-only 审批审计（清空留墓碑、5MiB 裁剪） |
| `review-mode.ts` | 52 | 每会话评审模式持久化快照 |

> 同层的其余模块（类别层 `category.ts`、学习层 `learning.ts`、diff 预览 `editdiff.ts`、耗时遥测 `latency.ts`、上下文探针 `probe.ts`、结果脱敏 `redact.ts`、重试 `retry.ts`）各有专章或见 [§14](./14-code-map) 全量清单。

## 3.1　assessTool —— 每一次调用的 17 步判定 <span class="lnum">policy.ts:L230-370</span>

下面 17 个分支与 `policy.ts:L230-370` 的判定顺序一一对应。一级分支数没有变，但读/写/补丁/编辑四步内部各自长出了**子闸**（受保护读、敏感名熔丝、插件运行态无条件拒）：

```mermaid
flowchart TD
    A1["① hardDenyReason：命中即 deny，不弹窗 [deny]"]
    A1 --> A2["② bash/pwsh 且 command 是字符串 → 交给 assessShell（§3.3）[shell]"]
    A2 --> A3["③ bash/pwsh 但 command 缺失/非法 → ask（command argument is missing or invalid）[ask]"]
    A3 --> A4["④ 读家族 read/read_image/grep/glob/lsp：无路径→放行；受保护项目路径→ask（L254）；工作区外敏感名→ask（L259）；出工作区/其余异常→交人工；否则放行 [read]"]
    A4 --> A5["⑤ write/edit：插件开发目录→放行；**插件运行态文件（history/audit/learning 等）→ 无条件 deny，不进分类器（L272）**；工作区外/受保护→交人工；常规→放行 [write]"]
    A5 --> A6["⑥ apply_patch：目标藏在 patches 各项的 file_path；运行态目标→无条件 deny（L294）；任一不可读→ask（fail-closed）；全部常规→放行，否则交人工 [patch]"]
    A6 --> A7["⑦ str_replace_editor：command∈view/create/str_replace/insert 才认；view=读语义（受保护 L324 / 敏感名 L326 子闸同④），其余=写语义；运行态目标→无条件 deny（L319） [editor]"]
    A7 --> A8["⑧ SESSION_STATE_TOOLS（8：ask_user_question/todo_write/get_goal/…）→ 放行 [allow]"]
    A8 --> A9["⑨ HARNESS_READ_TOOLS（13：job_output/job_list/session_search/cordis_inspect_*…）→ 放行 [allow]"]
    A9 --> A10["⑩ AGENT_TEAMS_CONTROL_TOOLS（9）→ 放行（只动工作区本地协作状态） [allow]"]
    A10 --> A11["⑪ OWNER_CONTROL_TOOLS（3：job_kill/terminal_signal/terminal_close）→ 放行 [allow]"]
    A11 --> A12["⑫ terminal_open / terminal_send → 一律 ask（持久终端保有 cwd/env/别名状态，不可快路径） [ask]"]
    A12 --> A13["⑬ web_search/web_fetch/time/weather → 放行（只读外查） [allow]"]
    A13 --> A14["⑭ 编排类 subagent/workflow/ralph/send_message/list_agents/interrupt_agent/… → 放行（子工具独立被查） [allow]"]
    A14 --> A15["⑮ git_push/deploy/publish/send_email/create_issue/create_pull_request → 交人工 [ask]"]
    A15 --> A16["⑯ 工具名命中风险正则（delete/upload/credential/auth …）→ 交人工 [ask]"]
    A16 --> A17["⑰ 兜底 = 未识别注册工具 → **ask，fail-closed**（unrecognized registered plugin tool requires independent classification，<span class="lnum">policy.ts:L368-370</span>）—— 名字里没带风险词不再是放行理由 [ask]"]
```

::: warning 第⑰步语义
兜底方向是「拿不准就问人」：一个注册插件工具若没有任何已知形态可对号入座，一律转人工并允许语义分类器介入，**绝不因为「名字无害」而静默放行**。
:::

## 3.2　硬拒闸门 hardDenyReason <span class="lnum">policy.ts:L198-228</span>

- **凭据物质**：`web_fetch/curl/wget` 或外部写工具，参数里含 PEM 私钥、`sk-` / `ghp_` / `github_pat_` / `xox*`、`AKIA[0-9A-Z]{16}`、aws 密钥赋值、`Bearer …`、`.ssh` 路径等 → 拒。
- **shell 熔断**：bash/pwsh 命令走 `hardDenyShellReason`（见 [§3.3](#33shell-命令分析管线)）。
- **变更目标不可读**：write/edit/apply_patch/str_replace_editor(≠view) 目标解析不出 → 拒（fail-closed，宁可误拒）。
- **破坏性工具指向受保护路径** → 拒。

## 3.3　shell 命令分析管线 <span class="lnum">shell.ts</span>

```mermaid
flowchart TD
    B1["① 词法分解 decomposeCommandLine：单双引号状态机；反引号/$(... )/heredoc/() 分组/未闭合引号 → opaque（读不懂就不瞎判，转入工或语义复审） [lex]"]
    B1 --> B2["② 整行硬拒 hardDenyShellReason：sudo/doas/su 提权（锚定段起始，含 { brace group）；set-executionpolicy/clear-disk/format-volume/bcdedit 等系统策略；curl/wget/iwr 的凭据外传；动态删除直指 home [deny]"]
    B2 --> B3["③ 逐段结构判定：分解后每个段剥 wrapper（env/nohup/sudo 前缀/NAME=value）→ 命令名再验提权；重定向/删除目标过 hardDestructiveTargetReason；find 的 -delete/-exec 提权审查 [segment]"]
    B3 --> B4["④ 分类 classifyEffectiveCommand：删除（只许删本会话自建产物 artifacts.has，否则交人工）→ 只读命令（BASH_READ_ONLY 42 个 / PWSH_READ_ONLY 12 个 + git 只读 + sed -n + find 只读）→ 版本探测 → build/test → 创建(mkdir/touch/new-item) → cp/mv → git 变更 / 网络 / 基建（psql/kubectl/terraform…）→ 兜底「未识别命令，独立分类」 [classify]"]
```

- 只读名单刻意**不含** `cd`（会改变后续段 cwd 解析基准）。
- `routineInlineProbe`：`python -c` 只放行 import/print 字面量，`node -e` 只放行 require/console.log(process.version) —— 内联代码只认可「绝对安全」形态。
- 危险 token 提取：`sensitiveMarker`（.ssh/.env/密钥关键词）、`dshHomeExfil`（4 组模式抓 DSH_HOME 外传）、`dynamicHomeTarget`（$HOME 动态目标）→ 全部绕过静态判定。
- **写重定向脱离只读快径**：命令含真实文件写重定向（`>`/`>>`/`>|`/`&>`/`N>`，非 discard sink）时，其段不得走只读命令快径放行——落入既有评估流；`/dev/null`、NUL、`$null` 等 discard sink 维持快径。
- **build/test 与版本探测快径目标守卫**：快径仅保留给「写目标全为 discard sink 或工作区内非敏感非受保护非运行态路径」——区外/敏感/受保护/运行态目标一律脱离快径进入正常评估（`categoryMode: aggressive` 与 trustedDirs 放宽模式同样生效）。

## 3.4　路径保护清单 <span class="lnum">paths.ts</span>

| 类别 | 内容 | 判定 |
|---|---|---|
| 家目录根 / DSH_HOME 树 | `~` 、`~/.dsh`（env DSH_HOME 或默认） | `hardDestructiveTargetReason` → 硬拒（allowedDshSubpaths 白名单可豁免） |
| 凭据根 | `.ssh` `.gnupg` `.aws` `.azure` `.kube` `.config/gcloud` | isCriticalPath |
| shell 启动文件（12） | `.bashrc` `.bash_profile` `.bash_login` `.bash_logout` `.profile` `.zshrc` `.zprofile` `.zlogin` `.zlogout` `.kshrc` `.cshrc` `.tcshrc` | isCriticalPath（家目录变体硬拒；工作区变体 ask） |
| 系统关键目录 | POSIX: `/etc` `/bin` `/sbin` `/usr` `/system` `/library` `/private/etc` `/boot` ；Win: `windows/program files/boot…` | isCriticalPath |
| 工作区元数据首段 | `.git` `.vscode` `.idea` `.husky` `.dsh` | isProtectedProjectPath → 读/写都交人工 |
| 秘密文件 basename | `.gitconfig` `.gitmodules` `.bashrc` `.bash_profile` `.zshrc` `.zprofile` `.profile` `.mcp.json` `.netrc` `.npmrc` `.pypirc` | isProtectedProjectPath |
| 环境密钥文件 | `.env` / `.env.*`（**.env.example 例外**） | isProtectedProjectPath |
| Windows 设备/NT 命名空间 | `\\.\` `\device\` `\\?\` `\??\`（非 UNC/X: 变体） | `canonicalizeWindowsNamespace` 折叠后再判包含 |
| 保留设备名 | `con` `prn` `aux` `nul` `com1-9` `lpt1-9` | 硬拒 |

**symlink 逃逸**：文本层判定无法识破**快捷方式/软链接指向工作区外**（如 `ws/ln → ~/.bashrc`）。宿主侧守卫 `symlinkEscapeReason`（<span class="lnum">index.ts:L2209-2270</span>）取 `symlinkGuardTargets` 提取每个工具的真实路径操作数，对「文本上在工作区内/受信区」的目标做 realpath 最深祖先解析，一旦真实路径离开工作区/受信区就硬拒。守卫解析的是**归一化后的文本路径**（`resolveDeepest(textual)`）：若拿原始参数 realpath，相对路径会被锚定到 `process.cwd()` 而非会话工作区，`dsh web` 下会把所有相对路径调用误硬拒（PR #4 修复，2026-09-02）。受信区不止插件目录：`trustedDirs` 成员与 allowedDshSubpaths 一并构成复检区（<span class="lnum">index.ts:L2222</span>）；aggressive 模式下「普通出区」是设计目标故放行，但落在 critical 树 / DSH_HOME / 插件运行态文件上的逃逸仍硬拒（<span class="lnum">index.ts:L2261</span>）——运行态文件复检与位置模式无关，改审批/审计/学习状态在任何模式下都不算例行写。

## 3.5　声明式规则 rulesText <span class="lnum">rules.ts</span> —— 用户写的「最优先纸条」

```text
# 语法（每行一条，空行与 # 注释忽略）
Tool(pattern) | allow|deny|human [| reason|toolName|arguments]
pattern       | allow|deny|human [| field]

# 例：禁止任何含 "rm -rf" 的 bash
bash(rm\s+-\s*rf) | deny
# 例：任何工具的 any_dangling 参数命中即交人
(any_dangling)     | human
```

- 工具作用域可逗号多选（含 `*` 通配）；无括号则适配所有工具；field 缺省 `arguments`。
- **首条命中即胜**；`evaluateRules` 先用 `extractRuleTarget` 抽取命令文本（command/script/code/prompt/text/content），防锚定正则（如 `^git push`）被 JSON 信封击穿。
- ReDoS 防护：长度 ≤2000；拒绝嵌套无界量词 `(a+)+`、交替外套量词、嵌套重复组、`{n,}` 计数重复。
- **host 与浏览器设置卡共用同一份 `parseRulesText`**（错误逐行红字显示）。
- 干跑 `rulesDryRun`：只记命中不执法（host 端 <span class="lnum">index.ts:L2448-2449</span>）。

## 3.6　产物登记 ArtifactRegistry <span class="lnum">artifacts.ts</span>

```mermaid
flowchart TD
    C1["plan（评估时）：记录该命令计划创建的路径（须 in 工作区/临时区 且 当前不存在） [pre]"]
    C1 --> C2["settle（结果时）：成功（shell exitCode===0 或 write operation==='create'）才登记进 created [post]"]
    C2 --> C3["闭环：删除命令只豁免「本会话=self 亲手创建」的文件，其余删除一律交人工 [deny-exempt]"]
```