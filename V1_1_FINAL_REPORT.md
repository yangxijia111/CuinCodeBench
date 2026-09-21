# V1_1_FINAL_REPORT.md — CuinCodeBench v1.1.0 Hardening 最终报告

发布日期：2026-09-21 ｜ GitHub：https://github.com/yangxijia111/CuinCodeBench ｜ 标签：`v1.1.0`

## Summary

在不破坏 v1.0 任何功能的前提下完成 Production Hardening：外部链接协议白名单、IPC sender 校验、Markdown/XSS 净化显式化与回归测试、编译输出上限、数据库显式关闭与导入回滚回归、GitHub Actions 双平台 CI、自动化 Release 流水线、测试从 109 项补强至 **137 项**、renderer 按路由分割（主 bundle 1.97MB → 737KB）、Issue/PR 模板与贡献指南、README/SECURITY.md 按威胁模型重写。安全之外的真实问题（spawn 异步错误信息丢失等）已在 v1.0 发布前修复，本轮无新增功能性回归。

## Security Improvements

| 加固项 | 实现 | 测试 |
|---|---|---|
| External URLs | `isAllowedExternalUrl`：仅 http/https；`setWindowOpenHandler`（一律 deny）与 `will-navigate`（一律 preventDefault）统一走白名单后才 `shell.openExternal`，拒绝时记安全日志 | https/http allowed；javascript:/file:/data:/vbscript:/shell:/ms-settings:/powershell:/cmd:/自定义协议/畸形 URL 全部 denied（12 项） |
| IPC sender validation | `validateIpcSender`：可信 WebContents 注册表（窗口创建时注册）+ frame URL 校验（生产 `file:` / 开发 `ELECTRON_RENDERER_URL` origin），`handle()` 统一接入；非法请求拒绝 + 安全日志，不执行 service | `isTrustedFrameUrl` 10 项（origin 不匹配/端口不同/127.0.0.1≠localhost/生产 http/恶意协议/畸形 URL） |
| Markdown/XSS | 净化独立为 `sanitize-markdown`：DOMPurify 显式 FORBID_TAGS（script/style/iframe/form/object/embed/svg/math）+ FORBID_ATTR + SANITIZE_DOM + 禁未知协议；事件属性全删（DOMPurify 默认 on*） | 11 项回归：script/img onerror/iframe/form/object/embed/svg/math/style/javascript: 链接/data: URL/onclick，含组件级渲染断言 |
| Compile output limit | `COMPILE_OUTPUT_LIMIT_BYTES`：编译阶段同样 enforce 输出上限（原 `enforceOutputLimit: false` 缺口关闭），超限判编译失败并附截断标记 | 可配置 `outputLimitBytes` 机制集成测试（持续输出程序 + 100KB 上限 → OLE、进程被杀、截断标记） |
| 进程生命周期审计 | 确认 double-settle 防护、killTree 后 3s SIGKILL 兜底、`activeChildren` 退出统一终止均在位（v1.0 已实现），本轮文档化到 SECURITY.md §3.2 | 现有 TLE/OLE/清理集成用例持续覆盖 |
| Database | 退出显式 `closeServices()`（WAL 检查点落地，幂等）；导入单事务（v1.0 已实现）补回滚回归 | 中途 CHECK 失败 → 全量回滚断言（题目与用例均无残留）；重复关闭安全 |

## CI

`.github/workflows/ci.yml`：push/PR → main 触发，**ubuntu-latest + windows-latest** 双平台矩阵：

- 步骤：checkout → setup-node 22（npm cache）→ `npm ci` → lint → typecheck → test → build
- 无编译器环境（ubuntu CI）：工具链集成用例按 `describe.skipIf` 条件跳过（设计语义，非禁用），node 桩用例验证执行器全管线
- windows runner：真实验证 MSVC（vswhere + vcvars）与 Python 探测及端到端判题
- 无 `continue-on-error`；job timeout 25 分钟

## Release Pipeline

`.github/workflows/release.yml`：push `v*` tag → windows-latest → npm ci → 四门禁 → electron-builder（NSIS + zip，`CSC_IDENTITY_AUTO_DISCOVERY=false` 显式声明未签名）→ 发布 GitHub Release。

产物命名（electron-builder.yml）：
- `CuinCodeBench-Setup-{version}.exe`
- `CuinCodeBench-{version}-win-x64.zip`

Release 仅含应用构建产物；不含数据库/日志/源码临时目录/.env/工具链。未签名声明见 README 与 Release Notes。

## Electron Hardening

