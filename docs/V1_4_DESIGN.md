# CuinCodeBench v1.4 设计文档 — Editor & Project Experience

状态：实施中（P0 基线 2026-09-30，lint/typecheck/test 427 项全绿）
配套：V1_4_ROADMAP 分期见本文 §12；架构基线见 docs/V1_3_ARCHITECTURE.md。

## 0. 目标与非目标

**目标**：
1. 智能编辑：实时诊断（squiggle）、补全、hover；Python 开箱即用（内置 pyright），C/C++ 检测 clangd，未装时回退编译器语法检查。
2. 多文件项目：题目可定义附加文件（头文件/辅助源文件），做题页文件 Tab 编辑，多文件编译判题，提交快照完整复盘。
3. CPU 限频（JOB_OBJECT_RATE_CONTROL）：设置项，默认关闭，防死循环空转吃满核。

**非目标（留后续版本）**：launcher minidump、备份增量/去重、launcher 进程池、mastery 批量物化、格式化/重命名等高级重构操作、goto definition（stretch，时间允许再做）。

## 1. 每题工作区（LSP 与多文件的共同地基）

现状：代码是内存字符串，判题时才写临时目录（判完即删）。LSP（clangd/pyright 均基于磁盘文件）与多文件都需要代码以**持久文件**存在。

```
{CCB_DATA_DIR}/workspaces/{problemId}/{c|cpp|python}/
  main.c|main.cpp|main.py      ← 入口文件（SOURCE_FILENAMES 不变）
  util.h / util.cpp / ...      ← 附加文件（题目定义 + 用户自建）
  compile_flags.txt            ← 仅 C/C++，与 buildRunPlan 的 -std/-Wall 对齐
```

**语义**：
- **编辑态真相**：renderer 持有权威状态，编辑防抖 250ms 后 `workspace.sync` 增量写盘（changed/removed 两个列表），main 写盘后向 LSP 发 didChange。
- **seed-on-open**：`workspace.open` 时仅补种缺失文件（入口 ← initialCode / 附加 ← problem_files 定义），已存在的工作区文件一律保留（solver 的编辑态）。题目定义在打开后被作者修改导致的工作区陈旧，由「重置」修复（重置 = 恢复入口 + 覆盖定义文件 + 删除用户自建文件）。
- **草稿迁移**：localStorage 旧草稿（`ccbench.draft.{problemId}.{lang}`）在 open 时一次性读入工作区入口文件后删除 key，消除双真相源。
- **判题不读工作区**：判题/运行输入永远由 renderer 显式传入（入口 code + files 列表），与 v1.3 的「code 单字符串显式传入」同语义——可审计、可回放、不受工作区外部篡改影响。判题仍走临时目录复制即弃，v1.3 的隔离/清扫语义不变。
- **备份不含工作区**：工作区是编辑态（可从 initialCode + 草稿语义重建），与现状 localStorage 草稿一致，写入 Known Limitations。
- 启动清扫：workspaces 目录不属于临时目录清扫范围（持久数据）；删除题目时同步删除其工作区目录（best-effort）。

## 2. LSP 客户端（main 进程，LspService）

**进程模型**：每语言族一个长驻 server——clangd（服务 c+cpp 两个工作区）、pyright（服务 python）。**不进 Job Object**（长驻信任进程，与判题 Job 生命周期解耦），app 退出统一树杀。

**启动方式**：
- pyright（内置，随应用打包）：`process.execPath` + `env ELECTRON_RUN_AS_NODE=1` + `[<pyright>/langserver.index.js, --stdio]`。路径解析：开发 = `app.getAppPath()/node_modules/pyright/`；打包 = `process.resourcesPath/app.asar.unpacked/node_modules/pyright/`（electron-builder asarUnpack）。pythonPath 经初始化项传入（ToolchainService 检测结果）。
- clangd（检测 + 手工路径）：`detectClangd()` 复用 detect.ts 的 where.exe + `--version` 模式；AppSettings.manualClangdPath 手工覆盖。参数：`--compile-commands-dir` 不用，工作区根放 compile_flags.txt（clangd 原生支持，单目录项目标准做法）；`--background-index=false --pch-storage=memory`（避免索引缓存污染工作区）。

