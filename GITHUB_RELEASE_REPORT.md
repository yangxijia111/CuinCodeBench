# GITHUB_RELEASE_REPORT.md — 公开发布前安全审计与发布报告

发布日期：2026-09-21 ｜ 仓库：https://github.com/yangxijia111/CuinCodeBench

## Repository

https://github.com/yangxijia111/CuinCodeBench（public，main 分支）

## Branch

`main`

## Version

`v1.0.0`（annotated tag，指向 v1.0.0 发布时 commit `9eeb2d0`；后续发布准备提交不改动已发布代码）

## Privacy Audit

扫描范围：全部 85 个 tracked 文件 + 全部 untracked 文件（排除 node_modules/.git/.tools/out/dist）+ **Git 完整历史**（9 个 commit 的全量 patch 内容，因仓库此前已推送，历史等同远程内容）。gitleaks 未安装，采用等效的 Git 全历史内容扫描 + 模式匹配完成审计。

| 检查项 | 结果 |
|---|---|
| API Keys / Tokens（sk-、ghp_、github_pat_、AKIA、ASIA、xox、AIza 等高危模式，当前文件 + 全历史） | NOT FOUND |
| Passwords / Secrets / Credentials / Authorization / Cookie / Session（词法扫描，当前文件 + 全历史） | NOT FOUND |
| Private Keys / Certificates（*.pem / *.key / *.pfx / *.p12 / *.crt / id_rsa / PRIVATE KEY 块） | NOT FOUND |
| .env 文件（当前与历史） | NOT TRACKED |
| 真实用户数据库（*.db / *.sqlite；运行时数据在 %APPDATA%，项目外） | NOT TRACKED |
| 用户数据（Submission 历史 / 练习代码 / 错误记录 / 运行日志） | NOT TRACKED |
| 日志文件（*.log） | NOT FOUND |
| 个人绝对路径（C:\Users\…、D:\…、/Users/、/home/、真实用户名；当前文件 + 全历史） | NOT FOUND |
| 个人邮箱 / 电话 / 身份证类信息 | NOT FOUND（commit 身份为 GitHub noreply 隐私邮箱） |
| 高熵随机字符串（排除 lockfile integrity） | NOT FOUND |
| 内网/外部 IP（127.0.0.1 本地回环除外） | NOT FOUND |
| .npmrc 专项（仅 npmmirror 公共镜像地址，无 _authToken/_password） | PASS |
| package-lock.json（无 resolved 凭据 / _authToken） | PASS |
| Git 历史 secret scan（高危模式 + 凭据词 + 敏感文件名，全量 patch） | PASS |
| 文档隐私（README / docs/ / FINAL_REPORT / CHANGELOG 中的账号、电脑信息、私人地址） | PASS（GitHub URL 为本仓库公开地址，属发布必需信息） |

结论：**SAFE TO PUBLISH**

## 加固措施（本次审计落地）

- `.gitignore` 补充预防性规则：`.env` / `.env.*`（保留 `!.env.example` 口子）、`tmp/`、`temp/`、`.cache/`、`desktop.ini`；并明确注释运行时数据库位于 `%APPDATA%` 项目外
- README 增加「已知限制」与「数据与隐私」章节，明确：本地 Runner 非安全沙箱、数据不出本机、`CCB_DATA_DIR` 为可选调试变量（项目不需要任何 API Key / 账号配置，因此未创建 .env 体系）

## Git

latest commit：见 `git log -1`（本次为发布准备提交：.gitignore 加固 + README 隐私章节 + 本报告）

## Quality

| 门禁 | 结果 |
|---|---|
| lint（eslint typed-lint） | PASS（0 错误） |
| typecheck（tsc strict × 2 tsconfig） | PASS（0 错误） |
| tests（vitest：单元 + 集成 + 真实工具链端到端 + UI 组件） | PASS（109 passed / 0 failed / 10 文件） |
| build（electron-vite 三端） | PASS |

## Known Limitations

见 README「已知限制」与 FINAL_REPORT.md §6：非安全沙箱（设计定位）、杀软可能拦截新编译 exe、判题串行、未做代码签名、仅 Windows 验证、clang 分支未在本机实测（与 gcc 共用实现）。
