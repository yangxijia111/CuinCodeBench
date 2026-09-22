# CHANGELOG.md

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格；版本号遵循语义化版本。

## [Unreleased] — v1.2.0 Learning Experience

进行中：v1.2 学习体验升级（设计文档见 docs/V1_2_*.md）。

### Added（开发中，随 Phase 提交推进）
- **P0 数据库 v2 migration**：新增学习路线（learning_paths/learning_stages/knowledge_points）、题目↔知识点多对多（problem_knowledge_points）、掌握度（mastery）、复习调度（review_items/review_history）、错题笔记（mistake_notes）、练习队列（practice_sessions/practice_session_items）共 10 张表；error_records 扩展学习错误分类列；孤儿数据兜底清理 SQL
- 内置「C 基础」学习路线种子（6 阶段 15 知识点，`seed-learning-path.json`），应用升级时幂等灌入并把内置旧题一次性映射到知识点（`learning_v2_mapped` 标记）
- 学习体验领域类型与常量（MasteryStatus/ReviewGrade/ErrorCategory 等，shared/types）

### Changed
- SQLite schema 版本 1 → 2（只增不删，v1.1 数据零改动；v1.1 代码可正常打开 v2 库）

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
- 新增 Dashboard 2.0 聚合测试（tests/dashboard-v2.test.ts，4 项：空库零值/趋势计数/复习与到期/错题计数）
- 新增错题复盘测试（tests/mistake-review.test.ts，7 项：自动分类规则/历史派生/首末代码/笔记/手动分类/auto 落库语义）
- 新增复习调度阶梯表对拍与 Review Session 集成测试（tests/review-scheduler.test.ts，11 项：全阶梯/again 重置/hard/60 天上限/组题优先级/完整会话流/历史追加）
- 新增掌握度 spec 对拍与集成测试（tests/mastery.test.ts，13 项：未做题/单题刷分封顶/weak 优先级/复习压制/45 天衰减/重算幂等/样本限量等）
- 新增学习路线进度聚合/绑定幂等/解绑回落测试（tests/learning-path.test.ts，6 项）
- 新增备份往返/损坏 JSON/版本错误/字段缺失/引用断裂/重复主键/事务中途失败注入/verify 失败注入/settings 特例测试（tests/backup.test.ts，13 项）
- 测试总数 137 → 198

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