**工作区切换**：单一 server 实例 + `workspace/didChangeWorkspaceFolders`（先移除旧文件夹再添加新文件夹，同族同时至多一个活跃文件夹）。文档同步：sync 写盘后对变更文件发 didOpen（首次）/ didChange（全量文本），避免依赖平台文件监听。

**崩溃自愈**：非主动关闭的退出 → 指数退避重启（500ms/1s/2s），≤3 次；超限标记该语言族降级（renderer 收到状态事件），诊断走 §3 回退链。

**生命周期**：惰性启动（首次该语言 workspace.open 且 server 可用）；`window-all-closed`/`before-quit` 与 killAllActiveProcesses 同点位清理。LspService 不进 ServiceContext、不持 DB 引用（同 ToolchainService 模式，备份恢复换库不受影响）。

## 3. 诊断回退链（无语言服务器时的底线体验）

| 语言 | 首选 | 回退 | 说明 |
|---|---|---|---|
| C/C++ | clangd 诊断 | gcc/clang `-fsyntax-only -fdiagnostics-color=never`（gcc 原生语法，clang 兼容），解析 `file:line:col: severity: message` | gcc 是本项目主力工具链，覆盖面大；MSVC-only 用户无回退（文档注明） |
| Python | pyright 诊断 | `python -X utf8 -c "import ast,sys; ast.parse(...)"` 语法级检查 | 只报语法错误（SyntaxError 行号） |

- 回退执行：直接用 execute()（fallback 执行器），**不占 JudgeService 串行队列**，不经 native launcher（受信编译命令，无需 Job 围栏）。
- 触发：sync 后主进程侧防抖 500ms，仅当该语言族 LSP 不可用时。
- 诊断统一映射为共享类型（§5 LspDiagnostic）后走同一条推送通道，renderer 无感知来源差异。

## 4. IPC 面扩展（含首个事件通道）

现有模型是纯 invoke 请求/响应。v1.4 新增：

**invoke 通道**（四层契约照旧：shared/ipc.ts + preload + register.ts + schemas.ts）：
```
workspace.open(problemId, language) → WorkspaceFile[]（补种 + 草稿迁移）
workspace.sync(problemId, language, changed[], removed[]) → void
workspace.reset(problemId, language) → WorkspaceFile[]
lsp.status() → Record<LanguageId, { server: 'clangd'|'pyright'|'fallback'|'none', state: 'ready'|'starting'|'degraded' }>
lsp.complete(problemId, language, path, line, col, content) → CompletionItem[]（≤50）
lsp.hover(problemId, language, path, line, col, content) → { contents: string; isMarkdown: boolean } | null
judge.submit(problemId, language, code, files?)   ← 扩展可选第 4 参
run.once(input)                                    ← RunOnceInput 增加可选 files
```
- complete/hover 携带当前文件 content：主进程先对该文档发 didChange 再转发请求，消除防抖窗口内的状态滞后；payload ≤100KB，本地 IPC 可忽略。

**事件通道（唯一）**：`lsp.diagnostics`
- preload 新增 `onLspDiagnostics(cb): () => void`（返回退订函数；只暴露这一个事件订阅方法，不提供通用 on）。
- payload：`{ problemId, language, path, diagnostics: LspDiagnostic[] }`；LspDiagnostic = `{ line, col, endLine, endCol, severity: 'error'|'warning'|'info', message, source? }`（LSP 0 基坐标，renderer 映射 CM6）。
- 推送目标限定 registerTrustedSender 注册过的可信窗口（复用 validate-sender 的 WeakSet，导出一个 sendToTrustedWindows(channel, payload)）。

## 5. 共享类型（src/shared）

