# 19 · 平台支持与反馈

> *Platform Support & Feedback*

本插件的**开发与测试基线是 Windows + Git Bash**。代码层面已做跨平台适配，但非 Windows 平台缺少真实用户验证——本章说明各平台的现状、边界与反馈方式。

## 19.1　开发与测试基线

- 路径判定、shell 词法解析、分类器语义均以 **Windows + Git Bash** 为准开发与回归。
- 跨平台能力由**路径语法自动分派**保证（`normalizePath`/`isWithin` 对 `C:\` 与 `/` 分别使用 win32/posix 语义），不依赖 `process.platform` 单一判据。
- POSIX 侧关键判定已由契约测试锚定（`tests/posix-platform.test.mjs`，12 例）：系统关键路径（`/etc`、`/usr/bin`…）、文件系统根 `/`、macOS `/tmp→/private/tmp` 别名、POSIX 写目标硬拒串、未识别命令的 fail-closed `ask` 兜底。

## 19.2　平台支持矩阵

| 平台 | 状态 | 说明 |
|---|---|---|
| Windows（Git Bash） | ✅ 正式 | 主开发/测试环境 |
| macOS / Linux / WSL | 🟡 欢迎反馈 | 代码已适配（见 19.1），尚未经真实用户验证 |
| Electron 桌面版（dsh desktop） | 🟡 已适配 · 待实机验证 | 桌面载体不提供 `webServer`：路由注册在 connection 的载波中立 Fetch 注册表（见 19.5），插件启动不再依赖该服务 |
| Android 浏览器访问 dsh web | ⚠️ 仅收集反馈 | 窄视口/触屏下的设置卡与审批面板体验可反馈，**不承诺支持**（不按手机宽度改造官方 UI） |
| Android 原生环境（Auto 档，machine value `auto-approval`） | ❌ 明确不支持 | Termux / root / adb / shizuku 等环境差异过大；国产安卓即使 root 也存在各种定制路径，Auto 档在此类环境视为玩家实验场景 |

## 19.3　为什么 Android 原生环境不支持 Auto 档

Auto 档的安全模型假设一个**稳定、可预期的文件系统与 shell 基线**（路径语义、权限模型、借壳进程行为）。Android 原生执行环境（Termux、root 后的 adb/shizuku、各家定制 ROM）在这些维度上差异巨大，无法保证「自动但安全」的裁决质量，且多为实验/玩具用途——因此明确不支持，而非降级支持。

## 19.4　反馈指引

请到 [GitHub Issues](https://github.com/cuddly-guacamole/dsh-auto-approval-llm/issues) 发起，并包含：

| 字段 | 内容 |
|---|---|
| 平台 | macOS / Linux / WSL / Android 浏览器 / 其他（注明发行版与版本） |
| dsh 版本与插件版本 | `dsh --version` 与 npm 安装版本 |
| 复现 | 最小命令 + 期望行为 + 实际行为（含审批面板/倒计时表现） |
| 敏感信息 | 请先移除 API 密钥、凭据、完整对话与无关工作区路径 |

> 若你的环境是 Android 原生 + Auto 档，我们可能直接关闭 issue 并指向本页。

## 19.5　桌面载体（Electron 桌面版）

dsh 桌面端（Electron）**不提供 `webServer` 服务**，也不在本地打开 HTTP 端口：Web UI 资源与 Fetch 流量经 `dsh-app://` 协议与分帧字节管道交给内置的 dsh 子进程。因此本插件的路由不注册在 web 服务上，而是注册到 connection 的**载波中立 Fetch 注册表**（`connection.fetch.register`）——web 载体把该注册表挂在 web server 的 `/api/auto-approval-llm/*` 前缀下，shell 载体直接分派同一个 handler。

两条载体差异：

- **命令方法**：注册表只承载 `GET`／`HEAD`／`POST`。删除语义（清空审批历史、清空延迟遥测、吊销学习条目、清除评审密钥）以 `POST` + 请求头 `x-auto-approval-op: delete` 表达。
- **信任栅栏**：web 载体上这些路由与其它 `/api` 消费者一样，先过载波层的主机／Origin 校验与会话认证（未认证即 401），再进入插件自身的主机白名单与权威判定（Fetch handler 不读 socket，权威取自 Host，缺失时退回请求 URL），因此非浏览器消费者需要携带会话；桌面载体不经 HTTP，由 shell 持有传输本身作为信任边界。

桌面载体的权威（Host／Origin）形态、cookie 行为与长轮询超时尚未在真机确认——桌面安装包目前未公开发布，待其可得后按同批施工方案收尾。
