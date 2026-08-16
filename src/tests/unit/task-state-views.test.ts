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
  it("offers explicit keep, archive, or untouched choices for legacy tasks", () => {
    const html = renderToStaticMarkup(React.createElement(BacklogView, {
      data: { dataUnavailable: false, totalCount: 0, groups: [] },
      legacySkipped: {
        dataUnavailable: false,
        tasks: [{
          id: "task-1",
          title: "Old unfinished task",
          date: "2026-08-15",
          estimatedMinutes: 30,
          projectId: "project-1",
          projectName: "Research",
          projectColor: "#2563eb",
        }],
      },
    }));

    expect(html).toContain("以前清理的任务");
    expect(html).toContain("还要做");
    expect(html).toContain("不做了");
    expect(html).toContain("没有选择的任务会继续留在这里");
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

    expect(html).toContain("不再继续");
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
