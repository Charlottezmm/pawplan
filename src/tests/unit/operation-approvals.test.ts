import { describe, expect, it } from "vitest";
import {
  approvalPreviewHash,
  consumeOperationApproval,
  createOperationApproval,
  OperationApprovalError,
  verifyOperationApproval,
} from "@/lib/approvals/service";

function selectDb(rows: Array<Record<string, unknown>>, onUpdate?: (values: Record<string, unknown>) => void) {
  return {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                orderBy() {
                  return { limit: () => Promise.resolve(rows.slice(0, 1)) };
                },
                limit() {
                  return {
                    for: () => Promise.resolve(rows.slice(0, 1)),
                    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
                      Promise.resolve(rows.slice(0, 1)).then(resolve, reject),
                  };
                },
              };
            },
          };
        },
      };
    },
    update() {
      return {
        set(values: Record<string, unknown>) {
          onUpdate?.(values);
          return { where: () => ({ returning: () => Promise.resolve([{ id: rows[0]?.id }]) }) };
        },
      };
    },
  };
}

describe("operation approval service", () => {
  const now = new Date("2026-08-16T00:00:00.000Z");
  const previewToken = "signed-preview-token";
  const approved = {
    id: "approval-1",
    workspaceId: "workspace-1",
    operationKind: "archive_tasks_batch",
    requestHash: "request-hash",
    previewHash: approvalPreviewHash(previewToken),
    status: "approved",
    expiresAt: new Date("2026-08-16T01:00:00.000Z"),
  };

  it("creates a pending record that stores only the preview hash", async () => {
    let inserted: Record<string, unknown> | undefined;
    const db = {
      ...selectDb([]),
      insert() {
        return {
          values(values: Record<string, unknown>) {
            inserted = values;
            return { returning: () => Promise.resolve([{ id: "approval-1", ...values }]) };
          },
        };
      },
    };

    const result = await createOperationApproval(db, {
      workspaceId: "workspace-1",
      operationKind: "archive_tasks_batch",
      requestHash: "request-hash",
      previewToken,
      summary: { count: 2, totalMinutes: 90, items: ["A", "B"] },
      expiresAt: new Date("2026-08-16T01:00:00.000Z"),
    });

    expect(result.status).toBe("pending");
    expect(inserted).toMatchObject({ previewHash: approvalPreviewHash(previewToken) });
    expect(inserted).not.toHaveProperty("previewToken");
  });

  it("rejects pending and mismatched approvals during read-only preflight", async () => {
    await expect(verifyOperationApproval(selectDb([{ ...approved, status: "pending" }]), {
      workspaceId: "workspace-1",
      approvalId: approved.id,
      operationKind: approved.operationKind,
      requestHash: approved.requestHash,
      previewToken,
      now,
    })).rejects.toMatchObject({ code: "approval_not_approved" } satisfies Partial<OperationApprovalError>);

    await expect(verifyOperationApproval(selectDb([approved]), {
      workspaceId: "workspace-1",
      approvalId: approved.id,
      operationKind: approved.operationKind,
      requestHash: "different-request",
      previewToken,
      now,
    })).rejects.toMatchObject({ code: "approval_mismatch" } satisfies Partial<OperationApprovalError>);
  });

  it("locks and consumes an exact approved credential once", async () => {
    let update: Record<string, unknown> | undefined;
    await consumeOperationApproval(selectDb([approved], (values) => { update = values; }), {
      workspaceId: "workspace-1",
      approvalId: approved.id,
      operationKind: approved.operationKind,
      requestHash: approved.requestHash,
      previewToken,
      now,
    });

    expect(update).toMatchObject({ status: "consumed", consumedAt: now });
  });
});
