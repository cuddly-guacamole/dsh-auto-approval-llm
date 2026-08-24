# 17 · 类别开关与信任目录
> *Tri-state category switches & trusted directories*

静态引擎（§03）回答「**这一次调用**危不危险」，类别层回答「**这一类操作**要不要问」。工具与 shell 命令被归入 11 个类别，每类可配 `auto / ask / deny` 三态；未配置 = `inherit`，行为与没有这层时完全一致。全部实现是纯函数（<span class="lnum">src/auto/category.ts</span>，647 行），宿主在两个接线点各自从零调用。

## 17.1　十一个类别与优先级 <span class="lnum">category.ts:L47-59</span>

| 优先级 | 类别 | 典型内容 | 配置约束 |
|---|---|---|---|
| 11 | `privilege` | sudo/su、set-executionpolicy 等提权 | <span class="badgeerr">LOCKED：仅可 ask</span> |
| 10 | `delete` | rm/del/Remove-Item 等删除 | <span class="badgeerr">LOCKED：仅可 ask</span> |
| 9 | `disk` | format/bcdedit/磁盘镜像写 | <span class="badgeerr">LOCKED：仅可 ask</span> |
| 8 | `protected` | 触碰受保护/关键路径的写改 | <span class="badgeerr">LOCKED：仅可 ask</span> |
| 7 | `networkExec` | curl/wget/iwr 外联下载执行 | 三态可配 |
| 6 | `gitPush` | git push 及等价远端变更 | 三态可配 |
| 5 | `publish` | npm publish/deploy 等发布动作 | 三态可配 |
| 4 | `gitLocal` | 本地 git 变更（commit/branch…） | 三态可配 |
| 3 | `fileEdit` | 工作区文件写改 | 三态可配 |
| 2 | `build` | 构建/测试/包管理例行命令 | 三态可配 |
| 1 | `readOnly` | 只读查询 | 三态可配 |

类别清单 `CATEGORY_KEYS`（L33-37）、锁定名单 `LOCKED_CATEGORIES = ['delete','protected','privilege','disk']`（L40）。另有 `harnessInternal` 与 `unknown` 两个非类别归宿：它们**没有配置键、恒为 inherit**（<span class="lnum">category.ts:L586</span>）——看不懂的东西不给你开自动。

## 17.2　三态语义

| 值 | 语义 | 关键边界 |
|---|---|---|
| `auto` | ≡ 按 LOW 档走，LLM 复审仍是最后一关 | 只对「本来就要进语义分类器」的调用生效（ask + classifierEligible，<span class="lnum">category.ts:L597-600</span>）；降档**不越 HIGH**——原判 HIGH/DENY 原地不动（<span class="lnum">category.ts:L643-645</span>） |
| `ask` | 无条件转人工，status-less、无宿主倒计时 | pre-execute 快径直接返回（<span class="lnum">index.ts:L1883-1885</span>），LLM 分类器**永远没机会**回答一次类别 ask；answerer 侧同样直达人工（<span class="lnum">index.ts:L2513-2518</span>） |
| `deny` | 绝对拒绝，提权重试不可绕过 | 与 denyList 同构的终端拒绝（<span class="lnum">index.ts:L2484-2498</span>）；`applyCategoryDirective` 里 DENY 是地板，任何配置都压不住它（<span class="lnum">category.ts:L640</span>） |

## 17.3　双接点机制

```mermaid
flowchart TD
    T["一次 Auto 档工具调用"] --> G["tools.guard 同步硬拒闸门<br/>永不挂类别分类"]
    G --> P["接线点① tools/pre-execute · 收紧层<br/>index.ts:L1868-1885（只收紧、不产放行）"]
    P -->|"deny"| PD["完整拒绝对话：<br/>feedback + history(source='category-deny') → rejected [deny]"]
    P -->|"ask"| PA["立即返回 kind:'ask'<br/>跳过 classifier 快径 [ask]"]
    P -->|"auto / inherit"| N["继续原路：classifier 或静态放行 [normal]"]
    G --> A["接线点② approval/request answerer<br/>全三态（deny L2484 / ask L2513 / auto 在分档处生效）"]
    A -->|"deny"| AD["rejected(category-deny) 终端拒绝 [deny]"]
    A -->|"ask"| AA["status-less 转人工 [ask]"]
    A -->|"auto"| AL["applyCategoryDirective 降档后进正常分派<br/>LOW/MEDIUM/HIGH 各自兜底不变 [gated]"]
```

