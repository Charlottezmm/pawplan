import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { getWorkspaceIdFromSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { runPawPlanTool } from "@/lib/mcp/tools";
import { TimelineError } from "@/lib/planning/daily-timeline";
import { readJsonBody } from "@/lib/validation/common";

// POST carries a potentially large preview request. This endpoint never writes.
export async function POST(request: Request) {
  const workspaceId = await getWorkspaceIdFromSession();
  if (!workspaceId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(await runPawPlanTool(getDb(), workspaceId, "get_daily_timeline", await readJsonBody(request), "read_only"));
  } catch (error) {
    if (error instanceof TimelineError) return NextResponse.json({ error: error.message, code: error.code }, { status: 409 });
    if (error instanceof ZodError) return NextResponse.json({ error: "Invalid timeline request", details: error.flatten() }, { status: 400 });
    return NextResponse.json({ error: "Unable to load live timeline; no changes saved" }, { status: 500 });
  }
}
