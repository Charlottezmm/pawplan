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
    const detailSource = readFileSync("src/components/task-detail-content.tsx", "utf8");

    expect(source).toContain('<TaskDetailContent detail={task.detail} notes={task.notes} />');
    expect(detailSource).toContain("if (detail.sections.length === 0)");
    expect(detailSource).toContain('<p className="paw-task-detail-raw">{notes}</p>');
  });

  it("keeps shared structured task detail inside the original sidebar", () => {
    const source = readFileSync("src/components/plan-view.tsx", "utf8");
    const todaySource = readFileSync("src/components/today-view.tsx", "utf8");
    const detailSource = readFileSync("src/components/task-detail-content.tsx", "utf8");
    const css = readFileSync("src/app/globals.css", "utf8");
    const detailRule = css.match(/\.paw-task-detail-content \{[\s\S]*?\}/)?.[0] ?? "";

    expect(source).toContain('<section className="paw-plan-view paw-plan-split">');
    expect(source).toContain('<TaskDetailContent detail={task.detail} notes={task.notes} />');
    expect(todaySource).toContain('<TaskDetailContent detail={task.detail} notes={task.notes} />');
    expect(detailSource).toContain('className="paw-detail-resource-card"');
    expect(detailRule).toContain("display: grid;");
  });
});
