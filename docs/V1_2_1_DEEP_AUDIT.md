# CuinCodeBench v1.2.1 深度正确性 / 架构 / 可靠性审计

- 审计基线：v1.2.0（commit f2210ac）
- 审计范围：`src/main/**`（services / db / review / learning / runner / ipc）、`src/shared/**`、`tests/**`、`tests/e2e/**`、v1.2 全部文档
- 审计方法：源码逐文件精读 + 可执行复现（临时 vitest 复现用例，确认后移除，转为正式 regression test）
- 结论摘要：**确认 4 个 P0 级正确性缺陷（全部已用失败测试复现）、3 个 P1 架构缺陷、2 个 P1 可靠性缺陷、1 个 P2 待研究项**，另有若干次要发现。

---

## P0-A：连续学习 streak 恒为 1（方向反了的相邻日判断）

| 项 | 内容 |
|---|---|
| 现象 | 连续 3 天每天有提交，Dashboard `streakDays` 显示 1 而非 3 |
| 根因 | `StatsRepository.computeStreak()`（src/main/db/repositories/stats-repository.ts:146-155）：`days` 为 DESC 序（`days[i-1]` 比 `days[i]` 更新），但相邻判断写成了 `prev === prevDayNumber(curr)`。`prevDayNumber(curr)` 是 curr 的**前一天**（更旧），而 `prev` 恒比 `curr` 新，两者永不相等 → 循环第一次迭代即 break。正确判断应为 `curr === prevDayNumber(prev)` |
| 复现 | 已复现：临时脚本注入今天/昨天/前天三条提交 → streak=1（期望 3）。测试 `tests/db.test.ts:332` 只覆盖「今天提交=1 天」，从未覆盖多天连续，因此未被发现 |
| 严重程度 | P0（核心学习指标完全失真，用户可感知） |
| 已有测试 | 仅「今天=1」单一用例；无多天/断档/跨月用例 |
| 修复设计 | 1) 修正判断方向；2) 抽取 `LocalCalendarDay` 工具（src/shared，纯函数、可注入时钟），streak 与 trend 共用，禁止 ms 算术冒充日历日 |
| 数据兼容风险 | 无（纯读路径计算，无持久化） |

### P0-A-2：buildTrend 用 `now - n*86400000` 冒充本地日历日（DST 漂移）

| 项 | 内容 |
|---|---|
| 现象 | 在有夏令时的时区，趋势图 7/30 天序列在 DST 切换周会出现**重复日或跳日**；`since` 过滤会截断最旧一天的头部数据（fall-back 周本地日长 25h > 24h） |
| 根因 | `buildTrend()`（stats-repository.ts:223,244）：`since = now - days * 86_400_000` 与 `new Date(now - i * 86_400_000)` 均为毫秒算术。例：2026-03-09 00:30 EDT 减 24h 落在 2026-03-07 23:30 EST —— 03-08 被跳过。中国大陆无 DST 故现网不可见，但代码是错的 |
| 复现 | 时区注入测试（TZ 环境变量 + 固定时钟）可稳定复现跳日 |
| 严重程度 | P0（与 P0-A 同源：日历语义错误；对中国用户潜伏） |
| 已有测试 | dashboard-v2.test.ts 只断言「最后一天=今天」与总计数，未断言连续无重复 |
| 修复设计 | `LocalCalendarDay` 工具：以本地日历构造 Date 并用 `setDate(getDate()-1)` 回退（ECMAScript 保证跨 DST/闰年/月正确），生成 N 天连续 key 序列 + 对应 `since`（用最早一天的本地 00:00 的 UTC ms，而非 ms 减法） |
| 数据兼容风险 | 无 |

---

## P0-B：学习路线 seed 失败后 marker 仍被标记，「下次启动重试」是假的

| 项 | 内容 |
|---|---|
| 现象 | seed 文件损坏（JSON.parse / zod 抛错）时启动日志打印「学习路线灌入失败（下次启动重试）」，但下次启动**不再重试**——路线永远缺失 |
| 根因 | `src/main/index.ts:141-154`：`catch` 只记日志，`finally { services.settings.markMarker(LEARNING_V2_MAPPED_KEY) }` **无条件**标记成功 |
| 复现 | 已复现：`resources/seed-learning-path.json` 写入损坏 JSON → `ensureLearningSeedFromFile` 抛 `SyntaxError`；复刻 index.ts 的 try/catch/finally 结构证实 marker 被标记。四种情况矩阵：成功→标记（对）；失败→标记（**bug**）；文件不存在→静默跳过+标记（设计如此但无日志，可接受）；JSON 损坏→标记（**bug**） |
| 严重程度 | P0（升级路径数据丢失，且以「重试」名义掩盖） |
| 已有测试 | 无（learning-seed 相关测试只测成功路径） |
| 修复设计 | 仅在成功后标记：把 `markMarker` 移入 try 成功路径末尾；文件缺失单独 info 日志。regression test 覆盖四种情况（用临时目录注入 seed 文件） |
| 数据兼容风险 | 无（修复后老用户中曾因损坏 seed 被误标记的库**不会自动重试**——marker 已存在。提供说明：重装/修复 seed 文件后可通过恢复备份或手动清 marker 触发；默认不自动清，避免重复灌入） |

