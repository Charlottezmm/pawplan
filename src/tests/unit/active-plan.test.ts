import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { plans } from "@/lib/db/schema";
import {
  ActivePlanError,
  getActivePlanId,
  resolveActivePlanContext,
} from "@/lib/planning/active-plan";

function createDb(rows: Array<Record<string, unknown>>) {
  return {
    select() {
      return {
        from(table: unknown) {
          expect(getTableName(table as Parameters<typeof getTableName>[0])).toBe("plans");
          return {
            where() {
              const result = {
                limit(count: number) {
                  const selected = rows.slice(0, count);
                  return {
                    for: () => Promise.resolve(selected),
                    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
                      Promise.resolve(selected).then(resolve, reject),
                  };
                },
              };
              return result;
            },
          };
        },
      };
    },
  };
}

function activePlan(id: string) {
  return {
    id,
    workspaceId: "workspace-1",
    title: "Long-term plan",
    startDate: new Date("2026-08-01T00:00:00.000+08:00"),
    endDate: new Date("2026-12-31T00:00:00.000+08:00"),
    currentVersionId: "version-1",
    baselineSnapshot: {},
  };
}

describe("active plan resolver", () => {
  it("returns the complete single active plan context and supports a row lock", async () => {
    const row = activePlan("plan-1");

    await expect(resolveActivePlanContext(createDb([row]), "workspace-1", { lock: true })).resolves.toEqual(row);
  });

  it("returns a structured missing error while the legacy id wrapper remains nullable", async () => {
    const db = createDb([]);

    await expect(resolveActivePlanContext(db, "workspace-1")).rejects.toMatchObject({
      code: "active_plan_missing",
      details: { workspaceId: "workspace-1" },
    });
    await expect(getActivePlanId(db, "workspace-1")).resolves.toBeNull();
  });

  it("never chooses arbitrarily when multiple active plans exist", async () => {
    const db = createDb([activePlan("plan-1"), activePlan("plan-2")]);

    await expect(resolveActivePlanContext(db, "workspace-1")).rejects.toEqual(
      expect.objectContaining<Partial<ActivePlanError>>({
        code: "active_plan_conflict",
        details: { workspaceId: "workspace-1", planIds: ["plan-1", "plan-2"] },
      }),
    );
    await expect(getActivePlanId(db, "workspace-1")).rejects.toMatchObject({ code: "active_plan_conflict" });
  });
});
