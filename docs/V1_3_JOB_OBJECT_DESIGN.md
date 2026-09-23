# ccb-launcher 设计：Windows Job Object Native Launcher（v1.3）

前置研究：docs/V1_2_1_JOB_OBJECT_STUDY.md（竞态分析、方案对比）。
本文档是正式实现设计。定位：**资源围栏，不是沙箱**。

## 1. 目标与非目标

目标：
1. `CREATE_SUSPENDED → Assign → Resume` 消除 spawn→assign 竞态（首个指令前入 Job）；
2. KILL_ON_JOB_CLOSE：launcher 无论何种方式死亡，整树自动清理；
3. 内存上限（JOB_OBJECT_LIMIT_JOB_MEMORY / PROCESS_MEMORY，默认 512MB）；
4. 进程数上限（JOB_OBJECT_LIMIT_ACTIVE_PROCESSES，默认 32）；
5. timeout 由 launcher 权威执行（TerminateJobObject 整树终止）；
6. stdin/stdout/stderr 可靠转发，输出双层限制，行为与旧 Runner 对拍一致；
7. 错误全映射（错误码 + Win32 GetLastError + 可读 message，不泄露隐私路径/env）。

非目标：
- 安全沙箱、防恶意代码（继承声明）；
- CPU 限频（JOB_OBJECT_RATE_CONTROL 留待后续版本，避免 RTL 系列 API 的版本坑）；
- 跨平台（非 Windows 永远走旧 execute() fallback）。

## 2. 构建形态

- 单文件 `native/ccb-launcher/launcher.cpp`，C++17，Win32 API，x64；
- `/EHsc /O2 /W4 /std:c++17 /MT`（静态 CRT，目标机零依赖）；
- 产物 `ccb-launcher.exe`（gitignore；CI windows 实际编译）；
- 路径解析单源 `resolveLauncherPath()`：
  - dev：`<repo>/native/bin/ccb-launcher.exe`
  - 打包：`process.resourcesPath/bin/ccb-launcher.exe`（electron-builder extraResources）
  - 任一步缺失 → 返回 null → Runner 走 fallback。

## 3. 帧协议（Node ↔ launcher，stdio 管道）

### 3.1 帧格式

```
+----------+--------------+------------------+
| u8 type  | u32 len (LE) | payload (len B)  |
+----------+--------------+------------------+
```

| 值 | 方向 | 名称 | payload |
|---|---|---|---|
| 0x01 | N→L | REQ | UTF-8 JSON（唯一，首帧） |
| 0x02 | N→L | STDIN | 原始字节（≤256KB/帧） |
| 0x03 | N→L | STDIN_EOF | 空 |
| 0x10 | L→N | STDOUT | 原始字节（≤256KB/帧） |
| 0x11 | L→N | STDERR | 原始字节（≤256KB/帧） |
| 0x20 | L→N | INFO | UTF-8 JSON（childPid 等，Resume 后 1 次） |
| 0x21 | L→N | RESULT | UTF-8 JSON（终帧） |
| 0x22 | L→N | ERROR | UTF-8 JSON（致命错误，终帧） |

约束：
- 帧长上限 256KB + 16KB（REQ/RESULT/ERROR JSON 上限 16KB；数据帧 ≤256KB），
  超限 = 协议损坏 → ERROR 帧 + 退出码 2；
- REQ `version` 必须 === 1，否则 ERROR 帧退出码 3；
- launcher 收到 STDIN_EOF 后不再接受 STDIN；RESULT/ERROR 后不再读输入。
- 退出码约定：0 正常（有 RESULT）；2 协议损坏；3 版本不支持；4 内部致命（ERROR 帧）；
  负值/其它 = launcher 被外部终止（Node 侧按 launcher_died 处理）。

### 3.2 REQ JSON

```json
{
  "version": 1,
  "program": "C:\\path\\to\\prog.exe",
  "args": ["--flag", "value with space"],
  "cwd": "C:\\work\\dir",
  "env": { "FULL": "merged env block, node merges process.env first" },
  "stdinBytes": 12345,
  "timeoutMs": 5000,
  "memoryLimitBytes": 536870912,
  "processLimit": 32,
  "outputLimitBytes": 1048576
}
```

- `env` 是完整合并后的环境块（Node 侧合并 process.env，launcher 不做合并）；
- 校验：program/cwd 绝对路径且存在性由 CreateProcess 自行判定（错误→ERROR 帧）；
- timeoutMs ∈ [1, 600000]，memoryLimitBytes ∈ [64MB, 4GB]，processLimit ∈ [1, 4096]，
  outputLimitBytes ∈ [1KB, 64MB]（超界 = 协议损坏）。

### 3.3 RESULT JSON

