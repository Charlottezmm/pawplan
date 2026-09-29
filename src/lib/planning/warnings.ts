type WarningInput = {
  inboxCount: number;
  hadYesterdayCheckin: boolean;
};

export function buildWarnings(input: WarningInput) {
  const warnings: Array<{ code: string; message: string }> = [];

  if (input.inboxCount > 10) {
    warnings.push({ code: "inbox_pileup", message: `Inbox 堆了 ${input.inboxCount} 条，先清一下。` });
  }

  if (!input.hadYesterdayCheckin) {
    warnings.push({ code: "missing_checkin", message: "昨天没复盘，今天先看 must-win 优先级。" });
  }

  return warnings;
}
