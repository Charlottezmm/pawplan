import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { getWorkspaceIdFromSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { readJsonBody } from "@/lib/validation/common";
import { ActualRecordError, getActualRecords, mutateActualRecord } from "@/lib/actual-records/service";
function failure(error: unknown) {
  if (error instanceof ActualRecordError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  if (error instanceof ZodError) return NextResponse.json({ error: error.issues[0]?.message ?? "记录格式无效" }, { status: 400 });
  return NextResponse.json({ error: "暂时无法确认记录，请稍后重试" }, { status: 500 });
}
export async function GET(request: Request) {
  const workspaceId = await getWorkspaceIdFromSession();
  if (!workspaceId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { return NextResponse.json(await getActualRecords(getDb(), workspaceId, Object.fromEntries(new URL(request.url).searchParams))); } catch (error) { return failure(error); }
}
async function write(request: Request, action: "save" | "delete") {
  const workspaceId = await getWorkspaceIdFromSession();
  if (!workspaceId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { return NextResponse.json(await mutateActualRecord(getDb(), workspaceId, action, await readJsonBody(request))); } catch (error) { return failure(error); }
}
export const POST = (request: Request) => write(request, "save");
export const DELETE = (request: Request) => write(request, "delete");
