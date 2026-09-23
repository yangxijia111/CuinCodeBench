# CuinCodeBench v1.3.0 总体架构：Native Runtime Containment & Backup v2

- 版本目标：v1.2.1 → v1.3.0（minor：新增原生组件、新备份格式、平台语义强化）
- 三大交付：
  1. **Windows Job Object Native Launcher**（进程树资源围栏）
  2. **Backup v2**（NDJSON 流式 + worker_threads + Staging 原子恢复）
  3. **Clock Rollback Semantics**（时钟回拨语义定义与防护）
- 定位声明（继承 v1.2.1）：Job Object 是**资源围栏（containment）**，不是安全沙箱；
  运行不可信恶意代码仍然是不安全的（README/SECURITY 同步声明，不夸大）。

---

## 1. 系统全景（v1.3 后）

```
┌────────────────────────── Electron Main ──────────────────────────┐
│ index.ts（启动/退出编排、restore journal 自愈、窗口）              │
│   │                                                               │
│   ├─ ServiceContext（services/index.ts）                          │
│   │    db: better-sqlite3 ── openDatabase（WAL + FK + migrations）│
│   │    ↑ v1.3：DatabaseLifecycleManager.reopen（Backup 恢复换库） │
│   │                                                               │
│   ├─ IPC（ipc/register.ts）                                       │
│   │    ↑ v1.3：maintenance gate（恢复期间业务 IPC 一律 busy）      │
│   │                                                               │
│   ├─ JudgeService ──▶ runProcess（runner/dispatch）               │
│   │      win32 + launcher 存在 ─▶ NativeLauncherClient            │
│   │      否则（非 Windows / exe 缺失 / 显式禁用）                  │
│   │                               ─▶ 旧 execute()（fallback 保留）│
│   │                                                               │
│   ├─ BackupService v2（backup/ 目录）                             │
│   │    export: worker_threads 流式 NDJSON → 临时文件 → rename     │
│   │    import: worker 解析校验 → staging.sqlite → 原子 swap       │
│   │    v1 JSON 备份：legacy importer → 同一 staging + swap 路径    │
│   │                                                               │
│   └─ RestoreCoordinator（staging 生命周期 / journal / 维护模式）   │
└───────────────────────────────────────────────────────────────────┘
        │ spawn（stdio 管道）                 │ worker_threads
        ▼                                     ▼
┌─ ccb-launcher.exe（C++17/Win32）─┐   ┌─ backup worker ─┐
│ 读 REQ（长度前缀 JSON）          │   │ 自持 DB 连接     │
│ CreateJobObjectW + 限制          │   │ 分页读/逐行校验  │
│ CreateProcessW(CREATE_SUSPENDED) │   │ 流式写出/导入    │
│ Assign → Resume（无 spawn 竞态） │   │ 进度/取消协议    │
│ IO 转发 + 双层输出限制           │   └─────────────────┘
│ timeout → TerminateJobObject     │
│ RESULT 回传；死后 KILL_ON_CLOSE  │
└──────────────────────────────────┘
```

## 2. 模块与文件布局（v1.3 新增/修改）

新增：
```
native/ccb-launcher/launcher.cpp        # 单文件 launcher（C++17，<700 行）
scripts/build-launcher.mjs              # MSVC 构建脚本（vswhere 定位 + vcvars64 + cl）
native/bin/ccb-launcher.exe             # 构建产物（gitignore，不入库）
src/main/runner/native-protocol.ts      # 帧协议常量 + 编解码（Node 侧）
src/main/runner/native-launcher.ts      # NativeLauncherClient（REQ/IO/RESULT/看门狗）
src/main/runner/resolve-launcher.ts     # resolveLauncherPath()（dev/package 统一路径）
src/main/runner/dispatch.ts             # runProcess()：launcher 可用则用，否则 fallback
src/main/backup/backup-v2-format.ts     # v2 NDJSON 常量/行编解码/规范 hash 域
src/main/backup/backup-v2-export.ts     # 流式导出（分页 SELECT → 行 → hash → 写）
src/main/backup/backup-v2-import.ts     # 流式解析 + zod 行校验 + hash/计数复核
src/main/backup/restore-coordinator.ts  # staging + swap + journal + 维护模式
src/main/backup/backup-worker.ts        # worker_threads 入口（export/import/staging）
src/main/backup/backup-worker-client.ts # Worker 客户端（进度/取消/超时/降级 inline）
docs/V1_3_*.md                          # 本套设计文档
```

修改（关键）：
```
src/main/runner/execute.ts              # 保留为 fallback；ExecutionResult 增 terminationReason
src/main/judge/normalize.ts             # terminationReason 不吞（映射 runtime_error 但保留原因）
src/main/services/judge-service.ts      # execute → runProcess；per-case reason 透传落库
src/main/db/migrations.ts               # v4：test_case_results.termination_reason（可空，无损）
src/main/services/index.ts              # closeServices/reopenServices（生命周期管理）
src/main/ipc/register.ts                # backup v2 通道 + maintenance gate
src/main/index.ts                       # 启动时 restore journal 自愈；恢复后窗口 reload
src/shared/{types,schemas,constants}.ts # v2 格式/协议常量/terminationReason 类型
src/renderer/.../SettingsView.tsx       # 备份进度/恢复向导/禁用重复点击
electron-builder.yml                    # extraResources: bin/ccb-launcher.exe
.github/workflows/{ci,e2e,release}.yml  # Windows 编译 launcher + 打包 smoke
```

