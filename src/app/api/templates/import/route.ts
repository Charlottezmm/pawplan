import { NextResponse } from "next/server";
import { getWorkspaceIdFromSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { importWorkspaceTemplate, TemplateImportError, templateImportRequestSchema } from "@/lib/templates/import";
import { readJsonBody } from "@/lib/validation/common";

function templateError(error: unknown) {
  if (error instanceof TemplateImportError) {
    return NextResponse.json(
      { error: error.message, code: error.code, details: error.details },
      { status: error.status },
    );
  }
  return NextResponse.json({ error: "Failed to import template" }, { status: 500 });
}

export async function POST(request: Request) {
  const workspaceId = await getWorkspaceIdFromSession();
  if (!workspaceId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = templateImportRequestSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) return NextResponse.json({ error: "Invalid template import request" }, { status: 400 });

  try {
    return NextResponse.json(await importWorkspaceTemplate(getDb(), workspaceId, parsed.data));
  } catch (error) {
    return templateError(error);
  }
}
