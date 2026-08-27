import { describe, expect, it } from "vitest";
import { readPendingReviewCount, sumPendingReviewCount } from "@/lib/planning/pending-review-count";

function fakeDb(results: unknown[][]) {
  return {
    select() {
      const rows = results.shift() ?? [];
      const query = {
        from() { return query; },
        where() { return query; },
        limit() { return Promise.resolve(rows); },
        then(resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) {
          return Promise.resolve(rows).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

describe("pending Review count", () => {
  it("adds actionable draft patches and unexpired pending approvals", () => {
    expect(sumPendingReviewCount([{ id: "patch-1" }, { id: "patch-2" }], [{ id: "approval-1" }])).toBe(3);
  });

  it("returns zero when no Review work exists", () => {
    expect(sumPendingReviewCount([], [])).toBe(0);
  });

  it("reads drafts from the active plan plus unexpired pending approvals", async () => {
    const db = fakeDb([
      [{ id: "active-plan" }],
      [{ id: "patch-1" }, { id: "patch-2" }],
      [{ id: "approval-1" }],
    ]);

    await expect(readPendingReviewCount(db as never, "workspace-1", new Date("2026-08-27T00:00:00Z"))).resolves.toBe(3);
  });

  it("does not count draft patches when there is no active plan", async () => {
    const db = fakeDb([
      [],
      [{ id: "approval-1" }],
    ]);

    await expect(readPendingReviewCount(db as never, "workspace-1", new Date("2026-08-27T00:00:00Z"))).resolves.toBe(1);
  });
});
