# 17 · 类别开关与信任目录
> *Tri-state category switches & trusted directories*

静态引擎（§03）回答「**这一次调用**危不危险」，类别层回答「**这一类操作**要不要问」。工具与 shell 命令被归入 11 个类别，每类可配 `auto / ask / deny` 三态；未配置 = `inherit`，行为与没有这层时完全一致。全部实现是纯函数（<span class="lnum">src/auto/category.ts#</span>，786 行），宿主在两个接线点各自从零调用。

## 17.1　十一个类别与优先级 <span class="lnum">category.ts:LCATEGORY_PRECEDENCE</span>

| 优先级 | 类别 | 典型内容 | 配置约束 |
|---|---|---|---|
| 11 | `privilege` | sudo/su、set-executionpolicy 等提权 | <span class="badgeerr">LOCKED：仅可 ask</span>（开启 `privilegeAutoReview` 后三态可配） |
| 10 | `delete` | rm/del/Remove-Item 等删除 | <span class="badgeerr">LOCKED：仅可 ask</span> |
| 9 | `disk` | format/bcdedit/磁盘镜像写 | <span class="badgeerr">LOCKED：仅可 ask</span> |
| 8 | `protected` | 触碰受保护/关键路径的写改 | <span class="badgeerr">LOCKED：仅可 ask</span>（开启 `protectedAutoReview` 后三态可配） |
| 7 | `networkExec` | curl/wget/iwr 外联下载执行；agent 的 `web_fetch` 同属此类（URL 级安全边界在宿主 fetch provider，插件可用本类目或声明式规则收紧） | 三态可配 |
| 6 | `gitPush` | git push 及等价远端变更 | 三态可配 |
| 5 | `publish` | npm publish/deploy 等发布动作 | 三态可配 |
| 4 | `gitLocal` | 本地 git 变更（commit/branch…） | 三态可配 |
| 3 | `fileEdit` | 工作区文件写改 | 三态可配 |
| 2 | `build` | 构建/测试/包管理例行命令 | 三态可配 |
| 1 | `readOnly` | 只读查询 | 三态可配 |

类别清单 `CATEGORY_KEYS`（<span class="lnum">category.ts:LCATEGORY_KEYS</span>）、锁定名单 `LOCKED_CATEGORIES = ['delete','protected','privilege','disk']`（<span class="lnum">category.ts:LLOCKED_CATEGORIES</span>）。另有 `harnessInternal` 与 `unknown` 两个非类别归宿：它们**没有配置键、恒为 inherit**（<span class="lnum">category.ts:L"if (category === 'unknown' || category === 'harnessInternal') return 'inherit'"</span>）——看不懂的东西不给你开自动。

## 17.2　三态语义

| 值 | 语义 | 关键边界 |
|---|---|---|
| `auto` | ≡ 按 LOW 档走，LLM 复审仍是最后一关 | 只对「本来就要进语义分类器」的调用生效（ask + classifierEligible，<span class="lnum">category.ts:L"only applies to an ask-classified, classifier-eligible call"</span>）；降档**不越 HIGH**——原判 HIGH/DENY 原地不动（<span class="lnum">category.ts:LapplyCategoryDirective</span>） |
| `ask` | 无条件转人工；普通类别 = status-less 无倒计时；**LOCKED 类 = 恒拒倒计时**（默认 10s，超时自动拒绝，绝不因 timeoutAction 放行） | pre-execute 快径直接返回，LLM 分类器**永远没机会**回答一次类别 ask；answerer 侧 LOCKED 类带 `action:'reject'` 的 countdown status（index.ts:isLockedCategory 判定），普通类别仍直达无状态人工 |
| `deny` | 绝对拒绝，提权重试不可绕过 | 与 denyList 同构的终端拒绝（<span class="lnum">decision.ts:L"{ kind: 'reject', source: 'denyList-deny' }"</span>）；`applyCategoryDirective` 里 DENY 是地板，任何配置都压不住它（<span class="lnum">category.ts:LapplyCategoryDirective</span>） |

## 17.3　双接点机制

