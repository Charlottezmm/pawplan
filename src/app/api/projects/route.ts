import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getWorkspaceIdFromSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { projects } from "@/lib/db/schema";
import { readJsonBody } from "@/lib/validation/common";

const nullableText = (max: number) => z.union([z.string().trim().min(1).max(max), z.null()]);
const nullableDate = z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()]);

const projectUpdateSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  category: nullableText(80),
  objective: nullableText(4000),
  successCriteria: nullableText(4000),
  status: z.enum(["active", "paused", "completed", "archived"]),
  priority: z.enum(["low", "normal", "high", "urgent"]),
  startDate: nullableDate,
  targetDate: nullableDate,
  weeklyTargetMinutes: z.number().int().min(0).max(10080).nullable(),
});
const projectCreateSchema = projectUpdateSchema.omit({ id: true });

function dateFromKey(value: string | null) {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00.000+08:00`);
  if (Number.isNaN(date.getTime())) return undefined;
  const normalized = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  return normalized === value ? date : undefined;
}

function validatedProjectValues(input: z.infer<typeof projectCreateSchema>) {
  if (input.status === "active" && (!input.category || !input.objective || !input.successCriteria)) {
    return { error: "Active projects require category, objective, and success criteria" } as const;
  }
  const startDate = dateFromKey(input.startDate);
  const targetDate = dateFromKey(input.targetDate);
  if (startDate === undefined || targetDate === undefined) return { error: "Invalid project date" } as const;
  if (startDate && targetDate && targetDate < startDate) {
    return { error: "Target date cannot be before start date" } as const;
  }
  return {
    values: {
      name: input.name,
      category: input.category,
      objective: input.objective,
      successCriteria: input.successCriteria,
      status: input.status,
      priority: input.priority,
      startDate,
      targetDate,
      weeklyTargetMinutes: input.weeklyTargetMinutes,
      needsDefinition: !input.category || !input.objective || !input.successCriteria,
      updatedAt: new Date(),
    },
  } as const;
}

export async function POST(request: Request) {
  const workspaceId = await getWorkspaceIdFromSession();
  if (!workspaceId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = projectCreateSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) return NextResponse.json({ error: "Invalid project" }, { status: 400 });
  const validated = validatedProjectValues(parsed.data);
  if ("error" in validated) return NextResponse.json({ error: validated.error }, { status: 400 });

  const db = getDb();
  const [project] = await db
    .insert(projects)
    .values({ workspaceId, ...validated.values })
    .returning();
  return NextResponse.json({ project }, { status: 201 });
}

export async function PATCH(request: Request) {
  const workspaceId = await getWorkspaceIdFromSession();
  if (!workspaceId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = projectUpdateSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) return NextResponse.json({ error: "Invalid project update" }, { status: 400 });

  const input = parsed.data;
  const validated = validatedProjectValues(input);
  if ("error" in validated) return NextResponse.json({ error: validated.error }, { status: 400 });

  const db = getDb();
  const [project] = await db
    .update(projects)
    .set(validated.values)
    .where(and(eq(projects.id, input.id), eq(projects.workspaceId, workspaceId)))
    .returning();

  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  return NextResponse.json({ project });
}