```json
{
  "exitCode": 3221225725,
  "timedOut": false,
  "outputLimitExceeded": false,
  "killedByLauncher": false,
  "durationMs": 123,
  "peakJobMemoryBytes": 10485760,
  "peakProcessCount": 1,
  "terminationReason": null
}
```

`terminationReason` 枚举（null = 正常退出）：
`memory_limit` | `process_limit` | `timeout` | `output_limit` | `launcher_shutdown`。

- memory_limit 判定：进程非正常退出且 `peakJobMemoryBytes ≥ memoryLimitBytes×0.98`
  （PROCESS_MEMORY 触发时分配失败，进程通常以异常退出；用 Job 记账做证据）；
- process_limit 判定：`peakProcessCount ≥ processLimit` 且子进程创建失败
  （ACTIVE_PROCESSES 满时 CreateProcess 返回失败，程序通常报错退出）；
  两者的映射决策在 Node 侧完成（launcher 只报证据）。

### 3.4 ERROR JSON

```json
{ "code": "create_process_failed", "win32LastError": 2, "message": "..." }
```

错误码全集（launcher 错误映射矩阵，P14 审计对象）：
`invalid_request` / `unsupported_version` / `frame_too_large` / `frame_type_unknown` /
`create_job_failed` / `set_job_limits_failed` / `create_pipe_failed` /
`create_process_failed` / `assign_job_failed` / `resume_thread_failed` /
`wait_failed` / `stdin_write_failed` / `stdout_read_failed` / `stderr_read_failed` /
`internal_error`。
`message` 只含 API 名与阶段描述；**绝不包含** REQ 中的 program/cwd/env 值
（隐私路径与敏感变量不回显；Node 侧日志同样脱敏——只记 program 基名）。

## 4. Launcher 内部流程

```
main:
  读 REQ（严格一帧）→ 解析/校验
  CreatePipe ×3（子 stdin 读端 r1 / 子 stdout 写端 w2 / 子 stderr 写端 w3，
                 均 SECURITY_ATTRIBUTES bInheritHandle=TRUE）
  CreateEvent（超时/IO 完成控制）
  CreateJobObjectW
  SetInformationJobObject：
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
      BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      | JOB_OBJECT_LIMIT_ACTIVE_PROCESSES        (processLimit)
      | JOB_OBJECT_LIMIT_JOB_MEMORY              (memoryLimitBytes)
      | JOB_OBJECT_LIMIT_PROCESS_MEMORY          (memoryLimitBytes)
      | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
    }
  STARTUPINFOEXW：
    si.StartupInfo = { cb=sizeof(STARTUPINFOEXW), STARTF_USESTDHANDLES,
                       hStdInput=r1, hStdOutput=w2, hStdError=w3 }
    UpdateProcThreadAttribute(PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                              allowlist = { r1, w2, w3 })   ← P14 句柄白名单
  CreateProcessW(lpApplicationName=program, lpCommandLine=quote(program, args),
                 bInheritHandles=TRUE, CREATE_SUSPENDED, lpEnvironment=envBlock)
    失败 → ERROR(create_process_failed, GetLastError)
  AssignProcessToJobObject(hJob, hProcess)   ← 仍挂起，无竞态窗口
    失败 → 终止进程 + ERROR(assign_job_failed)
  ResumeThread(hThread)
  INFO 帧（childPid = dwProcessId）
  [stdin writer 线程] STDIN 帧 → WriteFile(r1 的对端? 不，写 hChildStdinWrite)…EOF → CloseHandle
  [stdout reader 线程] ReadFile(hChildStdoutRead) → STDOUT 帧；累计>outputLimitBytes → 置标志+TerminateJobObject
  [stderr reader 线程] 同上
  WaitForSingleObject(hProcess, 剩余 timeoutMs)
    WAIT_TIMEOUT → TerminateJobObject(hJob, EXIT_CODE_TIMEOUT)；timedOut=true；再 WAIT(5s) 收尸
  GetExitCodeProcess + QueryInformationJobObject(记账：peak memory / process count)
  RESULT 帧；CloseHandle(hJob)（正常清理，树已退出）；exit 0
```

线程模型：main（等待+终态）+ 3 个 IO 线程（stdin 写、stdout 读、stderr 读），
线程间只通过：管道句柄、原子标志（limit 触发）、无锁（单读单写管道天然同步）。
IO 线程在进程退出后 ReadFile 返回 0/ERROR_BROKEN_PIPE 自然收尾。

### 4.1 命令行构造（P14 quoting）

