# CuinCodeBench

**面向编程学习者的本地代码练习、运行、自动判题与错题分析工具。** 单机版轻量 OJ + 错题本 + 练习统计，全部数据保存在本机。

![平台](https://img.shields.io/badge/platform-Windows%2010%2F11-blue) ![技术栈](https://img.shields.io/badge/Electron%20%2B%20React%20%2B%20TypeScript-strict-3fb950) ![测试](https://img.shields.io/badge/tests-vitest-8b949e)

## 功能

- **代码编辑**：C / C++ / Python，行号 + 语法高亮（CodeMirror 6）、Tab 缩进、字号调整、草稿自动保存、一键重置
- **本地运行**：自动探测本机 gcc / g++ / clang / clang++ / MSVC cl.exe / python / py；编译错误、运行错误、超时、输出超限都有明确展示
- **自动判题**：逐用例对比 stdin → stdout，状态含 通过 / 答案错误 / 编译错误 / 运行时错误 / 超出时限 / 输出超限；输出归一化（CRLF、行尾空白、末尾换行）
- **题库管理**：内置 10 道种子题目；新建 / 编辑 / 删除 / 搜索 / 标签与难度筛选 / JSON 导入导出
- **学习记录**：完整提交历史（代码、语言、逐用例明细）、尝试次数、首次通过时间
- **错题本**：失败 ≥ 2 次自动收录，错误类型分布、重新练习、标记已掌握
- **统计面板**：正确率、连续练习天数、语言分布、常见错误类型、最近练习

## 环境要求

- Windows 10/11 x64
- 想跑哪种语言，就装哪种工具链（**应用本身不附带编译器**）：
  - **C / C++**：[MinGW-w64](https://winlibs.com/)（推荐，把 `bin` 加入 PATH）、LLVM/clang、或 Visual Studio 生成工具（MSVC，自动经 vswhere 定位）
  - **Python**：[python.org](https://www.python.org/downloads/) 安装时勾选 *Add to PATH*（Microsoft Store 版会被自动排除）
- 未安装任何工具链也能启动：题库、设置等功能可用，运行/判题会给出友好提示

## 开发

```bash
npm install        # 安装依赖（Electron 二进制走 npmmirror 镜像，见 .npmrc）
npm run dev        # 开发模式（HMR）
```

质量门禁与构建：

```bash
npm run lint       # eslint（typed-lint，禁止 any / 吞异常）
npm run typecheck  # tsc --noEmit（main + web 两套 tsconfig，strict）
npm run test       # vitest 全量测试（单元 + 集成 + UI 组件）
npm run build      # 三端产物构建
npm run dist:dir   # 打包 win-unpacked（免安装目录）
npm run dist       # 打包 NSIS 安装器 + zip
```

Runner 集成测试会自动探测真实工具链（含项目内 `.tools/` 便携 MinGW）；node 桩用例在无任何编译器的机器上也能验证执行器管线。

## 打包产物使用

`npm run dist:dir` 产物位于 `dist/win-unpacked/CuinCodeBench.exe`，双击即用；数据保存在 `%APPDATA%/CuinCodeBench/`（SQLite，WAL 模式），删除该目录即完全重置。

## 安全须知（重要）

**本工具不是安全沙箱。** 代码以当前用户完整权限在本机运行，与直接在 IDE 里运行代码的风险级别相同——只运行你自己编写或来自可信来源的代码。超时强杀、输出限制、临时目录隔离等机制的目标是**防失控与保稳定**，不要将它们等同于完整的 Sandbox 隔离。详见 [docs/SECURITY.md](docs/SECURITY.md)。

## 已知限制

- 判题串行执行，无内存/CPU 限制，不支持 Special Judge 与文件 IO 型题目
- 杀毒软件（如 Defender）可能拦截新编译的无签名 exe：应用会退避重试并给出明确报错，但无法绕过本机安全策略
- 仅在 Windows 10/11 上开发与验证；其它平台未测试、不承诺
- NSIS 安装包未经代码签名，SmartScreen 可能出现提示
- 更多细节见 [FINAL_REPORT.md](FINAL_REPORT.md) §6

## 数据与隐私

所有数据（题库、提交历史、错题本、统计）保存在本机 `%APPDATA%/CuinCodeBench/`，删除该目录即完全重置；应用不上传任何数据。开发/调试可用环境变量 `CCB_DATA_DIR` 覆盖数据目录（可选，非必需配置，无需任何 API Key 或账号）。

## 文档

| 文档 | 内容 |
|---|---|
| [PRODUCT.md](docs/PRODUCT.md) | 项目目标、用户场景、v1.0 完成标准 |
| [REQUIREMENTS.md](docs/REQUIREMENTS.md) | 功能/非功能需求（FR/NFR 编号追溯） |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | 技术选型、模块分层、判题策略、ADR |
| [DATA_SPEC.md](docs/DATA_SPEC.md) | 领域模型、SQLite schema、导入导出格式 |
| [SECURITY.md](docs/SECURITY.md) | 威胁模型与安全边界 |
| [TEST_PLAN.md](docs/TEST_PLAN.md) | 测试分层与覆盖要求 |
| [ROADMAP.md](docs/ROADMAP.md) | P0–P7 阶段执行记录 |
| [CHANGELOG.md](docs/CHANGELOG.md) | 变更日志 |

## 架构一览

```
src/
├── main/      # Electron 主进程：IPC（zod 校验）→ services → repositories(SQLite)
│   └── runner/    # 独立执行模块：探测 / 编译 / 运行 / 杀进程树 / 临时目录（无 DB 依赖）
├── preload/   # contextBridge 白名单 API（contextIsolation + sandbox）
├── renderer/  # React + CodeMirror：题库 / 练习 / 错题本 / 统计 / 设置
└── shared/    # 三端共用类型、zod schema、常量
```

## License

[MIT](LICENSE)