```ts
interface WorkspaceFile { path: string; content: string; isEntry: boolean }
interface WorkspaceFileInput { path: string; content: string }
interface ProblemFileInput { language: LanguageId; path: string; content: string }
interface LspDiagnostic { line: number; col: number; endLine: number; endCol: number; severity: 'error'|'warning'|'info'; message: string; source?: string }
interface LspCompletionItem { label: string; kind?: number; detail?: string; insertText?: string }
```

**文件约束（常量单源 src/shared/constants.ts）**：
- `MAX_WORKSPACE_FILES = 16`（不含入口）、单文件 ≤100KB（与 initialCode 同限）、总量 ≤1MB、路径深度 ≤8。
- `WORKSPACE_PATH_RE = /^[A-Za-z0-9_\-][A-Za-z0-9_\-.\/]*$/`，禁 `..` 段、禁绝对路径/盘符、禁反斜杠、禁与入口文件同名、禁 `compile_flags.txt`/`.clangd` 保留名。校验函数放 src/shared/workspace-path.ts（zod schema 与判题写入、工作区同步三处复用同一实现）。

## 6. 数据模型（migration v5）

```sql
CREATE TABLE problem_files (
  id TEXT PRIMARY KEY,
  problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  language TEXT NOT NULL CHECK (language IN ('c','cpp','python')),
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (problem_id, language, path)
);
CREATE INDEX idx_problem_files_lookup ON problem_files(problem_id, language);
ALTER TABLE submissions ADD COLUMN files TEXT;  -- JSON [{path,content}]，NULL = 单文件（旧数据/旧备份）
```

- **单一真相**：入口文件内容 = `problems.initial_code`（不变，内置 45 题零迁移）；`problem_files` 只存附加文件。
- ProblemInput 增加 `files?: ProblemFileInput[]`（每语言 ≤16，zod 复用 §5 校验）；ProblemDetail 返回 `files: ProblemFile[]`。
- submissions.files = 当次判题的附加文件快照（错题复盘可见完整现场）。

**备份**：
- v2 NDJSON：新增记录类型 `problem_file`（v2RecordSchemas + 导出行序 + 导入 staging 写入）；submission 记录 schema 增加可选 `files`。**格式版本 2 → 3**（新记录类型对旧版是未知行，必须版本协商拒绝：BACKUP_V2_VERSION=3，导入接受 ≤3）。
- v1 JSON 信封：backupProblemSchema 增加可选 `files`；backupSubmissionSchema 增加可选 `files`；v1 备份导入缺失 → 空/NULL 语义。

## 7. 判题链路改造

- `buildRunPlan(toolchain, dir, extraSources?: string[])`：
  - gcc-c/clang-c：`[main.c, ...*.c, ...GCC_C_ARGS, -o, app.exe]`；cpp 同理（*.cpp）。附加源按字典序（确定性）。
  - msvc：`[...MSVC_ARGS, main.cpp, util.cpp, ..., /Fe:app.exe]`。
  - python：无编译，附加 .py 落同目录即可 import；.h/.hpp 永不进命令行。
  - extraSources 扩展名过滤：c → `.c`；cpp → `.cpp/.cc/.cxx`；其余忽略（头文件靠 include）。
- `writeWorkspaceFiles(dir, language, entryCode, files)`（compile.ts）：入口写 SOURCE_FILENAMES，附加文件经 §5 校验后写入（含子目录 mkdir -p）。
- JudgeService.doSubmit/doRunOnce：files 透传 → 校验 → 写盘 → buildRunPlan(files 的源文件列表)；persist 时 files 快照进 submissions.files。
- 安全：编译在临时目录内，gcc/clang 头文件搜索默认限当前目录（无 -I 注入面），include 只能引用本次判题文件集。

## 8. CPU 限频（launcher 协议 v2）

