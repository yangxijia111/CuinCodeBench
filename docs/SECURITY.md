# SECURITY.md — 安全设计与威胁模型（v1.1）

## 1. 定位与最大风险声明（必读）

**CuinCodeBench 不是安全沙箱。** 用户代码以当前 Windows 用户完整权限在本机直接执行，可以读写该用户能访问的任意文件、访问网络、执行任意系统调用。本工具的定位是**运行学习者自己编写（或来自可信题库）的代码**。

**明确不适合的场景**：

- ❌ 运行不可信、未知来源或恶意代码
- ❌ 多用户/服务器环境下当作在线判题系统
- ❌ 任何需要强隔离的执行场景

✅ 它适合个人本机练习场景，风险级别与本地 IDE 运行代码相同。

## 2. 威胁模型与信任边界

```
┌─────────────────────────── 本机（信任边界外：一切外部输入）──────────────────────────┐
│                                                                                      │
│  不可信输入：                                     信任边界（应用进程）：              │
│  ├─ 题面 Markdown（导入的题目）  ──────────→  DOMPurify 净化 → renderer 渲染         │
│  ├─ JSON 导入文件                ──────────→  zod 校验 → 事务入库                  │
│  ├─ 用户代码（stdin/程序输出）   ──────────→  仅作文件内容写入/文本展示             │
│  ├─ IPC 消息（renderer → main）  ──────────→  sender 校验 + zod 校验 → service     │
│  └─ 工具链输出（编译器/程序）    ──────────→  大小上限 + 截断展示                   │
│                                                                                      │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

| 威胁 | 场景 | v1.1 对策 | 残余风险 |
|---|---|---|---|
| 代码失控 | 死循环、fork 炸弹式输出 | 编译/运行超时 + 进程树强杀 + 输出上限（运行 1MB / 编译 1MB）+ 退出时终止全部子进程 | 超时窗口内的资源消耗 |
| shell 注入 | 输入进入命令行 | 全程数组参数 spawn（`shell: false`），用户代码只以文件内容写入固定文件名 | 无 |
| 恶意 Markdown | 导入题库携带脚本 | DOMPurify 显式净化（禁 script/svg/math/style/iframe/form/object/embed、SANITIZE_DOM、禁未知协议 URI） | 依赖库漏洞 |
| XSS → 主进程 | renderer 被注入后调 IPC | contextIsolation + sandbox + preload 白名单 + **IPC sender 校验**（可信 WebContents 注册表 + frame URL 协议校验）+ zod 参数校验 | 依赖库漏洞 |
| 恶意外链 | 题面含钓鱼/协议链接 | `isAllowedExternalUrl` 仅放行 http/https；file:/javascript:/data: 等一律拒绝并记日志 | 钓鱼页面本身 |
| 临时文件残留 | 并发运行、崩溃残留 | 每任务独立随机目录 + finally 清理（锁重试）+ 启动清扫 | 进程被强杀时残留（下次启动清扫） |
| 路径注入 | 题目数据含路径内容 | 外部输入只作为**文件内容**（不进 argv）；文件名固定；工具链手工路径仅接受用户在设置中显式输入的本机路径 | 无 |
| 编译器失控 | 恶意/异常编译器插件、递归 include 爆炸 | 编译超时 30s + 编译输出上限 1MB（超限判编译失败并截断标记） | 极端场景的窗口期资源消耗 |
| 数据安全 | 本地 DB 损坏 | WAL 模式、退出显式 close、导入事务原子、迁移事务化 | 无加密（本地明文） |
| 杀软误报 | 新编译 exe 被拦截 | 退避重试 + 明确报错；不做任何绕过 | 体验受本机安全策略影响 |

## 3. 边界与机制详解

### 3.1 进程与命令执行（Compiler Execution / User Code）

- 一切子进程（编译器、解释器、`where`、`vswhere`、`taskkill`）均为 `spawn(exe, args[], {shell: false})` 数组参数调用；**项目内无 exec/execSync/shell 字符串拼接**。
- 用户代码只以文件内容写入临时目录的固定文件名（`main.c`/`main.cpp`/`main.py`）；可执行文件名固定（`app.exe`）。
- 唯一经过 `cmd` 的场景：MSVC 环境解析 `cmd /d /c "<vswhere 定位的 vcvars64.bat> && set"`（windowsVerbatimArguments 保留引号）——bat 路径来自 vswhere 定位结果（非用户输入），执行时机为探测阶段。
- 手工指定的工具链路径：仅接受用户在设置页显式输入的完整路径，作为 spawn 的 program 直接执行（不经过任何 shell 重解析）。

### 3.2 超时与进程树终止

| 阶段 | 超时 | 终止方式 |
|---|---|---|
| 编译 | 30s | `taskkill /PID <pid> /T /F`（树杀）+ `child.kill('SIGKILL')` 兜底 |
| 运行 | 用例 `timeoutMs`（默认 5000） | 同上 |

- `execute` 内部 double-settle 防护：`close`/`error`/兜底定时器多路径只会结算一次。
- `killTree` 后等待 exit 事件；3 秒兜底后强制 SIGKILL 并结算，判题队列不挂死。
- 活跃子进程登记表（`activeChildren`）：应用退出时统一终止，防孤儿进程。

### 3.3 输出大小限制

- 运行阶段：stdout/stderr 各 1MB（`OUTPUT_LIMIT_BYTES`），超限立即杀进程树并置 Output Limit Exceeded。
- 编译阶段：stdout/stderr 各 1MB（`COMPILE_OUTPUT_LIMIT_BYTES`），超限判编译失败，stderr 附截断标记。
- 展示层再截断到 64KB/块，防止 UI 卡死。

### 3.4 临时目录（Temp Directory）

- 目录：`<os.tmpdir()>/cuincodebench/<runId>/`，runId 随机；每任务独占；结束 `fs.rm(recursive, force)` + Windows 锁重试；应用启动清扫遗留目录。

### 3.5 IPC 边界（IPC Boundary）

- `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`webviewTag: false`、无 remote module、无 `webSecurity: false`、无 `allowRunningInsecureContent`、`nodeIntegrationInWorker` 未启用。
- preload 仅暴露 `window.api` 白名单方法。
- 主进程侧三道防线：① **sender 校验**（可信 WebContents 注册表 + frame URL 只接受 `file:` 与开发服务器 origin）；② zod 参数校验；③ 统一错误信封（内部错误只返回摘要，不泄漏堆栈）。
- 窗口导航：`setWindowOpenHandler` 一律 deny + `will-navigate` 一律 preventDefault；URL 经协议白名单后才交给系统浏览器。

### 3.6 Renderer 边界与 Markdown

- CSP：`default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'`。
- Markdown：marked 解析 → DOMPurify 净化（配置见威胁模型表）→ 唯一的 `dangerouslySetInnerHTML` 注入点，输入全部来自题面文本。
- 外部 URL：仅 http/https 允许经 `shell.openExternal` 打开。

### 3.7 本地数据（Local Data）

- 数据目录：`app.getPath('userData')`（`CCB_DATA_DIR` 可覆盖，仅调试）。
- 迁移在事务中执行；导入（信封 zod 校验 + `createMany` 单事务）；提交与明细同事务写入；错误返回统一信封不泄漏内部细节。

## 4. 明确的"非防护"（Known Limitations）

以下**不在**防护目标内：内存限制、CPU 时间限制（Windows Job Object 规划于 v1.2）、文件系统重定向、网络隔离、系统调用过滤、反调试、代码签名。如需真沙箱，应使用容器/虚拟机/Job Object + 受限令牌等机制。

## 5. 漏洞反馈

发现安全问题请通过 GitHub Issues 反馈（当前为个人项目，暂无私有漏洞报告渠道；请勿提交含他人隐私数据的复现材料）。