两个接点各自调 `categoryDirectiveFor` 从零重算类别与指令，**无任何状态跨越**（函数注释明言，<span class="lnum">category.ts:L611-616</span>）；同一次调用被两层检查，但不存在「上层记住下层结论」的耦合。guard 层只做硬拒，从不参与类别判定。

## 17.4　LOCKED 四类与三重保险

delete / protected / privilege / disk 四类在配置面上**只能收 `ask`**。保险有三道：

1. **schema 层**：`categoryPolicy` 的 zod 定义只允许 `auto|ask|deny` 三值字典（<span class="lnum">index.ts:L166</span>）；
2. **resolveConfig 层**：未知键 warn+丢弃，LOCKED 类别收到非 ask 值一律钳回丢弃并告警（<span class="lnum">index.ts:L198-216</span>）；
3. **决策层常量兜底**：即便有漏网配置进了运行时，`categoryDirective` 对 locked 类别的分支也只会给出 `ask` 或 `inherit`，绝无 auto/deny（<span class="lnum">category.ts:L591-594</span>）。

## 17.5　复合命令：类别取先、指令取严

一条 bash 可能串了多段命令。`categorizeCommandSegments` 先做词法分解再逐段归类；**读不懂的整行（opaque）退化为单个 unknown 段**——不瞎判（<span class="lnum">category.ts:L553-563</span>）。合并规则 `mergeCommandDecisions`（<span class="lnum">category.ts:L530-546</span>）双轨取值：

- **类别取先**：按 §17.1 优先级表，最高优先级类别的标签胜出（`git push && rm x` 归 gitPush？不——delete 10 > gitPush 6，归 delete）;
- **directive 取严**：`deny > ask > auto > inherit`，任一段最严的指令决定整行待遇。

## 17.6　信任目录模式 `categoryMode` 与敏感名熔丝

位置谓词 `isEffectiveRoutine(target, roots)`（<span class="lnum">category.ts:L140-145</span>）决定「工作区内的例行放行」认哪些地方：

| 模式 | 判定 |
|---|---|
| `standard`（默认） | workspace ∪ trustedDirs 内才认（<span class="lnum">category.ts:L143-144</span>） |
| `aggressive` | 直接 `return true`——位置不限（<span class="lnum">category.ts:L142</span>） |

aggressive 下三个内置类别 `['networkExec','gitPush','publish']`（`AGGRESSIVE_BUILTIN`，<span class="lnum">category.ts:L65</span>）在**未显式配置**时隐式取 `auto`（<span class="lnum">category.ts:L595</span>）——这就是「切激进会自动放行网络读写/git push/发布」的出处；显式配置过则听你的。

**危险度门全部不动**：敏感名熔丝 `sensitiveBasenameAt`（<span class="lnum">category.ts:L127-132</span>）对任意位置的 `.gitconfig/.netrc/.npmrc/.pypirc/.mcp.json/.bash*/.env(非 example)` 与 `.ssh/.gnupg/.aws/.azure/.kube` 目录段生效（名单 L110-120）——换什么模式都拦着；插件运行态文件硬拒、symlink realpath 复检同样与模式无关（§3.2/§3.4）。

## 17.7　trustedDirs 配置面

- **校验**：仅收绝对路径；凭据树（.ssh/.gnupg/.aws/.azure/.kube）、home、dshHome、critical 路径内的条目 warn+丢弃，余下归一化入库（resolveConfig，<span class="lnum">index.ts:L222-247</span>）。
- **host-only**：九员 host-only 键之一（<span class="lnum">decision.ts:L224-234</span>）——只能写在 settings.yaml / patch，设置卡保存不会抹掉它，也没有它的控件。
- **复检扩区**：symlink 守卫把 trustedDirs 并入受信复检区（workspace ∪ 插件区 ∪ trustedDirs，<span class="lnum">index.ts:L1807</span>）——文本上落进信任目录的目标照样做真实路径逃逸检查。

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
    networkExec: ask    # 外联下载：无条件转人工
    gitLocal: deny      # 本地 git 变更：绝对拒绝
    # delete/protected/privilege/disk 写 auto/deny 会被 warn+丢弃，仅 ask 有效
  categoryMode: aggressive   # 取消位置白名单：任意位置视为常规位置（危险度门、敏感名 fuse 不动）
  trustedDirs:
    - D:\work\shared-lib     # 绝对路径；落在凭据树/home/critical 内会被丢弃
```
