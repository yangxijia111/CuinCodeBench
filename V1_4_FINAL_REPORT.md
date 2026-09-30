# CuinCodeBench v1.4.0 最终报告

- 版本：v1.3.0 → **v1.4.0**（Editor & Project Experience）
- 仓库：https://github.com/yangxijia111/CuinCodeBench
- Release：https://github.com/yangxijia111/CuinCodeBench/releases/tag/v1.4.0
- 报告生成：2026-09-30
- 设计文档：docs/V1_4_DESIGN.md（P0 起即冻结的权威设计）

---

## 1. Summary

三大交付全部落地并经真实测试验证：

1. **智能编辑（LSP）**：诊断 squiggle、补全、hover 进入做题编辑器。**pyright 内置打包**
   （Python 开箱即用），clangd 走检测 + 手工路径，未装语言服务器时回退
   **gcc/clang -fsyntax-only / python ast 语法检查**（诊断回退链，主力工具链即 gcc 覆盖面大）。
   首个 main→renderer 事件通道（`lsp.diagnostics`，受控订阅 + 可信窗口推送）。
2. **多文件项目**：题目可定义附加文件（problem_files 表，入口仍是 initialCode 单一真相）；
   做题页文件 Tab + 每题工作区（磁盘编辑态真相，localStorage 草稿一次性迁移）；
   多文件编译判题（gcc/clang 多源链接、MSVC 同理、Python 同目录 import）；
   submissions.files 快照使错题复盘可见完整现场。判题输入永远由 renderer 显式传入
   （不读工作区，v1.3 的临时目录即弃隔离语义不变）。
3. **CPU 限频（技术债清偿）**：launcher 协议 v2（REQ 可选 `cpuRatePercent`）+
   `JOB_OBJECT_RATE_CONTROL`；设置项默认 **0 = 关闭**（判词语义与 v1.3 逐字节一致），
   开启后防死循环空转吃满核；仅 native launcher 路径生效（与内存/进程上限同语义）。

配套：备份格式 v2 → **v3**（problem_file 记录 + submissions.files + 版本协商，旧备份可导入）、
migration v5、性能门禁（pyright 真实会话）、E2E 多文件闭环与 pyright 诊断端到端、
Release smoke 断言 pyright 资产。

## 2. 架构：每题工作区（LSP 与多文件的共同地基）

`{CCB_DATA_DIR}/workspaces/{problemId}/{c|cpp|python}/`——做题编辑态的磁盘真相：

- **seed-on-open**：仅补种缺失文件（入口 ← localStorage 旧草稿（一次性迁移）或
  initialCode；附加 ← problem_files 题目定义）；已存在的工作区文件一律保留
  （solver 编辑态优先；题目定义更新后由「重置」同步）。
- **判题不读工作区**：判题/运行输入永远来自 renderer 显式 IPC 参数，判题仍走
  临时目录复制即弃——v1.3 的隔离/清扫/防篡改语义不变。
- **备份不含工作区**（编辑态可重建，与旧 localStorage 草稿同语义）。
- 删除题目时清理其全部工作区（best-effort）。

## 3. LSP 客户端（main 进程）

- 每语言族一个长驻 server：clangd（c+cpp 共用）/ pyright（python）；**不进 Job Object**
  （信任进程，与判题 Job 生命周期解耦），app 退出统一树杀。
- 工作区切换经 `workspace/didChangeWorkspaceFolders`（不重启 server；同 URI 幂等）。
- 文档同步：写盘后 didOpen/didChange（全量文本）+ 删除 didClose；
  补全/hover 请求携带当前内容先行 didChange（消除 250ms 防抖窗口滞后）。
- **崩溃自愈**：非主动退出 → 退避重启（500ms/1s/2s），≤3 次；超限降级到编译器回退链
  （状态徽标同步 renderer）。
- clangd 工作区生成 `compile_flags.txt`（与 buildRunPlan 的 -std/-Wall 对齐，
  诊断与判题编译口径一致）；`--background-index=false --pch-storage=memory`
  防索引缓存污染工作区。

## 4. 内置 pyright（分发与 spawn）

- npm 依赖 `pyright`（1.1.414，纯 JS 无需 Python 安装）；electron-builder
  `asarUnpack: node_modules/pyright/**`。
- spawn：`process.execPath` + `ELECTRON_RUN_AS_NODE=1` + langserver.index.js
  （开发 = repo node_modules；打包 = resources/app.asar.unpacked）。
- 环境隔离：ELECTRON_RUN_AS_NODE 仅注入 LSP 子进程 env；判题子进程 env 由
  buildRunPlan/compile 构造（白名单），互不相通。
- pythonPath 经初始化项传入（ToolchainService 检测结果）。

