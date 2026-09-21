# 贡献指南

## 开发环境

- Windows 10/11 x64（本项目 Windows 优先）
- Node.js 22+（LTS）
- 按需安装工具链（跑哪种语言装哪种）：MinGW-w64 / MSVC Build Tools / Python 3

```bash
npm install
npm run dev        # 开发模式
npm test           # 测试（无编译器的机器会按设计条件跳过工具链用例）
```

## 质量门禁

每个 PR 必须通过（CI 会自动执行，本地请先自测）：

```bash
npm run lint && npm run typecheck && npm run test && npm run build
```

## 约定

- **安全**：禁止提交任何密钥、Token、个人数据、数据库、日志或含真实用户名的绝对路径；子进程一律数组参数 spawn（禁止 shell 拼接）；渲染进程不接触 Node API（经 preload 白名单 IPC）
- **代码**：TypeScript strict，禁止 `any`（用 `unknown` + 收窄）；禁止吞异常；单文件建议不超过约 400 行；注释使用中文
- **测试**：核心逻辑必须有单测；Runner 相关真实工具链测试使用 `describe.skipIf` 条件执行（无编译器的环境自动跳过，不算失败）
- **提交**：遵循 Conventional Commits（`feat:` / `fix:` / `security:` / `ci:` / `docs:` / `chore:`）；禁止 force push

## 提交范围注意

请勿修改 `.tools/`（本地便携工具链，不入库）或提交 `dist/`、`out/` 构建产物。
