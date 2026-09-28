import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, inArray } from "drizzle-orm";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import { getActualRecords, mutateActualRecord } from "@/lib/actual-records/service";
import { runPawPlanTool } from "@/lib/mcp/tools";
const url=process.env.DATABASE_URL??"";
const run=process.env.RUN_DATABASE_INTEGRATION==="1" && url.includes("pawplan_records_check") && url.includes("127.0.0.1");
describe.runIf(run)("actual record PostgreSQL persistence",()=>{
 let pool:Pool;let db:ReturnType<typeof drizzle<typeof schema>>;const ids:string[]=[];
 beforeAll(()=>{pool=new Pool({connectionString:url});db=drizzle(pool,{schema});});
 afterEach(async()=>{if(ids.length)await db.delete(schema.workspaces).where(inArray(schema.workspaces.id,ids.splice(0)));});
 afterAll(async()=>{await pool.end();});
 async function workspace(){const [w]=await db.insert(schema.workspaces).values({name:`actual-${randomUUID()}`,passwordHash:"test"}).returning();ids.push(w.id);return w.id;}
 const fields={title:"概率练习",starts_at:"2026-01-01T09:20:00+08:00",ends_at:"2026-01-01T09:50:00+08:00",approximate:true};
 async function seed(){const w=await workspace();const[p]=await db.insert(schema.plans).values({workspaceId:w,title:"test",status:"active",baselineSnapshot:{},startDate:new Date("2026-01-01"),endDate:new Date("2026-12-31")}).returning();const[t]=await db.insert(schema.tasks).values({workspaceId:w,planId:p.id,title:"任务",date:new Date("2026-01-01"),daySegment:"morning",scheduledStart:new Date("2026-01-01T09:00:00+08:00"),scheduledEnd:new Date("2026-01-01T10:00:00+08:00"),estimatedMinutes:60}).returning();return {w,t};}
 it("saves facts, snapshots the plan, reads exact ID and never changes task status or schedule",async()=>{
  const{w,t}=await seed();const args={idempotency_key:randomUUID(),record:{...fields,task_id:t.id}};
  const result=await runPawPlanTool(db,w,"save_actual_record",args,"read_write");
  expect(result.readback).toEqual({verification:"succeeded",matchesMutation:true});
  const[row]=await db.select().from(schema.actualRecords).where(eq(schema.actualRecords.id,result.record.id));
  expect(row.title).toBe(fields.title);expect(row.startsAt.toISOString()).toBe("2026-01-01T01:20:00.000Z");
  expect(row.planSnapshot).toMatchObject({taskId:t.id,estimatedMinutes:60,scheduledStart:t.scheduledStart!.toISOString()});
  const[task]=await db.select().from(schema.tasks).where(eq(schema.tasks.id,t.id));expect(task).toEqual(t);
  expect((await runPawPlanTool(db,w,"save_actual_record",args)).status).toBe("duplicate");
  expect(await db.select().from(schema.actualRecords)).toHaveLength(1);
  const list=await runPawPlanTool(db,w,"get_actual_records",{date_from:"2026-01-01",date_to:"2026-01-01"},"read_only");
  expect(list.records[0].task.status).toBe("todo");
  await db.update(schema.tasks).set({date:new Date("2026-01-02T00:00:00+08:00"),scheduledStart:new Date("2026-01-02T09:00:00+08:00"),scheduledEnd:new Date("2026-01-02T10:00:00+08:00")}).where(eq(schema.tasks.id,t.id));
  const changed=await mutateActualRecord(db,w,"save",{id:row.id,expected_revision:1,idempotency_key:randomUUID(),record:{...fields,title:"更正内容",task_id:t.id}});
  expect(changed.record.planSnapshot).toEqual(result.record.planSnapshot);
 });
 it("works without a plan and serializes concurrent identical retries",async()=>{
  const w=await workspace();const args={idempotency_key:randomUUID(),record:fields};
  const results=await Promise.all([mutateActualRecord(db,w,"save",args),mutateActualRecord(db,w,"save",args)]);
  expect(results.map(r=>r.status).sort()).toEqual(["duplicate","succeeded"]);
  expect(await db.select().from(schema.actualRecords)).toHaveLength(1);
  expect(await db.select().from(schema.actualRecordWrites)).toHaveLength(1);
  await expect(mutateActualRecord(db,w,"save",{...args,record:{...fields,title:"different"}})).rejects.toMatchObject({code:"idempotency_mismatch"});
 });
 it("protects workspace boundaries, permissions and stale revisions",async()=>{
  const{w,t}=await seed();const other=await workspace();const args={idempotency_key:randomUUID(),record:{...fields,task_id:t.id}};
  await expect(mutateActualRecord(db,other,"save",args)).rejects.toMatchObject({code:"task_not_found"});
  for(const permission of ["read_only","review_only"] as const) await expect(runPawPlanTool(db,w,"save_actual_record",args,permission)).rejects.toMatchObject({code:"mcp_permission_denied"});
  const saved=await mutateActualRecord(db,w,"save",args);
  expect((await getActualRecords(db,other,{date_from:"2026-01-01",date_to:"2026-01-01"})).records).toHaveLength(0);
  const edit={id:saved.record.id,expected_revision:1,idempotency_key:randomUUID(),record:{...fields,title:"new",task_id:t.id}};
  await expect(mutateActualRecord(db,other,"save",edit)).rejects.toMatchObject({code:"record_not_found"});
  await mutateActualRecord(db,w,"save",edit);
  await expect(mutateActualRecord(db,w,"save",{...edit,idempotency_key:randomUUID()})).rejects.toMatchObject({code:"record_changed"});
  const replay=await mutateActualRecord(db,w,"save",args);expect(replay.readback.matchesMutation).toBe(false);expect(replay.record.revision).toBe(2);
 });
 it("returns overnight records on both days, rejects future facts, and soft-deletes with retry receipts",async()=>{
  const w=await workspace();const args={idempotency_key:randomUUID(),record:{...fields,starts_at:"2026-01-01T23:00:00+08:00",ends_at:"2026-01-02T07:00:00+08:00"}};
  const saved=await mutateActualRecord(db,w,"save",args);
  for(const day of ["2026-01-01","2026-01-02"])expect((await getActualRecords(db,w,{date_from:day,date_to:day})).records).toHaveLength(1);
  await expect(mutateActualRecord(db,w,"save",{...args,idempotency_key:randomUUID(),record:{...fields,starts_at:"2099-01-01T00:00:00Z",ends_at:"2099-01-01T01:00:00Z"}})).rejects.toMatchObject({code:"future_record"});
  const del={id:saved.record.id,expected_revision:1,idempotency_key:randomUUID()};
  expect((await mutateActualRecord(db,w,"delete",del)).record.deletedAt).not.toBeNull();
  expect((await mutateActualRecord(db,w,"delete",del)).status).toBe("duplicate");
  expect((await getActualRecords(db,w,{date_from:"2026-01-01",date_to:"2026-01-02"})).records).toHaveLength(0);
  expect(await db.select().from(schema.actualRecords)).toHaveLength(1);
  expect(await db.select().from(schema.actualRecordWrites)).toHaveLength(2);
 });
 it("keeps a committed receipt if post-commit readback fails, then recovers on retry",async()=>{
  const w=await workspace();const args={idempotency_key:randomUUID(),record:fields};
  const broken={transaction:db.transaction.bind(db),select:()=>{throw new Error("read unavailable");},insert:db.insert.bind(db),update:db.update.bind(db)};
  const result=await mutateActualRecord(broken,w,"save",args);
  expect(result.status).toBe("applied_with_readback_error");expect(result.mutationApplied).toBe(true);
  const retry=await mutateActualRecord(db,w,"save",args);expect(retry.status).toBe("duplicate");expect(retry.readback.verification).toBe("succeeded");
 });
});
