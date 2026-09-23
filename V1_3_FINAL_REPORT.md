# CuinCodeBench v1.3.0 最终报告

- 版本：v1.2.1 → **v1.3.0**（Native Runtime Containment & Backup v2）
- 仓库：https://github.com/yangxijia111/CuinCodeBench
- Release：https://github.com/yangxijia111/CuinCodeBench/releases/tag/v1.3.0
- 报告生成：2026-09-23

---

## 1. Summary

三大交付全部落地并经真实测试验证：

1. **Windows Job Object Native Launcher（ccb-launcher）**：C++17/Win32 单文件，消除
   spawn→assign 竞态（CREATE_SUSPENDED → Assign → Resume），KILL_ON_JOB_CLOSE 内核级
   整树清理，内存 512MB / 进程数 32 硬上限，launcher 权威超时，二进制帧协议，
   句柄白名单。Windows 判题默认走 launcher；非 Windows / exe 缺失自动回退旧 Runner
   （对拍一致）。**资源围栏，非沙箱**（README/SECURITY 声明保留）。
2. **Backup v2**：NDJSON 流式格式（.ccbbackup），导出/导入在 worker_threads 执行
   （主进程零大对象），恢复 = staging 五重校验 + 文件级原子 swap + restore journal
   崩溃自愈 + 业务 IPC 维护门；v1 JSON 备份兼容导入且收敛到同一安全路径。
3. **Clock Rollback Semantics**：复习调度走单调学习时间线（effectiveNow），
   掌握度衰减 elapsed 钳制，streak/日历按墙钟如实展示。

配套：CI 双平台（Windows 实际编译 launcher）、Release 携带 launcher + 打包 smoke、
打包态判题 smoke、性能门禁、失败注入/取消/崩溃自愈测试。

## 2. Native Launcher Architecture

```
Electron main ──spawn（stdio 管道）──▶ ccb-launcher.exe
   │ REQ 帧（JSON：program/args/cwd/env/timeout/limits）
   │ STDIN 帧×N + EOF                     ┌─ CreateJobObjectW
   │                                      ├─ SetInformationJobObject
   │ STDOUT/STDERR 帧 ◀── IO 线程转发     ├─ CreateProcessW(CREATE_SUSPENDED)
   │ INFO 帧（childPid）                  ├─ AssignProcessToJobObject（挂起中）
   │ RESULT 帧（exitCode/reason/记账）    └─ ResumeThread
```

- 单请求单响应，一判题一 launcher，无复用池；并发 10 判题 = 10 独立 Job。
- 源码 `native/ccb-launcher/launcher.cpp`（正式版）+ `poc.cpp`（可行性验证）；
  `/MT` 静态 CRT 零目标机依赖；产物 gitignore，CI 实际编译。

## 3. Job Object Design

- 限制：`KILL_ON_JOB_CLOSE` + `JOB_OBJECT_LIMIT_ACTIVE_PROCESS`（32）+
  `PROCESS_MEMORY | JOB_MEMORY`（512MB）+ `DIE_ON_UNHANDLED_EXCEPTION`。
- timeout 权威在 launcher（`TerminateJobObject` 一次调用杀整树）；
  Node 看门狗 = timeoutMs + 5s 宽限，兜底杀 launcher（→ Job 关闭清树）并以
  INFO 帧的 childPid 做 `ensureTreeGone` 清理验证（进程存在性轮询 +
  taskkill /T /F 兜底 + 复查，未消失记入结果告警——不静默）。

## 4. Race Elimination

spawn→assign 竞态根因：`child_process.spawn` 内部 CreateProcess 后子进程已可执行。
launcher 以 CREATE_SUSPENDED 创建后在 ResumeThread 之前 Assign——**首条指令执行前
已在 Job 内**，后代进程因 Job 继承出生即入 Job，逃逸窗口不存在。
PoC 与正式矩阵以「child→grandchild 全灭 + fork 炸弹截断 + 强杀清树」实证。

