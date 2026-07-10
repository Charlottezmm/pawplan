import { NextResponse } from "next/server";
import { z } from "zod";
import { getWorkspaceIdFromSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { PatchApplyError, rejectReviewPatches } from "@/lib/planning/service";
import { readJsonBody } from "@/lib/validation/common";

const rejectAllBodySchema = z
  .object({
    patchIds: z.array(z.string().uuid()).min(1).max(1000),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.patchIds).size !== value.patchIds.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Patch ids must be unique", path: ["patchIds"] });
    }
  });

export async function POST(request: Request) {
  const workspaceId = await getWorkspaceIdFromSession();
  if (!workspaceId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = rejectAllBodySchema.safeParse(await readJsonBody(request));
  if (!parsed.success) {
    return NextResponse.json({ error: "Select between 1 and 1000 Review drafts to reject" }, { status: 400 });
  }

  try {
    const result = await rejectReviewPatches(getDb(), {
      workspaceId,
      patchIds: parsed.data.patchIds,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof PatchApplyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Failed to reject Review drafts" }, { status: 500 });
  }
}