## 3. Architecture Review（12 项必答）

### Q1 Job Object 是否真正消除 spawn → assign 竞态？
是。竞态根源：`child_process.spawn` 内部 CreateProcess 后进程已开跑，JS 拿到 pid 前
子进程可 fork 孙进程逃逸。launcher 用 `CreateProcessW(CREATE_SUSPENDED)` 创建即挂起，
在 `ResumeThread` 之前完成 `AssignProcessToJobObject`——**首个指令执行前已在 Job 内**，
任何后代进程因 Job 继承（默认语义，未设 BREAKAWAY）出生即在 Job 内，逃逸窗口不存在。
PoC 用「child→grandchild 全灭 + 进程数上限截断 fork 炸弹」验证（V1_3_TEST_PLAN §2）。

### Q2 Launcher 崩溃时是否仍能清理 Job？
是，依赖 **KILL_ON_JOB_CLOSE**：launcher 持 Job 句柄，进程死亡（无论正常退出、崩溃、
被 taskkill /F）→ 句柄关闭 → 内核终止 Job 内全部进程。Node 侧对 launcher 异常退出
（无 RESULT 帧）返回 `launcher_died` 状态，并用 REQ 阶段回传的 childPid 做
`taskkill /T` 兜底 + 进程存活复查（V1_3_JOB_OBJECT_DESIGN §7）。

### Q3 Node 与 launcher 的协议是否稳定？
二进制帧协议（[u8 type][u32 LE len][payload]），版本号在 REQ JSON 内
（`version: 1`），launcher 拒绝未知版本/未知帧型/超长帧（报 ERROR 帧后退出）。
单请求单响应、stdin 数据帧化（用户数据永不与控制流混流）。协议常量双端单源：
C++ 侧内置同值常量并在 PoC 交叉验证；Node 侧 `native-protocol.ts`。
破坏性变更将升 `version`，launcher 按 version 分支（当前仅 1）。

### Q4 stdout/stderr/stdin 如何可靠转发？
- stdin：Node 按 ≤256KB 分帧 STDIN → launcher 写子进程 stdin 管道；EOF 帧 → 关闭。
  用户数据是纯 payload，不可能与控制 JSON 混淆（v1.2.1 研究指出的核心风险）。
- stdout/stderr：launcher 双线程读管道 → 分帧回传（≤256KB/帧）；Node 侧仍由
  StreamCollector 累计并执行第一层输出限制（保留现有 1MB 语义与截断标记）。
- launcher 同时执行第二层限制（累计字节超 outputLimitBytes → TerminateJobObject），
  双层任一触发即整树终止（V1_3_JOB_OBJECT_DESIGN §6）。

### Q5 timeout / output limit / memory limit 谁负责？
- **timeout：launcher 权威**（持有 Job 句柄，WAIT_TIMEOUT → TerminateJobObject 一次
  杀整树，无枚举竞态）；Node 看门狗（timeoutMs + 5s 兜底余量）只在 launcher 无响应时
  杀 launcher → KILL_ON_JOB_CLOSE 兜底，并验证清理完成（Q2）。
- **output limit：双层**（Node 流层语义兼容现状 + launcher 管道层兜底）。
- **memory/process limit：launcher（Job 内核强制）**。Windows 无用户态可靠等价物。

### Q6 Backup v2 如何避免主进程大对象？
导出/导入/staging 全部在 worker_threads 中执行：worker 自持 SQLite 连接（WAL 允许
并发读者/独立写者文件），分页 SELECT（rowid 游标，每批 500 行）→ 逐行序列化 →
流式写出；导入反向流式。主进程仅 dialog/IPC/进度转发/取消信号，
内存 O(batch) 而非 O(database)。`:memory:` 库（测试）或 worker 不可用时降级
inline 模式跑同一代码路径（功能等价，不撑大主进程是生产语义）。

### Q7 Worker 崩溃时如何处理？
client 监听 `exit` 事件：worker 非正常退出 → 清理其半成品（临时导出文件 /
staging 文件）→ 上报 AppError('internal', '备份工作线程异常退出，正式数据未改动')。
staging 导入中 worker 死亡 → staging 文件删除，正式 DB 全程未触碰。
`worker.terminate()`（取消）与崩溃走同一清理路径。

### Q8 Restore 如何保证真正原子？
**不在正式库中做分批 COMMIT**。全部导入发生在独立的 staging.sqlite
（先 migrate 到当前 schema），全量校验通过后做**文件级原子切换**：
`close 正式库 → rename 正式库→.bak → rename staging→正式库 → reopen → smoke → 删 .bak`。
切换窗口内任何一步失败 → 回滚 rename（.bak 还原），重开旧库，用户数据零丢失。
WAL 文件在关闭+checkpoint(TRUNCATE) 后清理，rename 只动主文件（§V1_3_BACKUP_V2_SPEC §6）。

