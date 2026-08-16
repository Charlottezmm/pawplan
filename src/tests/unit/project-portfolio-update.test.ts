import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { approvalPreviewHash } from "@/lib/approvals/service";
import {
  applyProjectPortfolioUpdate,
  proposeProjectPortfolioUpdate,
} from "@/lib/mcp/project-portfolio-update";
import {
  createProjectPortfolioPreviewToken,
  projectPortfolioHash,
  verifyProjectPortfolioPreviewToken,
} from "@/lib/mcp/project-portfolio-update-token";

type Row = Record<string, any>;

function createDb() {
  const state = {
    plans: [{
      id: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      title: "Active plan",
      startDate: new Date("2026-08-01T00:00:00.000+08:00"),
      endDate: new Date("2026-12-31T00:00:00.000+08:00"),
      currentVersionId: null,
      baselineSnapshot: {},
      status: "active",
    }],
    projects: [] as Row[],
    milestones: [] as Row[],
    approvals: [] as Row[],
    operations: [] as Row[],
    changeLogs: [] as Row[],
    touchedTables: [] as string[],
    beforeOperationLeaseLock: null as null | ((operation: Row) => void),
  };
  const tableName = (table: unknown) => getTableName(table as Parameters<typeof getTableName>[0]);
  const rowsFor = (name: string): Row[] => name === "plans"
    ? state.plans
    : name === "projects"
      ? state.projects
      : name === "project_milestones"
        ? state.milestones
        : name === "operation_approvals"
          ? state.approvals
          : name === "plan_operations"
            ? state.operations
            : [];
  function query(rows: Row[], name?: string) {
    const value = {
      orderBy: () => value,
      limit: (count: number) => {
        const limited = query(rows.slice(0, count), name);
        return limited;
      },
      for: () => {
        if (name === "plan_operations" && state.beforeOperationLeaseLock && rows[0]) {
          const hook = state.beforeOperationLeaseLock;
          state.beforeOperationLeaseLock = null;
          hook(rows[0]);
        }
        return Promise.resolve(rows);
      },
      then: (resolve: (rows: Row[]) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject),
    };
    return value;
  }
  const client = {
    select() {
      return { from(table: unknown) { const name = tableName(table); return { where() { return query(rowsFor(name), name); } }; } };
    },
    insert(table: unknown) {
      const name = tableName(table);
      return {
        values(values: Row) {
          return {
            onConflictDoNothing() {
              return {
                returning() {
                  const existing = state.operations.find((row) => row.idempotencyKey === values.idempotencyKey);
                  if (existing) return Promise.resolve([]);
                  const row = { id: `operation-${state.operations.length + 1}`, ...values };
                  state.operations.push(row);
                  state.touchedTables.push(name);
                  return Promise.resolve([row]);
                },
              };
            },
            returning() {
              const row = {
                id: `${name}-${rowsFor(name).length + 1}`,
                createdAt: new Date("2026-08-16T01:00:00.000Z"),
                updatedAt: values.updatedAt ?? new Date("2026-08-16T01:00:00.000Z"),
                ...values,
              };
              rowsFor(name).push(row);
              state.touchedTables.push(name);
              return Promise.resolve([row]);
            },
            then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
              if (name === "change_logs") state.changeLogs.push(values);
              state.touchedTables.push(name);
              return Promise.resolve(undefined).then(resolve, reject);
            },
          };
        },
      };
    },
    update(table: unknown) {
      const name = tableName(table);
      return {
        set(values: Row) {
          return {
            where() {
              const rows = rowsFor(name);
              if (name === "operation_approvals") Object.assign(rows.at(-1) ?? {}, values);
              else if (name === "plan_operations") Object.assign(rows.at(-1) ?? {}, values);
              else for (const row of rows) Object.assign(row, values);
              state.touchedTables.push(name);
              return { returning: () => Promise.resolve(rows.length ? [{ id: rows.at(-1)!.id }] : []) };
            },
          };
        },
      };
    },
    transaction<T>(callback: (tx: any) => Promise<T>) { return callback(client); },
  };
  return { ...client, state };
}

