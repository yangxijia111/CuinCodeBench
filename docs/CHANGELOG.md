# CHANGELOG.md

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格；版本号遵循语义化版本。

## [Unreleased]

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