审计确认并保留：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`webviewTag: false`、preload 白名单（无 remote module）、无 `webSecurity: false` / `allowRunningInsecureContent` / `nodeIntegrationInWorker`、CSP `script-src 'self'`、`loadFile` 本地加载。新增配置相关文档见 docs/SECURITY.md §3.5/§3.6。

## IPC Hardening

三道防线：sender 校验（本轮新增）→ zod 参数校验（单参数/多参数 tuple 双约定）→ 统一错误信封（内部错误仅摘要）。所有 handler 经同一 `handle()` 封装，无复制逻辑。

## Markdown Hardening

唯一 `dangerouslySetInnerHTML` 注入点收敛于 `MarkdownView`，净化逻辑独立可测（`sanitize-markdown.ts`）。不依赖逐个列举事件属性（DOMPurify 默认删除全部 on*），并显式禁用危险标签与未知协议 URI。

## Runner Hardening

审计确认：全部子进程数组参数 spawn（无 exec/execSync/shell 拼接）；用户代码仅以文件内容写入固定文件名；manual toolchain path 仅作为 spawn program 直接执行（不经 shell 重解析）；临时目录固定文件名 + 随机 runId。MSVC cmd 场景为唯一例外且路径非用户输入（详见 SECURITY.md §3.1）。"非沙箱"定位保持不变并多处声明。

## Tests

**13 个文件 / 137 passed / 0 failed**（2026-09-21，Windows 11 本机真实执行；工具链相关用例在无编译器环境按设计条件跳过，不计失败）。较 v1.0（109 项）新增 28 项：安全回归（URL 白名单/sender 校验/XSS）、DB 回滚、可配置输出上限。文档中的数字已统一为"137 passed / 0 failed + 条件 skip 说明"形式（README/CHANGELOG），v1.0 历史报告加注时点说明。

## Build

- lint（typed-lint）：PASS，0 错误
- typecheck（strict × 2 tsconfig）：PASS，0 错误
- build（三端）：PASS；renderer 主 chunk **737KB**（原 1.97MB，CodeMirror 按需加载）
- `npm ci` 干净安装验证：**从本地 clone 的全新目录完整走通四门禁**（等效验证 CI 与用户克隆场景）
- `npm run dist:dir`：win-unpacked 产物正常
- 打包产物运行时验证：UI 冒烟 3 路由 PASS；端到端判题 Python AC 5/5、C（MSVC 真实编译）WA 1/5、统计落库正确
- `npm run dist`（NSIS）：由 release.yml 在 CI 执行（本地不再重复验证签名告警路径）

## GitHub Actions

- CI 与 Release workflow 已建立；YAML 语法经 GitHub 平台解析验证（push 后以 Actions 运行结果为准）
- 如 Actions 因平台故障未绿：不影响本地全部门禁结论，处理记录见下节

## Release

`v1.1.0` tag 推送后由 release.yml 自动构建发布；Release 内容仅应用构建产物。

## Dependency Audit

`npm audit`：**found 0 vulnerabilities**（v1.0 基线即 0，本轮未引入新依赖——CI/Release 使用 GitHub 官方 actions）。依赖版本策略：Electron 44 / React 19 / TS / Vite 7 / better-sqlite3 13 / marked 18 / DOMPurify / zod 4 均为当前大版本的稳定线，无已知漏洞，**不做盲目 major 升级**。

## Known Limitations

- 非安全沙箱（设计定位，SECURITY.md 多处声明）
- 判题串行、无内存/CPU 限制、不支持 Special Judge / 文件 IO
- 构建未代码签名（SmartScreen 提示，README 与 Release Notes 声明）
- 仅 Windows 10/11 验证；clang 分支与 gcc 共用实现，本机未单独实测
- 杀软可能持续拦截新编译 exe（退避重试 + 明确报错，无法绕过）

## Deferred to v1.2

1. **完整数据备份/恢复**（题库+历史+错题+设置的 versioned 信封、schema 校验、事务恢复）——实现成本中等，非安全关键，见 V1_1_HARDENING_PLAN.md「明确推迟」
2. **Windows Job Object 资源限制**（memory/CPU/kill-on-job-close）——需原生 addon，避免引入不稳定；设计与权衡已记录于 SECURITY.md §4
3. 代码签名证书采购
4. renderer 进一步瘦身与多窗口支持评估

## Git

- latest commit：见 `git log -1`（v1.1.0 发布提交）
- tag：`v1.1.0`
- GitHub：https://github.com/yangxijia111/CuinCodeBench