---

## P0-C：Review Session 非 Exactly-Once（重复评分 / 双计 / interval 连推）

核心不变量被违反：**一个 Review Session 中，同一 ReviewItem 最多只能产生一次有效评分**。

| # | 现象（均已复现） | 根因 |
|---|---|---|
| C1 | 同一知识点在会话中对应 2 道题（`PROBLEMS_PER_KP=2`），两题都 AC → KP `review_count` +2、interval 连推两级 | `finishSession`（review-service.ts:203-244）逐题循环，每题都对**其全部关联 KP** 调 `applyGrade`，无按 review_item 去重 |
| C2 | 最后一题判题 → `onSubmission` 自动收尾（`reportResult` 置 finished + `finishSession`），UI「完成」按钮再调一次 `review.finishSession` → 全部题目二次评分 | `finishSession` 无 finished 守卫：item.status 已是 accepted/failed（非 pending），全部再次 applyGrade |
| C3 | IPC 快速重复请求 / 重试 → 双计 | 同 C2，服务层无幂等；`ipc handle` 亦无 |
| C4 | 事务失败重试 | 当前整段在一个事务内，better-sqlite3 失败自动回滚——单次调用原子性成立；但 C2 的重复调用使其失效 |

| 项 | 内容 |
|---|---|
| 严重程度 | P0（最高优先级：调度状态被破坏，用户复习计划永久漂移） |
| 已有测试 | review-scheduler 只测纯函数；practice-session/review 集成测试只测 happy path 单次收尾 |
| 修复设计 | 1) **DB 层 exactly-once**：migration v3 新增 `review_session_results(session_id, review_item_id, PRIMARY KEY(session_id, review_item_id))`；`finishSession` 在同一事务内 `INSERT OR IGNORE`，`changes===0` 即跳过该 item 评分——重复调用天然幂等，事务回滚则记录一并消失；2) **聚合规则（写入文档与代码）**：会话内同一 review_item 的多题成绩聚合为单一等级，优先级 `again > hard > good > easy`（任一失败即拉低，保守取向，与错题语义一致）；3) `finishSession` 对已 finished 会话直接返回已记录结果（幂等读）；4) mastery 重算移入收尾路径幂等执行 |
| 数据兼容风险 | migration v3 仅新增表，无破坏；v1.2 旧会话无 results 行，重复 finish 旧会话理论上仍可双计——但旧会话在 v1.2.1 打开后按新代码走 `INSERT OR IGNORE`，首次调用即建立 results 行，此后幂等。已有双计数据不做回滚（无审计基线），在报告中说明 |

---

## P0-D：review_items 多态引用完整性（孤儿 + startSession 崩溃）

| 项 | 内容 |
|---|---|
| 现象 | 1) 删除题目 → 其 problem 类型 review_item 成孤儿（已复现：orphan 计数=1）；2) 孤儿导致 `review.today` 显示幽灵项、`review.startSession` 把已删题目塞进 `practice_session_items` → **FK 约束违反，组题崩溃**（后续复习功能完全不可用，直到该孤儿被清理）；3) `review_history.submission_id`、`practice_session_items.first_accepted_submission_id` 无 FK，submission 随 problem 级联删除后悬挂 |
| 根因 | `review_items(target_type, target_id)` 是多态引用，普通 FK 无法表达。服务层仅 `onMistakeMastered` 一处主动清理；`problems.delete` 无清理；migration v2 有一次性兜底 DELETE 但只跑一次 |
| 复现 | 已复现（orphan 计数断言失败）。startSession 崩溃由代码路径推演 + FK 定义证实（practice_session_items.problem_id REFERENCES problems ON DELETE CASCADE，插入已删 id 必然违反） |
| 严重程度 | P0（用户可稳定触发的功能崩溃） |
| 已有测试 | 无 |
| 修复设计 | 双层防线：1) **DB 层（migration v3）**：SQLite 触发器 `problems_ai_after_delete`——problems 删除后 DELETE 相应 problem 复习项（含 review_history 级联）；`review_history.submission_id` / `practice_session_items.first_accepted_submission_id` 重建表加 `ON DELETE SET NULL`（SQLite 不支持 ALTER COLUMN，需 rebuild）；再加孤儿兜底清理（同 v2 手法，防御历史数据）；2) **服务层**：`ProblemService.remove` 显式调用 `reviewSvc.deleteByProblem`（提前清理，不依赖触发器）；`startSession` 组题前过滤 target 不存在的 due 项（防御 future 漂移）。备份恢复路径已有 `checkCrossReferences` 挡导入，保持 |
| 数据兼容风险 | 重建两张表需在 migration v3 内 `CREATE new → INSERT SELECT → DROP old → RENAME`，单事务；旧行的悬挂 submission_id 被 SET NULL 语义吸收（NULL 本来就合法）。触发器为幂等 DDL，备份恢复（clearAll/writeAll）期间触发器会对 DELETE 产生额外清理（幂等无害） |

