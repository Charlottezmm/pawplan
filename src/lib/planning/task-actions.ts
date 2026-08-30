const shanghaiTimeZone = "Asia/Shanghai";

export function shanghaiDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: shanghaiTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function persistedDateMatchesDateKey(value: unknown, expectedDateKey: string) {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && shanghaiDateKey(date) === expectedDateKey;
}

export function addDaysToDateKey(dateKey: string, days: number) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new Error("Invalid date key");
  const [year, month, day] = dateKey.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  if (
    value.getUTCFullYear() !== year ||
    value.getUTCMonth() !== month - 1 ||
    value.getUTCDate() !== day
  ) {
    throw new Error("Invalid date key");
  }
  value.setUTCDate(value.getUTCDate() + days);
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
}

export function defaultPostponeDate(date = new Date()) {
  return addDaysToDateKey(shanghaiDateKey(date), 1);
}

export function postponeTaskUpdate(id: string, date: string) {
  return { id, date, status: "todo" as const, blocked: false };
}

export function moveOutOfScheduleUpdate(id: string) {
  return { id, status: "backlog" as const, blocked: false };
}
