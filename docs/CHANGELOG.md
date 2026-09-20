# CHANGELOG.md

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格；版本号遵循语义化版本。

## [Unreleased]

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
