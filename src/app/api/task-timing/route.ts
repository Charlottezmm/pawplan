import { NextResponse } from "next/server";
import { z } from "zod";
import { getWorkspaceIdFromSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { readJsonBody } from "@/lib/validation/common";
import {
  readTaskTiming,
  proposeTaskTiming,
  applyTaskTiming,
} from "@/lib/planning/task-timing-service";
import { TimingError } from "@/lib/planning/task-timing";
import { shanghaiDateKey } from "@/lib/planning/task-actions";
function failure(e: unknown) {
  if (e instanceof TimingError)
    return NextResponse.json(
      { error: e.message, ...(e.code ? { code: e.code } : {}) },
      { status: e.status },
    );
  if (e instanceof z.ZodError)
    return NextResponse.json(
      { error: "日期、时间或任务信息不完整，请检查输入。" },
      { status: 400 },
    );
  return NextResponse.json(
    { error: "无法读取或保存时间安排，请刷新后重试。" },
    { status: 500 },
  );
}
export async function GET(request: Request) {
  const workspaceId = await getWorkspaceIdFromSession();
  if (!workspaceId)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const q = new URL(request.url).searchParams;
  const from = q.get("from") ?? shanghaiDateKey();
  try {
    return NextResponse.json(
      await readTaskTiming(getDb(), workspaceId, from, q.get("to") ?? from),
    );
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  const workspaceId = await getWorkspaceIdFromSession();
  if (!workspaceId)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = z
      .object({
        request: z.unknown(),
        idempotencyKey: z.string().min(1).max(180),
      })
      .strict()
      .parse(await readJsonBody(request));
    return NextResponse.json(
      await proposeTaskTiming(
        getDb(),
        workspaceId,
        body.request,
        body.idempotencyKey,
      ),
    );
  } catch (e) {
    return failure(e);
  }
}
export async function PATCH(request: Request) {
  const workspaceId = await getWorkspaceIdFromSession();
  if (!workspaceId)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = z
      .object({ approvalId: z.string().uuid() })
      .strict()
      .parse(await readJsonBody(request));
    return NextResponse.json(
      await applyTaskTiming(getDb(), workspaceId, body.approvalId),
    );
  } catch (e) {
    return failure(e);
  }
}
