import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  createMcpToken,
  hashMcpToken,
  listMcpTokens,
  revokeMcpToken,
  verifyMcpBearerToken,
} from "@/lib/mcp/tokens";

function createFakeDb(options: { tokenRows?: Array<Record<string, unknown>> } = {}) {
  const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];
  const updates: Array<{ table: string; values: Record<string, unknown> }> = [];

  function tableName(table: unknown) {
    return getTableName(table as Parameters<typeof getTableName>[0]);
  }

  return {
    inserts,
    updates,
    select() {
      return {
        from() {
          return {
            where() {
              return {
                orderBy() {
                  return Promise.resolve(options.tokenRows ?? []);
                },
                limit(count: number) {
                  return Promise.resolve((options.tokenRows ?? []).slice(0, count));
                },
              };
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          inserts.push({ table: tableName(table), values });
          return {
            returning() {
              return Promise.resolve([{ id: "token-1", createdAt: new Date("2026-06-12T00:00:00.000Z"), ...values }]);
            },
          };
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where() {
              updates.push({ table: tableName(table), values });
              return {
                returning() {
                  return Promise.resolve([{ id: "token-1", ...values }]);
                },
              };
            },
          };
        },
      };
    },
  };
}

describe("MCP token service", () => {
  it("creates a raw token once and stores only a hash", async () => {
    const db = createFakeDb();

    const result = await createMcpToken(db, "workspace-1", {
      name: "Codex local",
      permission: "read_write",
      expiresInDays: null,
    });

    expect(result.rawToken).toMatch(/^pwp_live_/);
    expect(result.token).toEqual(expect.objectContaining({ name: "Codex local", permission: "read_write" }));
    expect(db.inserts[0]).toEqual(
      expect.objectContaining({
        table: "mcp_tokens",
        values: expect.objectContaining({
          workspaceId: "workspace-1",
          name: "Codex local",
          permission: "read_write",
          tokenHash: expect.any(String),
          expiresAt: null,
        }),
      }),
    );
    expect(JSON.stringify(db.inserts[0].values)).not.toContain(result.rawToken);
  });

  it("lists active tokens without token hashes", async () => {
    const db = createFakeDb({
      tokenRows: [
        {
          id: "token-1",
          workspaceId: "workspace-1",
          tokenHash: "secret-hash",
          name: "Codex local",
          permission: "read_only",
          expiresAt: null,
          revokedAt: null,
          createdAt: new Date("2026-06-12T00:00:00.000Z"),
        },
      ],
    });

    const result = await listMcpTokens(db, "workspace-1");

    expect(result).toEqual([
      {
        id: "token-1",
        name: "Codex local",
        permission: "read_only",
        expiresAt: null,
        revokedAt: null,
        createdAt: "2026-06-12T00:00:00.000Z",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("secret-hash");
  });

  it("revokes workspace-scoped tokens", async () => {
    const db = createFakeDb();

    await revokeMcpToken(db, "workspace-1", "token-1");

    expect(db.updates[0]).toEqual(
      expect.objectContaining({
        table: "mcp_tokens",
        values: expect.objectContaining({ revokedAt: expect.any(Date) }),
      }),
    );
  });

  it("verifies a bearer token against non-revoked rows", async () => {
    const created = await createMcpToken(createFakeDb(), "workspace-1", {
      name: "Codex local",
      permission: "read_write",
      expiresInDays: null,
    });
    const db = createFakeDb({
      tokenRows: [
        {
          id: "token-1",
          workspaceId: "workspace-1",
          tokenHash: hashMcpToken(created.rawToken),
          name: "Codex local",
          permission: "read_write",
          expiresAt: null,
          revokedAt: null,
          createdAt: new Date(),
        },
      ],
    });

    const result = await verifyMcpBearerToken(db, created.rawToken);

    expect(result).toEqual({ workspaceId: "workspace-1", permission: "read_write", tokenId: "token-1" });
  });

  it("creates and verifies review-only bearer tokens", async () => {
    const created = await createMcpToken(createFakeDb(), "workspace-1", {
      name: "Daily Review",
      permission: "review_only",
      expiresInDays: null,
    });
    const db = createFakeDb({
      tokenRows: [
        {
          id: "token-review",
          workspaceId: "workspace-1",
          tokenHash: hashMcpToken(created.rawToken),
          name: "Daily Review",
          permission: "review_only",
          expiresAt: null,
          revokedAt: null,
          createdAt: new Date(),
        },
      ],
    });

    await expect(verifyMcpBearerToken(db, created.rawToken)).resolves.toEqual({
      workspaceId: "workspace-1",
      permission: "review_only",
      tokenId: "token-review",
    });
  });
});