```mermaid
flowchart TD
    T["一次 Auto 档工具调用"] --> G["tools.guard 同步硬拒闸门<br/>永不挂类别分类"]
    G --> P["接线点① tools/pre-execute · 收紧层<br/>index.ts（只收紧、不产放行）"]
    P -->|"deny"| PD["完整拒绝对话：<br/>feedback + history(source='category-deny') → rejected [deny]"]
    P -->|"ask"| PA["立即返回 kind:'ask'<br/>跳过 classifier 快径 [ask]"]
    P -->|"auto / inherit"| N["继续原路：classifier 或静态放行 [normal]"]
    G --> A["接线点② approval/request answerer<br/>index.ts · 全三态（deny 终端 / ask 转人 / auto 降档）"]
    A -->|"deny"| AD["rejected(category-deny) 终端拒绝 [deny]"]
    A -->|"ask"| AA["status-less 转人工 [ask]"]
    A -->|"auto"| AL["applyCategoryDirective 降档后进正常分派<br/>LOW/MEDIUM/HIGH 各自兜底不变 [gated]"]
```

两个接点各自调 `categoryDirectiveFor` 从零重算类别与指令，**无任何状态跨越**（函数注释明言，<span class="lnum">category.ts:LcategoryDirectiveFor</span>）；同一次调用被两层检查，但不存在「上层记住下层结论」的耦合。guard 层只做硬拒，从不参与类别判定。

## 17.4　LOCKED 类与三重保险（privilege 可解锁）

delete / protected / privilege / disk 四类在配置面上默认**只能收 `ask`**。保险有三道：

1. **schema 层**：`categoryPolicy` 的 zod 定义只允许 `auto|ask|deny` 三值字典（<span class="lnum">index.ts:L"categoryPolicy: z.dict(z.union(['auto', 'ask', 'deny'] as const), z.string()).default({})"</span>）；
2. **resolveConfig 层**：未知键 warn+丢弃，LOCKED 类别收到非 ask 值一律钳回丢弃并告警（<span class="lnum">index.ts:LresolveConfig</span>）；
3. **决策层常量兜底**：即便有漏网配置进了运行时，`categoryDirective` 对 locked 类别的分支也只会给出 `ask` 或 `inherit`，绝无 auto/deny（<span class="lnum">category.ts:L"if (locked && !privilegeUnlocked && !protectedUnlocked && !provenArtifactDeletion)"</span>）。

**两档锁定分层**：`LOCKED_CATEGORIES`（delete/protected/privilege/disk，<span class="lnum">category.ts:LLOCKED_CATEGORIES</span>）之上还有更硬的 `HARD_LOCKED_CATEGORIES = ['delete','disk']`（<span class="lnum">category.ts:LHARD_LOCKED_CATEGORIES</span>）——后两者**任何按名授权的通道都不得预先放行**：allowlist、pre-execute 镜像、显式配置一律无效，delete/disk 的批准只能来自人工逐次确认（带恒拒倒计时），绝不静默自动允许；protected/privilege 保留显式 operator override（分别由 `protectedAutoReview` / `privilegeAutoReview` 解锁）。理由：delete/disk 的破坏在大规模上不可逆。

**例外一：`privilegeAutoReview`（默认关，fail-closed）**。开启后 `privilege` 类别从 LOCKED 名单中剔除（delete / protected / disk 仍锁死）：配置面上 privilege 可设 auto/ask/deny，未配置时走 `inherit`——类别层不再强制转人，命令进入正常评审管线（classifier + LLM 评审 + 倒计时）。三层改动：schema 新键（<span class="lnum">index.ts:L"privilegeAutoReview: z.boolean().default(false)"</span>）、resolveConfig 解锁分支（<span class="lnum">index.ts:L"key === 'privilege' && raw.privilegeAutoReview === true"</span>）、categoryDirective 解锁判定（<span class="lnum">category.ts:L"const privilegeUnlocked = category === 'privilege'"</span>）；client 设置卡「分类开关与信任模式」子卡新增同名开关（locale 键 `settings.category.privilegeAutoReview`），开启后 privilege 行的下拉才出现 自动/拒绝 选项。

**例外二：`protectedAutoReview`（默认关，fail-closed）**。解除 `protected` 的**非凭据**锁定钳制，但**不改变它仍是敏感类别**。先说清开关的实际效果：类别 ask 在 pre-execute 处即返回（`index.ts` 的 `directive === 'ask'` 分支，分类器快径不执行），所以**评审器始终不会被问到**；开启本键只是把原来那条「倒计时恒拒、无人能答」的询问换成**常驻人工询问**（status-less，不再自动拒绝），仍须人工作答。要自动放行必须再把 `categoryPolicy.protected` 显式设为 `auto`；直接 `inherit` 会让策略层的静态放行**无任何评审**地生效，故不采用。

