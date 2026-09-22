# CuinCodeBench v1.2.1 深度审计最终报告

- 审计对象：v1.2.0（commit f2210ac）→ 修复交付 v1.2.1
- 审计方法：源码逐文件精读 + 可执行复现（每个 P0 先写失败复现确认红，修复后转正式 regression test 确认绿）
- 过程文档：docs/V1_2_1_DEEP_AUDIT.md（逐项：现象/根因/复现条件/严重程度/测试覆盖/修复设计/数据兼容风险）
- 版本选择：**v1.2.1**（patch）。理由：无公开 API / 备份格式不兼容变化（备份仅新增 optional 字段，v1 备份可导入）；migration v3 为新增式 + 数据无损重写；Job Object 未实装不构成 minor。

---

## 1. Confirmed Bugs（全部已复现 + 已修复 + 已有 regression test）

| # | 缺陷 | 复现 | 严重度 | 修复 |
|---|---|---|---|---|
| B1 | **连续学习天数恒为 1**：`computeStreak` 相邻日判断方向反了（`prev === prevDayNumber(curr)` 在 DESC 序中恒假，首次迭代即 break） | 临时脚本注入连续 3 天提交 → streak=1 | P0 | 改日序号差判定；21 项日历矩阵测试 |
| B2 | **趋势图 DST 跳日/重复**：`buildTrend` 用 `now - n*86400000` 毫秒算术冒充本地日历日；`since` 在 fall-back 周截断最旧日头部 | DST 时区属性测试（CI ubuntu TZ=America/New_York 执行；无 DST 主机跳过） | P0 | LocalCalendarDay 统一日历工具 |
| B3 | **seed 失败 marker 仍标记**：`finally { markMarker }` 无条件执行，「下次启动重试」为假 | 损坏 JSON → `ensureLearningSeedFromFile` 抛错，复刻 index.ts 结构证实 marker 被标记 | P0 | `runLearningSeedStep`：仅成功标记，四终态（seeded/missing/failed/已标记）5 测试 |
| B4 | **Review Session 双计**：同 KP 两题 → interval 连推两级；自动收尾后 UI 再完成 → 全部二次评分；重复 IPC 同理 | 三个独立复现用例全部断言失败（review_count=2 ≠ 1） | P0 | exactly-once 表 + 聚合（见 §4） |
| B5 | **复习项孤儿 → 组题崩溃**：删除题目遗留 `review_items`（多态引用无 FK），`review.startSession` 把已删题目塞入 `practice_session_items` 触发 FK 约束异常，复习功能永久不可用 | orphan 计数=1 复现 + FK 违反代码路径证实 | P0 | DB 触发器 + 服务层双防线（见 §3） |
| B6 | **mastery 45 天衰减不闭环**：衰减只在写路径（recalc）发生，长期不开应用时间流逝不改变物化状态 | 代码路径证实（读路径直读 mastery 表） | P1 | effective on read（见 §6） |
| B7 | **备份 O(N²)**：readAll 五处 filter-inside-map | 10000×50000 ≈ 5×10⁸ 比较推算 | P1 | Map 分组索引（见 §7） |
| B8 | **导出非原子**：writeFileSync 直写，中途被杀留半文件 | 代码证实 | P1 | temp + fsync + rename |
| B9 | **mtime 防调包可绕过**：同尺寸改写可保留 mtime | 代码证实 | P1 | 流式 SHA-256（含同尺寸改写用例） |
| B10 | **E2E 遗留进程/目录**：close 只杀主进程；50+ 个 `.e2e-data` 遗留目录为实证 | 工作区遗留目录 + Windows Electron 多进程模型 | P1 | graceful → kill tree → 断言（见 §8） |
| B11 | 次要：`todaySubmissions/todayReviews` 用 SQL `DATE('now')` 真实时钟与注入 now 口径不一致；`startSession` 死代码；`mapBuiltinProblems` 硬编码 slug；`localMarkerKeys` 硬编码；`before-quit` 不杀子进程；seed 文件缺失无日志 | 代码审读 | S 级 | 全部随相应项顺带修复 |

## 2. Architecture Fixes

- **LocalCalendarDay（src/shared/local-calendar-day.ts）**：全部「天」语义的单一入口——日历算术（Date 构造 + setDate）而非毫秒减法；本地日 key + 日序号（Date.UTC 编码，跨月/跨年/闰年正确）；注入时钟。stats 的 streak / trend / 今日统计全部改走该工具。
- **Review 收尾权威唯一化**：`PracticeRepository.reportResult` 不再对 review 会话自动置 finished（random/kp 会话保留自动收尾）；review 会话的 finished 与评分由 `ReviewService.finishSession` 在同一事务内完成——消除「先 finish 后评分」的中间态。
- **marker 语义集中**：`runLearningSeedStep`（learning-seed.ts）封装「检查 marker → 灌入 → 仅成功标记」；`LOCAL_MARKER_KEYS` 集中于 SettingsRepository（新增 marker 必须同步维护的约定已注释）。
- **掌握度读路径**：`MasteryReader` 结构化接口注入 LearningService；规则单源 `effectiveMasteryStatus` 纯函数。

