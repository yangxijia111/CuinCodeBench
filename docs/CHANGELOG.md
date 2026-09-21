# CHANGELOG.md

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格；版本号遵循语义化版本。

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
