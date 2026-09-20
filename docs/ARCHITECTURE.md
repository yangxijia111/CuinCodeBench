# ARCHITECTURE.md — 架构设计

## 1. 技术栈（选型论证）

| 层 | 选型 | 理由 |
|---|---|---|
| 桌面框架 | **Electron** | 需求推荐；Node 侧可直接 spawn 编译器/解释器、读写 SQLite，主进程天然承载 Runner；Windows 11 一等支持。Tauri 需 Rust 工具链且子进程/SQLite 需侧车与插件，复杂度更高，不选 |
| 构建 | **electron-vite**（Vite 7） | 统一处理 main/preload/renderer 三端构建与 dev HMR；约定式目录与本项目分层一致 |
| UI | **React 19 + TypeScript strict**（实际版本以 package.json 为准） | 需求指定；生态成熟 |
| 编辑器 | **CodeMirror 6**（@uiw/react-codemirror + lang-cpp/lang-python） | 成熟开源、包体远小于 Monaco、Vite 打包友好、行号/高亮/缩进开箱即用 |
| 存储 | **better-sqlite3**（SQLite） | 需求指定 SQLite；同步 API 适合主进程单写入者；本机有 MSVC 可兜底编译 |
| 校验 | **zod** | IPC 边界与 JSON 导入校验 |
| 测试 | **vitest** | TS 原生、快、与 Vite 同源 |
| 代码质量 | **eslint（flat config）+ typescript-eslint（typed-lint）** | strict 类型与规范检查 |
| 打包 | **electron-builder** | Windows NSIS 安装包 + win-unpacked |
| 路由 | react-router-dom（HashRouter） | 多页面导航（题库/练习/错题/统计/设置） |

## 2. 进程模型与模块划分

```
┌────────────────────────── Electron 主进程 (Node) ──────────────────────────┐
│  index.ts            窗口创建、应用生命周期、单实例锁                          │
│  ── ipc/            IPC 处理器（薄层：zod 校验 → 调 service）                 │
│  ── services/       业务层：problem / judge / history / mistake / stats /    │
│                     settings / toolchain                                    │
│  ── runner/         独立执行模块（无 DB 依赖，可独立单测）：                  │
│     detect          工具链探测（where + --version 校验 + vswhere/MSVC）      │
│     languages       LanguageConfig 与编译/运行命令构造（纯函数）             │
│     compile         编译执行（超时、输出捕获）                                │
│     execute         运行执行（stdin 写入、超时、输出限制）                    │
│     kill-tree       进程树终止（win: taskkill /T /F）                        │
│     temp-dir        临时目录创建与清理（重试）                                │
│  ── db/             connection（WAL、migration）+ repositories（数据访问层）  │
│  ── seed/           首次启动种子题库灌入                                      │
└───────────────▲──────────────────────────────────────────┬─────────────────┘
                │ ipcRenderer.invoke / contextBridge        │ better-sqlite3
┌───────────────┴───────────────┐                          ▼
│  preload/index.ts             │                   %APPDATA%/CuinCodeBench/
│  contextBridge 暴露类型化 API  │                   cuincodebench.db (WAL)
│  （白名单方法，无 nodeIntegration）│
└───────────────▲───────────────┘
                │ window.api.*（类型见 src/shared/ipc.ts）
┌───────────────┴───────────────┐
│  renderer (React)             │
│  views/  题库 / 练习 / 错题 / 统计 / 设置                          │
│  components/ 通用组件；hooks/ 数据获取；api/ window.api 封装        │
│  编辑器 CodeMirror；样式 CSS（dark 变量）                          │
└───────────────────────────────┘
```

分层规则：

1. **renderer 不接触 Node**：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，仅经 preload 白名单 API。
2. **ipc 层不写业务**：只做 zod 校验与 service 调用、错误转译。
3. **service 不写 SQL**：经 repository；runner 模块不依赖 DB（judge-service 编排 runner）。
4. **shared**（`src/shared/`）：纯类型与常量，三端共用，无运行时依赖。

