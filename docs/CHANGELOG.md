# CHANGELOG.md

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格；版本号遵循语义化版本。

## [1.0.0] — 2026-09-21

v1.0.0 正式发布：完整功能见 FINAL_REPORT.md 与上方各 Phase 记录。

### Fixed（P7 审计修复）
- Runner 异步 spawn 失败（ENOENT/杀软 EPERM）时错误信息丢失，导致 UI 空报错与 EPERM 退避重试死逻辑
- 种子题库文件损坏会导致应用启动白屏 → 降级为空题库继续启动
- 渲染异常无兜底 → 新增顶层 ErrorBoundary
- Markdown 内链接会导航走整个应用且无法恢复 → will-navigate 一律阻止并转交系统浏览器
- JSON 导入非原子（部分失败部分落库）→ 单事务批量创建
- 提交历史详情加载失败无反馈 → 补充错误展示
- 清理死代码/死常量、合并重复 spawn 逻辑、设置页脏检查、移除未使用依赖
- 文档与实现漂移订正（版本号、cmd 参数、种子策略、Markdown 渲染方式等 10 处）
- 补充测试：seed 不复活、工具链手工合并、展示截断（累计 108 项）

## [Unreleased]

### Added（P6 设置与打包）
- 设置页：字号/缩进/换行/判题默认超时；工具链手工指定与重新检测；数据目录展示
- electron-builder 打包（win-unpacked + NSIS 配置），extraResources 携带种子题库
- 端到端验证脚本（打包产物全链路判题：renderer → IPC → MSVC/Python → SQLite）
- README 完整（安装/开发/打包/安全声明）

### Fixed
- 多参数 IPC 通道（judge.submit / problems.update / mistakes.setMastered）schema 校验失败：handle 现支持单参数与 tuple 双约定

### Added（P5 记录/错题/统计）
- 错题本页：失败次数、最近错误类型、错误分布、重新练习、标记已掌握/恢复
- Dashboard：已练题目/通过数/正确率/今日提交/连续天数卡片，语言占比条形图，常见错误 Top 5，最近练习列表
- 练习页「提交历史」标签：分页列表 + 单次提交代码与逐用例明细回看
- UI 冒烟脚本（CDP 驱动真实 Electron 窗口验证路由渲染）

### Added（P4 练习页）
- 练习页 UI：左题面（Markdown 净化渲染 + 示例）/ 右 CodeMirror 编辑器 + 结果区
- CodeMirror 6：行号、C/C++/Python 语法高亮、Tab 缩进、字号/换行主题注入
- 草稿自动保存（按题目+语言，localStorage），重置为初始代码（需确认）
- 自定义运行面板（stdin 编辑、stdout/stderr/退出码/耗时）
- 判题结果面板：总体状态 + 逐用例折叠详情（输入/期望/实际/stderr/退出码十六进制/耗时）
- UI 组件测试（jsdom + testing-library）

### Added（P3 本地 Runner）
- 工具链自动探测：PATH（where + --version 校验）与 MSVC（vswhere + vcvars64 环境解析），手工指定路径覆盖
- 执行器：stdin 写入、stdout/stderr 捕获（1MB 上限）、超时进程树强杀（taskkill /T /F）、EPERM 退避重试
- 编译器支持：gcc/clang（C11/C++17）与 MSVC（/std:c11、/std:c++17 /EHsc），Python（-I -X utf8）
- 临时目录隔离：每任务独立随机目录、退出清理（Windows 锁重试）、启动清扫遗留
- 判题核心纯函数：输出归一化（CRLF/行尾空白/末尾空行）与用例状态判定
- JudgeService：串行队列、判题编排、提交/明细/错误记录落库、错题聚合
- 集成测试：node 桩全管线 + 真实 Python/gcc/MSVC 端到端判题（AC/WA/RE/TLE/CE）

### Added（P2 题库）
- 题库服务：CRUD、关键词/难度/标签组合筛选、JSON 导入导出（信封格式 + zod 校验）
- 内置种子题库 10 题（覆盖三难度、三语言初始代码、48 个用例，期望值经参考解验证）
- IPC 层：zod 校验 + 统一 `{ok, data|code, message}` 错误信封；preload 白名单 API
- UI：HashRouter 应用壳（侧栏导航）、题库列表页（搜索/筛选/删除/导入导出）、题目编辑页（示例/初始代码/用例编辑器）

### Added（P1 数据层）
- SQLite（better-sqlite3，WAL）+ 版本化迁移机制
- 仓储层：题目聚合 / 提交历史 / 错题本 / 设置 / 统计聚合

### Added（P0 脚手架）
- electron-vite + React 19 + TypeScript strict 三端骨架
- eslint（typed-lint）/ typecheck / vitest / build 四条质量门禁
- 开发文档全套：PRODUCT / REQUIREMENTS / ARCHITECTURE / DATA_SPEC / SECURITY / TEST_PLAN / ROADMAP / CHANGELOG
