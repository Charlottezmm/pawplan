import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({
  getWorkspaceIdFromSession: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  getDb: vi.fn(),
}));

function jsonRequest(url: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("import routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.APP_SECRET = "test-secret";
  });

  it("returns plan preview warnings without writing import data", async () => {
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    const { POST } = await import("@/app/api/imports/plan/route");

    const response = await POST(jsonRequest("http://localhost/api/imports/plan", {
      markdown: `Goal: ship PawPlan tomorrow

## Projects
- PawPlan Import: save imports by 2026-06-11
- PawPlan Import: verify imports by 2026-06-12
`,
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.preview).toEqual(
      expect.objectContaining({
        timezone: "Asia/Shanghai",
        warnings: ["Duplicate project name: PawPlan Import"],
        conflicts: ["Project PawPlan Import appears 2 times in this import"],
      }),
    );
    expect(body.previewToken).toEqual(expect.any(String));
    expect(vi.mocked(getDb)).not.toHaveBeenCalled();
  });

  it("requires save confirmation before opening a database connection", async () => {
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    const { POST: savePlan } = await import("@/app/api/imports/plan/save/route");
    const { POST: saveTimetable } = await import("@/app/api/imports/timetable/save/route");

    const planResponse = await savePlan(jsonRequest("http://localhost/api/imports/plan/save", {
      markdown: "Goal: ship PawPlan tomorrow",
    }));
    const timetableResponse = await saveTimetable(jsonRequest("http://localhost/api/imports/timetable/save", {
      csv: `title,kind,day_of_week,start_time,end_time,starts_on,ends_on,course,recurrence,notes
Deep Learning Lecture,course,Monday,09:00,11:00,2026-09-01,2026-09-14,Deep Learning,weekly,Room 204
`,
    }));

    expect(planResponse.status).toBe(400);
    expect(await planResponse.json()).toEqual({ error: "Plan import confirmation required" });
    expect(timetableResponse.status).toBe(400);
    expect(await timetableResponse.json()).toEqual({ error: "Timetable import confirmation required" });
    expect(vi.mocked(getDb)).not.toHaveBeenCalled();
  });

  it("rejects static save confirmation without a matching preview token before opening a database connection", async () => {
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    const { POST: savePlan } = await import("@/app/api/imports/plan/save/route");
    const { POST: saveTimetable } = await import("@/app/api/imports/timetable/save/route");

    const planResponse = await savePlan(jsonRequest("http://localhost/api/imports/plan/save", {
      markdown: "Goal: ship PawPlan tomorrow",
      confirmation: "CONFIRM_PLAN_IMPORT",
    }));
    const timetableResponse = await saveTimetable(jsonRequest("http://localhost/api/imports/timetable/save", {
      csv: `title,kind,day_of_week,start_time,end_time,starts_on,ends_on,course,recurrence,notes
Deep Learning Lecture,course,Monday,09:00,11:00,2026-09-01,2026-09-14,Deep Learning,weekly,Room 204
`,
      confirmation: "CONFIRM_TIMETABLE_IMPORT",
    }));

    expect(planResponse.status).toBe(400);
    expect(await planResponse.json()).toEqual({ error: "Import preview token required" });
    expect(timetableResponse.status).toBe(400);
    expect(await timetableResponse.json()).toEqual({ error: "Import preview token required" });
    expect(vi.mocked(getDb)).not.toHaveBeenCalled();
  });

  it("blocks timetable preview when existing conflict lookup is unavailable", async () => {
    const { getWorkspaceIdFromSession } = await import("@/lib/auth/session");
    const { getDb } = await import("@/lib/db/client");
    vi.mocked(getWorkspaceIdFromSession).mockResolvedValue("workspace-1");
    vi.mocked(getDb).mockImplementation(() => {
      throw new Error("DATABASE_URL is required");
    });
    const { POST } = await import("@/app/api/imports/timetable/route");

    const response = await POST(jsonRequest("http://localhost/api/imports/timetable", {
      csv: `title,kind,day_of_week,start_time,end_time,starts_on,ends_on,course,recurrence,notes
Deep Learning Lecture,course,Monday,09:00,11:00,2026-09-01,2026-09-14,Deep Learning,weekly,Room 204
`,
    }));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({ error: "暂时无法检查现有日程冲突，请稍后重试" });
  });
});
