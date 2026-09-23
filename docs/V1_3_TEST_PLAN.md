# v1.3 测试计划（docs/V1_3_TEST_PLAN.md）

门禁原则：全部新增能力有**真实执行**的测试（launcher 用例在真实 Windows +
真实子进程上跑；备份用例在真实 SQLite 文件与真实 worker 上跑）。
非 Windows / 无 launcher 环境：native 用例按条件跳过，**fallback 路径必须继续全测**。

## 1. Native Launcher 测试矩阵（P3，核心门禁）

位置 `tests/native-launcher.test.ts`（win32 + launcher.exe 存在时启用）与
`tests/native-launcher.protocol.test.ts`（协议层，可跨平台用桩测编解码）。

### 1.1 功能对拍（与旧 execute() 同输入双路径，结果逐字段一致）

| # | 用例 | 断言 |
|---|---|---|
| 1 | Hello World（C/C++/Python 三语言） | stdout/exitCode 与 fallback 一致 |
| 2 | stdout+stderr 同时输出 | 两路内容与 fallback 一致、互不混流 |
| 3 | 大 stdin（1MB 文本） | 程序完整读回（分帧正确） |
| 4 | 非 ASCII UTF-8（stdin/参数/输出/中文路径 cwd） | 字节级一致 |
| 5 | 正常 exit code（0 / 3） | exitCode 透传 |
| 6 | 崩溃程序（空指针 / abort） | runtime_error 判定不变 |
| 18 | C 编译（gcc/MSVC 真实工具链） | compile ok + 运行 ok |
| 19 | C++ 编译 | 同上 |
| 20 | Python 执行 | 同上 |

### 1.2 资源围栏（真实子进程，事后无孤儿断言）

| # | 用例 | 断言 |
|---|---|---|
| 7 | 死循环 | timeout → terminated，terminationReason=timeout |
| 8 | 无限输出 | output_limit → terminated，截断标记一致 |
| 9 | 大量内存分配（逐步 malloc > 512MB） | memory_limit（runtime_error + reason） |
| 10 | child spawning child（1 层） | 正常完成；超时场景孙进程一并清理 |
| 11 | child spawning grandchild（2 层） | 同上 |
| 12 | process explosion（fork 炸弹） | 进程数截断 ≤ processLimit，整树最终清理 |
| 13 | timeout（每 TestCase） | 与现状语义一致 |
| 14 | output limit | 与现状语义一致 |
| 15 | launcher 被强杀（taskkill /F） | Node 得 launcher_died；子树全灭（KILL_ON_JOB_CLOSE）+ childPid 复查 |
| 16 | Electron 主进程被强杀（E2E 级） | 执行中子树随 launcher 生命周期自然收尾，无孤儿 |
| 17 | 并发 10 Runner | 全部成功、互不串扰、限额独立、无孤儿 |

**每条围栏用例收尾统一断言**：进程表按命令行过滤无遗留
`ccb-launcher` / 用户程序 / 编译器 / python（复用 E2E 的 findOrphan 思路，加 launcher 名）。

### 1.3 协议健壮性（Node 侧注入，无需 launcher 配合）

| 注入 | 断言 |
|---|---|
| REQ 前提前关闭 stdin | launcher 报协议错误退出，Node 得错误不悬挂 |
| 帧长超限 / 未知帧型 / 坏 JSON RESULT | client 解析器拒绝，返回 protocol_error |
| 提前 EOF（RESULT 前退出） | launcher_died + 兜底清理 |
| 超时看门狗（launcher 挂起桩） | +5s 兜底触发 → 杀 launcher → 树清理验证 |

## 2. PoC 门禁（P1，正式实现前置）

最小 launcher + 测试脚本验证 6 项（不达三绿不进入 P2 正式集成）：
1. CREATE_SUSPENDED → Assign → Resume 顺序正确（子进程首输出前 Job 已生效）；
2. KILL_ON_JOB_CLOSE：taskkill launcher → 子进程 500ms 内退出；
3. 孙进程进 Job：child→grandchild 全灭；
4. ACTIVE_PROCESSES=4：fork 炸弹截断；
5. JOB_MEMORY=64MB：malloc 超限程序异常退出且记账峰值 ≥ 限制；
6. 空格/引号/反斜杠/中文参数 argv 交叉验证（--selftest + 回显程序双验）。

## 3. Backup v2 测试

