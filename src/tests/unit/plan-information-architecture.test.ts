import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Plan information architecture", () => {
  it("keeps schedule, projects, later, and archive as the four Plan sections", () => {
    const source = readFileSync("src/components/plan-section-nav.tsx", "utf8");

    expect(source).toContain('{ href: "/plan", label: "日程" }');
    expect(source).toContain('{ href: "/projects", label: "项目" }');
    expect(source).toContain('{ href: "/backlog", label: "稍后处理" }');
    expect(source).toContain('{ href: "/archive", label: "归档" }');
  });

  it("removes Plan destinations from More", () => {
    const source = readFileSync("src/components/more-view.tsx", "utf8");

    expect(source).not.toContain('href: "/projects"');
    expect(source).not.toContain('href: "/backlog"');
    expect(source).not.toContain('href: "/archive"');
  });

  it("keeps the four schedule views and standard month navigation", () => {
    const source = readFileSync("src/components/plan-view.tsx", "utf8");

    expect(source).toContain('["day", "日", "/plan?view=day"]');
    expect(source).toContain('["week", "周", "/plan?view=week"]');
    expect(source).toContain('["reschedule", "改期", "/plan?view=reschedule"]');
    expect(source).toContain('type="month" name="month"');
    expect(source).toContain("month.previousMonthKey");
    expect(source).toContain("month.nextMonthKey");
  });

  it("does not repeat raw notes when structured task details are available", () => {
    const source = readFileSync("src/components/plan-view.tsx", "utf8");

    expect(source).toContain("task.detail.sections.length === 0");
    expect(source).toContain('task.notes\n          ? <p className="paw-plan-detail-notes">{task.notes}</p>');
  });

  it("keeps the month calendar full width and opens task details on demand", () => {
    const source = readFileSync("src/components/plan-view.tsx", "utf8");

    expect(source).toContain('<section className="paw-plan-view paw-plan-month">');
    expect(source).toContain('layout="drawer"');
    expect(source).toContain('createPortal(detail, document.body)');
    expect(source).toContain('<DetailLine line={line} />');
  });

  it("styles month details as a responsive drawer instead of a permanent column", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    const monthRule = css.match(/\.paw-plan-month \{[\s\S]*?\}/)?.[0] ?? "";
    const drawerRule = css.match(/\.paw-plan-detail\.drawer \{[\s\S]*?\}/)?.[0] ?? "";

    expect(monthRule).toContain("width: min(1240px, calc(100vw - 64px));");
    expect(drawerRule).toContain("position: fixed;");
    expect(drawerRule).toContain("pointer-events: none;");
  });
});
