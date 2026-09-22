# CHANGELOG.md

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格；版本号遵循语义化版本。

## [1.2.1] — 2026-09-22

深度正确性 / 架构 / 可靠性审计修复（完整报告见 V1_2_1_DEEP_AUDIT_REPORT.md，审计过程见 docs/V1_2_1_DEEP_AUDIT.md）。

### Fixed（P0）
- **连续学习天数恒为 1**：`computeStreak` 相邻日判断方向反了（DESC 序中 prev 恒新于 curr，`prev === prevDayNumber(curr)` 永假）——修正为日序号差判定；新增全套日历矩阵测试（今天/昨天/连续 3/7 天/断一天/跨月/跨年/闰年/DST 切换周）
- **趋势图 DST 漂移**：`buildTrend` 用 `now - n*86400000` 毫秒算术冒充本地日历日（DST 周会跳日/重复、`since` 截断最旧日头部）——新建统一 `LocalCalendarDay` 工具（src/shared），streak/trend/今日统计全部走本地日历算术；「今天」口径改为注入时钟（不再依赖 SQL `DATE('now')`）
- **学习路线 seed 失败后 marker 仍被标记**：`finally` 无条件 `markMarker` 使「下次启动重试」失效——重构为 `runLearningSeedStep`（成功才标记；文件缺失/损坏均真实重试），四种终态（seeded/missing/failed/marker 已存在）全覆盖测试
- **Review Session 双计（exactly-once）**：同一会话重复 finish / 自动收尾后 UI 再完成 / 同知识点两题，都会把 interval 连推两级——migration v3 新增 `review_session_results`（(session_id, review_item_id) 主键），评分推进与登记同事务 `INSERT OR IGNORE`，重复调用幂等；同 KP 多题按 **again > hard > good > easy** 聚合为单一等级（规则入档）；取消会话为终态不再评分；review 会话收尾权威唯一化（reportResult 不再对 review 自动置 finished）
- **复习项孤儿导致组题崩溃**：删除题目遗留多态引用的 review_items（无 FK 可用），`review.startSession` 会把已删题目塞进练习队列触发 FK 约束崩溃——DB 触发器（migration v3）+ 服务层清理双防线；`review_history.submission_id` / `practice_session_items.first_accepted_submission_id` 重建为 `ON DELETE SET NULL`；组题与今日概览过滤幽灵项

### Changed（P1）
- **内置内容稳定语义 ID**：stage/knowledgePoint 由位置型 id（`kp:c-basics:0:0`）迁移为语义 id（`kp:c-basics:io`）——seed v2（slug + seedVersion）；启动步骤单事务重写全部引用（mastery/review/mapping/practice_sessions）并带名称安全网（顺序错位即中止零副作用）；`ensureBuiltinPath` 改 upsert（改名/描述/tags/排序可迭代不破坏用户数据）；v1.2 备份导入后自动执行同一迁移
- **掌握度时间衰减闭环**：45 天 mastered→familiar 此前只在重算时发生（时间流逝不改变物化缓存）——读路径统一 effective on read（`mastery.list`/Dashboard/学习路线），规则单源（`effectiveMasteryStatus` 纯函数，时钟可注入），不写库、不全库重算
- **备份规模化**：readAll 五处 filter-inside-map 的 O(N²) 聚合全部改单次分组索引 O(N)（10000 提交/50000 明细全链路 < 2s，性能门禁入测）；导出改原子落盘（临时文件 + fsync + rename，失败/中途被杀不留半文件）；导入防调包校验由 mtime 升级为流式 SHA-256
- **E2E 进程生命周期**：harness close 改为 CDP `Browser.close`（优雅退出）→ 等待 exit → `taskkill /T /F` 杀树兜底 → 诊断；临时目录删除失败不再静默（输出 PID/路径/持锁进程）；新增全局「无遗留本项目 Electron 进程」断言

### Added
- migration v3（review_session_results + 引用完整性触发器/重建；不改 v1/v2）
- docs/V1_2_1_DEEP_AUDIT.md（逐项：现象/根因/复现/严重度/覆盖/修复设计/数据兼容）
- docs/V1_2_1_JOB_OBJECT_STUDY.md（Windows 资源围栏可行性研究：竞态分析、Native Launcher 设计、测试矩阵、v1.3 立项条件；本版不实装）
- 新增测试文件 6 个 / 用例 60+：日历工具与 streak 矩阵、seed marker 四态、review exactly-once（重复 finish×10/同 KP 两题/事务回滚重试/并发/取消终态/等级聚合）、引用完整性（触发器/SET NULL/孤儿过滤）、内置身份迁移（真实 v1.2 库全数据绑定断言/幂等/安全网/内容迭代）、mastery effective read、备份性能门禁与原子写/哈希

