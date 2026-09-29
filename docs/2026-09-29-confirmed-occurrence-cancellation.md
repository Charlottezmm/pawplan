# 聊天确认批量取消单次课块与 Hosted MCP 额度

状态：实现及本地验收完成；用户已明确授权提交、推送及生产部署。无需数据库迁移，复用现有 `PAWPLAN_CONFIRMED_TIME_BLOCK_ENABLED` 开关。线上是否生效以 Vercel 生产版本及 MCP 读回为准。

## 接口契约

MCP Zod / JSON Schema 的事实来源为 `src/lib/mcp/tools.ts`。

只读预览 `preview_confirmed_time_block_occurrences`：

```json
{
  "occurrences": [
    { "series_id": "11111111-1111-4111-8111-111111111111", "occurrence_date": "2026-10-01" },
    { "series_id": "22222222-2222-4222-8222-222222222222", "occurrence_date": "2026-10-02" }
  ]
}
```

返回签名的 `previewToken`、精确目标、取消前的有效课块、取消后的空结果及 `noChange`。不创建 Review、审批或操作记录，不修改课表；Hosted 请求仍保留调用审计。read_only/review_only/read_write 均可预览。

`cancel_confirmed_time_block_occurrences` 接受相同 `occurrences`，加上：

- `preview_token`：上述签名，有效期 30 分钟，绑定 workspace、完整目标列表及所有涉及系列与例外的旧值。
- `confirmation: "USER_CONFIRMED"`、`user_instruction`：用户确认原文，1–2000 字符；声明不替代服务端 read_write 权限。
- `idempotency_key`：8–200 字符，重试保持同键。目标顺序无关；同键不同目标或不同确认原文拒绝。

每批 1–20 个不重复的 `{series_id, occurrence_date}`，最早到最晚日期的包含首尾范围最多 14 个 Asia/Shanghai 自然日。例如 10/1–10/14 合法，10/1–10/15 拒绝。日期必须真实存在且是对应系列的 occurrence。输入不接受 scope、following 或 series，不能取消整个系列，也不能改 protected。

AI 解析用户明确给出的取消范围，展示具体目标，取得签名后在已有授权内执行；不要求用户进入 Review。AI 自选清理或整系列删除仍遵循既有审核契约。

## 原子性、审计和读回

所有系列按稳定顺序加锁，并在首次课表写入前验证整批快照。任一目标无效、跨空间、过期或陈旧，整批拒绝；事务内后续失败会撤回此前的单次取消。

取消保存为 `time_block_exceptions.action=cancel`，保留原系列及其他日期。整批一条 `plan_operations` 和一条变更审计，保留全部目标、旧系列/例外、用户原话、操作 ID 与例外 ID。事务内校验后，提交后按精确系列/例外 ID 再读回，核对取消状态和系列旧值。

返回 `status`、`operationId`、`seriesIds`、`exceptionIds`、精确 `affectedDates`，以及 `readback.verification` 和逐 occurrence 的 `cancelled / seriesPreserved`。`duplicate` 必须检查 `priorStatus` 和持久化 `result`。已全部取消返回 `no_change`。

提交后读回失败返回 `applied_with_readback_error`，保留操作 ID、事务内读回和已保存的取消状态；不能把它当成未写入，或用新幂等键盲目重试。正常按同键取得记录结果，再用返回 ID 核对。

## 额度

- 日上限从 50 改为 200，Asia/Shanghai 午夜重置。
- 每个成功批量调用只占 1 次，不按条目数累计；并发预留、失败释放与 duplicate 释放沿用现有逻辑。
- `preview_confirmed_time_block`、新批量预览、`preview_task_batch` 和 `update_time_block_series / delete_time_block_series / replace_plan_window` 的 `mode=preview` 不计额度。
- 权限与额度分开。已有 Review 预览仍可保存审批记录并要求原权限；正式创建 Review 草案的 `propose_*` 仍计额度。
- 已有 `preview_task_batch` 历史日志也从当前额度查询排除。旧版混合工具的日志未保存 mode，无法可靠区分历史 preview/apply，因此不盲改历史记录；新版以 `工具名:preview` 保存成功审计，使这些调用不进入写入计数。无需新表或迁移。

## 验证与回滚

验证入口：`src/tests/integration/confirmed-occurrence-cancellation-db.test.ts`。显式使用新建隔离 PostgreSQL 和 `RUN_DATABASE_INTEGRATION=1`，验证预览无写入、多系列/同系列多日期、20 节边界、系列与之后日期保留、精确 ID 读回、权限/日期/签名/陈旧快照拒绝、事务回滚、并发幂等、读回失败恢复状态，以及持久化额度计数。旧固定块直改与 Review/Apply 集成测试也需通过。

2026-09-29 本地验收：8 个相关测试文件共 108 项通过，其中隔离数据库 18 项。MCP 客户端 tools/list 已核对公开 schema。全仓类型检查已有 66 项测试文件错误，与 HEAD 基线比较无本次新增；生产构建及其应用类型检查通过。本次发布不执行真实课表取消。

关闭 `PAWPLAN_CONFIRMED_TIME_BLOCK_ENABLED` 会同时关闭聊天确认固定块编辑与批量取消；旧 Review 接口保持原契约。额度变更可通过回退代码恢复。已取消的课块只能根据审计旧值和当前状态恢复对应例外，不能盲目覆盖之后的修改。
