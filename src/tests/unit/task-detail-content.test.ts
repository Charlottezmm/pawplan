import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { parseTaskResource, TaskDetailContent } from "@/components/task-detail-content";

describe("TaskDetailContent", () => {
  it("renders the concise template as semantic cards and clickable resources", () => {
    const html = renderToStaticMarkup(React.createElement(TaskDetailContent, {
      notes: "structured source",
      detail: {
        summary: null,
        sections: [
          { label: "目标", lines: ["理解最小循环"] },
          { label: "执行", lines: ["观看主视频", "画出循环"] },
          { label: "完成标准", lines: ["保存循环图"] },
          { label: "卡点与边界", lines: ["60 分钟停止"] },
          { label: "快捷链接", lines: ["[MathWorks](https://example.com/rl) — 主视频"] },
        ],
      },
    }));

    expect(html).toContain("tone-goal");
    expect(html).toContain("paw-detail-steps");
    expect(html).toContain("tone-completion");
    expect(html).toContain("tone-boundary");
    expect(html).toContain('href="https://example.com/rl"');
    expect(html).toContain("MathWorks");
    expect(html).toContain("主视频");
    expect(html).toContain("example.com");
    expect(html).not.toContain("structured source");
  });

  it("keeps unstructured legacy notes visible", () => {
    const html = renderToStaticMarkup(React.createElement(TaskDetailContent, {
      notes: "旧任务的完整原始说明",
      detail: { summary: "旧任务的完整原始说明", sections: [] },
    }));

    expect(html).toContain("旧任务的完整原始说明");
    expect(html).toContain("paw-task-detail-raw");
  });

  it("parses named Markdown and bare task resources", () => {
    expect(parseTaskResource("[主视频](https://example.com/video) — 先看这个")).toEqual({
      label: "主视频",
      href: "https://example.com/video",
      host: "example.com",
      description: "先看这个",
    });
    expect(parseTaskResource("备用入口：https://docs.example.com/guide。")).toEqual({
      label: "备用入口",
      href: "https://docs.example.com/guide",
      host: "docs.example.com",
      description: "",
    });
  });
});