### Known Limitations
- 备份导入的 JSON.parse/Zod 校验仍在主进程同步执行（512MB 上限内可用，超大库的 UI 冻结风险记录在案；Backup v2 streaming 设计列入 v1.3）
- v1.2 时期因 seed 损坏被误标 marker 的库不会自动重试（修复文件后可恢复备份触发，或重置数据目录）
- Windows Runner 无内存/进程数上限（Job Object 见研究文档，v1.3 决策）

## [1.2.0] — 2026-09-22

进行中：v1.2 学习体验升级（设计文档见 docs/V1_2_*.md）。

### Added（开发中，随 Phase 提交推进）
- **P0 数据库 v2 migration**：新增学习路线（learning_paths/learning_stages/knowledge_points）、题目↔知识点多对多（problem_knowledge_points）、掌握度（mastery）、复习调度（review_items/review_history）、错题笔记（mistake_notes）、练习队列（practice_sessions/practice_session_items）共 10 张表；error_records 扩展学习错误分类列；孤儿数据兜底清理 SQL
- 内置「C 基础」学习路线种子（6 阶段 15 知识点，`seed-learning-path.json`），应用升级时幂等灌入并把内置旧题一次性映射到知识点（`learning_v2_mapped` 标记）
- 学习体验领域类型与常量（MasteryStatus/ReviewGrade/ErrorCategory 等，shared/types）

### Changed
- SQLite schema 版本 1 → 2（只增不删，v1.1 数据零改动；v1.1 代码可正常打开 v2 库）

- **P9 全流程 E2E**：自制 CDP 驱动 harness（Node 22 内置 WebSocket，零新依赖）驱动真实 Electron 产物；8 个用例覆盖 启动→题库→学习路线→Dashboard→复习页→设置数据管理、判题闭环（真实 python 判题→错题→笔记→复习会话→调度推进）、备份导出→导入恢复全量替换、v1.1 库自动升级迁移；E2E 专用 workflow（windows-latest）
  - 选型记录：Playwright `_electron.launch`（1.49/1.63 实测）的 loader 劫持 whenReady 后其 CDP 连接与 Electron 44 断开（code=1006）导致挂起；原生 DevTools 端点正常，故采用自制 CDP 驱动
  - 测试钩子：仅 `CCB_E2E=1` 时替换文件对话框为受控桩并关闭 sandbox（生产不受影响）
