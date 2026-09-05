# PawPlan agent 开工与验收

## 开工

- 先运行 `git status --short --branch`，保留已有改动；确认本次范围与授权。
- 从 [README](README.md#-quickstart) 进入项目；命令以 `package.json`、`vitest.config.ts`、`playwright.config.ts`、`drizzle.config.ts` 为准。验收复用 [smoke checklist](docs/public-beta/2026-06-13-public-beta-smoke-checklist.md#local-gate)。历史设计与 handoff 只作背景，以当前代码为准。
- 按改动读取 `src/app` 路由、`src/components`、相应 `src/lib` 服务和 `src/tests`；不顺手修改产品、重构或新增框架。
- 数据库测试和迁移只连接明确隔离的测试库，显式设置 `DATABASE_URL`。本地地址不代表空库；不要使用个人日常库、生产凭据或输出 `.env*` 内容。

## 验收与交付

- 按 checklist 选择相关单测、真实数据库集成与浏览器验收；说明执行命令、通过/失败/跳过数量以及 mock 边界。数据库测试默认跳过；Playwright 绿色不等于持久化验证。
- 规划草稿保留 **Review → 用户确认 → Apply → 持久化读回**。`draft_created`、`duplicate`、approval 和工具成功都不是已应用。`review_only` 不能执行 Apply 或直接写入；明确授权的直接写工具也不能绕过其权限与审批契约。
- 核心写流程必须核对 Apply 前未变、Apply 后按精确 ID 读回、重试幂等及关键失败路径；复用已有集成测试，不把 mock 当成数据库证据。
- UI 改动补相关桌面/移动端用例；构建与 Playwright 不并行运行，二者共用 `.next`。不要复用来源不明的 3000 端口服务。
- 结束运行 `git diff --check`、`git diff --stat`、`git status --short`；停止自己启动的服务，确认测试数据清理。报告具体改动、证据、未执行项及原因。
- 提交、推送、部署、生产迁移和生产数据写入需另有授权；本地检查通过不构成授权。
