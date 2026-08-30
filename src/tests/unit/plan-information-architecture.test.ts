import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Plan information architecture", () => {
  it("separates rough tasks from fixed-time schedules inside Plan", () => {
    const source = readFileSync("src/components/plan-section-nav.tsx", "utf8");
    const shellSource = readFileSync("src/components/app-shell.tsx", "utf8");

    expect(source).toContain('{ href: "/plan", label: "任务" }');
    expect(source).toContain('{ href: "/constraints", label: "日程" }');
    expect(source).toContain('{ href: "/projects", label: "项目" }');
    expect(source).toContain('{ href: "/backlog", label: "稍后处理" }');
    expect(source).toContain('{ href: "/archive", label: "归档" }');
    expect(shellSource).not.toContain('{ href: "/constraints", label:');
  });

  it("removes Plan destinations from More", () => {
    const source = readFileSync("src/components/more-view.tsx", "utf8");

    expect(source).not.toContain('href: "/projects"');
    expect(source).not.toContain('href: "/backlog"');
    expect(source).not.toContain('href: "/archive"');
    expect(source.match(/href: "\/settings"/g)).toHaveLength(1);
    expect(source).not.toContain('title: "MCP 连接"');
  });

  it("uses four Chinese high-frequency destinations and no global capture cat", () => {
    const source = readFileSync("src/components/app-shell.tsx", "utf8");

    expect(source).toContain('{ href: "/today", label: "今天"');
    expect(source).toContain('{ href: "/plan", label: "计划"');
    expect(source).toContain('{ href: "/inbox", label: "收集"');
    expect(source).toContain('{ href: "/review", label: "审核"');
    expect(source).not.toContain("FloatingCat");
    expect(source).not.toContain('href: "/more"');
  });

  it("refreshes the server Review badge after single-patch decisions", () => {
    const source = readFileSync("src/components/reschedule-preview.tsx", "utf8");
    const dismissBlock = source.slice(source.indexOf("async function dismissPatch"), source.indexOf("async function applySelected"));
    const applyBlock = source.slice(source.indexOf("async function applySelected"), source.indexOf("function formatConflictSide"));

    expect(dismissBlock).toContain("router.refresh();");
    expect(applyBlock).toContain("closedAnyPatch = true;");
    expect(applyBlock).toContain("if (closedAnyPatch) router.refresh();");
  });

  it("keeps three view tabs, a separate manual reschedule action, and standard month navigation", () => {
    const source = readFileSync("src/components/plan-view.tsx", "utf8");

    expect(source).toContain('["day", "日", "/plan?view=day"]');
    expect(source).toContain('["week", "周", "/plan?view=week"]');
    expect(source).not.toContain('["reschedule", "改期", "/plan?view=reschedule"]');
    expect(source).toContain('className={`paw-plan-reschedule-link');
    expect(source).toContain('手动改期');
    expect(source).toContain('type="month" name="month"');
    expect(source).toContain("month.previousMonthKey");
    expect(source).toContain("month.nextMonthKey");
  });

  it("keeps collapsed task cards compact and fixed occupancy visible", () => {
    const source = readFileSync("src/components/plan-view.tsx", "utf8");
    const cardSource = source.slice(source.indexOf("function TaskCard"), source.indexOf("function FixedItems"));

    expect(cardSource).toContain('{segmentLabel[task.segment]} · {minutesLabel(task.minutes)}');
    expect(cardSource).not.toContain('{task.context} · {task.track}');
    expect(source).toContain('<details className="paw-plan-fixed" open>');
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