## 3. Migrations（新增 v3，未动 v1/v2）

migration v3（`review-exactly-once-and-integrity-v1.2.1`，单事务）：
1. `review_session_results`（PK = (session_id, review_item_id)，双 FK CASCADE）；
2. 触发器 `trg_problems_delete_review_cleanup` / `trg_kp_delete_review_cleanup`（多态引用的 DB 层防线）；
3. `review_history` / `practice_session_items` 复制法重建：submission 引用 → `ON DELETE SET NULL`（悬挂引用迁移中置 NULL）；
4. 历史孤儿兜底清理（幂等）。

内置 ID 重写（P1）不在静态 SQL——依赖 seed 内容，由 `migrateBuiltinContentIds` 启动步骤执行（见 §5）。备份格式新增 **optional** 字段 `reviewSessionResults`（v1 备份无此字段可导入，已测）。

## 4. Review Exactly-Once Design

**核心不变量**：一个 Review Session 中，同一 ReviewItem 最多产生一次有效评分（`Review target per session ≤ 1 grade` 不变量测试固化）。

机制三层：
1. **DB 层**：`review_session_results` 主键 (session_id, review_item_id)；`recordSessionResult` 用 `INSERT OR IGNORE`，`changes===1` 才推进调度；与 `applyGrade` 同事务——事务回滚记录一并消失，重试安全；重复 finish/并发 IPC（better-sqlite3 同步序列化）天然幂等；已评分会话再调用为幂等读（返回已记录结果）。
2. **聚合规则（文档化）**：会话内同一复习项命中多题时按 **again > hard > good > easy** 聚合（`GRADE_SEVERITY` / `worseGrade`，任一失败拉低整体，与错题语义一致的保守取向）。同 KP 两题 → KP 只推一级。
3. **终态语义**：取消（`review.cancelSession`）的会话 finished 且无评分记录 → finishSession 拒绝再评分；自动收尾路径 = 判题 hook `onSubmission` → 全部作答完毕 → `finishSession`（评分 + finished 同事务）。

测试（tests/review-exactly-once.test.ts，17 项）：重复 finish ×10 → review_count 仍 1；同 KP 两题（成一败聚合 again）；事务注入失败 → 整体回滚 → 重试不双计；同步连续两次 finish；取消终态；题目项与 KP 项并存一题一评；会话删除级联清理评分记录。

## 5. Seed Identity Migration（P1：位置型 → 稳定语义 ID）

- 新 ID：`ls:{path}:{stage-slug}`（如 `ls:c-basics:loops`）、`kp:{path}:{kp-slug}`（如 `kp:c-basics:for-loop`）；seed v2（`seedVersion: 2`，slug 与 v1.2 内容逐位对应）。
- 迁移（`migrateBuiltinContentIds`）：**单事务** + 事务外切换 `PRAGMA foreign_keys`；显式重写全部引用方（knowledge_points.stage_id / problem_knowledge_points / mastery / review_items.target_id / practice_sessions.knowledge_point_id）；**名称安全网**——按位置映射前核对旧 id 名称与 seed 同位条目一致，顺序错位即中止（零副作用，fail fast 测试覆盖）；迁移后悬挂引用计数自检。
- 触发：新 marker `learning_seed_v2`（保证 v1.2 老用户即使 `learning_v2_mapped` 已置也执行一次）；**恢复备份后强制重跑**（绕过 marker，防止 v1.2 备份把库内 ID 换回位置型后迁移被 marker 跳过——复审中发现的次生问题）。
- 内容迭代：`ensureBuiltinPath` v2 upsert——改名/描述/tags/排序更新、新增 KP 插入、seed 移除的 KP 保留（不破坏 mastery）。「重命名知识点 + 交换顺序 + 追加新 KP」迭代测试证实 mastery 绑定不动。
- 迁移测试（tests/builtin-identity-migration.test.ts，6 项）：用**真实发布 seed 文件**驱动模拟 v1.2 库（mastery/review_items/review_history/mapping/session 全挂在位置型 id 上）→ 升级 → 断言全部数据仍绑定原语义知识点；幂等；安全网；全新库直灌语义 id。

## 6. Mastery Time Model（P1-B）

- 规则单源：`effectiveMasteryStatus(status, lastActivityAt, now)` 纯函数（mastered 且 >45 天无活动 → familiar，score 不变），写路径 `computeMastery` 与读路径共用。
- **effective on read**：`mastery.list` IPC、Dashboard `masteryList`、学习路线页全部经此函数；`lastActivityAt` 与写侧同源（最后提交或复习，单条聚合查询 `kpLastActivityMap`，每行 O(1) 修正，无全库重算、不写库）。
- 测试（tests/mastery-effective-read.test.ts，11 项，注入时钟）：45 天后重开应用读 familiar 而库内仍 mastered；边界恰好 45 天不衰减；读写规则一致性；复习活动刷新 lastActivity；Dashboard 闭环；确定性（同输入同输出）。

## 7. Backup Performance（P1-C）

