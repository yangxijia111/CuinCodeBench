# SECURITY.md — 安全设计

## 1. 定位与最大风险声明（必读）

**CuinCodeBench 不是安全沙箱。** 用户代码以当前 Windows 用户完整权限在本机直接执行，可以读写该用户能访问的任意文件、访问网络、执行任意系统调用。本工具的定位是**运行学习者自己编写（或来自可信题库）的代码**。

因此：

- ❌ 不要用它运行来自不可信来源的代码；
- ❌ 不要在多用户/服务器环境把它当作在线判题系统；
- ✅ 它适合个人本机练习场景，与本地 IDE 运行代码的风险级别相同。

## 2. 威胁模型

| 威胁 | 场景 | v1.0 对策 | 残余风险 |
|---|---|---|---|
| 代码失控（死循环、fork 炸弹式输出） | 学习者写出 `while(1)` | 编译/运行超时 + 进程树强杀 + 输出大小限制 | 恶意代码可在超时窗口内消耗资源 |
| 输出撑爆内存 | 程序输出巨量数据 | 每路输出 1MB 硬上限，超限即杀 | 窗口期内内存占用 |
| shell 注入 | 代码/输入进入命令行 | 全程数组 spawn，无 shell 拼接（唯一例外：MSVC 环境解析用固定 bat 路径，见 §3） | 无 |
| 临时文件残留/互踩 | 并发运行、崩溃残留 | 每任务独立随机临时目录；finally 清理 + 重试；启动时清扫遗留目录 | 进程被强杀时残留（下次启动清扫） |
| 路径逃逸 | 题目数据包含路径类内容 | 题目内容只作为**文件内容**写入（不进 argv、不进命令行）；可执行文件名固定（app.exe）；工作目录固定为临时目录 | 无 |
| Electron 渲染层被注入 | 题面 Markdown 含恶意 HTML/脚本 | contextIsolation + 无 nodeIntegration；Markdown 经 marked 解析 + DOMPurify 净化后渲染（禁 style/iframe/form 与内联事件） | 依赖库漏洞 |
| IPC 滥用 | 渲染进程被攻破后调 IPC | preload 白名单 API + 主进程 zod 参数校验 | 无远程内容来源，攻击面小 |
| 数据安全 | 本地 DB 损坏 | WAL 模式；数据目录用户可控、可备份 | 无加密（本地明文，含用户代码） |
| 杀软误报 | 新编译 exe 被 Defender 拦截 | 文档说明；不做任何绕过 | 用户体验受本机安全策略影响 |

## 3. 关键控制措施

### 3.1 禁止 shell 拼接（FR-R3）

- 一切子进程（编译器、解释器、`where`、`vswhere`、`taskkill`）均 `spawn(exe, args[], {shell: false})`。
- 用户代码只以**文件内容**形态写入临时目录；文件名为系统生成的固定名（`main.c` / `main.cpp` / `main.py`），不使用用户输入作文件名。
- 唯一经过 `cmd` 的场景：MSVC 环境解析 `cmd /d /c "<vswhere 定位的 vcvars64.bat> && set"`（windowsVerbatimArguments 保留引号）——bat 路径来自 vswhere 定位结果（非用户输入），且执行时机为探测阶段。

### 3.2 超时与进程树终止（FR-R5）

| 阶段 | 默认超时 | 终止方式 |
|---|---|---|
| 编译 | 30s（常量） | `taskkill /PID <pid> /T /F` + `child.kill()` 兜底 |
| 运行 | 用例 `timeoutMs`（默认 5000） | 同上 |

终止实现：Windows 用 `taskkill /T /F`（树杀）；等待 `exit` 事件再返回，避免僵尸进程。PID 为运行时句柄值，不可被外部注入。

### 3.3 输出大小限制（FR-R6）

stdout/stderr 各 1MB 累计上限；达到上限立即杀进程树并置 `output_limit`。展示层再截断到 64KB/块，防止 UI 卡死。

### 3.4 临时目录隔离（FR-R4）

- 目录：`<os.tmpdir()>/cuincodebench/<runId>/`，runId 随机。
- 每次运行/编译独占一个目录；任务结束 `fs.rm(recursive, force, maxRetries=5)`。
- 应用启动时清扫 `cuincodebench/` 下的遗留目录（上次崩溃残留）。

### 3.5 路径安全

- 数据目录：`app.getPath('userData')`（可用 `CCB_DATA_DIR` 覆盖，仅测试）。
- 所有路径由 `path.join` 派生；不将任何外部输入直接拼入路径；不写死盘符/绝对路径（NFR-8）。

### 3.6 Electron 加固

`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、只加载本地文件（`loadFile`），不开远程内容。preload 仅暴露白名单方法；`will-navigate` 一律阻止并转交系统浏览器。Markdown 题面经 DOMPurify 净化后渲染。

## 4. 明确的"非防护"

以下**不在** v1.0 目标内（再次强调非沙箱）：内存限制、CPU 限制（job object）、文件系统重定向、网络隔离、系统调用过滤、反调试。如需真沙箱，应使用容器/虚拟机/Job Object + 受限令牌等机制（列入 v1.1 方向）。
