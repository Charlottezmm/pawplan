import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ session: vi.fn(), run: vi.fn(), db: {} }));
vi.mock("@/lib/auth/session", () => ({ getWorkspaceIdFromSession: mocks.session }));
vi.mock("@/lib/db/client", () => ({ getDb: () => mocks.db }));
vi.mock("@/lib/mcp/tools", () => ({ runPawPlanTool: mocks.run }));
import { POST } from "@/app/api/assistant/route";
function request(body: unknown, origin = "https://pawplan.test") { return new Request("https://pawplan.test/api/assistant", { method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
describe("session-owned assistant API", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.session.mockResolvedValue("owned-workspace"); mocks.run.mockResolvedValue({ liveUnchanged: true }); });
  it("requires a signed-in workspace and same origin", async () => {
    mocks.session.mockResolvedValueOnce(null);
    expect((await POST(request({}))).status).toBe(401);
    expect((await POST(request({}, "https://other.test"))).status).toBe(403);
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("limits operations and rejects client workspace overrides", async () => {
    for (const body of [{ tool: "update_task_schedule", arguments: {} }, { tool: "get_continuation", arguments: {}, workspaceId: "other" }]) expect((await POST(request(body))).status).toBe(400);
    expect(mocks.run).not.toHaveBeenCalled();
    expect((await POST(request({ tool: "get_continuation", arguments: {} }))).status).toBe(200);
    expect(mocks.run).toHaveBeenCalledWith(mocks.db, "owned-workspace", "get_continuation", {}, "read_write");
  });
  it("binds to the HTTP Host when Next uses an internal hostname and rejects other origins", async () => {
    const body=JSON.stringify({tool:"get_continuation",arguments:{}});
    const local=(origin:string)=>new Request("http://localhost:3104/api/assistant",{method:"POST",headers:{host:"127.0.0.1:3104",origin,"Content-Type":"application/json"},body});
    expect((await POST(local("http://127.0.0.1:3104"))).status).toBe(200);
    for(const origin of ["http://localhost:3104","http://other.test","null",""]) expect((await POST(local(origin))).status).toBe(403);
  });
});
