import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/app/globals.css", "utf8");
const mobileStart = css.indexOf("@media (max-width: 760px)");
const mobileEnd = css.indexOf("@media (max-width: 640px)", mobileStart);
const mobileCss = css.slice(mobileStart, mobileEnd);

describe("mobile navigation and control sizing", () => {
  it("centers each schedule view label in a real flex hit target", () => {
    const baseRule = css.match(/\.paw-sub-tab \{[\s\S]*?\}/)?.[0] ?? "";
    const mobileRule = mobileCss.match(/\.paw-sub-tab \{[\s\S]*?\}/)?.[0] ?? "";

    expect(baseRule).toContain("display: inline-flex;");
    expect(baseRule).toContain("align-items: center;");
    expect(baseRule).toContain("justify-content: center;");
    expect(baseRule).toContain("line-height: 1;");
    expect(mobileRule).toContain("min-height: var(--app-control-min);");
    expect(mobileRule).toContain("padding: 0 10px;");
    expect(mobileRule).not.toMatch(/transform|negative|margin-left/);
  });

  it("gives the five Plan sections full width and scrolls instead of squeezing labels", () => {
    const navRule = mobileCss.match(/\.paw-plan-section-nav \{[\s\S]*?\}/)?.[0] ?? "";
    const linkRule = mobileCss.match(/\.paw-plan-section-link \{[\s\S]*?\}/)?.[0] ?? "";

    expect(navRule).toContain("width: 100%;");
    expect(navRule).not.toContain("calc(100% -");
    expect(linkRule).toContain("flex: 1 0 max-content;");
    expect(css.match(/\.paw-plan-section-link \{[\s\S]*?\}/)?.[0] ?? "").toContain("min-width: var(--app-control-min);");
    expect(linkRule).toContain("min-height: var(--app-control-min);");
  });

  it("keeps shared primary actions at least 44px tall", () => {
    const sharedRule = css.match(/\.paw-save-btn,\n\.paw-primary-btn,\n\.paw-secondary-btn \{[\s\S]*?\}/)?.[0] ?? "";
    const frequentRule = mobileCss.match(/\.paw-act-btn,[\s\S]*?\.paw-back \{[\s\S]*?\}/)?.[0] ?? "";
    const checkHitbox = mobileCss.match(/\.paw-task-check::after \{[\s\S]*?\}/)?.[0] ?? "";

    expect(sharedRule).toContain("min-height: var(--app-control-min);");
    expect(frequentRule).toContain("display: inline-flex;");
    expect(frequentRule).toContain("min-height: var(--app-control-min);");
    expect(checkHitbox).toContain("inset: -7px;");
  });
});
