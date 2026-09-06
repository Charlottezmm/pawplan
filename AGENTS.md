# PawPlan 项目约束

## 入口与验证

- 编辑前检查 Git 状态，保留已有改动。环境搭建查 [README Quickstart](README.md#-quickstart)；命令以 `package.json` 和对应 Vitest/Playwright/Drizzle 配置为准。
- 仅在相关行为变更或发布验收时查 [smoke checklist](docs/public-beta/2026-06-13-public-beta-smoke-checklist.md#local-gate)，选择受影响的测试。历史 handoff 不替代当前代码。
- 数据库测试/迁移必须显式设置隔离测试库的 `DATABASE_URL`；localhost 不代表空库，不用个人/生产库，不输出 `.env*`。真实数据库集成需 `RUN_DATABASE_INTEGRATION=1`；默认跳过与 mock 不能算持久化证据。
- UI 变更检查相关桌面/移动路径；build 与 Playwright 串行（共用 `.next`），不复用来源不明的 3000 服务。收尾检查 diff、停止自己启动的服务并清理测试数据；报告实际验证与跳过原因。

## 写入契约

- **Review → 用户确认 → Apply → 精确 ID 持久化读回**。`draft_created`、`duplicate`、approval、工具成功均不代表已应用；`review_only` 不得 Apply 或直接写入。
- 核心写流程变更验证 Apply 前未变、Apply 后读回、重试幂等及关键失败路径，优先复用已有集成测试。直接写工具仍遵守其权限与审批契约。
- 提交、推送、部署、生产迁移和生产写入需已有明确授权；本地验收不产生这些授权。
