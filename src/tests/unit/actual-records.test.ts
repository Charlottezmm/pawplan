import { describe, expect, it } from "vitest";
import { saveActualRecordSchema, actualRecordRangeSchema, type ActualRecord } from "@/lib/actual-records/schema";
import { buildActualTimeline, recordTimeLabel } from "@/lib/actual-records/display";
const record: ActualRecord = { id:"r", taskId:"task", title:"实际练习", startsAt:"2026-09-28T09:20:00+08:00", endsAt:"2026-09-28T09:50:00+08:00", approximate:false, revision:1, deletedAt:null, createdAt:"",updatedAt:"",planSnapshot:{} };
const plan = { id:"task",title:"任务",kind:"task" as const, startsAt:"2026-09-28T09:00:00+08:00",endsAt:"2026-09-28T10:00:00+08:00",minutes:60,segment:"morning" as const,protected:false };
describe("actual records",()=>{
 it("validates real dates, bounded range, positive duration and update versions",()=>{
  expect(actualRecordRangeSchema.safeParse({date_from:"2026-02-30",date_to:"2026-03-01"}).success).toBe(false);
  expect(actualRecordRangeSchema.safeParse({date_from:"2026-01-01",date_to:"2026-02-01"}).success).toBe(false);
  expect(saveActualRecordSchema.safeParse({idempotency_key:"record-1",record:{title:"test",starts_at:record.endsAt,ends_at:record.startsAt}}).success).toBe(false);
  expect(saveActualRecordSchema.safeParse({id:"11111111-1111-4111-8111-111111111111",idempotency_key:"record-1",record:{title:"test",starts_at:record.startsAt,ends_at:record.endsAt}}).success).toBe(false);
 });
 it("replaces an overlapping old plan with facts without mutating either",()=>{
  const result=buildActualTimeline([plan],[record],"2026-09-28");
  expect(result.map(r=>r.id)).toEqual(["actual:r"]);
  expect(result[0].startMinute).toBe(560);
  expect(plan.startsAt).toBe("2026-09-28T09:00:00+08:00");
 });
 it("keeps an explicit later continuation and does not label plans versus records as a conflict",()=>{
  const result=buildActualTimeline([{...plan,startsAt:"2026-09-28T12:00:00+08:00",endsAt:"2026-09-28T13:00:00+08:00"}],[record],"2026-09-28");
  expect(result).toHaveLength(2);expect(result.every(r=>!r.conflict)).toBe(true);
 });
 it("keeps multiple sessions and clips midnight display without discarding real duration",()=>{
  const sleep={...record,id:"sleep",taskId:null,startsAt:"2026-09-27T23:00:00+08:00",endsAt:"2026-09-28T07:00:00+08:00"};
  const result=buildActualTimeline([], [sleep,record,{...record,id:"r2",startsAt:"2026-09-28T14:00:00+08:00",endsAt:"2026-09-28T14:30:00+08:00"}],"2026-09-28");
  expect(result).toHaveLength(3);expect(result[0].startMinute).toBe(0);expect(result[0].minutes).toBe(420);
  expect(recordTimeLabel(sleep)).toBe("23:00–次日 07:00");
  expect(buildActualTimeline([], [{...sleep,endsAt:"2026-09-28T00:00:00+08:00"}],"2026-09-28")).toHaveLength(0);
 });
});
