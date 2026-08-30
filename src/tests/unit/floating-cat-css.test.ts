import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("mobile app shell", () => {
  it("uses four bottom destinations with a safe-area aware compact header", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    const mobileBlock = css.match(/@media \(max-width: 760px\) \{[\s\S]*?\.paw-page-header/s)?.[0] ?? "";
    const tabbarRule = mobileBlock.match(/\.mobile-tabbar \{[\s\S]*?\}/)?.[0] ?? "";
    const topnavRule = mobileBlock.match(/\.app-topnav-inner \{[\s\S]*?\}/)?.[0] ?? "";

    expect(tabbarRule).toContain("grid-template-columns: repeat(4, minmax(0, 1fr));");
    expect(tabbarRule).toContain("env(safe-area-inset-bottom, 0px)");
    expect(topnavRule).toContain("env(safe-area-inset-top, 0px)");
  });
});

describe("mobile form controls", () => {
  it("prevents native date and time inputs from overflowing constraint forms", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    const controlRule = css.match(/\.paw-textarea,\n\.paw-input \{[\s\S]*?\}/)?.[0] ?? "";
    const mobileBlock = css.match(/@media \(max-width: 760px\) \{[\s\S]*?\.paw-page-header/s)?.[0] ?? "";
    const mobileControlRule = mobileBlock.match(/\.paw-textarea,\n  \.paw-input,[\s\S]*?\}/)?.[0] ?? "";

    expect(controlRule).toContain("min-width: 0;");
    expect(mobileControlRule).toContain("max-width: 100%;");
  });
});

describe("agent run and review long text wrapping", () => {
  it("provides an anywhere-wrapping utility for long unbroken agent text", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    const rule = css.match(/\.paw-wrap-anywhere \{[\s\S]*?\}/)?.[0] ?? "";

    expect(rule).toContain("overflow-wrap: anywhere;");
    expect(rule).toContain("word-break: break-word;");
  });

  it("applies long-text wrapping to Task 5 agent observability copy", () => {
    const settingsView = readFileSync("src/components/settings-view.tsx", "utf8");
    const reviewPreview = readFileSync("src/components/reschedule-preview.tsx", "utf8");

    expect(settingsView).toContain('className="paw-row-meta paw-wrap-anywhere"');
    expect(settingsView).toContain('className="paw-row-meta paw-wrap-anywhere text-[var(--app-danger)]"');
    expect(reviewPreview).toContain('className="paw-suggestion-why paw-wrap-anywhere">{item.reason}</p>');
    expect(reviewPreview).toContain("<ReviewItemState");
    expect(reviewPreview).toContain("formatConflictSide(item.conflict.expected)");
  });
});

describe("Review queue bulk action styling", () => {
  it("keeps the destructive action compact and visually secondary", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    const reviewPreview = readFileSync("src/components/reschedule-preview.tsx", "utf8");
    const rule = css.match(/\.paw-review-clear-btn \{[\s\S]*?\}/)?.[0] ?? "";

    expect(rule).toContain("display: inline-flex;");
    expect(rule).toContain("border-radius: 999px;");
    expect(rule).toContain("background: transparent;");
    expect(rule).toContain("font-size: 13px;");
    expect(rule).toContain("white-space: nowrap;");
    expect(reviewPreview).toContain('aria-label="清空全部待审核建议"');
    expect(reviewPreview).toContain('pendingAction === "bulk-reject" ? "清空中…" : "清空建议"');
  });
});

describe("Today task detail copyability", () => {
  it("keeps expanded task notes and resource sections selectable", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    const detailRule = css.match(/\.paw-task-detail \{[\s\S]*?\}/)?.[0] ?? "";
    const notesRule = css.match(/\.paw-task-detail-raw \{[\s\S]*?\}/)?.[0] ?? "";

    expect(detailRule).toContain("user-select: text;");
    expect(detailRule).toContain("-webkit-user-select: text;");
    expect(notesRule).toContain("cursor: text;");
  });
});

describe("mobile Plan layout", () => {
  it("uses the shared fixed dialog sheet for mobile Plan and month detail", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    const source = readFileSync("src/components/plan-view.tsx", "utf8");
    const mobileStart = css.indexOf("@media (max-width: 760px)");
    const mobileEnd = css.indexOf("@media (max-width: 640px)", mobileStart);
    const mobileBlock = css.slice(mobileStart, mobileEnd);

    expect(source.match(/<DialogSheet/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source).toContain('variant="detail"');
    expect(mobileBlock).toContain(".paw-dialog-backdrop");
    expect(css).toContain("position: fixed;");
  });
});
