# v1.3 路线图（docs/V1_3_ROADMAP.md）

阶段门禁：每阶段完成标准全绿才进入下一阶段；高风险设计先 PoC 后实现。
数据安全 > 进程生命周期 > 原子性 > 竞态消除 > 资源限制 > 兼容性 > 测试 > 性能。

## P0 — 基线确认（已完成）

- 目标：v1.2.1 基线全绿（lint/typecheck/test/build/e2e）
- 结果：基线发现并修复 1 个真实缺陷（设置页被工具链探测阻塞，commit 7985c29），
  修复后 367 单测 + 8 E2E 全绿
- 完成标准：✅ 已达成

## P1 — Native Launcher PoC

- 目标：最小 launcher（C++17/Win32）验证 6 项核心可行性（V1_3_TEST_PLAN §2）
- 风险：MSVC 构建链不可用 → 改 CI-only 编译 + 本机降级验证；Job 嵌套语义差异 →
  PoC 明确验证；如果 KILL_ON_JOB_CLOSE 在真实环境不可靠 → 整体降级为 Deferred
- 涉及文件：native/ccb-launcher/launcher.cpp、scripts/build-launcher.mjs、tests/native-launcher.poc.test.ts
- 回滚方案：PoC 失败 → 保留 v1.2.1 Runner，输出 PoC 报告与 Deferred 记录
- 完成标准：6 项 PoC 测试全绿 + 12 项 Architecture Review 问题有实现级答案

## P2 — Launcher 正式集成

- 目标：完整帧协议 + NativeLauncherClient + runProcess 分发（fallback 保留）
- 风险：协议死锁/悬挂（全部读写带超时与提前 EOF 处理）；判题语义回归（对拍测试）
- 涉及文件：src/main/runner/{native-protocol,native-launcher,resolve-launcher,dispatch}.ts、
  judge-service、compile、shared/types（terminationReason）
- 数据库变化：migration v4（test_case_results.termination_reason 可空列）
- 回滚方案：runProcess 一行开关回退 fallback（launcher 缺失/禁用自动回退）
- 完成标准：§1.1 对拍 10 项全绿；C/C++/Python 判题 E2E 不回归

## P3 — Launcher 测试矩阵

- 目标：20 项矩阵 + 每用例无孤儿断言（V1_3_TEST_PLAN §1）
- 风险：CI runner 无 C 工具链 → 条件跳过 + ubuntu fallback 覆盖；fork 炸弹用例
  资源冲击 → processLimit=8 的小规模验证语义等价
- 完成标准：矩阵全绿 + 「无遗留进程」全局断言 20/20

## P4 — Launcher 构建工程与 CI

- 目标：MSVC 构建脚本、gitignore 产物、electron-builder extraResources、
  Windows CI 实际编译、打包 smoke
- 风险：CI MSVC 路径差异 → vswhere 定位（与 msvc-locate 同源逻辑）
- 回滚方案：构建失败不阻塞 ubuntu CI；windows CI 失败即门禁失败（正确行为）
- 完成标准：windows CI 绿 + dist:dir 产物含 ccb-launcher.exe

## P5 — Backup v2 格式与流式导出

- 目标：NDJSON 格式（meta/records/trailer/规范 hash）+ worker 流式导出 + 进度/取消
- 风险：行级 zod 与 v1 envelope 漂移 → 行 schema 从 v1 元素 schema 复用单源
- 涉及文件：src/main/backup/{backup-v2-format,backup-v2-export,backup-worker,backup-worker-client}.ts
- 回滚方案：v1 导出通道保留到 P7 完成后移除（期间双通道并存）
- 完成标准：§3 导出闭环 + 流式内存门禁绿

## P6 — 原子 Restore（staging + swap + journal + 维护模式）

- 目标：staging 导入校验 → 文件级 swap → journal 自愈 → IPC maintenance gate
- 风险（最高）：swap 期间状态机漏洞 → journal 状态表测试覆盖每一崩溃点；
  services 重开引用失效 → index.ts ToolchainService 闭包改走 getServices()
- 涉及文件：src/main/backup/restore-coordinator.ts、services/index.ts（reopen）、
  index.ts（启动自愈）、ipc/register.ts + ipc/index.ts（gate）
- 回滚方案：swap 任意失败自动回滚 rename；journal 自愈兜底
- 完成标准：§4 注入矩阵 restore 相关全部绿 + 崩溃自愈 3 场景绿

## P7 — v1 兼容 + 导入 UI

- 目标：v1 JSON → staging 路径；SettingsView 恢复向导（Preview → Confirm → Progress →
  Success）+ 进度显示 + 禁用重复点击 + 可读错误
- 风险：UI 状态机复杂 → 复用既有 confirm 流骨架，仅加进度态
- 完成标准：v1 兼容组全绿；恢复向导 E2E 绿

## P8 — Clock Rollback（P10 语义）

- 目标：effectiveNow + mastery 钳制 + 测试（spec §7）
- 涉及文件：review-scheduler.ts、review-service.ts、mastery-status.ts、
  tests/clock-rollback.test.ts
- 回滚方案：纯函数小改，回归测试保证无 v1.2.1 行为变化（正常时钟路径逐字节一致）
- 完成标准：新用例全绿 + v1.2.1 复习/掌握度回归不破

## P9 — Failure Injection / Property / 性能（P11-P13）

- 目标：注入矩阵全绿、模糊/属性测试、性能门槛与记录
- 完成标准：V1_3_TEST_PLAN §3-§6 全部绿，性能数字进最终报告

## P10 — 安全审计 / 文档 / 版本（P14-P18）

- launcher quoting/句柄白名单复查；README/SECURITY（containment ≠ sandbox）；
  CHANGELOG；版本 1.3.0；CI workflow（windows 编译 launcher + 打包 smoke）；
  release workflow（安装包/portable 含 launcher）
- 完成标准：文档三件套更新；CI 双平台绿；本地 dist 产物检查通过

## P11 — 最终审计 + 门禁（P19-P20）

- 13 项专项审计（Native Process / Handle Leak / Job Lifetime / Runner Compatibility /
  Backup Format / Worker Thread / Atomic Restore / Crash Recovery / DB Lifecycle /
  Clock Semantics / Migration / Security / Performance）
- 特别搜索：orphan process、double resolve、race、partial restore、stale DB connection、
  temp/staging/.bak 泄漏、worker orphan、handle leak、无界内存、主进程阻塞
- 完成标准：npm ci/lint/typecheck/test/build/e2e + native 全测试 + dist 全绿 0 failed

## P12 — Release + 报告（P21-P23）

- push main → CI/E2E 绿 → tag v1.3.0 → Release（Setup exe + portable 均含
  ccb-launcher.exe，实际下载/解包验证）→ 敏感信息扫描 → V1_3_FINAL_REPORT.md
- 完成标准：Release 资产齐全 + 报告含全部章节与证据

## 明确不做（v1.4 Editor & Project Experience）

clangd / pyright / LSP / 多文件项目 / 在线 OJ / AI 辅助 / 云同步 / 账号系统 /
大型 UI 重做 / 题库大规模扩充。
