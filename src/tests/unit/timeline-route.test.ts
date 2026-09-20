import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { TimelineError } from "@/lib/planning/daily-timeline";
const mocks = vi.hoisted(() => ({ session: vi.fn(), run: vi.fn(), db: { readOnlyMarker: true } }));
vi.mock("@/lib/auth/session", () => ({ getWorkspaceIdFromSession: mocks.session }));
vi.mock("@/lib/db/client", () => ({ getDb: () => mocks.db }));
vi.mock("@/lib/mcp/tools", () => ({ runPawPlanTool: mocks.run }));
import { POST } from "@/app/api/timeline/route";
const request = () => new Request("https://pawplan.test/api/timeline", { method: "POST", body: JSON.stringify({ date: "2026-09-20", workspaceId: "attacker-supplied" }) });
describe("timeline preview route", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.session.mockResolvedValue("session-workspace"); mocks.run.mockResolvedValue({ persisted: false }); });
  it("requires a session before reading", async () => {
    mocks.session.mockResolvedValue(null); expect((await POST(request())).status).toBe(401); expect(mocks.run).not.toHaveBeenCalled();
  });
  it("uses the session workspace and read-only tool permission", async () => {
    expect((await POST(request())).status).toBe(200);
    expect(mocks.run).toHaveBeenCalledWith(mocks.db, "session-workspace", "get_daily_timeline", expect.anything(), "read_only");
  });
  it("returns an actionable stale response without applying anything", async () => {
    mocks.run.mockRejectedValue(new TimelineError("snapshot_stale", "Reload live state"));
    const response = await POST(request()); expect(response.status).toBe(409); expect(await response.json()).toEqual({ code: "snapshot_stale", error: "Reload live state" });
  });
  it("separates invalid requests from unavailable live data", async () => {
    mocks.run.mockRejectedValue(new ZodError([])); expect((await POST(request())).status).toBe(400);
    mocks.run.mockRejectedValue(new Error("private database details")); const response = await POST(request()); expect(response.status).toBe(500); expect(JSON.stringify(await response.json())).not.toContain("private database details");
  });
});
