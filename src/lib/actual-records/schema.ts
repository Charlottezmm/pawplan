import { z } from "zod";
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}, "日期无效");
export const actualRecordRangeSchema = z.object({
  date_from: date,
  date_to: date,
  task_id: z.string().uuid().optional(),
}).strict().refine((v) => {
  const days = (Date.parse(v.date_to) - Date.parse(v.date_from)) / 86400000;
  return days >= 0 && days < 31;
}, "每次可读取 1–31 天的记录");
export const actualRecordFieldsSchema = z.object({
  title: z.string().trim().min(1, "请填写做了什么").max(240),
  starts_at: z.string().datetime({ offset: true }),
  ends_at: z.string().datetime({ offset: true }),
  task_id: z.string().uuid().nullable().default(null),
  approximate: z.boolean().default(false),
}).strict();
export const saveActualRecordSchema = z.object({
  id: z.string().uuid().optional(),
  expected_revision: z.number().int().positive().optional(),
  idempotency_key: z.string().trim().min(8).max(200),
  record: actualRecordFieldsSchema,
}).strict().superRefine((v, ctx) => {
  if (Boolean(v.id) !== Boolean(v.expected_revision)) ctx.addIssue({ code: "custom", message: "修改记录需要 ID 和版本号" });
  const duration = Date.parse(v.record.ends_at) - Date.parse(v.record.starts_at);
  if (duration <= 0 || duration > 48 * 3600000) ctx.addIssue({ code: "custom", message: "结束时间需晚于开始时间，单段不超过 48 小时" });
});
export const deleteActualRecordSchema = z.object({
  id: z.string().uuid(), expected_revision: z.number().int().positive(),
  idempotency_key: z.string().trim().min(8).max(200),
}).strict();
export type PlanSnapshot = { taskId?: string; title?: string; date?: string; scheduledStart?: string | null; scheduledEnd?: string | null; estimatedMinutes?: number; capturedAt?: string };
export type ActualRecord = {
  id: string; taskId: string | null; title: string; startsAt: string; endsAt: string;
  approximate: boolean; revision: number; deletedAt: string | null;
  planSnapshot: PlanSnapshot; createdAt: string; updatedAt: string;
  task?: { title: string; status: string; scheduledStart: string | null; scheduledEnd: string | null; estimatedMinutes: number } | null;
};
export type ActualRecordList = { records: ActualRecord[]; truncated: boolean };
