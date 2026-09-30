import { z } from "zod";
import { getWorkspaceIdFromSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { runPawPlanTool } from "@/lib/mcp/tools";
import { AssistantError, assistantToolSchemas } from "@/lib/assistant/schema";
import { readJsonBody } from "@/lib/validation/common";

export const dynamic = "force-dynamic";
const requestSchema = z.object({
  tool: z.enum(Object.keys(assistantToolSchemas) as [keyof typeof assistantToolSchemas, ...Array<keyof typeof assistantToolSchemas>]),
  arguments: z.unknown(),
}).strict();

// Same-origin, session-owned companion API. Remote assistants use bearer/OAuth /api/mcp.
export async function POST(request: Request) {
  const workspaceId = await getWorkspaceIdFromSession();
  if (!workspaceId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  // Next may construct request.url with its internal hostname. Bind Origin to
  // the actual HTTP Host, preserving the same-origin boundary behind that adapter.
  const requestUrl = new URL(request.url);
  const requestOrigin = `${requestUrl.protocol}//${request.headers.get("host") ?? requestUrl.host}`;
  if (request.headers.get("origin") !== requestOrigin) return Response.json({ error: "Same-origin request required" }, { status: 403 });
  const parsed = requestSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) return Response.json({ error: "Invalid assistant request" }, { status: 400 });
  try {
    return Response.json(await runPawPlanTool(getDb(), workspaceId, parsed.data.tool, parsed.data.arguments, "read_write"));
  } catch (error) {
    if (error instanceof AssistantError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    if (error instanceof z.ZodError) return Response.json({ error: "invalid_arguments", issues: error.issues }, { status: 400 });
    return Response.json({ error: "Assistant request failed" }, { status: 500 });
  }
}
