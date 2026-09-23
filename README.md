# CuinCodeBench

**面向编程学习者的本地代码练习、自动判题与个人编程学习系统。** 单机版轻量 OJ + 学习路线 + 知识点掌握度 + 间隔复习 + 错题复盘 + 完整备份，全部数据保存在本机。

![CI](https://github.com/yangxijia111/CuinCodeBench/actions/workflows/ci.yml/badge.svg)
![Version](https://img.shields.io/badge/version-1.2.0-2f81f7)
![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-blue)
![Tech](https://img.shields.io/badge/Electron%20%2B%20React%20%2B%20TypeScript-strict-3fb950)
![License](https://img.shields.io/badge/license-MIT-green)

## 下载

前往 [Releases](https://github.com/yangxijia111/CuinCodeBench/releases) 获取：

- `CuinCodeBench-Setup-x.y.z.exe` — Windows 安装器（NSIS）
- `CuinCodeBench-x.y.z-win-x64.zip` — 免安装便携版

> ⚠️ 当前构建未做代码签名，Windows SmartScreen 可能出现"未知发布者"提示——选择"更多信息 → 仍要运行"即可，或自行从源码构建。

## 主要功能

- **代码编辑**：C / C++ / Python，行号 + 语法高亮（CodeMirror 6）、Tab 缩进、字号调整、草稿自动保存、一键重置
- **本地运行**：自动探测本机 gcc / g++ / clang / clang++ / MSVC cl.exe / python / py；编译错误、运行错误、超时、输出超限都有明确展示
- **自动判题**：逐用例对比 stdin → stdout，状态含 通过 / 答案错误 / 编译错误 / 运行时错误 / 超出时限 / 输出超限；输出归一化（CRLF、行尾空白、末尾换行）
- **题库管理**：内置 10 道种子题目；新建 / 编辑 / 删除 / 搜索 / 标签与难度筛选 / JSON 导入导出（事务原子导入）
- **学习记录**：完整提交历史（代码、语言、逐用例明细）、尝试次数、首次通过时间
- **学习路线**：内置「C 基础」路线（6 阶段 15 知识点），题目与知识点多对多关联，阶段进度条与完成度一览
- **知识点掌握度**：可解释规则模型（表现/覆盖/复习/连击四因子），五态状态，防刷分设计，不用 AI
- **间隔复习**：错题与知识点自动进入复习循环，确定性阶梯调度（1→3→7→14→30→60 天），复习会话一键组题
- **错题复盘**：错误历史时间线、首次/最近错误代码对比、错因笔记、学习错误分类（自动规则 + 手动归类）
- **练习队列**：随机练习（难度/知识点/未做/错题/低掌握过滤）与专项训练（知识点一键组题），完成统计
- **Dashboard 2.0**：今日练习/今日复习/连续天数、7 与 30 天趋势图（自研 SVG）、知识点掌握热力图
- **完整备份 v2**：一键导出/导入全部数据（题库、提交、错题、笔记、学习记录、设置），NDJSON 流式格式（后台线程执行，超大库不冻结界面），恢复走临时库校验 + 原子切换，任意失败/崩溃不破坏现有数据；兼容导入 v1 JSON 备份
- **题库管理**：内置 45 道种子题目（参考解经真实工具链验证）；新建/编辑/删除/搜索/标签与知识点筛选/JSON 导入导出（事务原子导入）

## 支持语言与工具链

| 语言 | 支持的编译器/解释器 | 说明 |
|---|---|---|
| C | gcc / clang / MSVC cl.exe | 自动探测，也可在设置中手工指定 |
| C++ | g++ / clang++ / MSVC cl.exe | C++17 |
| Python | python / py | 以隔离模式运行（-I -X utf8） |

应用**不附带**任何编译器：想练习哪种语言就安装对应工具链。未安装时应用正常启动，运行/判题会给出友好提示。

## 安装与运行

从 Release 下载安装，或自行构建：

```bash
npm install        # 安装依赖（Electron 二进制走 npmmirror 镜像，见 .npmrc）
npm run dev        # 开发模式（HMR）
```

## 构建与测试

```bash
npm run lint       # eslint（typed-lint，禁止 any / 悬浮 Promise）
npm run typecheck  # tsc --noEmit（main + web 两套 tsconfig，strict）
npm run test       # vitest 全量测试（单元 + 集成 + UI 组件）
npm run build      # 三端产物构建
npm run dist:dir   # 打包 win-unpacked（免安装目录）
npm run dist       # 打包 NSIS 安装器 + zip
```

**测试说明**：Runner 相关真实工具链测试使用条件执行（`describe.skipIf`）——机器上没有对应编译器/解释器时自动跳过（不计为失败），node 桩用例在任何机器上验证执行器管线；Windows CI 上会真实验证 MSVC 与 Python 路径。最终测试结果形如 `X passed / 0 failed`，被跳过的用例数因机器环境而异。

**CI**：每次 push / PR 自动执行四门禁（ubuntu + windows 双平台，见 `.github/workflows/ci.yml`）；push `v*` tag 自动构建并发布 Release（`release.yml`）。

## 项目结构

```
src/
├── main/      # Electron 主进程：IPC（sender 校验 + zod）→ services → repositories(SQLite)
│   └── runner/    # 独立执行模块：探测 / 编译 / 运行 / 杀进程树 / 临时目录（无 DB 依赖）
├── preload/   # contextBridge 白名单 API（contextIsolation + sandbox）
├── renderer/  # React + CodeMirror：题库 / 练习 / 错题本 / 统计 / 设置（按路由懒加载）
└── shared/    # 三端共用类型、zod schema、常量
tests/         # 单元 / 集成 / 端到端 / UI 组件测试
scripts/       # UI 冒烟与打包产物端到端判题脚本
docs/          # 开发文档（产品/需求/架构/数据/安全/测试/路线图）
```

## 安全说明（重要）

**本工具不是安全沙箱。** 代码以当前用户完整权限在本机运行，与直接在 IDE 里运行代码的风险级别相同——**不要用它运行不可信、未知或恶意的代码**。超时强杀、输出限制、临时目录隔离、IPC sender 校验等机制的目标是**防失控与保稳定**，不要将它们等同于完整的 Sandbox 隔离。完整威胁模型见 [docs/SECURITY.md](docs/SECURITY.md)。

## 数据与隐私

所有数据（题库、提交历史、错题本、统计）保存在本机 `%APPDATA%/CuinCodeBench/`，删除该目录即完全重置；应用不上传任何数据。开发/调试可用环境变量 `CCB_DATA_DIR` 覆盖数据目录（可选，非必需配置，无需任何 API Key 或账号）。

## 已知限制

- 判题串行执行，无内存/CPU 限制，不支持 Special Judge 与文件 IO 型题目
- 杀毒软件（如 Defender）可能拦截新编译的无签名 exe：应用会退避重试并给出明确报错，但无法绕过本机安全策略
- 仅在 Windows 10/11 上开发与验证；其它平台未测试、不承诺
- 构建未做代码签名（Release 说明中亦有声明）
- 判题为串行队列；Windows 上经 Job Object 提供内存（512MB）/进程数（32）上限与整树清理，但**这是资源围栏不是沙箱**（无 CPU 限频、无文件系统/网络隔离）
- 备份文件包含全部代码与学习记录，请妥善保管，勿上传网络

## 文档

| 文档 | 内容 |
|---|---|
| [PRODUCT.md](docs/PRODUCT.md) | 项目目标、用户场景、完成标准 |
| [REQUIREMENTS.md](docs/REQUIREMENTS.md) | 功能/非功能需求（FR/NFR 编号追溯） |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | 技术选型、模块分层、判题策略、ADR |
| [DATA_SPEC.md](docs/DATA_SPEC.md) | 领域模型、SQLite schema、导入导出格式 |
| [SECURITY.md](docs/SECURITY.md) | 威胁模型、信任边界、安全设计 |
| [TEST_PLAN.md](docs/TEST_PLAN.md) | 测试分层与覆盖要求 |
| [ROADMAP.md](docs/ROADMAP.md) | P0–P7 阶段执行记录 |
| [V1_1_HARDENING_PLAN.md](docs/V1_1_HARDENING_PLAN.md) | v1.1 加固计划与推迟项 |
| [V1_2_PRODUCT.md](docs/V1_2_PRODUCT.md) | v1.2 产品定义与成功标准 |
| [V1_2_LEARNING_MODEL.md](docs/V1_2_LEARNING_MODEL.md) | 学习体验领域模型与数据库设计 |
| [V1_2_MASTERY_SPEC.md](docs/V1_2_MASTERY_SPEC.md) | 知识点掌握度规范（可解释规则） |
| [V1_2_REVIEW_SPEC.md](docs/V1_2_REVIEW_SPEC.md) | 间隔复习调度算法规范 |
| [V1_2_BACKUP_SPEC.md](docs/V1_2_BACKUP_SPEC.md) | 完整备份与恢复规范（v1 格式兼容导入） |
| [V1_3_ARCHITECTURE.md](docs/V1_3_ARCHITECTURE.md) | v1.3 总体架构（Native Launcher / Backup v2 / 时钟回拨） |
| [V1_3_JOB_OBJECT_DESIGN.md](docs/V1_3_JOB_OBJECT_DESIGN.md) | ccb-launcher 设计（帧协议/资源围栏/生命周期） |
| [V1_3_BACKUP_V2_SPEC.md](docs/V1_3_BACKUP_V2_SPEC.md) | Backup v2 规格（流式 NDJSON/原子恢复/journal 自愈） |
| [V1_3_CLOCK_ROLLBACK_SPEC.md](docs/V1_3_CLOCK_ROLLBACK_SPEC.md) | 时钟回拨语义 |
| [V1_2_E2E_PLAN.md](docs/V1_2_E2E_PLAN.md) | 端到端测试方案 |
| [V1_2_ROADMAP.md](docs/V1_2_ROADMAP.md) | v1.2 阶段执行记录 |
| [CHANGELOG.md](docs/CHANGELOG.md) | 变更日志 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 贡献指南 |

## License

[MIT](LICENSE)