标准 MSVCRT 规则（Raymond Chen "Everyone quotes command line arguments the wrong way"）：
- `lpApplicationName = program`（精确路径，不经 shell 解析）；
- `lpCommandLine = "program" + 参数列表`：
  - 参数为空串 → `""`；
  - 不含 space/tab/quote → 原样；
  - 否则加引号，其中 `\` 仅在位于 `"` 前时翻倍，`"` 前置 `\`；
- 末端 `\` 修正在引号闭合前补 `\`。
PoC 用含空格/引号/反斜杠/中文参数的程序回显 argv 交叉验证。

### 4.2 环境块构造

Node 传入完整 env map（已合并）。launcher 构造 UTF-16 环境块：
- 键按不区分大小写排序去重（Windows 要求）；`key=value\0` 序列 + 终止 `\0`；
- 总块 ≤ 1MB、单条 ≤ 32767 UTF-16 单元，超限 = invalid_request。

### 4.3 句柄继承与安全（P14）

- `bInheritHandles=TRUE` + `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` 白名单
  = { 子 stdin 读端, 子 stdout 写端, 子 stderr 写端 }；
- Job 句柄、launcher 自身句柄、标准句柄一律不进白名单 → 不泄露给用户程序；
- 全部可继承句柄以 SECURITY_ATTRIBUTES 显式创建，默认 DACL。

## 5. 资源限制语义

| 限制 | 机制 | 触发后行为 | terminationReason |
|---|---|---|---|
| timeout | WaitForSingleObject 计时 | TerminateJobObject(exit=1) | timeout |
| stdout 输出 | 管道读累计 | TerminateJobObject(exit=2) | output_limit |
| stderr 输出 | 同上 | 同上 | output_limit |
| 内存 | JOB/PROCESS_MEMORY | 分配失败→程序异常退出 | memory_limit（记账佐证） |
| 进程数 | ACTIVE_PROCESSES | 子进程 CreateProcess 失败 | process_limit（记账佐证） |

注意：
- 内存超限不产生内核"击杀"事件，程序以自身异常退出（exitCode 非零），
  launcher 以 Job 记账峰值佐证 reason；映射为 runtime_error + reason（ADR D3）；
- ACTIVE_PROCESSES 是硬闸门：达到上限后新进程无法创建，现有进程不被杀
  （fork 炸弹被截断在 32 个进程，程序可能因 spawn 失败自行退出/死循环由 timeout 收尾）；
- 双层输出限制：launcher 层触发即整树终止并上报 output_limit；
  Node 层（StreamCollector 1MB）保留——两层层值当前同源（OUTPUT_LIMIT_BYTES），
  任一先触发结果一致（对拍测试覆盖）。

## 6. 超时与看门狗（职责矩阵）

| 场景 | 责任方 | 动作 |
|---|---|---|
| 正常超时 | launcher | WAIT_TIMEOUT → TerminateJobObject → RESULT(timedOut=true) |
| launcher 卡死（bug/挂起） | Node 看门狗 | timeoutMs+5s 无 RESULT → taskkill launcher → 等待 Job 清理 → childPid taskkill /T 兜底 → 复查进程消失 → 返回 timeout |
| Node 主动取消（应用退出） | Node | killAllActiveChildren：杀 launcher → KILL_ON_JOB_CLOSE → childPid 复查 |
| launcher 崩溃 | KILL_ON_JOB_CLOSE + Node | Node 得 exit 无 RESULT → launcher_died → childPid 兜底清理 → spawn_error(launcher_died) |

「验证 Job 清理完成」：INFO 帧回传 childPid 后，凡 Node 侧触发终止的路径，
收尾统一走 `ensureTreeGone(childPid, budgetMs)`：轮询进程存在性（powershell
Get-Process -Id 或 tasklist 过滤），预算内未消失 → taskkill /T /F → 仍存在 →
返回结果附 cleanupWarning（不静默）。

## 7. 生命周期与并发

- launcher 进程单请求单响应，一判题一 launcher；Node 用完即等 exit，无复用池
  （避免协议状态机复杂化；启动开销 ~10ms 级，性能测试监控）；
- 并发 10 判题 = 10 个独立 launcher + 10 个独立 Job，限额互不干扰；
- Electron 主进程被强杀：launcher 是孤儿进程，但其 Job 句柄仍在 → 判题按
  timeout/EOF 自然结束，launcher 退出 → Job 关闭 → 树清理；
  launcher 等待 stdin EOF（Node 死后管道断，ReadFile 0）→ 不悬挂。
- launcher 自身不读环境变量、不访问网络、不写文件（除 stderr 回传），攻击面最小。

## 8. 可测试性设计（PoC 钩子）

- launcher 无参数运行 = 协议模式（生产）；`--selftest` 运行内置自检
  （quoting/环境块构造纯函数自证，CI 用，不走协议）；
- REQ 可选 `"stdinBytes": 0` 且无 STDIN 帧 = 空 stdin（合法，等价 EOF 立即）；
- 全部 Win32 调用失败路径在协议层可注入？——不做注入钩子（保持二进制极简），
  失败注入在 Node 侧做（喂损坏协议/杀进程/传错路径），覆盖等效
  （V1_3_TEST_PLAN §3 失败注入矩阵）。