## 3. 数据流

### 3.1 判题流（核心）

```
UI 点击「判题」
  → renderer: api.judge.submit({problemId, language, code})
  → ipc: zod 校验 → judge-service.submit()
      1) 读题目与用例（problem-repo）
      2) 取该语言工具链（toolchain-service，无则返回友好错误）
      3) compiled 语言 → runner.compile()；失败 → CompileError 结果
      4) 逐用例 → runner.execute(stdin, timeoutMs)
      5) 归一化对比 → 判定各用例状态（§5）
      6) 写 submission + 明细 + error_records（history-repo / mistake 逻辑）
      7) 更新错题聚合（mistake-service.recompute(problemId)）
  → 返回 JudgeResult 给 UI 渲染
```

判题在主进程内**串行队列**执行（`Promise` 链），同一时刻仅一个编译/运行任务。

### 3.2 自定义运行流

UI「运行」→ `api.run.once({language, code, stdin, timeoutMs})` → judge-service.runOnce → compile（如需）+ execute → 返回单次 ExecutionOutcome（不写库）。

### 3.3 工具链探测流

应用启动（或设置页触发）→ toolchain-service.detectAll()：
1. 对每个候选名（gcc/g++/clang/clang++/python/py）`where.exe <name>` 取 PATH 命中；
2. 对每个命中 spawn `<exe> --version`（5s 超时）校验真实可用、取版本号（排除 WindowsApps Store 空壳）；
3. MSVC：vswhere 定位 BuildTools/VS → 找 `VC\Tools\MSVC\*\bin\Hostx64\x64\cl.exe` → `cmd /d /c "vcvars64.bat && set"`（windowsVerbatimArguments 保留引号；/S 会剥离引号导致含空格路径断裂）解析环境差异，缓存于内存（WIN-3）；
4. 结果缓存于主进程内存（设置页可强制重扫）；探测失败的路径被跳过而非报错。

## 4. 代码执行架构（Runner）

- **临时目录**：`os.tmpdir()/cuincodebench/<runId>/`，runId 为随机串；源码、可执行文件、编译产物均落在此目录；结束（无论成败）`finally` 清理，Windows 锁文件延迟重试最多 5 次（WIN-5）。
- **编译**（compiled 语言）：
  - gcc/clang：`gcc -O2 -std=c11 source.c -o app.exe`（C）；`g++ -O2 -std=c++17 source.cpp -o app.exe`（C++）
  - MSVC：`cl /O2 /std:c11 source.c /Fe:app.exe`（C11 在 MSVC 用 `/std:c11`；C++ 用 `/std:c++17 /EHsc`）
  - Python：无编译步。
- **运行**：
  - compiled：cwd=临时目录，spawn `./app.exe`；stdin 写入用例输入后 end；
  - python：spawn `python -I script.py`（`-I` 隔离模式），env 注入 `PYTHONIOENCODING=utf-8`、`PYTHONUTF8=1`。
- **进程树终止**：超时/超限时 `taskkill /PID <pid> /T /F`（数组 spawn，PID 为运行时获得的数字，非用户输入）；随后 `child.kill()` 兜底；等待 `exit` 事件后才继续。
- **输出限制**：stdout/stderr 各自累计字节数 > 1MB 即判定超限，杀进程树，状态 Output Limit Exceeded（截断后内容仍展示前 64KB 供排查）。
- **编码**：源码 UTF-8 无 BOM 写盘；输出按 UTF-8 解码（`Buffer` 拼接后 `toString('utf8')`，无效字节替换处理）。

## 5. 判题策略（JUDGE POLICY，与 FR-J 对应）

