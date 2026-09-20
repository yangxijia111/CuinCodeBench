# ROADMAP.md — 开发路线图

执行规则：严格按 Phase 顺序推进；每个 Phase 结束必须通过门禁 `lint → typecheck → test → build`，更新本文件（勾选）与 CHANGELOG.md，然后 git commit（禁止 force push）。Phase 编号 P0–P7；FR/NFR 编号见 REQUIREMENTS.md。

---

## P0 项目脚手架 ✅（完成于 2026-09-20）

**实现内容**
- [x] electron-vite + React 19 + TS strict 三端骨架；空窗口加载 renderer
- [x] eslint(flat) + typescript-eslint strict 规则；`npm run lint`
- [x] `npm run typecheck`（三 tsconfig）
- [x] vitest 接入 + 首个冒烟测试；`npm run test`
- [x] `npm run build`（三端构建通过）
- [x] 目录分层落位（src/main、src/preload、src/renderer、src/shared）
- [x] GitHub 仓库创建并推送 main

**验收**：`npm run dev` 打开空窗口无报错；四条门禁命令全绿；首次 commit 推送成功。✅
补充验证：better-sqlite3 在 Electron ABI 下可用（prebuild 命中）；Electron 二进制经 npmmirror 镜像下载（.npmrc 固化）。
**覆盖需求**：NFR-1/3/5

## P1 数据层 ✅（完成于 2026-09-20）

**实现内容**
- [x] better-sqlite3 接入 + 连接管理（WAL、外键、CCB_DATA_DIR）
- [x] migration 机制 + v1 全部表
- [x] repositories：problem/test-case/history/mistake/settings
- [x] shared 类型与 zod schema
- [x] DB 单元测试（内存库）

**验收**：migration 幂等；repo CRUD/级联/统计口径测试全绿。✅（22 项数据层测试）
修复记录：多标签 JSON LIKE 筛选模式 bug；错误类型计数增加确定性次级排序。
**覆盖需求**：NFR-2/3、FR-H3（存储口径）、DATA_SPEC §2

## P2 题库服务与 UI ✅（完成于 2026-09-20）

**实现内容**
- [x] problem-service（CRUD/搜索/筛选/导入导出/zod 校验）
- [x] 种子题库 JSON + 首启灌入（10 题，期望输出经参考解程序验证）
- [x] IPC：problems.* 与 app.*；preload API（zod 校验 + 统一错误信封）
- [x] UI：题库列表（搜索/标签/难度筛选）、题目编辑器（含用例编辑）、删除确认、导入导出
- [x] 服务层与 UI 流程测试

**验收**：能新建/编辑/删除/筛选题目；导入导出往返一致；种子题首启出现。✅（37 项测试；dev 启动日志确认灌入）
修复记录：种子文件用内部格式校验（与导出信封区分）；ProblemDetail 上移 shared 供三端共用；IPC handle 泛型重构为 schema 驱动推断。
**覆盖需求**：FR-P1–P6

## P3 本地 Runner ✅（完成于 2026-09-21）

**实现内容**
- [x] languages 配置与命令构造（纯函数）
- [x] temp-dir（隔离/清理/启动清扫）
- [x] execute（stdin/超时/输出限制/杀树/EPERM 退避重试）
- [x] compile（gcc/clang/MSVC）
- [x] toolchain 探测（where/--version/vswhere/vcvars 解析）
- [x] Runner 集成测试（python 真实 + node 桩 + 真实 gcc（便携 w64devkit 16.2）+ 真实 MSVC）
- [x] JudgeService 端到端（AC/WA/RE/TLE/CE + 落库 + 错题聚合 + 串行队列）

**验收**：本机 MSVC 与 Python 真实跑通 hello/stdin/RE/TLE/OLE/Unicode/清理；无工具链时返回友好错误；杀树无残留进程。✅（96 项测试，含真实三工具链端到端判题）
关键修复与发现：
- Node 20.12+ 对 cmd.exe 参数自动转义引号，vcvars 解析需 `/d /c` + windowsVerbatimArguments（含空格路径的两引号保留规则）
- Python `-I` 隔离模式忽略全部 PYTHON* 环境变量 → UTF-8 必须用 `-X utf8` 命令行选项
- Windows 管道为文本模式（\n→\r\n），判题归一化（FR-J4）为必需而非可选
- 杀软（Defender）可能持续拦截新编译的无签名 exe（spawn EPERM）→ execute 退避重试 + 持续拦截时错误可见（WIN-7）
**覆盖需求**：FR-R1–R10、WIN-1–7、SECURITY §3

## P4 自动判题与练习页 ✅（完成于 2026-09-21）

**实现内容**
- [x] normalize/verdict 纯函数 + 全量单测
- [x] judge-service（串行队列、编排、落库挂钩）
- [x] IPC：judge.submit / run.once
- [x] UI 练习页：CodeMirror 编辑器（行号/高亮/缩进/字号/重置/草稿）、运行面板（自定义输入）、判题结果面板（逐用例期望/实际/状态/耗时）
- [x] 判题策略测试（CRLF/尾空白/尾换行/多行/AC/WA）
- [x] UI 组件测试（jsdom）：判题/运行结果面板全状态分支

**验收**：本机用 Python 与 C 对种子题判题，五种状态真实复现；结果面板信息完整。✅（103 项测试；CDP 验证渲染进程真实加载路由）
**覆盖需求**：FR-J1–J6、FR-C1、FR-E1–E5（部分）

## P5 记录、错题与 Dashboard

**实现内容**
- [ ] history-service + IPC（列表/详情分页）
- [ ] mistake-service（聚合/重算/mastered）+ 错题页 UI
- [ ] stats-service（Dashboard 全指标）+ Dashboard UI
- [ ] 提交历史 UI（题目维度）
- [ ] 对应测试

**验收**：判题后历史/错题/统计即时正确；连续天数与正确率口径与文档一致。
**覆盖需求**：FR-H1–H4、FR-M1–M4、FR-D1–D3

## P6 设置、打磨与打包

**实现内容**
- [ ] 设置页（字号/缩进/换行/判题默认超时/工具链手工指定/重新检测）
- [ ] 编辑器字号联动；语言切换与草稿恢复完善（FR-E6）
- [ ] 空状态/错误提示打磨（无工具链提示等 FR-R9）
- [ ] electron-builder 打包（win-unpacked + NSIS）验证启动
- [ ] README 完整（安装/开发/打包/安全声明）

**验收**：打包产物可启动并完成一次真实判题；README 可照做安装运行。
**覆盖需求**：FR-E4/E6、FR-R10、NFR-6、WIN-7

## P7 审计与发布

**实现内容**
- [ ] 全项目审计：架构/安全/异常处理/UX/重复代码/死代码/TODO/测试缺口
- [ ] 修复审计发现 → 回归全部门禁 + 完整手工验收清单
- [ ] docs 校对与实现一致性修正
- [ ] FINAL_REPORT.md
- [ ] GitHub 推送 + tag v1.0.0

**验收**：PRODUCT.md §5 全部条目满足；FINAL_REPORT.md 完整。
**覆盖需求**：全部

---

## 执行日志（每 Phase 完成后追加）

- （待填）
