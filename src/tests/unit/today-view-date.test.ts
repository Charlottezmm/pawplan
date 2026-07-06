import { describe, expect, it } from "vitest";
import { buildTaskCopyText, formatTodayGreeting } from "@/components/today-view";

describe("today greeting date label", () => {
  it("uses deterministic spacing across server and WebKit hydration", () => {
    expect(formatTodayGreeting(new Date("2026-06-18T04:00:00.000Z"))).toBe("6月18日 星期四");
  });
});

describe("today task copy text", () => {
  it("includes the title, metadata, notes, and detail sections", () => {
    const copyText = buildTaskCopyText({
      title: "Karpathy GPT/nanoGPT 视频（补看，不要求复现）",
      context: "Karpathy Zero-to-Hero",
      track: "学习主线",
      minutes: 120,
      energy: "高",
      priority: "high",
      notes: "只被动看，不要求复现。",
      detail: {
        summary: null,
        sections: [
          { label: "目标", lines: ["被动看完 Karpathy Let's build GPT from scratch"] },
          { label: "资源", lines: ["视频 https://www.youtube.com/watch?v=kCc8FmEb1nY"] },
        ],
      },
    });

    expect(copyText).toBe(
      [
        "Karpathy GPT/nanoGPT 视频（补看，不要求复现）",
        "Karpathy Zero-to-Hero · 学习主线 · 2h · 能量 高 · 优先级 高",
        "备注",
        "只被动看，不要求复现。",
        "目标",
        "- 被动看完 Karpathy Let's build GPT from scratch",
        "资源",
        "- 视频 https://www.youtube.com/watch?v=kCc8FmEb1nY",
      ].join("\n"),
    );
  });
});
