import { NextResponse } from "next/server";
import { z } from "zod";
import { getWorkspaceIdFromSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { createImportPreviewToken } from "@/lib/imports/preview-token";
import {
  buildTimetableImportPreview,
  materializeTimetableRows,
  timetableBlockFingerprint,
} from "@/lib/imports/timetable-save";
import { inspectTimetableImportConflicts } from "@/lib/mcp/timetable-import";
import { readJsonBody } from "@/lib/validation/common";

const bodySchema = z.object({
  csv: z.string().min(1).max(200_000),
});

export async function POST(request: Request) {
  const workspaceId = await getWorkspaceIdFromSession();
  if (!workspaceId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await readJsonBody(request));
  if (!parsed.success) {
    return NextResponse.json({ error: "timetable.csv 内容无效" }, { status: 400 });
  }

  try {
    const preview = buildTimetableImportPreview(parsed.data.csv);
    const blocks = materializeTimetableRows(preview.rows);
    let inspection: Awaited<ReturnType<typeof inspectTimetableImportConflicts>>;
    try {
      inspection = await inspectTimetableImportConflicts(getDb(), {
        workspaceId,
        blocks,
      });
    } catch {
      return NextResponse.json(
        { error: "暂时无法检查现有日程冲突，请稍后重试" },
        { status: 503 },
      );
    }
    const seen = new Set<string>();
    const rowStatuses = blocks.map((block, index) => {
      const fingerprint = timetableBlockFingerprint(block);
      if (seen.has(fingerprint)) {
        return { index, status: "duplicate" as const, reason: "与本次导入中的前一行重复，将跳过" };
      }
      seen.add(fingerprint);
      if (inspection.existingFingerprints.has(fingerprint)) {
        return { index, status: "existing" as const, reason: "日程已存在，将跳过" };
      }
      if (preview.conflictRowIndexes.includes(index)) {
        return { index, status: "conflict" as const, reason: "与本次导入的其他日程时间重叠" };
      }
      if (inspection.conflictFingerprints.has(fingerprint)) {
        return { index, status: "conflict" as const, reason: "与现有日程时间重叠" };
      }
      return { index, status: "new" as const, reason: "将新增" };
    });
    return NextResponse.json({
      preview: {
        ...preview,
        conflicts: [...preview.conflicts, ...inspection.conflicts],
        rowStatuses,
        newCount: rowStatuses.filter((row) => row.status === "new" || row.status === "conflict").length,
        existingCount: rowStatuses.filter((row) => row.status === "existing" || row.status === "duplicate").length,
        conflictCount: rowStatuses.filter((row) => row.status === "conflict").length,
      },
      previewToken: createImportPreviewToken({
        kind: "timetable",
        workspaceId,
        content: parsed.data.csv,
      }),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "timetable.csv 内容无效" },
      { status: 400 },
    );
  }
}