---

## P1：内置内容身份为位置型 ID（identity drift）

| 项 | 内容 |
|---|---|
| 现象 | `builtinStageId(slug, stageIndex)` = `ls:c-basics:0`、`builtinKpId` = `kp:c-basics:0:1`（learning-repository.ts:25-30）。未来在数组中间插入/重排 stage 或 KP 后，**已有 mastery / review_items / problem_knowledge_points / 备份中的 ID 语义全部漂移**（ID 不变但指向的内容变了） |
| 根因 | 以数组下标作长期身份；`ensureBuiltinPath` 用 `INSERT OR IGNORE`，内容修改（重命名/描述/tags）也永不生效 |
| 严重程度 | P1（当前数据无损，但 v1.3 任何内容迭代都会破坏用户数据——必须在内容迭代前修） |
| 已有测试 | migrations.test.ts 断言的就是 index 型 ID（测试固化了错误设计） |
| 修复设计 | 1) seed schema v2：stage/kp 增加稳定 `slug`（如 `control-flow`、`for-loop`），新 ID `ls:c-basics:control-flow` / `kp:c-basics:for-loop`；seed 文件加 `seedVersion`；2) migration v3（单事务、高风险）：按 **(path.slug, stage 原序, kp 原序) → 新 seed 的 slug 对应表** 重写 learning_stages/knowledge_points 主键并级联更新 mastery / review_items / problem_knowledge_points / practice_sessions.knowledge_point_id（SQLite `PRAGMA foreign_keys=OFF` + 手动级联 + defer，或重建表法；采用**显式 ID 映射重写**，全部在同一事务）；3) `ensureBuiltinPath` v2 改 upsert：新 KP 插入、已有 slug 更新内容、排序变化只改 sort_order——**不再用 index 生成 ID**；4) migration test：模拟真实 v1.2 库（mastery/review_items/review_history/problem mapping 各有数据）→ 升级 → 断言全部数据仍绑定原语义 KP |
| 数据兼容风险 | 高。缓解：映射表由 seed 文件静态给出（v1.2 seed 与 v1.2.1 seed 的 slug 一一对应，二者都在仓库中）；单事务失败整体回滚；迁移前后 KP 总数与名称集合断言。备份兼容：v1 备份里的旧 ID 导入后由同一迁移逻辑重写（导入路径在 v1.2.1 二进制上执行，届时库已是 v3 schema，恢复旧备份 → writeAll 旧 ID → **需要恢复后再跑一次 ID 重写**；方案：restore 完成后调用 `migrateBuiltinIdsV2` 幂等函数） |

## P1-B：Mastery 时间衰减不闭环（时间变化不改变物化状态）

| 项 | 内容 |
|---|---|
| 现象 | mastered 的 45 天惰性衰减只在 `computeMastery(now)` 里（mastery-service.ts:127-130），而 mastery 是持久化缓存，仅判题/复习/手动重算时刷新。**用户 45 天不打开应用 → 重新打开 → Dashboard/路线页读到的仍是 mastered**，`stale` 降级永不发生 |
| 根因 | 时间依赖的派生状态被物化，但读路径不做时间修正，也没有定时/lazy 刷新 |
| 严重程度 | P1（产品语义违约：spec 承诺「时间使掌握度衰减」） |
| 已有测试 | mastery.test.ts 有 stale 用例（直接测 computeMastery 纯函数），无读路径闭环测试 |
| 修复设计 | **effective status on read**：`MasteryRepository.listAll/get` 输出前用注入时钟做 `stale` 判定（仅 mastered→familiar 单行 O(1) 状态修正，score 不变），不写库；写库仍发生在真实重算时。读侧修正与 `computeMastery` 共用同一 `staleAt` 常量与判定函数，保证确定性与可测试（时钟可注入）。不做全库重算 |
| 数据兼容风险 | 无（读时计算，不迁移数据） |

