# V1_1_HARDENING_PLAN.md — v1.1 Hardening / Production Readiness 计划

基线（2026-09-21）：main `914e04b`，package 1.0.0，npm audit 0 漏洞，测试 109 passed / 0 failed（10 文件），无 CI、无 Release、无 Issue/PR 模板。

## 执行阶段与优先级

| # | 阶段 | 内容 | 涉及文件 | 验证方式 |
|---|---|---|---|---|
| H1 | CI 建设 | GitHub Actions：ubuntu（快速门禁）+ windows（真实工具链集成）；npm ci → lint → typecheck → test → build；工具链用例保持条件 skip 语义 | `.github/workflows/ci.yml` | push 后 Actions 绿灯 |
| H2 | 外部链接安全 | 新增 `isAllowedExternalUrl`（仅 http:/https:），`setWindowOpenHandler` 与 `will-navigate` 统一走校验 | `src/main/lib/external-url.ts`、`src/main/index.ts` | 单测 6+ 场景（含 javascript:/file:/data:/未知协议 denied） |
| H3 | IPC sender 校验 | `validateIpcSender`：可信 WebContents 注册表 + frame URL 协议校验（file:/dev server origin），handle 统一接入，非法拒绝并记日志 | `src/main/ipc/validate-sender.ts`、`ipc/index.ts`、`main/index.ts` | 单测 URL 判定逻辑 + 集成冒烟 |
| H4 | 窗口安全审计 | 复核 contextIsolation/nodeIntegration/sandbox/webviewTag/preload 白名单，文档化 | `src/main/index.ts`、docs/SECURITY.md | 审计清单 + 配置断言测试 |
| H5 | Markdown/XSS | DOMPurify 显式 URI allowlist（ALLOWED_URI_REGEXP）+ 禁 script/svg/math/style；补 XSS 回归测试 | `MarkdownView.tsx`、`tests/markdown-xss.test.tsx` | 恶意用例：script/img onerror/iframe/form/javascript: 链接/style/SVG |
| H6 | Runner 加固审计 | 复核数组 spawn 无 shell 拼接；manual toolchain path 校验（存在性 + 可执行文件名）；**编译阶段输出上限**（COMPILE_OUTPUT_LIMIT_BYTES，enforceOutputLimit 改为编译也启用） | `runner/*`、`shared/constants.ts` | 单测 + 编译超限集成用例 |
| H7 | 进程生命周期审计 | double-settle / killTree fallback / activeChildren 复核（v1.0 已具备），补文档与回归断言 | `runner/execute.ts`、`kill-tree.ts` | 现有 TLE/OLE 集成测试 + 审计记录 |
| H8 | 数据库可靠性 | 退出时显式 `close()`；导入事务回滚回归测试（repo 层注入非法数据验证 CHECK 失败回滚） | `services/index.ts`、`main/index.ts` | 新增回滚测试 |
| H9 | 测试补强 | 覆盖 H2/H3/H5/H6/H8 的恶意与异常输入用例 | `tests/` | 全量门禁 |
| H10 | 文档统一 | 以最终真实测试结果统一 README/FINAL_REPORT/GITHUB_RELEASE_REPORT/CHANGELOG 数字（X passed / Y conditionally skipped / 0 failed 形式） | 各文档 | 比对测试输出 |
| H11 | Release 工程 | `release.yml`（windows-latest，tag v* 触发，NSIS+zip，artifactName 规范化，unsigned 声明）；Issue/PR 模板、CONTRIBUTING | `.github/workflows/release.yml`、`.github/`、electron-builder.yml | YAML 校验 + push 后 workflow 触发 |
| H12 | 依赖与质量 | npm audit（基线 0）；TODO/console/死代码扫描；renderer bundle 按路由 lazy 分割（CodeMirror ~1.9MB 单包问题）；基础可访问性 | `App.tsx`、各 view | bundle 尺寸对比 + 门禁 |
| H13 | 发布 | 版本 1.1.0、CHANGELOG、README badge、SECURITY.md 重写（威胁模型/信任边界/已知限制）、V1_1_FINAL_REPORT、tag v1.1.0 | 多文件 | 全量门禁 + smoke + e2e + CI 绿灯 |

## 明确推迟（记录到 v1.2）

- **完整数据备份/恢复**（题库+历史+错题+设置的信封格式 v2）：实现成本中等，非安全任务，推迟到 v1.2，不阻塞 Hardening
- **Windows Job Object 资源限制**：需要原生 addon 或 node-ffi 方案，引入不稳定风险；v1.1 记录设计与权衡到 docs/SECURITY.md，不仓促实现
- 代码签名证书（外部采购，非代码任务）

## 风险等级评估

- 高：无 CI（回归无门禁）→ H1 最先
- 高：外部 URL 未过滤协议（file:/javascript: 可能进 shell.openExternal）→ H2
- 高：IPC 无 sender 校验（依赖 Electron 内部隔离，纵深防御缺失）→ H3
- 中：编译输出无上限（失控编译器可撑爆内存）→ H6
- 中：Markdown URI allowlist 未显式（依赖 DOMPurify 默认行为）→ H5
- 中：无 Release 自动化（人工打包易漏步骤）→ H11
- 低：bundle 未分割、无 lazy → H12
- 低：退出未显式 close DB（WAL 兜底强，但应显式）→ H8

## 必须保持的现有能力（回归防线）

三语言 Runner、自动工具链探测（gcc/g++/clang/clang++/MSVC/python/py）、题库 CRUD 与导入导出、判题五状态、提交历史、错题系统、Dashboard、设置、SQLite、打包、Windows 10/11 支持——每个阶段后全量门禁 + 最终 smoke/e2e 验证。