## 5. 诊断回退链

| 语言 | 首选 | 回退 | 说明 |
|---|---|---|---|
| C/C++ | clangd | gcc/clang `-fsyntax-only -fdiagnostics-color=never`（判题同 toolchain 同 flags） | MSVC-only 用户无回退（文档注明） |
| Python | pyright | `ast.parse` 助手脚本输出 JSON（比解析 traceback 稳定） | 语法级 |

- 回退执行直连 `execute()`（不占 JudgeService 串行队列，不经 Job Object——受信编译命令）。
- 触发：sync 后主进程防抖 500ms，仅当该语言族 LSP 不可用；已修复文件的旧诊断主动清空。
- 来源统一映射共享类型后走同一推送通道（renderer 无感知差异）。

## 6. IPC 面扩展（首个事件通道）

- invoke 新增：`workspace.open/sync/reset`、`lsp.status/complete/hover`；
  `judge.submit` 扩展可选 files（4 元组）、`run.once` 输入加可选 files。
- **事件通道（唯一）**：`lsp.diagnostics`——preload 受控订阅
  （`onLspDiagnostics(cb): () => void`，不暴露通用 on）；main 端推送目标限定
  registerTrustedSender 注册的可信窗口（destroyed 移除 / isDestroyed 竞态兜底 /
  单窗口异常隔离）；payload 契约 zod 校验（测试消费）。
- 全部新通道自动受 v1.1 sender 校验 + 恢复期维护门保护。

## 7. 数据模型（migration v5）

- `problem_files(id, problem_id FK CASCADE, language CHECK, path, content, sort_order,
  UNIQUE(problem_id, language, path))`——入口内容仍是 `problems.initial_code`
  （单一真相，内置 45 题零迁移）。
- `submissions.files`（JSON `[{path,content}]`，NULL = 单文件提交/旧数据）。
- 文件约束单源 `src/shared/workspace-path.ts`（zod schema / 工作区写盘 / 判题写盘
  三处复用）：路径白名单正则、禁 `..`/反斜杠/绝对路径/盘符、深度 ≤8、
  每语言 ≤16 文件、单文件 ≤100KB、总量 ≤1MB、保留名（compile_flags.txt/.clangd）、
  禁与入口同名；join 前再过 safeJoinWithin 纵深防御。

## 8. 多文件判题

- `buildRunPlan(toolchain, dir, extraSources?)`：gcc/clang/msvc 将入口 + 附加源
  （语言扩展名过滤、去重、字典序）一并编译链接；Python 附加 .py 落同目录可 import；
  头文件由 include 引用不进命令行。
- `writeWorkspaceFiles(dir, language, entryCode, files)`：校验后写盘（含子目录）。
- 判题/运行全程：renderer 传 files → 校验 → 写临时目录 → 编译 → 跑用例 →
  快照落 submissions.files。
- 编译在临时目录内，include 天然限于本次判题文件集（无 -I 注入面）。

## 9. 备份 v3

- NDJSON 新增记录类型 `problem_file`；`submission` 记录新增可选 `files`；
  格式版本 2 → 3（**版本协商**：旧版本应用拒绝 v3 并提示升级；v1.3 及以前的
  v2/v1 备份仍可导入，缺失字段按空/NULL 语义）。
- v1 JSON 信封：problem 元素可选 `files`、submission 可选 `files`（旧备份 → 空语义）。
- 导入 staging：problem_file 确定性 id（`{problemId}:{language}:{path}`）+
  sort_order 流内递增；submissions INSERT 带快照列。
- 预览计数新增 problemFiles；恢复后 verify 对拍含 problem_files 表。

## 10. CPU 限频（launcher 协议 v2）

- REQ 新增可选 `cpuRatePercent`（0-100，缺省 0 = 不启用）；`PROTOCOL_VERSION 1 → 2`
  双端同值（native-protocol.ts + launcher.cpp，含错误消息同步）。
- C++ 侧：`SetInformationJobObject(JobObjectCpuRateControlInformation,
  { ENABLE, CpuRate = percent * 100 })`；**失败视为致命**（ERROR 帧，不静默降级）。
- 链路：JudgeService 每任务读一次 `settings.judgeCpuRatePercent` →
  runProcess/compileSource 透传 → executeNative limits；fallback 无此能力
  （native-only，同内存/进程上限现状）。
- **默认 0 = 关闭**：默认判题语义与 v1.3 逐字段一致（对拍/CI 不受影响）。

## 11. UI

- **PracticeView**：文件 Tab（多文件题目才显示，单文件退化为 v1.3 观感——渐进披露）；
  Tab 带错误计数徽标与删除（入口不可删）；「+」新建文件；LSP 供给徽标
  （pyright/clangd/语法回退/无）；重置带确认并清自建文件；判题/运行取入口文件
  + 附加文件随提交。