- REQ 增加 `cpuRatePercent`（1–100；缺省/0 = 不启用）。`PROTOCOL_VERSION 1 → 2`（双端常量同步：native-protocol.ts + launcher.cpp，破坏性变更 +1 的既有规则）。
- C++ 侧：cpuRatePercent > 0 时 `SetInformationJobObject(JobObjectCpuRateControlInformation, { JOB_OBJECT_CPU_RATE_CONTROL_ENABLE, CpuRate = percent * 100 })`，失败 → ERROR 帧（不静默）。
- AppSettings 增加 `judgeCpuRatePercent`（0–100，**默认 0 = 不启用**，默认语义与 v1.3 逐字节一致，CI/对拍不受影响）。
- 链路：JudgeService 在 doSubmit/doRunOnce 入口读一次设置 → 传 runProcess opts → executeNative limits；fallback 无此能力（native-only，同内存/进程上限现状，文档注明）。限频同时作用于编译与运行（防的正是失控编译）。

## 9. UI

**PracticeView**：
- 文件状态：`files: WorkspaceFile[]` + activePath；文件数 >1 或题目有定义文件时显示 Tab 栏（入口 Tab 固定首位 + 附加文件 Tab + 「+」新建）；单文件且无定义文件 → 与 v1.3 完全一致（渐进披露）。
- Tab 能力：切换、新建（输入路径）、删除（非入口，带确认）；Tab 上显示该文件诊断计数徽标。
- 语言切换 = workspace.open(另一语言)；判题/运行传 `files`（非入口文件）。
- LSP 状态徽标（编辑器工具栏角落）：ready/fallback/none 三态，点击跳设置页。
- 诊断渲染：CM6 lint 扩展（cm-lintRange squiggle + gutter）；补全：CM6 autocompletion（LSP 项 + 语言关键字本地源合并）；hover：CM6 hoverTooltip，markdown 内容经现有 dompurify 净化管线。

**ProblemEditView**：每语言「附加文件」管理（列表 + 新建/删除 + CodeMirror 编辑；现状 textarea 顺势升级为 CodeEditor）。

**SettingsView**：语言服务器区（pyright 内置状态、clangd 检测结果 + 手工路径 + 重新检测、回退链说明）+ CPU 限频滑条（0=关闭）。

## 10. 测试矩阵

| 层 | 内容 |
|---|---|
| 纯函数单测 | workspace-path 校验（恶意路径矩阵）、buildRunPlan 多源命令（含无 shell 元字符审计）、LSP↔共享类型映射、JSON-RPC Content-Length 编解码、诊断解析（gcc -fsyntax-only / ast.parse stderr） |
| 集成（skipIf） | 真实 clangd/pyright 会话（握手→诊断→补全往返）；gcc 回退真实验证；judge-service 多文件全链路（:memory: 库 + util.h/util.cpp/main.cpp AC + submissions.files 断言） |
| native | 协议 v2 REQ 透传、限频配置生效（进程正常完成，不做时序脆弱断言）、既有对拍回归 |
| UI（jsdom） | 文件 Tab 交互、诊断渲染（mock 事件）、防抖同步调用序列 |
| E2E（CDP） | 多文件判题闭环（键盘注入 + DB 断言快照）；打包态 pyright 诊断出现（CM6 cm-lintRange DOM 断言） |

## 11. 风险与对策

- **打包态 pyright**：ELECTRON_RUN_AS_NODE + asarUnpack；Release smoke 断言 pyright 文件存在（复用 7za 冒烟）。
- **ELECTRON_RUN_AS_NODE 环境泄漏**：仅注入 LSP 子进程 env，判题子进程 env 由 buildRunPlan/compile 构造（PYTHONIOENCODING 等白名单），互不相通；加单测断言判题子进程 env 不含该变量。
- **LSP 延迟**：补全/诊断门槛 <100ms（本地往返），P9 设性能测试。
- **工作区膨胀**：题目删除时清理；workspaces 总量在设置页可见（后续可加手动清理）。

## 12. 分期

P0 设计文档+基线 → P1 PoC（pyright/clangd 握手、CM6 集成最小样、打包态 spawn 路径验证）→ P2 IPC 事件基建 → P3 LSP 客户端 → P4 工作区服务 → P5 编辑器集成 → P6 多文件判题 → P7 多文件 UI/编辑器/备份 → P8 CPU 限频 → P9 E2E/性能/Release/报告。