## 5. Resource Limits

| 限制 | 机制 | 触发行为 | 结果映射 |
|---|---|---|---|
| 内存 512MB | PROCESS/JOB_MEMORY | 分配失败→程序异常退出 | runtime_error + `terminationReason=memory_limit`（Job 记账峰值佐证） |
| 进程数 32 | ACTIVE_PROCESS_LIMIT | 超限 CreateProcess 失败 | runtime_error/timeout + `process_limit`（峰值计数佐证） |
| timeout | launcher Wait + Terminate | 整树终止 | time_limit_exceeded + `timeout` |
| 输出 1MB | 双层（launcher 管道层 + Node 流层） | 整树终止 | output_limit_exceeded（触发流上报，截断标志对齐旧语义） |

判题状态枚举**未新增**（ADR D3）：新原因以 `terminationReason` 证据链保留
（migration v4 可空列 + 备份字段透传 + UI 展示），不吞原因。

## 6. Runner Compatibility

同输入双路径对拍（execute vs executeNative）：status/exitCode/stdout/timedOut/
截断标志逐字段一致；异常退出码有符号化对齐（0xC0000005 → -1073741819）；
杀软拦截（win32 5/32）保留退避重试语义。C/C++/Python 判题 E2E 不回归。

## 7. Native Test Matrix（P3）

真实 Windows + 真实子进程：hello world、双流不混流、600KB stdin 跨帧、
中文 stdin/参数（UTF-8 全链）、崩溃退出码、timeout、无限输出、内存吞噬、
fork 炸弹截断、launcher 强杀→launcher_died+KILL_ON_CLOSE 清树+Node 复查、
协议错误（不存在程序）、双路径对拍、并发 5（矩阵 17 并发 10 归入性能门禁）、
**每条围栏用例无孤儿断言**（进程命令行扫描）。PoC 六项（suspend→assign 顺序、
kill-on-close、孙进程、进程上限、内存上限、argv quoting 全角标/中文）全绿。
协议编解码 8 项单元（分块/超限/混合流）。

## 8. Backup v2 Format

- 首行 meta（`{"type":"meta","format":"cuincodebench.backup","version":2,…}`）显式检测，
  绝不按扩展名/首字符猜版本；末行 trailer（counts + bodySha256 + bodyBytes）。
- **规范 hash 域** = meta 行末 LF 之后、trailer 之前的原始 UTF-8 字节；trailer 不参与；
  导出边写边 hash、导入边读行边 hash（禁止先读全文件）；counts/sha256/bytes 三重对拍。
- 行 schema 与 v1 信封元素 schema 单源复用；单行 64MB 上限；文件 4GB 上限。

## 9. Worker Architecture

worker_threads 独立入口（electron-vite 多入口 → out/main/backup-worker.js），
同一 `runJob` 双模式（worker/inline 降级，行为一致）。协议：progress（100ms 节流）/
done/error/cancel（协作式，批次间检查）。worker 崩溃 → 客户端清理临时产物并报
「正式数据未改动」。导出流式（iterator + JOIN 流分组，内存 O(单行/单题)）；
导入流式逐行（流过即弃，预览内存 O(1)）。

## 10. Atomic Restore

```
preview（worker 校验+全文件 SHA-256）→ confirm（防调包复验）
→ staging.sqlite（openDatabase 迁移至当前 schema）
→ 单事务流式导入 + 五重校验（FK/integrity/按表计数/多态引用/会话评分引用）
→ checkpoint+close → 维护模式 ON（业务 IPC gate）
→ journal{swap-start} → closeServices → rename db→.bak → rename staging→db
→ journal{swapped} → reopen + initServices + smoke
→ journal 删除 → .bak 删除 → 维护模式 OFF → renderer reload
```

任一步失败：回滚 rename + 重开旧库 + 维护解除（正式数据零丢失）。

## 11. Crash Recovery（journal 自愈）

启动时 `recoverRestoreJournal`（先于 openDatabase）：