## P1-C：Backup O(N²) 聚合 + 主进程同步阻塞 + 非原子导出

| 项 | 内容 |
|---|---|
| 现象 | 1) `BackupRepository.readAll()` 有 5 处 `filter` inside `map`（stages/kps/cases/results/session items），10000 提交 × 50000 明细 ≈ 5×10⁸ 次比较；2) 导出/导入全链路 `readFileSync/JSON.parse/zod.parse/JSON.stringify/writeFileSync` 全部同步跑在 **Electron 主进程**——512MB 上限的 JSON.parse 峰值内存可达数 GB（V8 字符串 + 对象图），UI 冻结与 OOM 风险真实存在；3) 导出 `writeFileSync` 直写目标路径，进程中途被杀会留下**半文件**；4) confirmRestore 用 mtime 做 TOCTOU 防护（弱：同尺寸改写可保留 mtime） |
| 根因 | v1.2 备份为一次性全量 JSON 设计，未考虑规模化 |
| 严重程度 | P1（数据量大时可用性崩坏；正确性风险=半文件+OOM） |
| 已有测试 | backup.test.ts 功能正确性；perf-large-db.test.ts 不覆盖 backup 路径 |
| 修复设计 | v1.2.1 范围（保守、不改备份格式版本，保持 v1 导入导出兼容）：1) readAll 全部改 Map 分组索引 O(N)；2) 导出改「临时文件 + fsync + rename」原子落盘，失败不留半文件；3) confirmRestore 校验从 mtime 升级为 **SHA-256**（流式 hash，不整块读）；4) 新增 10000 提交 / 50000 明细性能测试（阈值门禁）；5) `BACKUP_IMPORT_MAX_BYTES` 从 512MB 重新评估并下调到与 schema 上限一致的防护值（保持 v1 格式兼容）。**Backup v2（worker_threads + streaming NDJSON + 进度回调）** 输出设计文档，列入 v1.3（本次不实装——重构信封格式会破坏 v1 兼容承诺，需要独立版本迁移期） |
| 数据兼容风险 | 无格式变化；导入 v1 备份完全兼容 |

## P1-D：E2E 进程生命周期（Windows 孤儿进程 + 吞掉清理失败）

| 项 | 内容 |
|---|---|
| 现象 | `cdp-harness.close()` = `client.close(); child.kill(); sleep(500)`。Windows Electron 有 browser/gpu/utility/renderer 多进程，`child.kill()` 只杀 electron.exe 主进程，**子进程树可能遗留**；`rmDirForce` 静默吞掉删除失败。仓库工作区现存 **50+ 个 `.e2e-data` 遗留目录**即为实证（目录被运行中进程锁定无法删除） |
| 根因 | 无 graceful quit（`app.quit()`）、无进程树终止（`taskkill /T`）、无退出确认、无遗留进程检查 |
| 严重程度 | P1（CI 环境腐烂：node_modules/临时目录删不掉、端口/文件句柄泄漏、测试互相干扰） |
| 已有测试 | 无 |
| 修复设计 | close() 改为：CDP `Browser.close()`（graceful）→ 等 exit（超时 5s）→ `taskkill /PID <pid> /T /F`（杀树兜底）→ 再等 exit → 断言无 `electron.exe` 遗留进程（按命令行过滤本项目路径）→ 删除数据目录，失败时输出 PID/路径/诊断而非静默。afterAll 增加「无本项目遗留 Electron 进程」全局断言 |
| 数据兼容风险 | 无 |

## P2：Windows Job Object 资源围栏（研究项）

| 项 | 内容 |
|---|---|
| 现状 | Runner 用 `taskkill /T /F` 杀树 + 超时。已知缺口：1) spawn 后到 Assign 之间的 race（子进程先 fork 孙进程逃逸）；2) 无内存/进程数上限（`内存爆炸` 用例靠 output/timeout 兜底，进程可在此期间分配大量内存）；3) 应用崩溃（非正常退出）时子进程可能遗留（kill-on-job-close 可解） |
| 决定 | 产出正式可行性研究与设计文档（Native Launcher Helper：CREATE_SUSPENDED → CreateJobObject → SetInformationJobObject(JOB_OBJECT_LIMIT_*) → Assign → Resume）；**不替换现有 Runner**（维护成本/打包链/签名要求超出 v1.2.1 范围，且现有 taskkill 方案在超时路径上工作正常）。README 继续明确 untrusted code unsafe |
| 位置 | `docs/V1_2_1_JOB_OBJECT_STUDY.md` |

