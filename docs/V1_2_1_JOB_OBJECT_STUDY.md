# Windows Job Object 资源围栏：可行性研究与设计（v1.2.1 P2）

- 结论先行：**v1.2.1 不实装，保留现有 Runner（taskkill /T /F + 超时 + 输出上限）**。
  原因：可靠实现需要原生组件（C++ helper / native addon），引入 MSVC 构建链、
  electron-builder 打包、签名与协议维护成本，超出 patch 版本范围；现有方案在
  超时清理路径上工作正常，缺口是「极限场景的资源上限」而非功能缺陷。
  本文档给出完整设计与实施条件，供 v1.3 立项决策。
- 定位声明（与 README 一致）：本机制是**资源围栏（containment）**，
  目标是子进程树清理可靠性与资源上限，**不是安全沙箱**。
  Runner 执行不可信恶意代码仍然是不安全的。

## 1. 现状与缺口

当前实现（src/main/runner/execute.ts + kill-tree.ts）：

| 能力 | 现状 | 缺口 |
|---|---|---|
| 超时清理 | `taskkill /PID <pid> /T /F` 杀树 | 极端竞态下孙进程可能在 taskkill 枚举后逃逸（罕见但存在） |
| 内存上限 | 无 | 内存爆炸程序可在此期间分配大量内存，拖垮系统（现有 E2E「内存爆炸」用例只验证不挂死判题队列） |
| 进程数上限 | 无 | fork 炸弹可短时间创建大量进程 |
| 应用崩溃清理 | `killAllActiveChildren`（正常退出路径） | 主进程被强杀（OOM/崩溃）时执行中的子进程遗留 |
| 输出上限 | StreamCollector + 杀进程 | 已覆盖（1MB/路） |

核心竞态：Node 的 `child_process.spawn` 内部经 libuv 调 `CreateProcess`，
**无法以 CREATE_SUSPENDED 挂起后再加入 Job**——从进程创建到 JS 拿到 pid 并调用
`AssignProcessToJobObject` 之间，子进程已可运行并 fork 孙进程；孙进程若在加入前
出生则不在 Job 内（除非设置 JOB_OBJECT_LIMIT_BREAKAWAY_OK 的反向语义，不可靠）。

## 2. 目标

1. 子进程树 containment：主进程无论正常退出、崩溃还是被强杀，整棵树被清理
   （Job Object 的 kill-on-job-close 语义）；
2. 内存上限（JOB_OBJECT_LIMIT_PROCESS_MEMORY，建议 512MB/次判题，可配置）；
3. 进程数上限（JOB_OBJECT_LIMIT_ACTIVE_PROCESSES，建议 32）；
4. 超时后可靠清理（TerminateJobObject 一次调用杀整树，无枚举竞态）；
5. 不引入安全声明，不改变现有 stdio/输出上限/错误传播行为。

## 3. 方案对比

### 方案 A：独立 C++ Launcher Helper（推荐，若立项）

```
Electron main ──stdin/json──▶ ccb-launcher.exe ──CreateProcess(CREATE_SUSPENDED)
                              ├─ CreateJobObjectW
                              ├─ SetInformationJobObject(limits + KILL_ON_JOB_CLOSE)
                              ├─ AssignProcessToJobObject
                              ├─ ResumeThread(hMainThread)
                              └─ 转发 stdout/stderr 管道 → 退出码回传
```

- 协议：launcher 收 JSON 行（program/args/env/cwd/stdin/timeouts/limits），
  输出两路带长度前缀的管道（stdout/stderr）+ 最终 JSON 结果行（exitCode/signals/杀因）。
  Node 侧 `spawn('ccb-launcher.exe', [])` 与普通子进程无异，天然跨平台降级
  （非 Windows 直接走现有 spawn 路径）。
- 超时：Node 侧到点后 `TerminateJobObject` 不可跨进程——改为 launcher 自身持有
  等待句柄并按 timeout 调 TerminateJobObject；Node 只需杀 launcher（launcher
  退出时 Job 句柄关闭 → kill-on-job-close 兜底杀树，即使 launcher 被强杀）。
- 构建：单个 .cpp（<400 行），x64 MSVC（`cl /EHsc /O2`），CI windows job 增加
  一个编译步骤；electron-builder `extraResources` 携带；不签名（本地判题用途，
  README 说明；若未来签名则随主程序证书）。
- 维护成本：中。协议稳定后基本不动；Win32 API 均为十年级稳定接口。

### 方案 B：Node Native Addon（N-API 直接暴露 Job API）

- 优点：无独立进程与协议；缺点：`prebuildify` 多 ABI/多平台矩阵、node-gyp 构建
  脆弱、Electron ABI 差异（需 rebuild）、崩溃时拖垮主进程（addon 崩溃 = 应用崩溃）。
  **addon 内仍无法解决 CREATE_SUSPENDED 竞态**（libuv 源码层限制），还是要在
  addon 里自己 CreateProcess——等于方案 A 的代码搬进主进程，且放大崩溃面。不推荐。

### 方案 C：现有 npm 依赖

- 调研结论（2026-09）：无主流维护的「创建 Job + 挂起启动」包。
  `tree-kill`/`taskkill` 只做清理；`@vscode/windows-process-tree` 只做进程枚举。
  自研不可避免。

### 方案 D：维持现状 + 加固（本次 v1.2.1 已做的部分）

- P1-D 已把 E2E/应用退出的进程树清理加固（graceful → taskkill /T → 诊断）。
- 内存/进程数上限缺失，接受为 v1.3 已知限制（见审计报告 Known Limitations）。

## 4. 若实施：测试矩阵（必须全绿才可合入）

| 用例 | 期望 |
|---|---|
| 正常程序 | stdout/stderr/退出码与现有 execute 完全一致（对拍） |
| 死循环 | timeout 触发 → TerminateJobObject → 整树退出，无遗留 |
| 内存爆炸（malloc until crash） | 触达内存上限 → 进程被终止，状态仍可判（内存超限映射为既有 output/runtime 语义或新增 mem_limit） |
| fork 炸弹（每进程再 spawn） | 进程数上限触发 → 整树终止 |
| child spawning child 后超时 | 孙进程一并清理（Job 语义验证） |
| 主进程强杀（taskkill /F electron） | kill-on-job-close 生效，子树全部退出 |
| 输出超限 | 与现状一致（1MB 截断 + 终止） |
| 管道关闭（EPIPE） | 错误传播不回归 |
| 非参数调用/协议损坏 | launcher 报错退出，不悬挂 |
| 并发 10 个判题 | 各 Job 独立限额互不干扰 |

## 5. 决策记录

- v1.2.1：不实装。理由：正确性修复（P0 系列）优先；原生组件进 patch 版本风险
  （打包/CI/签名三链路都要动）大于收益；现有清理路径已被 P1-D 加固。
- v1.3 触发条件（满足其一即立项方案 A）：
  1. 出现真实用户报告的「判题遗留进程/系统资源被拖垮」；
  2. Runner 需要引入内存/时间双重计费（竞赛模式）；
  3. 开始支持不受限语言（如 shell/脚本生态）。
- 无论是否实装，README 的「untrusted malicious code is unsafe」声明保留。