| journal 阶段 | 磁盘状态 | 自愈 |
|---|---|---|
| swap-start | .bak 存在、正式路径缺失 | .bak 还原 + staging/journal 清理 |
| swapped | 新旧并存 | integrity_check 通过→收尾；失败→回滚旧库 |
| 无 journal | staging/.bak 残留 | >24h 才清理（防误删） |

测试覆盖两阶段 + 非 SQLite 文件（句柄泄漏修复）+ 残留清理边界。

## 12. v1 Backup Compatibility

显式检测（v2 meta 行 vs v1 单 JSON 信封 vs 题目导出）；v1 走 legacy zod 校验后
写入 staging（不再直写正式库），计数对拍复用 expectedCounts（键名映射到表名），
同一 swap/journal 机制。导出默认 v2（v1 导出通道保留在 BackupService 供测试）。

## 13. Database Lifecycle

- `closeServices/initServices` 复用为换库重开原语；
- **P19 审计修复**：index.ts ToolchainService 闭包捕获初始 ctx → 恢复后读已关闭
  旧库（stale DB connection）——改为经 `getServices()` 动态解析（04773cc）。
- maintenance gate：恢复期间业务 IPC 返回 `busy`（备份通道白名单放行），
  UI 显示阶段文案并禁用重复点击，完成后 renderer 全量 reload。

## 14. Clock Rollback Semantics

- 学习时间线（单调）：`effectiveNowForScheduling(now, lastReviewedAt ?? createdAt)`；
  `applyGrade` 拆分 lastReviewedAt（单调）与 history.reviewedAt（墙钟记录）。
- 掌握度：`elapsed = max(0, now - lastActivityAt)` 钳制——回拨不凭空衰减。
- 墙钟展示（streak/今日/趋势）：按系统日期如实呈现，不修正（用户可用手机日历对照）。
- 不变量测试 16 项：回拨 1h/1d/30d/60d ×（good/again/连续评分/恢复）、
  I1 nextReviewAt≥lastReviewedAt、I2 interval 非负、I3 计数不回退、I4 回拨不制造
  批量到期、正常时钟路径逐字段无回归。

## 15. Failure Injection

覆盖：launcher 强杀（清树+复查）、worker 崩溃路径（error 消息/exit）、
导出取消（协作式 + 无临时残留）、截断文件、篡改（50 组随机位翻转全拒）、
缺 trailer、未知记录类型、hash mismatch、staging 计数/外键失败、
journal swap-start/swapped 自愈、非 SQLite 库、残留清理边界、恢复期 IPC gate。

## 16. Performance

| 项 | 规模 | 实测 | 门槛 |
|---|---|---|---|
| Backup 导出 | 80k 提交 + 80k 明细（33MB） | **2.5s** | < 30s |
| Backup 预览 | 同上 | **1.4s** | < 20s |
| Restore（staging+swap） | 同上 | **6.1s** | < 60s |
| 主进程 RSS 增长 | 同上 | < 300MB（流式证据） | 有界 |
| launcher 开销 | hello world 均值 | **+58ms**（fallback 104ms vs native 162ms） | ≤ +100ms |

修复记录：记账轮询线程 Sleep(200) 曾使 launcher 收尾延迟 ~170ms（265ms→122ms），
粒度改 20ms；launcher 保留 `CCB_DEBUG_TIMING` 分段计时（默认零成本）。

## 17. Security Audit（P14）

- argv quoting：标准 MSVCRT 规则（空格/引号/反斜杠/尾部反斜杠/中文），
  PoC argv 回环 + 集成测试验证；`lpApplicationName` 精确路径不经 shell 解析。
- 句柄继承：`PROC_THREAD_ATTRIBUTE_HANDLE_LIST` 白名单 = 子进程三个 stdio 句柄；
  Job 句柄等不进白名单不泄露。
- Unicode：W 系列 API + UTF-8↔UTF-16 真转换（修复了 JSON 解析按字节转宽字符的
  重大缺陷——非 ASCII 参数曾全部破坏）。