- **CodeEditor（CodeMirror 6）**：诊断经 setDiagnostics 注入 squiggle（linter 基座）；
  补全 = LSP 项 + 语言关键字本地源合并（LSP 失败退化本地）；hover markdown 经
  dompurify 净化管线渲染；开折叠；主题/字号/Tab/折行配置照旧。
- **ProblemEditView**：初始代码 textarea → CodeMirror；附加文件管理区
  （语言 + 路径 + 内容编辑 + 删除）。
- **SettingsView**：语言服务器区（三语言供给状态 + clangd 手工路径）；
  CPU 限频滑条（0=关闭默认）；备份摘要计数含附加文件数。

## 12. 安全

- 路径校验三处单源（§7）；编译 include 面限于判题文件集；LSP 子进程 env 隔离；
- hover markdown 复用既有净化管线（禁 script/svg/iframe 等 + URI 白名单）；
- 事件通道 payload 由 main 构造（无不可信输入），接收方受控订阅；
- 工作区在 CCB_DATA_DIR 内，safeJoinWithin 防拼接逃逸。

## 13. PoC 与风险前置（P1，全部真实验证）

① pyright spawn + JSON-RPC 握手 + publishDiagnostics + completion 往返（843/896ms）；
② clangd 握手 + compile_flags.txt 生效（skipIf：本机/CI 无 clangd 时跳过，协议同构由 pyright 路径覆盖）；
③ CM6 lint/autocompletion/hover 扩展在 vitest+jsdom 可渲染；
④ gcc -fsyntax-only 输出格式可解析。发现的库级坑（setDiagnostics 返回 transaction spec
而非 effect、linter 基座必需）在 PoC 阶段消化。

## 13.1 E2E 抓到的真实设计缺陷（修复）

**Python 多文件 import 与 `-I` 隔离冲突**：v1.3 的 `python -I`（隔离模式）在
Python 3.11+ 隐含 `-P`（不把脚本目录加入 sys.path）——多文件题
`from helper import add` 直接 ModuleNotFoundError（runtime_error）。
修复：`-I` → 显式 `-E -s`（保留忽略 PYTHON* 环境变量与用户 site 的隔离语义，
恢复脚本目录可 import）。单文件判题行为不变（不 import 同目录模块），
E2E 多文件闭环从 runtime_error 修复为 accepted 实证。

## 14. 测试矩阵（新增 80+ 项）

| 层 | 内容 |
|---|---|
| 纯函数 | workspace-path 恶意路径矩阵（16+ 用例）/validateFileSet/buildRunPlan 多源（含无 shell 元字符审计）/JSON-RPC 编解码（分块/畸形/超限）/LSP 映射（severity/completion 三形态/hover 五形态/uriToPath）/gcc 诊断行解析/回退列表过滤 |
| LSP 单元 | LspServer 真实子进程（桩语言服务器：握手/诊断/补全/崩溃 onExit/close 不触发/请求超时） |
| LSP 编排 | LspService：open→诊断推送、防抖窗口内补全携新内容、崩溃退避重启恢复、无 LSP 回退接管+清空旧诊断、status 三态 |
| 工作区 | seed-on-open/草稿迁移（磁盘优先）/增量 sync+didClose/入口不可删/reset/定义文件补种+编辑态优先/保留名排除/removeProblem |
| 判题集成 | 多文件 AC+快照/缺实现 compile_error/恶意路径拒绝不落库/单文件回归一致（4 项真实 gcc） |
| 备份 | v3 回环（problem_file 3 记录 + submission 快照）/既有 hash 篡改 50 组翻转回归 |
| native | 协议 v2 对拍 15 项全绿 + cpuRatePercent=50 透传正常完成 |
| UI（jsdom） | useWorkspace 5 项（含 fake-timer 防抖断言）/PracticeView Tab 切换/判题新签名/squiggle/单文件无 Tab |
| 性能门槛 | pyright 冷启动→诊断 734ms（<15s）、补全往返中位 703ms（<2s） |
| E2E（CDP） | 新增 2 场景：多文件判题闭环（UI 按钮 → AC → DB files 快照断言）；pyright 诊断端到端（workspaceSync 错误代码 → cm-lintRange-error 渲染） |

## 15. 质量证据（本地门禁）

- lint / typecheck / build / build:launcher 全绿；
- 单元测试：**44 文件全绿，508 项（504 通过 + 4 条件跳过）**——v1.3 的 36 文件 427 项 → **+81**；
- native launcher 测试 15/15（协议 v2 对拍 + cpuRatePercent 透传）；
- E2E **10/10**（v1.3 的 8 → +2：多文件判题闭环、pyright 诊断端到端）；
- 判题/备份/恢复全链路回归无变化（v1.3 语义保持）。

