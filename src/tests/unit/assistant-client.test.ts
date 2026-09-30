import { describe, expect, it } from "vitest";
import { verifyContinuationSave, type AssistantPreview, type AssistantSave } from "@/lib/client/assistant";
const preview:AssistantPreview={draftId:"draft",draftStatus:"preview",expiresAt:"2036-01-01",liveUnchanged:true,change:{action:"save_continuation",task_id:"task",progress:"Section 1 done",blockers:[],next_step:"Read section 2",remaining_minutes:15,energy_required:"low",evidence:[]}};
const saved:AssistantSave={status:"succeeded",mutationApplied:true,draftId:"draft",readback:{verification:"succeeded",matchesMutation:true,entity:"continuation",id:"record",row:{id:"record",taskId:"task",kind:"progress",createdAt:"2026-09-30",content:preview.change}}};
describe("continuation exact persisted readback",()=>{
 it("accepts a verified exact record, including an idempotent retry",()=>{expect(verifyContinuationSave({...saved,status:"duplicate"},preview).id).toBe("record");});
 it("does not announce success for a wrong persisted ID, task, missing receipt or changed duration",()=>{
  for(const result of [
   {...saved,draftId:"other"},
   {...saved,readback:{...saved.readback,id:"other"}},
   {...saved,readback:{...saved.readback,row:{...saved.readback.row!,taskId:"other"}}},
   {...saved,readback:{...saved.readback,row:{...saved.readback.row!,content:{...preview.change,remaining_minutes:30}}}},
   {...saved,readback:{...saved.readback,verification:"failed"}},
  ]) expect(()=>verifyContinuationSave(result,preview)).toThrow();
 });
});
