# CuinCodeBench

**面向编程学习者的本地代码练习、运行、自动判题与错题分析工具。** 单机版轻量 OJ + 错题本 + 练习统计，全部数据保存在本机。

![CI](https://github.com/yangxijia111/CuinCodeBench/actions/workflows/ci.yml/badge.svg)
![Version](https://img.shields.io/badge/version-1.1.0-2f81f7)
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
- **错题本**：失败 ≥ 2 次自动收录，错误类型分布、重新练习、标记已掌握
- **统计面板**：正确率、连续练习天数、语言分布、常见错误类型、最近练习

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
- 完整数据备份/恢复、Windows Job Object 资源限制规划于 v1.2（见 V1_1_HARDENING_PLAN.md「明确推迟」）

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
| [CHANGELOG.md](docs/CHANGELOG.md) | 变更日志 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 贡献指南 |

## License

[MIT](LICENSE)