- readAll 五处 O(N²) → 单次分组索引 O(N)；**性能门禁**（tests/backup-perf.test.ts）：200 题 / 10000 提交 / 50000 明细，readAll + 导出 + SHA-256 + 校验 + 恢复全链路实测 < 2s（预算 5s；旧实现该规模为分钟级）。
- 原子导出：`atomicWriteFileSync`（临时文件 → fsync → rename；失败清理临时文件，不留半文件——失败注入测试覆盖）。
- 防调包：mtime → **流式 SHA-256**（1MB 分块恒定内存；预览时计算、确认时复验；同尺寸改写用例覆盖）。
- v1.2.1 范围内未做（见 Deferred）：主进程同步 JSON.parse/Zod（512MB 上限内可用）；Backup v2（NDJSON 流式 + worker_threads + 进度）设计已写入审计文档附录，v1.3 实施。

## 8. E2E Process Lifecycle（P1-D）

- `close()`：CDP `Browser.close`（优雅退出，走 window-all-closed → 杀判题子进程 → 关库）→ 等待 exit（5s）→ 超时 `taskkill /PID /T /F` 杀树 → 仍失败则抛错并附遗留进程清单。
- `rmDirForce` 改 async + 重试 + **失败抛诊断**（路径/错误/持锁进程/目录条目），不再静默；app-flow 用例 finally 补目录清理。
- 全局断言：两个 E2E 文件 `afterAll` 检查**无本项目遗留 Electron 进程**（powershell Get-CimInstance 按命令行过滤本项目路径）。
- 验证：E2E 8/8 全绿；跑完无 `.e2e-data` 遗留目录、无 electron.exe 遗留进程。

## 9. Job Object Result（P2）

未实装（决策记录于 docs/V1_2_1_JOB_OBJECT_STUDY.md）：完整可行性研究含——libuv 无法 CREATE_SUSPENDED 的竞态分析、三方案对比（C++ Launcher Helper 推荐 / native addon 不推荐 / 无成熟现成依赖）、launcher 协议设计、10 项测试矩阵、v1.3 立项触发条件。README 的「不是安全沙箱，不要运行不可信代码」声明保留。选择理由：正确性修复优先于围栏增强；原生组件（MSVC 构建链 + electron-builder extraResources + 协议维护）进 patch 版本风险大于收益；现有超时清理路径已被 P1-D 加固且工作正常。

## 10. Test Results

- **单测**：29 个文件 / **367 项**（364 passed + 3 skipped：DST 属性测试在无 DST 主机跳过，CI ubuntu TZ=America/New_York 执行）全绿。新增 7 个测试文件 80+ 用例（日历矩阵 24、seed marker 5、exactly-once 17、引用完整性 8、身份迁移 6、mastery effective 11、备份性能/原子/哈希 3 + v1 备份兼容）。
- **迁移测试**：v1 → v2 → v3 全链、幂等、v3 产物断言、真实 seed 驱动的 v1.2 库身份迁移。
- **E2E**（真实 Electron 产物 + CDP）：**8/8 全绿**（启动/路线/Dashboard/复习/设置/判题闭环/备份恢复/v1.1 自动升级），含无遗留进程断言与目录清理验证。
- **性能门禁**：既有 perf-large-db（10000 提交核心查询 <2s）+ 新增备份性能门禁（10000/50000 全链 <5s 实测 <2s）。
- lint / typecheck（node + web）/ build 全绿。

## 11. CI

- `ci.yml`：Test 步骤增加 `TZ: America/New_York`（激活 DST 日历属性测试；Windows 忽略 TZ，该用例在 windows 轮按设计跳过、ubuntu 轮执行）。
- `e2e.yml`：不变（受 P1-D 收益：无遗留进程导致的交叉污染）。

## 12. Known Limitations

1. 备份导入的 JSON.parse/Zod 仍在主进程同步执行——512MB 文本上限内功能正确，但超大库存在 UI 冻结与内存峰值（Backup v2 流式化解决，见 Deferred）。
2. v1.2 时期因 seed 文件损坏被误标 marker 的库不会自动重灌学习路线（marker 已存在）；修复/重装 seed 后可经「恢复任意正常备份」或重置数据目录恢复。
3. Windows Runner 无内存/进程数上限（fork 炸弹可短时占用资源；超时与输出上限路径正常），Job Object 见 §9。
4. DST 属性测试在无 DST 且忽略 TZ 的 Windows 主机本机跳过（CI ubuntu 覆盖）。
5. v1.2 时期已发生的双计评分数据不做回滚修正（无审计基线可判哪次是重复；修复保证不再发生）。

## 13. Deferred Work（v1.3 候选）

- **Backup v2**：NDJSON 流式 + worker_threads + 进度回调 + 上限重估（设计已定稿于审计文档附录）。
- **Windows Job Object**：C++ Launcher Helper（设计 + 测试矩阵已定稿，触发条件已列）。
- 复习调度器「时钟回拨」防护（now 注入架构已就绪，产品语义需设计：回拨时 next_review_at 早于 last_reviewed_at 的处理策略）。
- 掌握度 effective 状态的批量 lazy 物化（当前读侧计算已满足确定性与性能，物化仅在下次 recalc 落库）。