1. **预处理**：用例数为 0 的题目判为 Internal Error（题库约束应有 ≥1 用例）。
2. **编译**：仅执行一次；非零 exit code 或有 error 输出 → Compile Error，stderr 全文返回，跳过所有用例。gcc/clang 以 exit code 为准（警告不失败）；MSVC 同理。
3. **执行**：按用例顺序**全部执行**（失败不中断，便于学习者对比所有差异，FR-J5）；每用例独立 `execute`，超时取 `testCase.timeoutMs`（默认 5000ms，范围 100–60000）。
4. **单用例状态判定**（按序）：
   - 输出超限 → `output_limit_exceeded`
   - 超时（进程树被终止）→ `time_limit_exceeded`
   - exit code ≠ 0 → `runtime_error`（展示 stderr 与 exit code；Windows 崩溃码如 3221225477 原样展示并附十六进制）
   - exit code = 0 → 输出归一化后与期望相等 → `accepted`，否则 `wrong_answer`
5. **输出归一化**（`normalizeOutput`，纯函数）：
   - `\r\n` → `\n`，孤 `\r` → `\n`
   - 去除每行**行尾**空白（空格/Tab）
   - 去除末尾所有空行（即 `trimEnd` 整体尾部的 `\n`）
   - 保留行首空白与中间空行（` "1"` 与 `"1"` 不相等）
6. **总体状态**：执行顺序中第一个非 AC 用例的状态；全 AC → `accepted`。
7. **不设判题总时限**：安全性由单用例超时 + 用例数上限（50）保证。

## 6. 错误处理策略

| 层 | 策略 |
|---|---|
| Runner | 每个外部调用都有超时；spawn 失败（ENOENT 等）转为结构化错误（`spawn_error`），不抛裸异常出模块 |
| Service | 可预期错误（无工具链、题目不存在、用例为空）返回结构化结果/领域错误；不可预期错误打日志（主进程 console + 内存环形日志）并转为 Internal Error 响应，**不吞异常** |
| IPC | handler 统一 try/catch：领域错误 → `{ok:false, code, message}`；未知错误 → `{ok:false, code:'internal', message}`（含摘要日志） |
| DB | 迁移在事务中执行，失败则应用启动失败并明确报错；写操作 WAL 模式 |
| Renderer | api 层统一解包 `{ok}`；页面级 ErrorBoundary 兜底，展示可读错误而非白屏 |

领域错误约定：`AppError { code: string; message: string; cause?: unknown }`。

## 7. 进程生命周期

- 启动：单实例锁 → 打开 DB + 迁移 → 种子灌入（仅首次，按 settings 中的 seeded 标记；灌入失败降级为空题库）→ 清扫遗留临时目录 → IPC 注册 → 触发工具链探测（后台）→ 创建主窗口（1280×840，min 960×640，dark 背景）。
- 运行中：主窗口关闭 = 应用退出（macOS 行为不做）；退出前强制终止全部执行中的程序（防孤儿进程）并尽力清理临时目录。
- 崩溃兜底：`process.on('uncaughtException'/'unhandledRejection')` 记日志，不静默退出。

## 8. 关键设计决策记录（ADR 摘要）

| # | 决策 | 理由 |
|---|---|---|
| D1 | Runner 做成无 DB 依赖的纯模块 | 可用桩语言（node）与真实工具链独立测试，judge-service 编排 |
| D2 | 测试用例（TestCase）作为 Problem 聚合根的一部分整体读写 | UI 编辑场景一次成形，避免用例级 IPC 碎片化；导入导出天然成套 |
| D3 | 判题/运行串行队列 | 本机编译器资源有限，避免并发编译互踩临时资源；v1 复杂度可控 |
| D4 | better-sqlite3 同步 API | 主进程单写入者、无并发瓶颈；代码简洁；备选方案（node:sqlite）在 Electron 中可用性不稳 |
| D5 | MSVC 经环境解析后直接 spawn | 避免每次编译都过 cmd 链；命令行不拼接不可信内容 |
| D6 | UI 仅中文 | 目标用户定位；减少 i18n 复杂度 |
