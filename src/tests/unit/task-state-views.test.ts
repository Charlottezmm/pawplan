import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/backlog",
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { ArchiveHistoryView } from "@/components/archive-history-view";
import { BacklogView } from "@/components/backlog-view";

Object.assign(globalThis, { React });

describe("simplified task state views", () => {
  it("keeps legacy skipped tasks collapsed and offers moving them to backlog", () => {
    const html = renderToStaticMarkup(React.createElement(BacklogView, {
      data: { dataUnavailable: false, totalCount: 0, groups: [] },
      legacySkipped: {
        dataUnavailable: false,
        tasks: [{ id: "task-1", title: "Old unfinished task", date: "2026-08-15", estimatedMinutes: 30 }],
      },
    }));

    expect(html).toContain("旧兼容状态任务 · 1 条");
    expect(html).toContain("但不算完成");
    expect(html).toContain("加入稍后处理");
    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
  });

  it("labels archived skipped history as legacy and not completed", () => {
    const html = renderToStaticMarkup(React.createElement(ArchiveHistoryView, { data: {
      dataUnavailable: false,
      totalCount: 1,
      totalMinutes: 30,
      filters: {},
      projects: [],
      groups: [{
        projectId: null,
        projectName: "未关联 Project",
        category: null,
        color: "#a89f8d",
        tasks: [{
          id: "task-1",
          title: "Old unfinished task",
          status: "skipped",
          date: "2026-08-15",
          estimatedMinutes: 30,
          archivedLabel: "2026/8/16",
        }],
      }],
    } }));

    expect(html).toContain("旧兼容状态（未完成）");
    expect(html).toContain("恢复到稍后处理");
    expect(html).not.toContain("已完成");
  });

  it("keeps archive filters compact until a filter is active", () => {
    const baseData = {
      dataUnavailable: false,
      totalCount: 0,
      totalMinutes: 0,
      projects: [],
      groups: [],
    };
    const compactHtml = renderToStaticMarkup(React.createElement(ArchiveHistoryView, {
      data: { ...baseData, filters: {} },
    }));
    const filteredHtml = renderToStaticMarkup(React.createElement(ArchiveHistoryView, {
      data: { ...baseData, filters: { status: "todo" as const } },
    }));

    expect(compactHtml).toContain("筛选归档");
    expect(compactHtml).toContain("暂无归档任务");
    expect(compactHtml).not.toContain("<details class=\"paw-archive-filters\" open=\"\"");
    expect(compactHtml).not.toContain("查看 Projects");
    expect(filteredHtml).toContain("<details class=\"paw-archive-filters\" open=\"\"");
    expect(filteredHtml).toContain("没有符合筛选条件的任务");
    expect(filteredHtml).toContain("清除筛选");
  });
});