**凭据读取地板（本键不适用）**：`protected` 同时涵盖工作区敏感文件与受保护元数据（`.env` / `.npmrc` / `.git/*` / `.vscode/*` 等）**以及凭据树的读取**。这两半的风险不同，因此策略层把后者标成结构化字段 `credentialRead`（`sensitiveBasenameAt` 或 `isCriticalPath` 命中即置位），`categoryDirective` 与 answerer 的 `isLockedCategory` 都对它保持锁定——`~/.npmrc`、`~/.ssh/…`、`~/.aws/credentials` 这类凭据读取**在本开关开启时也不解锁**。启用本键真正解锁的只有**非凭据**的工作区元数据（`.git/`、`.vscode/` 等）。解锁判定读 `category.ts` 的 `protectedUnlocked`，answerer 的锁定谓词（`index.ts` 的 `isLockedCategory`）同读同一字段，两平面一致；设置卡开关（`settings.category.protectedAutoReview`）随分类卡一起保存。

**地板的三条边界（如实写明）**：①**写头读源**（`cp <凭据> out`、`tee out < <凭据>`、`dd if=<凭据>`）不落 write 快径（走语义评审，非静态放行），且同样置位地板；②地板按**类别层视角**生效——它只对类别为 `protected` 的调用起作用，`tee out < <凭据>` 这类被类别层判为 `fileEdit` 的命令由上面的「不落快径」保护，而非由本键的锁定谓词保护；③**opaque 行**（含 `(`/`{`/`$(`/heredoc 等无法静态分解的行）在类别层落到 `unknown`，因此既不受本键解锁、也不进地板——这类行的凭据读取是一次普通倒计时询问（`timeoutAction=allow` 下可被超时结算）。该残余面已登记 backlog，不在本键语义内。（此前同列的 shell 面 junction 逃逸已由 `docs/03` §3.4 的收窄型复检覆盖。）

**例外三：已证实的会话自建物删除（无需配置，始终生效）**。`delete` 仍是 LOCKED，但策略层对「删除目标全部是本会话成功创建过的路径」有不依赖配置的出处豁免（`shell.ts` 的 artifact 分支 → `allowed('delete exact session-created artifacts')`）。该豁免以**结构化字段** `sessionArtifactDeletion` 带出，类别层的锁定钳制与 answerer 的锁定谓词都读它——否则类别层看不到 artifact 注册表，会把这条静态放行拦成锁定询问，使豁免在 aggressive 模式下**永远不可达**（修复见 commit `cb02a3d`）。红线遵守：授权性信号走结构化通道，**不从 reason 文本解析**。

**LOCKED 类的转人行为**：LOCKED 类（delete / protected / disk；privilege 未解锁时）的类别 ask **不再是 status-less**——answerer 注入硬拒倒计时（`action:'reject'` 恒拒、秒数取 `highRiskSeconds` 默认 10），无 LLM 接管 handle、无学习上下文；超时未响应自动 `timeout-deny`（agent 收到「no response: auto-rejected」），**任何 timeoutAction 配置都无法把它变成自动放行**。无人值守会话不再因危险命令无限挂起；面板上拒绝按钮带 10s 倒计时可直接点击。

## 17.5　复合命令：类别取先、指令取严

一条 bash 可能串了多段命令。`categorizeCommandSegments` 先做词法分解再逐段归类；**读不懂的整行（opaque）退化为单个 unknown 段**——不瞎判（<span class="lnum">category.ts:LcategorizeCommandSegments</span>）。合并规则 `mergeCommandDecisions`（<span class="lnum">category.ts:LmergeCommandDecisions</span>）双轨取值：

- **类别取先**：按 §17.1 优先级表，最高优先级类别的标签胜出（`git push && rm x` 归 gitPush？不——delete 10 > gitPush 6，归 delete）;
- **directive 取严**：`deny > ask > auto > inherit`，任一段最严的指令决定整行待遇。

## 17.5b　写重定向与写向量族判类

- **写重定向目标参与判类**：含 `>`/`>>`/`>|`/`&>`/`N>` 写重定向（非 discard sink）的命令段按目标先行判类——命中敏感名/受保护路径 → `protected`，否则 → `fileEdit`，与显式写工具同语义；按 §17.1 优先级取严合并，delete/privilege 永不被拖低。
- **POSIX 写向量族五头**：`tee`、`dd of=`、`sed -i`（含后缀/--in-place 形态）、`truncate`、`install` 以操作数目标参与全部按目标闸门——直写运行态文件（history/audit 等）**无条件硬拒**，敏感/受保护目标与 cp/mv 同流；`sed` 不带 `-i`、`dd` 无 `of=` 保持读语义；`dd` 恒属 `disk` 锁定类。