- 错误回传只含错误码 + GetLastError + 阶段描述，不回显路径/环境变量；
  Node 日志仅记 program 基名。
- 协议：REQ version 校验、帧长上限、未知帧型拒绝（双端版本漂移保护）。
- 定位：资源围栏 ≠ 沙箱（README/SECURITY 明示，不夸大）。

## 18. Tests

- **单测**：36 文件 / **423 passed + 4 skipped（427）**——v1.2.1 基线 367 之上新增 56+
  （协议 8、launcher 集成 14、PoC 6、备份回环 5、原子恢复 8、时钟回拨 16、
  性能/取消 3 + 既有备份 schema/迁移断言更新）。
- **E2E**（真实 Electron + CDP，Windows）：**8/8 全绿**（启动/路线/Dashboard/复习/
  设置/判题闭环/备份 v2 恢复闭环/v1.1 自动升级），无遗留 Electron 进程断言。
- **打包态 smoke**：dist/win-unpacked 启动 → 建题 → python 判题 accepted（经
  resources/bin/ccb-launcher）→ 历史落库。
- 迁移链 v1→v2→v3→**v4**（新增可空列 test_case_results.termination_reason，无损），
  v1/v2/v3 未改动。

## 19. CI

- `ci.yml`：ubuntu（lint/typecheck/test TZ=America/New_York/build；native 用例条件跳过，
  fallback 路径全测）+ windows（**实际编译 launcher** → 全量单测含 native 矩阵 → build）。
- `e2e.yml`：Windows 真实 Electron，前置构建 launcher（判题流经 native 路径验证）。
- `release.yml`：tag 触发 → 质量门禁 → 编译 launcher → NSIS+zip →
  **打包 smoke**（zip 条目 + NSIS 7z 解包断言 ccb-launcher.exe 存在）→ GitHub Release。

## 20. Release

- tag：v1.3.0（指向 77c9f5e，与 main HEAD 一致）
- 资产（Release workflow 实际上传）：
  - `CuinCodeBench-Setup-1.3.0.exe`（123,366,666 B）
  - `CuinCodeBench-1.3.0-win-x64.zip`（169,305,942 B）
- **实际下载/解包验证**：zip 下载解包得 `resources/bin/ccb-launcher.exe`
  （235,008 B，CI/MSVC 构建）；Setup exe 下载后 7za 列表同条目存在——两个包均含 launcher ✅
- Release URL：https://github.com/yangxijia111/CuinCodeBench/releases/tag/v1.3.0
- Release 过程记录：第一/二次 run 失败于打包 smoke（runner 预装 GUI 7-Zip 对
  NSIS 容器列表行为与本地 7za 不一致）；修正为 workflow 内安装 7zip-bin 的
  确定 7za 版本后第三次 run 全绿（35821260312）。

## 21. 敏感信息扫描（P22）

`git ls-files` 无 .env/密钥/凭证/数据库/备份/journal/日志文件；内容模式扫描无
API key/token/private key；无个人绝对路径入库；`native/bin/`（构建产物）已 gitignore。

## 22. Known Limitations

0. **CI 环境时区敏感类**：本轮发现并修复 v1.2 遗留的「SQL localtime vs 进程 TZ」
   日键分裂（Dashboard）与两处测试的跨午夜假设—— CI 在纽约 20:00–24:00 /
   00:00–01:00 运行时曾暴露；现已单源 LocalCalendarDay + 锚定日界，无时钟假设。
1. **launcher 未签名**：SmartScreen/杀软可能对 ccb-launcher.exe 提示或实时扫描
   （首次执行开销 ~100ms 级）；签名链路待有证书后统一处理（随主程序）。