- **P9 种子题库扩充与验证**：题库 10 → **45 道**（新增 35 道高质量 C 基础题，覆盖输入输出/变量/运算符/if/switch/循环/数组/字符串/函数/递归/指针/struct 全知识点）；每题三语言参考解；新增 referenceSolution 机制（v1.1 骨架题与学生初始代码分离）；`seed-verify` 集成测试在真实 gcc/python 上对全部 45 题逐用例验证（92 项，无工具链环境自动跳过）；内置路线知识点映射覆盖全部题目
- **性能门禁**：tests/perf-large-db.test.ts——100 题/10000 提交/大量错误与复习数据下 Dashboard、错题列表、复习队列、学习路线聚合、关键词搜索均 < 2s
- **P7 练习体验增强**：练习页上一题/下一题（题库顺序导航 + 位置指示）与知识点徽章（点击进入学习路线）；随机练习（难度/语言初始代码/知识点过滤 + 未做题/错题/低掌握度范围，随机组题 5/10/20）；专项训练（学习路线知识点一键组题）；练习会话页（进度 x/y、判题自动回报、完成总结：正确率与首次 AC 数）
- **P8 搜索增强**：关键词覆盖标题/描述/标签/知识点名称；新增知识点筛选下拉，支持「知识点 + 难度」组合筛选
- **P6 Dashboard 2.0**：新增今日复习/错题待复习/知识点掌握度列表；7 天与 30 天趋势（每日提交/AC/复习，SQL 聚合 + 本地日历日连续序列）；自研轻量 SVG 趋势图（无新依赖）；Knowledge Heatmap（颜色进度条 + 点击进入学习路线）；stats.dashboardV2 IPC
- **P5 错题复盘增强**：错误历史（时间线 + 错误信息 + 错误代码，从提交记录派生）；首次/最近错误代码对比；错因笔记（本地 mistake_notes）；学习错误分类（编译→语法、超时→算法效率 自动规则，其余手动归类 unknown 不伪装判断）；错题本「错误复盘」展开 UI
- **P4 间隔复习系统**：确定性阶梯调度算法（good [1,3,7,14,30,60] / easy [2,5,10,21,45,60] / hard ×1.2 / again 当日 10 分钟重现，60 天封顶，纯函数可对拍）；复习项自动生命周期（错题入选即到期、知识点首次学习次日进入循环、标记掌握删除、再次失败重建）；Review Session（错题优先组题、知识点展开、会话去重、判题自动回报、完成页四档记忆等级确认与下次复习时间）；复习页（今日待复习计数 + 按知识点聚合）
- **P3 Knowledge Mastery 掌握度**：可解释规则模型（表现 45% + 覆盖 30% + 复习 15% + 连击 10%，指数衰减 0.85）；防刷分（每题样本上限 2 次 + <3 题信心折扣）；五态状态机（not_started/learning/weak/familiar/mastered，含 45 天惰性衰减）；判题落库后自动重算 hook（失败不阻断判题）；mastery.list/recalc IPC
- **P2 学习路线 Learning Path**：learning-service（路线/阶段/知识点进度聚合，单查询无 N+1）；学习路线页面（侧边栏「学习」入口：路线总览进度条、阶段卡片、知识点完成度 x/y 与掌握状态、点击展开题目开始练习）；题目编辑页知识点多选绑定（保存时 diff 同步）；掌握度仓储骨架
- IPC：learning.paths / learning.pathDetail / learning.allKps / learning.kpProblems / learning.problemKps / learning.bindProblem / learning.unbindProblem
- **P1 完整备份与恢复**：`cuincodebench.backup` versioned 格式（信封 + 全量数据载荷，zod 全字段校验 + 交叉引用校验）；单一事务恢复（依赖序清空 → 写回 → 逐表计数 verify，任一失败整体回滚）；settings 标记键防种子误重灌；设置页「数据管理」导出/导入（主进程 dialog + 确认对话框 + mtime 防调包）；备份隐私提示
- IPC：backup.export / backup.importPreview / backup.confirmRestore / backup.cancelImport（路径仅存在于主进程，renderer 不传路径）

### Testing
- 新增 migration v2 / 内置路线灌入 / 旧题映射 / 绑定幂等测试（tests/migrations.test.ts，7 项）；既有 migration 断言随版本号更新
- 新增种子验证测试（tests/seed-verify.integration.test.ts，92 项：45 题 × C/Python 真实编译运行比对 + 结构检查）与性能测试（tests/perf-large-db.test.ts，5 项）
- 新增随机练习/专项训练/范围过滤/会话总结测试（tests/practice-session.test.ts，6 项）；搜索增强用例并入 tests/learning-path.test.ts
- 新增 Dashboard 2.0 聚合测试（tests/dashboard-v2.test.ts，4 项：空库零值/趋势计数/复习与到期/错题计数）
- 新增错题复盘测试（tests/mistake-review.test.ts，7 项：自动分类规则/历史派生/首末代码/笔记/手动分类/auto 落库语义）
- 新增复习调度阶梯表对拍与 Review Session 集成测试（tests/review-scheduler.test.ts，11 项：全阶梯/again 重置/hard/60 天上限/组题优先级/完整会话流/历史追加）
- 新增掌握度 spec 对拍与集成测试（tests/mastery.test.ts，13 项：未做题/单题刷分封顶/weak 优先级/复习压制/45 天衰减/重算幂等/样本限量等）
- 新增学习路线进度聚合/绑定幂等/解绑回落测试（tests/learning-path.test.ts，6 项）
- 新增备份往返/损坏 JSON/版本错误/字段缺失/引用断裂/重复主键/事务中途失败注入/verify 失败注入/settings 特例测试（tests/backup.test.ts，13 项）
- 测试总数 137 → 205

## [1.1.0] — 2026-09-21

v1.1.0 Production Hardening：安全加固、CI 建设、测试补强与发布工程化。现有 v1.0 功能无回归。详见 V1_1_HARDENING_PLAN.md 与 V1_1_FINAL_REPORT.md。