const workspaceId = "22222222-2222-4222-8222-222222222222";
const createUpdate = {
  projects: [{
    action: "create" as const,
    clientKey: "research",
    name: "Embodied AI Research",
    color: "#2563eb",
    category: "科研",
    objective: "Build a physics-grounded manipulation model",
    successCriteria: "Validated experiment and paper draft",
    status: "active" as const,
    priority: "high" as const,
    startDate: "2026-08-16",
    targetDate: "2026-12-20",
    weeklyTargetMinutes: 600,
  }],
  milestones: [{
    action: "create" as const,
    clientKey: "baseline",
    projectClientKey: "research",
    title: "Reproduce baseline",
    objective: "Run the reference pipeline",
    successCriteria: "Metrics reproduced",
    targetDate: "2026-09-15",
    status: "planned" as const,
    position: 0,
  }],
};

describe("AI-first Project Portfolio updates", () => {
  it("signs an expiring workspace- and request-bound Preview token", () => {
    process.env.APP_SECRET = "project-portfolio-test-secret";
    const now = new Date("2026-08-16T00:00:00.000Z");
    const created = createProjectPortfolioPreviewToken({
      workspaceId,
      planId: "plan-1",
      requestHash: projectPortfolioHash(createUpdate),
      snapshotHash: projectPortfolioHash({ projects: [], milestones: [] }),
      now,
    });

    expect(verifyProjectPortfolioPreviewToken({
      token: created.token,
      workspaceId,
      requestHash: projectPortfolioHash(createUpdate),
      now,
    }).ok).toBe(true);
    expect(verifyProjectPortfolioPreviewToken({
      token: `${created.token}tampered`,
      workspaceId,
      requestHash: projectPortfolioHash(createUpdate),
      now,
    })).toMatchObject({ ok: false, code: "preview_invalid" });
  });

  it("creates only a pending approval during propose, then atomically writes exact rows after approval", async () => {
    process.env.APP_SECRET = "project-portfolio-test-secret";
    const db = createDb();
    const now = new Date("2026-08-16T01:00:00.000Z");
    const preview = await proposeProjectPortfolioUpdate(db as any, {
      workspaceId,
      update: createUpdate,
      reason: "Define the research Project before planning tasks",
      now,
    });

    expect(preview).toMatchObject({ status: "pending_review", liveUnchanged: true });
    expect(db.state.projects).toEqual([]);
    expect(db.state.milestones).toEqual([]);
    expect(db.state.approvals[0]).toMatchObject({
      status: "pending",
      operationKind: "project_portfolio_update",
      previewHash: approvalPreviewHash(preview.previewToken),
    });

    Object.assign(db.state.approvals[0], { status: "approved", approvedAt: now });
    const applied = await applyProjectPortfolioUpdate(db as any, {
      workspaceId,
      update: createUpdate,
      previewToken: preview.previewToken,
      approvalId: preview.approvalId,
      idempotencyKey: "portfolio-create-1",
      now,
    });

    expect(applied).toMatchObject({
      status: "succeeded",
      createdProjectIds: ["projects-1"],
      createdMilestoneIds: ["project_milestones-1"],
      projectClientIds: { research: "projects-1" },
      milestoneClientIds: { baseline: "project_milestones-1" },
      readback: { verification: "succeeded" },
    });
    expect(db.state.milestones[0].projectId).toBe("projects-1");
    expect(db.state.approvals[0].status).toBe("consumed");
    expect(db.state.changeLogs).toHaveLength(1);
    expect(db.state.touchedTables).not.toContain("tasks");

    const duplicate = await applyProjectPortfolioUpdate(db as any, {
      workspaceId,
      update: createUpdate,
      previewToken: preview.previewToken,
      approvalId: preview.approvalId,
      idempotencyKey: "portfolio-create-1",
      now,
    });
    expect(duplicate).toMatchObject({ status: "duplicate", originalStatus: "succeeded" });
    expect(db.state.projects).toHaveLength(1);
    expect(db.state.milestones).toHaveLength(1);
  });

  it("rejects an incomplete active Project before creating approval or live rows", async () => {
    process.env.APP_SECRET = "project-portfolio-test-secret";
    const db = createDb();
    await expect(proposeProjectPortfolioUpdate(db as any, {
      workspaceId,
      update: {
        projects: [{ ...createUpdate.projects[0], objective: null }],
        milestones: [],
      },
    })).rejects.toMatchObject({ code: "invalid_project_update" });
    expect(db.state.approvals).toEqual([]);
    expect(db.state.projects).toEqual([]);
  });

  it("does not claim idempotency or write live rows before user approval", async () => {
    process.env.APP_SECRET = "project-portfolio-test-secret";
    const db = createDb();
    const preview = await proposeProjectPortfolioUpdate(db as any, {
      workspaceId,
      update: createUpdate,
    });

    await expect(applyProjectPortfolioUpdate(db as any, {
      workspaceId,
      update: createUpdate,
      previewToken: preview.previewToken,
      approvalId: preview.approvalId,
      idempotencyKey: "portfolio-not-approved-1",
    })).rejects.toMatchObject({ code: "approval_not_approved" });

    expect(db.state.operations).toEqual([]);
    expect(db.state.projects).toEqual([]);
    expect(db.state.milestones).toEqual([]);
  });

  it("fences an expired old worker after a new worker reclaims the operation lease", async () => {
    process.env.APP_SECRET = "project-portfolio-test-secret";
    const db = createDb();
    const now = new Date("2026-08-16T01:00:00.000Z");
    const preview = await proposeProjectPortfolioUpdate(db as any, {
      workspaceId,
      update: createUpdate,
      now,
    });
    Object.assign(db.state.approvals[0], { status: "approved", approvedAt: now });

    const reclaimedLease = new Date("2026-08-16T01:11:00.000Z");
    db.state.beforeOperationLeaseLock = (operation) => {
      expect(operation.leaseExpiresAt).toEqual(new Date("2026-08-16T01:05:00.000Z"));
      operation.leaseExpiresAt = reclaimedLease;
      operation.updatedAt = new Date("2026-08-16T01:06:00.000Z");
    };

    await expect(applyProjectPortfolioUpdate(db as any, {
      workspaceId,
      update: createUpdate,
      previewToken: preview.previewToken,
      approvalId: preview.approvalId,
      idempotencyKey: "portfolio-lease-race-1",
      now,
    })).rejects.toMatchObject({ code: "operation_lease_lost" });

    expect(db.state.projects).toEqual([]);
    expect(db.state.milestones).toEqual([]);
    expect(db.state.approvals[0].status).toBe("approved");
    expect(db.state.operations[0]).toMatchObject({
      status: "started",
      leaseExpiresAt: reclaimedLease,
    });
  });

  it("requires expected_updated_at and returns the actual updated Project ID", async () => {
    process.env.APP_SECRET = "project-portfolio-test-secret";
    const db = createDb();
    const updatedAt = new Date("2026-08-15T01:00:00.000Z");
    db.state.projects.push({
      id: "33333333-3333-4333-8333-333333333333",
      workspaceId,
      name: "Research",
      color: "#2563eb",
      category: "科研",
      objective: "Old objective",
      successCriteria: "Validated experiment",
      status: "active",
      priority: "high",
      startDate: null,
      targetDate: null,
      weeklyTargetMinutes: 600,
      needsDefinition: false,
      createdAt: updatedAt,
      updatedAt,
    });
    const update = {
      projects: [{
        action: "update" as const,
        projectId: "33333333-3333-4333-8333-333333333333",
        expectedUpdatedAt: updatedAt.toISOString(),
        changes: { objective: "New exact objective" },
      }],
      milestones: [],
    };
    const preview = await proposeProjectPortfolioUpdate(db as any, { workspaceId, update });
    Object.assign(db.state.approvals[0], { status: "approved" });
    const result = await applyProjectPortfolioUpdate(db as any, {
      workspaceId,
      update,
      previewToken: preview.previewToken,
      approvalId: preview.approvalId,
      idempotencyKey: "portfolio-update-1",
    });

    expect(result).toMatchObject({
      status: "succeeded",
      updatedProjectIds: ["33333333-3333-4333-8333-333333333333"],
      readback: { verification: "succeeded" },
    });
    expect(db.state.projects[0].objective).toBe("New exact objective");
  });
});
