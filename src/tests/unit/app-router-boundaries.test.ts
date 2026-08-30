import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const loadingSource = readFileSync("src/app/(app)/loading.tsx", "utf8");
const errorSource = readFileSync("src/app/(app)/error.tsx", "utf8");
const notFoundSource = readFileSync("src/app/not-found.tsx", "utf8");

describe("App Router boundaries", () => {
  it("provides a non-destructive application loading state", () => {
    expect(loadingSource).toContain('role="status"');
    expect(loadingSource).toContain('aria-busy="true"');
    expect(loadingSource).toContain("正在打开这一页");
    expect(loadingSource).toContain("不会修改你的计划");
    expect(loadingSource).toContain('<CatIcon mood="think"');
    expect(loadingSource).not.toMatch(/\d+\s*(条|件|分钟|小时)/);
  });

  it("keeps the error boundary client-side and offers recovery actions", () => {
    expect(errorSource.startsWith('"use client";')).toBe(true);
    expect(errorSource).toContain('onClick={reset}');
    expect(errorSource).toContain("再试一次");
    expect(errorSource).toContain('href="/today"');
    expect(errorSource).toContain("页面没有确认任何新的改动");
    expect(errorSource).toContain("核对最终状态");
    expect(errorSource).not.toContain("error.message");
  });

  it("provides a concise not-found state with a route back to Today", () => {
    expect(notFoundSource).toContain("这里没有这个页面");
    expect(notFoundSource).toContain('href="/today"');
    expect(notFoundSource).toContain("<EmptyState");
  });
});