| 组 | 用例 |
|---|---|
| 格式单元 | meta/记录/trailer 编解码；hash 域精确性（改 body 任一字节 → 拒绝）；trailer 不在 hash 内（改 trailer 自身 hash 无影响） |
| 导出闭环 | 导出 → 预览 counts 一致 → 恢复 → 逐表计数 + 内容抽查（含 Unicode/大文本/空库/仅设置库） |
| v1 兼容 | v1 JSON（v1.2.1 产出的真实格式）→ 导入 staging → swap 成功；v1 缺 reviewSessionResults 可导入 |
| 流式性 | 10k 提交导出 worker 内存 O(batch)（进程内存 < 300MB 门禁）；导出过程无全量 stringify（代码审计 + 内存门禁双证） |
| 原子恢复 | 正常恢复全绿；恢复后 FK/integrity/多态检查通过 |
| 失败注入（P11） | 见 §4 |
| 取消 | 导出中途取消 → 无临时文件残留；restore staging 中取消 → staging 删除、正式库未动；swap 后 cancel 被忽略 |
| Worker | worker 正常退出/异常退出（注入 throw/exit）/terminate 清理路径 |

## 4. Failure Injection 矩阵（P11）

| 注入点 | 期望 |
|---|---|
| launcher crash（运行中 taskkill） | launcher_died + 无孤儿 |
| launcher pipe close（client 提前 end） | 协议错误快速失败，不悬挂 |
| worker crash（uncaught throw） | 主进程收到 error，临时产物清理，正式数据不变 |
| worker cancel | 见 §3 取消 |
| disk full（写入 staging 时注入 ENOSPC 桩） | 错误上抛，staging 清理，正式库不变 |
| rename fail（占位 .bak / 锁定注入） | 恢复中止 + 回滚 + 可读错误 |
| DB open fail（损坏 staging 校验） | 拒绝恢复，旧库完好 |
| staging validation fail（FK 断裂备份） | 拒绝 + staging 清理 |
| hash mismatch | 拒绝恢复 |
| corrupted line / 乱码 | 行级拒绝（含行号错误信息） |
| missing trailer / duplicate trailer / 未知 type | 拒绝 |
| restore swap 中断（swap-start 后崩溃，重启应用） | journal 自愈：旧库还原 |
| swapped 后崩溃重启 | journal 自愈：新库保留（integrity 通过）或回滚（损坏） |
| 恢复期间业务 IPC（判题/建题/写入） | maintenance gate 拒绝，错误可读 |

## 5. Property / Invariant 测试（P12）

- Runner 不变量：timeout → no orphan；launcher death → no orphan（随机 20 次循环）；
- Backup 不变量：**任意失败注入后正式 DB 字节不变**（失败前后文件 SHA-256 相等）；
- Restore 成功 → FK clean（foreign_key_check 空）；
- Hash mismatch → refuse（属性：篡改任意 body 字节必被拒——随机位翻转 ×50）;
- NDJSON 模糊：随机截断/乱码/字段缺失/重复记录/乱序/非法 FK ×生成参数，全部安全拒绝（错误信息含行号）;
- Review/Mastery v1.2.1 不变量回归：现有 17 项 exactly-once + 11 项 effective-read 全部保留执行。

## 6. 性能测试（P13）

| 项 | 规模 | 门槛 |
|---|---|---|
| Runner 启动开销 | hello world × 20 平均 | launcher 路径 ≤ fallback 路径 + 50ms |
| 并发判题 | 10 并发 hello | 全部成功，P95 < 3s |
| Backup 导出 | 10k 提交 / 50k 明细 / 100k+ 行 | < 30s，峰值 RSS < 300MB |
| Backup 预览 | 同上 | < 20s（纯读+校验） |
| Restore（staging+swap） | 同上 | < 60s（含迁移与校验） |
| 本地大规模（不入 CI） | 500MB 级备份 | 完成 + 峰值内存记录进最终报告 |

## 7. Clock Rollback 测试（P10）

见 docs/V1_3_CLOCK_ROLLBACK_SPEC.md §7（注入时钟纯函数级 + 服务级组合用例 +
DST 边界用例）。

## 8. 回归门禁（不删不改语义）

- v1.2.1 全部 367 单测 + 8 E2E 继续全绿（settings 修复后）；
- Runner fallback 路径（非 Windows 模拟 / launcher 缺失）行为与 v1.2.1 逐字段一致；
- migration v1→v2→v3→v4 链测试（v4 仅加可空列，无损）；
- E2E 增加：备份导出为 v2 格式（文件首行 meta 断言）+ v2 恢复闭环
  （替换原 v1 导出用例路径，v1 导入用例保留）。

## 9. CI 策略

| 平台 | 内容 |
|---|---|
| windows-latest | 编译 launcher（MSVC）→ native 测试矩阵（无编译器工具链的用例条件跳过）→ 全量单测 → build → package smoke（dist:dir 后断言 exe 在 resources） |
| ubuntu-latest | 全量单测（native 用例自动跳过）→ fallback Runner 集成 → build（TZ=America/New_York 保留） |
| e2e（windows） | 现 8 用例 + v2 备份 E2E + launcher 打包解析断言（resolveLauncherPath 在打包产物上命中） |