### Security
- **外部链接协议白名单**：`shell.openExternal` 与窗口导航统一经 `isAllowedExternalUrl` 校验，仅允许 http/https；拒绝 file:/javascript:/data:/vbscript:/shell:/ms-settings: 及一切未知协议（含测试）
- **IPC sender 校验**：新增 `validateIpcSender`——可信 WebContents 注册表 + frame URL 协议校验（生产 file: / 开发 dev server origin），所有 handler 统一接入，非法请求拒绝并记录安全日志（含测试）
- **Markdown/XSS 加固**：净化逻辑独立为 `sanitize-markdown`，DOMPurify 显式配置（禁 script/style/iframe/form/object/embed/svg/math，SANITIZE_DOM，禁未知协议）；补 XSS 回归测试（script/img onerror/iframe/form/javascript: 链接/data: URL/内联事件）
- **编译输出上限**：编译阶段同样受 `COMPILE_OUTPUT_LIMIT_BYTES` 约束，失控编译器被截断终止并判编译失败；执行器支持可配置输出上限（含测试）

### CI
- 新增 GitHub Actions 质量门禁（`ci.yml`）：ubuntu（快速门禁）+ windows（真实验证 MSVC/Python 工具链探测与端到端判题）双平台；npm ci → lint → typecheck → test → build；无编译器环境的工具链用例按设计条件跳过，不降低测试标准
- 新增 Release 工作流（`release.yml`）：push `v*` tag 自动在 windows-latest 构建并通过质量门禁，产出规范命名的 NSIS 安装器与便携 zip 并发布 GitHub Release

### Fixed
- 应用退出时显式关闭 SQLite（WAL 检查点落地，closeServices 幂等）
- 题库导入事务回滚回归测试（中途失败不留半份数据）

### Testing
- 测试从 109 项增至 137 项（13 个文件）：安全回归（URL 白名单/IPC frame 校验/XSS）、DB 回滚、可配置输出上限等恶意与异常输入覆盖

### Build / Performance
- renderer 按路由懒加载分割：主 bundle 1.97MB → 737KB（CodeMirror 仅随练习页加载）
- 基础可访问性：搜索框/筛选器/用例编辑器等控件补充 aria 标签

### Project
- Issue 模板（bug/feature）、PR 模板、CONTRIBUTING.md
- 依赖安全基线：npm audit 0 漏洞

## [1.0.0] — 2026-09-21

v1.0.0 正式发布：完整功能见 FINAL_REPORT.md 与 ROADMAP 执行记录。

### Fixed（发布前审计修复）
- Runner 异步 spawn 失败（ENOENT/杀软 EPERM）时错误信息丢失，导致 UI 空报错与 EPERM 退避重试死逻辑
- 种子题库文件损坏会导致应用启动白屏 → 降级为空题库继续启动
- 渲染异常无兜底 → 新增顶层 ErrorBoundary
- Markdown 内链接会导航走整个应用且无法恢复 → will-navigate 一律阻止
- JSON 导入非原子（部分失败部分落库）→ 单事务批量创建
- 提交历史详情加载失败无反馈 → 补充错误展示
- 清理死代码/死常量、合并重复 spawn 逻辑、设置页脏检查、移除未使用依赖
- 文档与实现漂移订正（版本号、cmd 参数、种子策略、Markdown 渲染方式等 10 处）

### Added（1.0 功能里程碑）
- **P0**：Electron + React + TypeScript strict 脚手架，lint/typecheck/test/build 四门禁
- **P1**：SQLite（better-sqlite3 WAL）+ 版本化迁移 + 仓储层（题目聚合/历史/错题/设置/统计）
- **P2**：题库服务（CRUD/搜索/筛选/JSON 导入导出）+ 内置种子题库 10 题 + 题库 UI
- **P3**：本地 Runner（工具链探测 MSVC/gcc/clang/python、进程树强杀、输出限制、临时目录隔离）+ 判题核心 + 真实工具链端到端测试
- **P4**：练习页（CodeMirror 编辑器、自定义运行、判题结果面板）
- **P5**：错题本、Dashboard 统计、提交历史面板
- **P6**：设置页、electron-builder 打包、README 与打包产物全链路判题验证
- **P7**：全项目审计与修复（spawn 错误信息/ErrorBoundary/will-navigate 等）
