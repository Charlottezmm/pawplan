# 每日时间线、反馈与跨助手续接

本次交付是本地实现，未部署、未迁移、未修改 live 排期。PawPlan 仍负责可变排期与任务状态；Academic 仓的现有大纲/首答/错误记录负责学习证据；Roadmap 负责战略。

## 可用入口

- Web：Today →「安排时间线 · 开始与续接」→ `/timeline`。保护时段可编辑；任务可设范围、预算、停止条件和有来源的截止；backlog 选择少量卡片与具体时段。
- Hosted MCP、stdio、Claude OAuth 共用原有 server builder：新增 `get_daily_timeline` 和 `validate_learning_handoff`，两者均为 **read** capability，`read_only` / `review_only` 均可用。不增加 OAuth scope 或外部服务。
- `POST /api/timeline`：通过现有登录 session 确定 workspace，内部强制 `read_only`。401 未登录，400 契约错误，409 旧快照/反馈冲突，500 live 读取失败；均无任务写入。
- 输入契约：[时间线 JSON Schema](contracts/daily-timeline.schema.json)、[交接 JSON Schema](contracts/learning-handoff.schema.json)。实现的唯一契约源为 `src/lib/planning/timeline-schema.ts`；MCP 发布同一 schema。

这是当下执行建议，不会把分钟级时间线写进现有只有 date/daySegment 的任务字段。反馈只留在当前页面/请求中，刷新前导出 JSON；没有 localStorage 或另一套持久化进度库。后续助手使用同一请求和累计反馈重算；长期事实回写原大纲，PawPlan 只存已有任务的证据链接/摘要。收口时走既有 notes Review → 本人批准 → Apply → 精确 ID 读回；改变排期走原 rebalance Review。实现本功能没有赋予任何生产写入授权。

## 每天怎么用

1. 读取 live 任务与课表，确认真实开始/收工时间。输入保护的吃饭、通勤、休息和机动时间；缺失、冲突或没有具体时间的 routine 会明确提示。接口自动查询 `[当天00:00, 次日00:00)`，覆盖全天有效 recurring occurrences/exceptions。
2. 给考试、作业、导师会前准备填写确认过的 `must_finish_by` 和 `deadline_reason`。PawPlan 原任务 date 只是排期日期。准备任务的前置用 `depends_on` 指向原卡，不从标题猜；前置预算不足就保留后续未排范围。
3. 指定少量 `backlog_windows` 和卡片；优先让截止任务使用其他空闲时间，确实放不下才借用 backlog，报告缺口。普通任务不会占用 backlog 预留时段。默认不会把所有旧积压加进今天。
4. 每块显示 scope、budget 和 stop condition。预算缩短不等于原范围删去，`original_scope` 和 `unallocated_minutes` 保留。任务不会跨保护块，默认每 50 分钟留 10 分钟休息；除最后少量剩余外，不开启不足 15 分钟的碎片块。算法是确定性启发式，`needs_decision` 不是数学意义上的无解证明。
5. 用户反馈：开始、卡住、完成、部分完成、暂停、超时。结束反馈需实际起止时间、剩余估时、准确断点、唯一下一步；完成另需证据链接。实际耗时不自动从学习范围扣除；“完成”只变成 `reported_complete_pending_record`，不是 live done 或 mastery。
6. 超时/晚开始从新的 `now` 重排；不突破收工时间，不自动顺延到明天。不够时列出剩余范围，读取目标日 live 容量后再提出具体安排并走 Review。

同一学习块的 `started` 反馈在结束时替换为最终反馈，沿用 id。提交的同一请求里相同 id/相同内容去重；同 id 不同内容拒绝。下一块使用新 id。保留累计历史以累计 actual minutes。拒绝重叠、未来时刻、旧任务版本和并行活跃块；暂停后开始新 session 即可续接。`expected_snapshot` 包含任务与课表内容，变更后必须重读并核对；不能自动抹去版本校验强行重试。

## Claude / Codex 交接

[交接模板](learning-handoff-template.json) 是可携带的引用包，填写已有事实，不另写第二份学习日志：

- 原材料链接、原大纲、当前分支、页码/题号；
- 原始独立首答的私人路径、提示依赖、未关闭错误索引及完整未覆盖范围；
- 实际耗时、唯一下一步和停止条件；
- live task `updatedAt`、原学习记录内容 hash/revision。

交接前更新原大纲；接收方先读取 source/outline 及相关错误，再调用 `validate_learning_handoff`。工具核对 workspace/active-plan task 与版本；source revision 由接收方读完原文后提供，服务端不访问本地文件。没读原文时返回 `source_read_required`；revision 不一致或 task 更新则拒绝旧包。`references_checked_by_caller` 仅表示调用方提供了匹配 revision，不是服务器验证过学习证据。重复调用只校验，不重复写入。

Claude Web 只有 PawPlan OAuth 时不能凭路径读取 Mac 上的 `_private` 文件：需由用户选择的文件访问方式提供当前材料/交接，不会自动公开受限材料。Claude Desktop 若已有授权的本地访问，可读取同一原文件。两边均保留首答与提示依赖，助手讲过不自动升级到独立通过。只有当前已确认分支需要读取，不重新装载所有历史。

## 验证与发布边界

单元测试验证纯排程、权限、live task/constraint adapter 和 API 失败路径；Playwright 使用本进程启动的独立 3417 端口，桌面 Chromium 与手机 WebKit，mock API 接到真实纯排程函数，覆盖开始→超时→剩余重排→JSON 导出/导入。UI 测试不代表生产持久化验证。没有使用个人/生产数据库、迁移或 Apply。

回滚：移除新增页面/API与两个只读工具注册即可；无 schema migration、无业务数据回滚需求。部署与 live 排期/记录应用仍分别需要明确授权。页面不会到点主动发通知；可另由用户明确选择系统闹钟或受支持的提醒服务，本次没有创建任何提醒。


实际验收结果：全仓 Vitest 509项通过、8项隔离数据库测试跳过；桌面/手机 Playwright 各1项通过；production build通过。独立 `tsc --noEmit` 在既有测试文件中报错，对照干净HEAD的错误集合无新增；生产源文件无类型错误。个人实际日程演示仅保留本地，不随公开源码发布。
