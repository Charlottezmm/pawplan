import { NextResponse } from "next/server";
import { z } from "zod";
import { getWorkspaceIdFromSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { ImportSaveError } from "@/lib/imports/plan-save";
import { verifyImportPreviewToken } from "@/lib/imports/preview-token";
import { buildTimetableImportPreview, materializeTimetableRows, saveTimetableImport } from "@/lib/imports/timetable-save";
import { inspectTimetableImportConflicts } from "@/lib/mcp/timetable-import";
import { readJsonBody } from "@/lib/validation/common";

const bodySchema = z.object({
  csv: z.string().min(1).max(200_000),
  confirmation: z.string().optional(),
  previewToken: z.string().optional(),
  allowConflicts: z.boolean().optional().default(false),
});

export async function POST(request: Request) {
  const workspaceId = await getWorkspaceIdFromSession();
  if (!workspaceId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await readJsonBody(request));
  if (!parsed.success) {
    return NextResponse.json({ error: "timetable.csv 内容无效" }, { status: 400 });
  }
  if (parsed.data.confirmation !== "CONFIRM_TIMETABLE_IMPORT") {
    return NextResponse.json({ error: "Timetable import confirmation required" }, { status: 400 });
  }
  const tokenResult = verifyImportPreviewToken({
    token: parsed.data.previewToken,
    kind: "timetable",
    workspaceId,
    content: parsed.data.csv,
  });
  if (!tokenResult.ok) {
    return NextResponse.json({ error: tokenResult.reason }, { status: 400 });
  }

  try {
    const db = getDb();
    const preview = buildTimetableImportPreview(parsed.data.csv);
    let inspection: Awaited<ReturnType<typeof inspectTimetableImportConflicts>>;
    try {
      inspection = await inspectTimetableImportConflicts(db, {
        workspaceId,
        blocks: materializeTimetableRows(preview.rows),
      });
    } catch {
      return NextResponse.json({ error: "暂时无法检查现有日程冲突，请稍后重试" }, { status: 503 });
    }
    const conflicts = [...preview.conflicts, ...inspection.conflicts];
    if (conflicts.length > 0 && !parsed.data.allowConflicts) {
      return NextResponse.json(
        {
          error: "时间冲突需要明确确认",
          code: "timetable_conflict_confirmation_required",
          conflicts,
        },
        { status: 409 },
      );
    }
    const result = await saveTimetableImport(db, {
      workspaceId,
      csv: parsed.data.csv,
      confirmation: parsed.data.confirmation,
    });
    return NextResponse.json({
      result,
      message: result.status === "no_change"
        ? "没有新增日程；所有时间块都已存在。"
        : `已保存 ${result.blocksCreated} 个时间块，并跳过 ${result.blocksExisting} 个重复项。`,
    });
  } catch (error) {
    if (error instanceof ImportSaveError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
