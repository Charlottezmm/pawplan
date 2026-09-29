import { describe, expect, it } from "vitest";
import { buildWarnings } from "@/lib/planning/warnings";

describe("warnings", () => {
  it("returns inbox and checkin warnings without imposing a recovery target", () => {
    const warnings = buildWarnings({
      inboxCount: 11,
      hadYesterdayCheckin: false,
    });

    expect(warnings.map((warning) => warning.code)).toEqual([
      "inbox_pileup",
      "missing_checkin",
    ]);
  });

  it("does not warn when inputs are within thresholds", () => {
    const warnings = buildWarnings({
      inboxCount: 10,
      hadYesterdayCheckin: true,
    });

    expect(warnings).toEqual([]);
  });
});