## 16. Known Limitations

1. clangd 未内置（50MB+）：C/C++ 智能编辑需本机安装 LLVM（或依赖 gcc 语法回退——
   仅诊断，无补全/hover）；设置页可手工指定路径。
2. MSVC-only 用户无编译器回退诊断（仅无 LSP 时无诊断；clangd 仍可用）。
3. LSP 服务器不进 Job Object（信任进程），无 CPU/内存围栏——pyright 大库分析
   理论上可占内存；做题工作区均为小项目（≤16 文件），实测无压力。
4. CPU 限频仅 native launcher 路径（fallback/非 Windows 无此能力，设置项说明已注明）。
5. goto definition / 格式化未做（stretch 未及，v1.5 候选；LSP 方法转发基建已就绪）。
6. 工作区不进备份（编辑态可重建）；判题进行中触发恢复的行为与 v1.3 相同。

## 17. Deferred to v1.5

- goto definition（跨文件跳 Tab）/ LSP formatting / 签名帮助（「LSP 方法转发」模式已就绪，边际成本低）
- launcher 崩溃 minidump；备份增量/去重；launcher 进程池；mastery 批量物化（v1.3 遗留）
- 在线 OJ / AI 辅助 / 云同步（远期，与历版路线一致）

## 18. Git / CI 证据

- 基线：77c9f5e（v1.3.0）→ 交付 HEAD / tag：v1.4.0
- 提交链（P0–P9 每期独立可验证，门禁全绿后提交）：
  - docs(v1.4 P0)：设计文档（ca37fd7）
  - feat(v1.4 P1)：PoC 六项验证（4671c0c）
  - feat(v1.4 P2)：IPC 事件通道基建（1734d1d → 2b18aec）
  - feat(v1.4 P3)：LSP 客户端（24f3d01）
  - feat(v1.4 P4)：工作区服务（5745975）
  - feat(v1.4 P5)：编辑器集成（82e9756）
  - feat(v1.4 P6)：多文件判题（eebdb3f）
  - feat(v1.4 P7)：多文件 UI + 备份 v3（51862a1）
  - feat(v1.4 P8)：CPU 限频协议 v2（3541a58）
  - chore(v1.4 P9)：E2E/性能门槛/版本 1.4.0/报告（bb3b38f）
  - CI 过程修正 ×3（891b428 / 5e0b7f1 / cdd9878）：uriToPath 断言平台条件化；
    CI windows runner 装有 clangd 暴露的环境假设（resolveClangd 测试注入 + PoC②
    管线级断言）——本地全绿但 CI 环境差异的三轮真实暴露与修复
- CI（ubuntu/windows 矩阵）✓ / E2E（windows）✓ / Release ✓（全绿）

## 18.1 Release 资产与实际下载验证

- 资产：CuinCodeBench-Setup-1.4.0.exe（122.05MB）+ CuinCodeBench-1.4.0-win-x64.zip（168.08MB）
- 实际下载两个资产并以 7zip-bin 7za 解包验证（与 CI smoke 同口径）：
  - `resources\bin\ccb-launcher.exe`（协议 v2）✓
  - `resources\app.asar.unpacked\node_modules\pyright\langserver.index.js` ✓（pyright 全量 6320 文件）

## 19. 成功标准核对（v1.4 验收单）

| 标准 | 结果 |
|---|---|
| 单文件题目全链路与 v1.3 一致（回归零变化） | ✅（既有套件全绿；judgeSubmit 兼容 3 参） |
| pyright 开箱：Python 题即有诊断+补全 | ✅（性能门槛真实会话 + E2E 诊断端到端） |
| clangd 未装时 C/C++ 有 gcc 回退诊断 | ✅（-fsyntax-only 解析 + LspService 降级链测试） |
| 多文件题目判题 AC 且快照完整 | ✅（集成 + E2E 双重 DB 断言） |
| `../` 等恶意 path 被拒 | ✅（16+ 恶意矩阵 + 判题拒绝不落库） |
| 默认设置下判词语义与 v1.3 逐字段一致 | ✅（native 对拍 15/15；cpuRate 默认 0） |
| CPU 限频仅显式开启后生效 | ✅（设置项 + 透传链 + native 用例） |
| 备份 v3 双向兼容（旧可导入/新被旧拒） | ✅（版本协商 + v1/v2 导入测试） |
| lint/typecheck/unit/E2E/build/dist 全绿 | ✅ |
| Release 资产含 launcher.exe 与 pyright | ✅（asarUnpack + 7za 冒烟双断言） |