2. **无 CPU 限频**：JOB_OBJECT_RATE_CONTROL 未启用（v1.4 候选）；内存/进程数/超时已覆盖。
3. **v1 备份导入**仍需整文本 JSON.parse（worker 内执行，≤512MB 上限）——大库建议用 v2。
4. 恢复期间的 `backup.export` 在白名单内：极小概率与 swap 窗口竞争导致导出报错
   （不破坏数据；UI busy 态通常已阻止）。
5. 判题进行中触发恢复：判题任务会因旧连接关闭而失败报错（数据安全，WAL 保护）。
6. 本机（Windows 中文 locale）专项修复过的 tasklist 文案解析问题——pidExists 改用
   CSV 引号字段判定，locale 无关；POSIX 平台不涉及。

## 23. Deferred to v1.4（Editor & Project Experience 之外的低优先技术项）

- JOB_OBJECT_RATE_CONTROL（CPU 限频）与 IO 速率限制。
- launcher 崩溃时的 minidump 收集（当前仅退出码 + stderr 尾部）。
- Backup v2 增量备份/去重（当前全量）。
- launcher 多请求复用池（当前一判题一进程，开销 ~30ms 已达标）。
- 掌握度 effective 状态批量 lazy 物化（v1.2.1 遗留，读侧计算已满足）。

## 24. Git / CI 证据

- 基线：08412a2（v1.2.1）→ 交付 HEAD / tag：77c9f5e（v1.3.0）
- 提交链（9 commits）：
  - 7985c29 fix(settings): 设置页不再被工具链探测阻塞（基线修复）
  - c13be65 docs(v1.3): 全套设计文档
  - 3cc999a feat(P1): PoC 六项验证全绿
  - d519e92 feat(P2+P4): Native Launcher 正式集成 + Backup v2 格式/流式导出导入
  - 15531a3 feat(P5-P7): Backup v2 worker/staging 原子恢复/维护模式/v1 兼容/UI
  - 9581e28 feat(P8): 时钟回拨语义
  - ec4e0c6 feat(P9): 性能门槛/取消/失败注入 + launcher 延迟修复
  - cca36c7 chore(P10): 版本 1.3.0 + 文档
  - 04773cc fix(P19): stale ServiceContext 闭包
  - c776e91 fix(P19): Dashboard 趋势/streak 日键统一收敛 LocalCalendarDay
    （SQL 'localtime' 与进程 TZ 分裂的 v1.2 遗留缺陷，CI 纽约 23:37 触发暴露）
  - 15ca66c / 6560401 fix: 对拍与 dashboard 测试的时区/跨午夜环境假设修正
  - 77c9f5e fix: Release smoke 改用 7zip-bin 7za（NSIS 列表行为确定性）
- 本地门禁（v1.3.0 HEAD）：npm ci ✓ / lint ✓ / typecheck ✓ / test 423+4 ✓ /
  build ✓ / E2E 8/8 ✓ / dist:dir + launcher ✓ / 打包态判题 smoke ✓

## 25. 成功标准核对（v1.3 验收单）

| 标准 | 结果 |
|---|---|
| v1.2.1 功能无回归 / exactly-once / 语义 ID / mastery effective | ✅（回归套件全绿） |
| Native Launcher 可靠运行（suspend→assign→resume） | ✅（PoC+矩阵） |
| Job kill-on-close / memory / process limit / timeout 无孤儿 | ✅（真实进程测试） |
| Child/grandchild 无逃逸 | ✅ |
| Runner C/C++/Python 正常（双路径对拍） | ✅ |
| Backup v2 可导出/可导入；v1 兼容导入 | ✅ |
| 导出不构建全量对象；导入不在主线程全量 parse | ✅（worker + 流式 + 内存门禁） |
| Restore staging / 原子切换 / 崩溃可恢复 | ✅（journal 状态表测试） |
| Hash mismatch 拒绝；Cancel 不破坏正式 DB | ✅ |
| Clock rollback 语义明确并测试 | ✅（16 项） |
| lint / typecheck / unit / E2E / native / build / package | ✅ 全绿 |
| v1.3.0 Release（含 launcher 资产） | ✅（见 §20） |
