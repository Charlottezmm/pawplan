import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/planning/active-plan", () => ({ getActivePlanId: vi.fn() }));

function values(value: unknown): unknown[] {
  if (!value || typeof value !== "object") return [];
  const chunks = (value as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(chunks)) return [];
  return chunks.flatMap((chunk) => {
    if (chunk && typeof chunk === "object" && "value" in chunk && "encoder" in chunk) {
      return [(chunk as { value: unknown }).value];
    }
    return values(chunk);
  });
}

function contains(value: unknown, expected: string, seen = new WeakSet<object>()): boolean {
  if (typeof value === "string") return value.includes(expected);
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((item) => contains(item, expected, seen));
}

describe("legacy skipped loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads only active-plan, non-archived legacy skipped tasks", async () => {
    const { getDb } = await import("@/lib/db/client");
    const { getActivePlanId } = await import("@/lib/planning/active-plan");
    const orderBy = vi.fn().mockResolvedValue([{
      id: "task-1",
      title: "Legacy task",
      date: new Date("2026-08-15T16:00:00.000Z"),
      estimatedMinutes: 30,
      projectId: "project-1",
      projectName: "Research",
      projectColor: "#2563eb",
    }]);
    const where = vi.fn(() => ({ orderBy }));
    const leftJoin = vi.fn(() => ({ where }));
    const from = vi.fn(() => ({ leftJoin }));
    const select = vi.fn(() => ({ from }));
    vi.mocked(getDb).mockReturnValue({ select } as never);
    vi.mocked(getActivePlanId).mockResolvedValue("plan-1");
    const { getLegacySkippedTasks } = await import("@/lib/planning/legacy-skipped");

    const result = await getLegacySkippedTasks("workspace-1");

    expect(result).toEqual({
      dataUnavailable: false,
      tasks: [{
        id: "task-1",
        title: "Legacy task",
        date: "2026-08-16",
        estimatedMinutes: 30,
        projectId: "project-1",
        projectName: "Research",
        projectColor: "#2563eb",
      }],
    });
    const predicate = (where.mock.calls as unknown[][])[0]?.[0];
    expect(values(predicate)).toEqual(["workspace-1", "plan-1", "skipped"]);
    expect(contains(predicate, "archived_at")).toBe(true);
  });
});