## 17.6　信任目录模式 `categoryMode` 与敏感名熔丝

位置谓词 `isEffectiveRoutine(target, roots)`（<span class="lnum">category.ts:LisEffectiveRoutine</span>）决定「工作区内的例行放行」认哪些地方：

| 模式 | 判定 |
|---|---|
| `standard`（默认） | workspace ∪ trustedDirs 内才认（<span class="lnum">category.ts:L"(roots.trustedDirs ?? []).some((root) => isWithin(normalizePath(root, roots.workspace, roots.home), normalized))"</span>；<span class="lnum">category.ts:L"return isWithin(roots.workspace, normalized)"</span>） |
| `aggressive` | 直接 `return true`——位置不限（<span class="lnum">category.ts:L"if (roots.mode === 'aggressive') return true"</span>） |

aggressive 下三个内置类别 `['networkExec','gitPush','publish']`（`AGGRESSIVE_BUILTIN`，<span class="lnum">category.ts:LAGGRESSIVE_BUILTIN</span>）在**未显式配置**时隐式取 `auto`（<span class="lnum">category.ts:L"AGGRESSIVE_BUILTIN.includes(category as CategoryKey) && mode === 'aggressive' ? 'auto' : 'inherit'"</span>）——这就是「切激进会自动放行网络读写/git push/发布」的出处；显式配置过则听你的。

**危险度门全部不动**：敏感名熔丝 `sensitiveBasenameAt`（<span class="lnum">category.ts:LsensitiveBasenameAt</span>）对任意位置的 `.gitconfig/.netrc/.npmrc/.pypirc/.mcp.json/.bash*/.env(非 example)` 与 `.ssh/.gnupg/.aws/.azure/.kube` 目录段生效（名单 <span class="lnum">category.ts:LSENSITIVE_BASE</span>，含 `.gitmodules` 与 `.config/gcloud` 双级标记）——换什么模式都拦着；插件运行态文件硬拒、symlink realpath 复检同样与模式无关（§3.2/§3.4）。

## 17.7　trustedDirs 配置面

- **校验**：仅收绝对路径；凭据树（.ssh/.gnupg/.aws/.azure/.kube）、home、dshHome、critical 路径内的条目 warn+丢弃，余下归一化入库（resolveConfig，<span class="lnum">index.ts:LresolveConfig</span>）。
- **host-only**：11 员 host-only 键之一（<span class="lnum">decision.ts:LHOST_ONLY_KEYS</span>）——只能写在 settings.yaml / patch，设置卡保存不会抹掉它，也没有它的控件。
- **复检扩区**：symlink 守卫把 trustedDirs 并入受信复检区（workspace ∪ 插件区 ∪ trustedDirs，<span class="lnum">symlink.ts:L"const trustedZone: string[] = [...(roots.allowedDshSubpaths ?? []), ...(roots.trustedDirs ?? [])]"</span>）——文本上落进信任目录的目标照样做真实路径逃逸检查（realpath 逃逸硬拒，<span class="lnum">symlink.ts:L"const escape = realpathCriticalReason(textual, normalized, roots, roots.trustedDirs, realWsNormalized)"</span>）。

### 配置示例（默认零变化）

```yaml
auto-approval-llm:
  # 什么都不写 = 全部 inherit = 行为与本层不存在时一致
  # categoryPolicy: {}
  # categoryMode: standard
  # trustedDirs: []
  # ---- 以下为主动收紧/放宽的样子 ----
  categoryPolicy:
    fileEdit: auto      # 工作区文件写改：降为 LOW 档（仍送 LLM 复审）
    networkExec: ask    # 外联下载（含 web_fetch）：无条件转人工
    gitLocal: deny      # 本地 git 变更：绝对拒绝
    # delete/protected/privilege/disk 写 auto/deny 会被 warn+丢弃，仅 ask 有效
  categoryMode: aggressive   # 取消位置白名单：任意位置视为常规位置（危险度门、敏感名 fuse 不动）
  trustedDirs:
    - C:\projects\shared-lib   # 绝对路径（POSIX 如 /opt/shared-lib）；落在凭据树/home/critical 内会被丢弃
```
