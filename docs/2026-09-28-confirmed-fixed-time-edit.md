# 固定日程聊天确认直改

状态：用户已确认；2026-09-28 经用户授权已部署至生产，`PAWPLAN_CONFIRMED_TIME_BLOCK_ENABLED=true` 已设置并读回。代码默认关闭；本功能无需数据库迁移。发布 ID：`dpl_BDb6LhitmnPKNgokNfMKvZaVBKnP`。线上未执行真实日程修改，直接写入路径已在隔离数据库验收。

## 用户流程

用户说“把周二这次课程改到 10:00–11:00”，AI 读取对应日程、展示具体旧值和新值后，在用户授权范围内直接应用并读回。明确请求本身可以构成聊天确认；范围不清楚时只询问“本次、之后、整个系列”。用户无需打开 Review。

AI 自行重排、删除整个系列、改变 protected 属性仍使用现有审核流程。read_only 与 review_only 连接都不能调用新写入口。2026-09-29 新增的明确确认单次批量取消使用独立接口，见[批量取消与额度契约](2026-09-29-confirmed-occurrence-cancellation.md)；该接口的本地验收和发布状态以此文档为准。

## 现有实现与变更边界

`src/lib/constraints/time-block-series.ts` 已提供系列/单次/后续编辑、签名预览、快照冲突校验、事务、操作审计和提交后读回。`update_time_block_series` 目前由 write 权限控制，应用时验证并消费 `operationApprovals`。

已增加独立的 `update_confirmed_time_block` MCP 工具；不放宽旧接口，不自动批准已有 Review。新增功能开关默认关闭。无需数据库结构迁移。

输入契约沿用现有 Zod / JSON Schema（见 `src/lib/mcp/tools.ts`，由 MCP 导出）：

- `series_id`：目标 UUID，禁止标题模糊匹配后直接写。
- `scope`：`occurrence | following | series`，必填。
- `occurrence_date`：本次/后续生效日期，必填。
- `changes`：沿用时间块字段的验证规则；首版只开放标题、开始/结束时间、地点，不接受 protected、删除或改归属。
- `preview_token`：来自只读预览的签名，绑定 workspace、精确目标、修改内容及旧值，过期或旧值变化立即拒绝。
- `confirmation`：`USER_CONFIRMED`；`user_instruction` 为用户授权原文，以进入审计；该声明本身不替代服务端 write 权限。
- `idempotency_key`：必填；同键同内容返回已记录结果，同键不同内容拒绝。

`preview_confirmed_time_block` 是只读预览，不创建待审核记录。新写入口复用事务修改核心，明确区分“已有审批授权”和“聊天确认授权”；不允许调用者通过传入内部 bypass 标志跳过权限。

返回遵循现有结构：明确区分 committed、重复、no_change 和读回失败；返回操作 ID、精确系列/例外 ID、影响日期和最终读回；修改前值及用户指令进入审计日志。提交成功但读回失败时不得谎报整体失败并诱发重复写入，应返回可按操作 ID 恢复的状态。

## 验证与回滚

使用新建隔离 PostgreSQL：预览前后数据相同；直接写后按精确 ID 独立 SELECT；单次不改变其他日期；后续不改变过去；跨空间、只读连接、缺失确认、过期或陈旧快照全部拒绝；同键重试不重复写；并发同键一致；提交后读回失败可恢复。现有 Review/Apply 测试保持通过。

关闭新功能开关即可回到现有 Review 路径。已成功写入的数据通过审计旧值生成反向改动，并重新校验当前值后恢复，不能盲目覆盖之后的编辑。

用户已在聊天确认该审批契约变更。原有 Review/Apply 路径保持可用；read_only/review_only 可预览，但不能调用直改。

## 使用顺序

1. 读取日程，解析用户明确指定的目标与范围。
2. 调用 `preview_confirmed_time_block`，参数为 `series_id / scope / occurrence_date / changes`。
3. 对同一组参数调用 `update_confirmed_time_block`，加上预览返回的 `preview_token`、`confirmation: "USER_CONFIRMED"`、`user_instruction` 和稳定的 `idempotency_key`。
4. 检查 `status` 与 `readback.verification`；`duplicate` 时检查 `priorStatus` 和 `result`，不要仅凭 duplicate 宣称成功。签名有效期 30 分钟，过期需重新预览；相同请求仍沿用原幂等键。

验证入口：`src/tests/integration/confirmed-time-block-db.test.ts`；只在显式隔离库和 `RUN_DATABASE_INTEGRATION=1` 下运行。