### Q9 v1 Backup 如何继续导入？
显式格式检测（首行 meta / v1 单 JSON 对象 + format 字段），v1 走 legacy importer
（既有 zod envelope 校验），但**写入目标改为 staging**，与 v2 共享同一 staging+swap
与 journal 机制——v1 路径不再直接写正式 DB。导出默认 v2，v1 导出通道移除。

### Q10 新备份格式如何版本化？
- 格式名 `cuincodebench.backup` + `version: 2`，位于首行 meta 显式声明；
- 导入支持 version ≤ 2（当前即 1/2），> 2 明确报「版本过新」；
- 每条记录带 `type`，新增表 = 新 type + trailer counts 扩展（向后兼容读端忽略未知 type？不——
  **导入端遇未知 type 拒绝**，防止截断语义丢失；写端只产已知 type）；
- `schemaVersion`（DB 迁移版本）记录在 meta，恢复时 staging 迁移到当前版本。

### Q11 数据库替换时如何避免半恢复？
三道防线：
1. **维护模式**：切换期间主进程 IPC gate 拒绝全部业务通道（判题/写入/建题），
   UI 显示「正在恢复数据」且按钮禁用；
2. **restore journal（restore-state.json）**：每次状态迁移前先写 journal（含阶段与
   文件名），切换完成后删除；启动时发现残留 journal 按阶段表自愈
   （staging 半成品→删；.bak 存在且正式库打不开→回滚；已换库且校验通过→收尾删 .bak）；
3. **rename 原子性**：同目录 rename 在 NTFS 上原子；顺序保证任意崩溃时刻
   正式路径上要么是旧库要么是新库，绝不缺失（V1_3_BACKUP_V2_SPEC §7 状态表）。

### Q12 恢复失败时如何回到原库？
切换前旧库已 rename 为 `.bak`（非删除）；任何 reopen/smoke 失败 →
回滚 rename（.bak → 正式路径）→ 重开旧库 → 报可读错误。极端崩溃场景由
journal 自愈兜底。`.bak` 仅在恢复完全成功后才删除，且删除失败只告警不报错
（保守：宁可多留一个备份文件）。

## 4. 关键决策记录（ADR）

| # | 决策 | 理由 |
|---|---|---|
| D1 | 独立 C++ launcher（方案 A），不做 N-API addon | addon 无法解决 CREATE_SUSPENDED 竞态且崩溃面扩大（v1.2.1 研究结论继承） |
| D2 | 二进制帧协议，不做行 JSON 混流 | 用户 stdin/stdout 任意二进制，必须与控制流分帧 |
| D3 | 新增 JudgeStatus？——**不新增** | memory/process 超限内部映射 runtime_error，`terminationReason`（ExecutionResult/TestCaseResult/migration v4 可空列）保留细节；避免 types/DB/UI/备份全链扩展的爆炸范围 |
| D4 | timeout 归 launcher，Node 看门狗兜底并验证清理 | launcher 持 Job 句柄可 TerminateJobObject 杀整树；Node 只杀 launcher 无法验证 Job 清理，故必须 childPid 复查 |
| D5 | 备份 restore 用 staging + 文件 swap，不用大事务 | 大事务跨分钟级会拖长 WAL 且 UI 冻结；文件 rename 是真正原子；journal 解决崩溃自愈 |
| D6 | v1/v2 备份统一 converge 到 staging 路径 | 消除「两条恢复路径两种可靠性」的长期维护税 |
| D7 | worker 内自开 SQLite 连接，不走主进程句柄 | better-sqlite3 句柄不能跨线程转移；WAL 并发读者是官方支持姿势 |
| D8 | launcher 无 MSVC CRT 动态依赖（/MT 静态链接） | 避免目标机缺 VC Redist 时 launcher 无法启动；exe 体积 ~100KB 可接受 |
| D9 | launcher 不签名（随主程序，同 v1.2.1 决策） | 本地判题用途；签名链路留待有证书后统一处理 |
| D10 | 时钟回拨：调度用 effectiveNow=max(now, lastReviewedAt)；展示用真实墙钟 | 学习时间线单调性与日历展示语义分离（V1_3_CLOCK_ROLLBACK_SPEC） |

## 5. 与 v1.2.1 不变量的关系

- Review exactly-once、stable semantic IDs、mastery effective-on-read、
  LocalCalendarDay、备份 O(N) 读取与原子导出（v1 导出路径被 v2 替代后，
  其原子导出思想延伸为 v2 的 temp+fsync+rename）——全部保留，回归测试不删。
- migration v1/v2/v3 不修改；v4 只新增可空列。
- 现有 Runner 语义（compile_error / runtime_error / time_limit_exceeded /
  output_limit_exceeded / internal_error / spawn_error）对拍测试保证不回归
  （V1_3_TEST_PLAN §1.3：同输入双路径对拍）。