---

## 次要发现（随修复顺带处理）

| # | 发现 | 位置 | 处理 |
|---|---|---|---|
| S1 | `getDashboardV2.todayReviews`、`getDashboard.todaySubmissions` 用 SQL `DATE('now')`（真实时钟），与注入 `now` 参数的口径不一致——测试无法控制「今天」 | stats-repository.ts:60-66,174-181 | 改为以注入 now 计算本地日边界（LocalCalendarDay），SQL 加 `created_at >= todayStart AND < nextDayStart` |
| S2 | `startSession` 里 `masteryScore` Map 声明即 `void`（死代码） | review-service.ts:122-125 | 删除 |
| S3 | `mapBuiltinProblems` 硬编码 `WHERE p.slug = 'c-basics'` | learning-repository.ts:124 | P1 重构顺带参数化 |
| S4 | `restore()` 的 `localMarkerKeys` 硬编码三键，新增 marker 易漏 | backup-service.ts:183 | 抽取共享常量并注释维护约定 |
| S5 | `loadLearningPathSeed` 文件缺失返回 null 无日志，静默 | learning-seed.ts:41 | 补 info 日志（P0-B 顺带） |
| S6 | `killAllActiveChildren` 在 `window-all-closed` 触发，但 `before-quit`/`will-quit` 未挂钩——`app.quit()` 由其它路径触发时可能漏杀 | index.ts:181 | 挂到 before-quit |
| S7 | `.e2e-data` 遗留目录应加入 .gitignore（工作区污染） | .gitignore | 加入 |

---

## 修复与验证计划（执行顺序）

1. `LocalCalendarDay` 工具 + P0-A/S1（含全套日历测试：今天/昨天/连续3天/断一天/跨月/跨年/闰年/DST）
2. P0-B seed marker（四情况 regression tests）
3. migration v3：`review_session_results` + P0-D 触发器/SET NULL 重建 + P1 内置 ID 迁移（**单事务**）+ 迁移测试
4. P0-C exactly-once（聚合规则 + 幂等 finish + 10 连 finish/同 KP 两题/并发 IPC/事务重试测试）
5. P1 seed v2 schema + upsert 内容更新 + 新旧 seed 兼容
6. P1-B mastery effective on read（injectable clock 测试）
7. P1-C backup O(N) + 原子导出 + SHA-256 + 性能门禁测试
8. P1-D E2E 生命周期改造 + 遗留进程断言
9. P2 Job Object 研究文档
10. 全量门禁：lint / typecheck / unit / migration / E2E / build；最终复审（Race/Double-Apply/Orphan/Time-Cache/O(N²)/Blocking/Process-Leak/Identity-Drift 全清单再扫一遍）

版本决定：v1.2.1（无公开 API/格式不兼容变化；migration v3 为新增式 + 数据无损重写，符合 patch 定位；Job Object 未实装，不构成 minor 的理由）。

---

## 附：Backup v2 设计（v1.3 deferred，本次仅记录设计）

v1.2.1 已落地：O(N) readAll、原子导出（temp + fsync + rename）、SHA-256 防调包、
性能门禁。仍未解决的根本问题：**JSON 全量 parse/stringify/zod 在主进程同步执行**——
512MB 上限时 V8 峰值内存可达数 GB、UI 冻结数秒。v2 目标与设计：

1. **格式**：`cuincodebench.backup` v2 = NDJSON 流（首行信封 meta，随后每行一条记录，
   按依赖序 problems → cases → submissions → ... ；SHA-256 逐块累计写入尾行 trailer）。
   导入端流式逐行 parse + 逐行 zod + 逐行插入（事务分批提交 + 计数校验），
   内存占用 O(batch)。v1 JSON 备份保持导入兼容（嗅探首字符 `{` vs `{`+换行流）。
2. **执行模型**：`worker_threads` 中跑读写与校验（主进程只做 dialog 与进度转发），
   `webContents.send('backup.progress', …)` 每千条推送；取消信号经 MessagePort。
3. **原子性**：导出临时文件 + fsync + rename（同 v1.2.1）；导入失败回滚（事务批次
   全部在一个大事务内，或 journal 按批次回放删除）。
4. **上限重估**：文本上限从 512MB 依据流式模型重评（预计 2GB，受磁盘而非内存约束）。
5. **迁移**：BACKUP_FORMAT_VERSION 1→2，导出默认 v2、导入支持 v1/v2，一个版本期后
   （v1.4）可停 v1 导出。
