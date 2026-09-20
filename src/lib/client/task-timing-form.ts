import type { TimingTask } from "@/lib/planning/task-timing";

export function selectedTimingTaskIds(
  tasks: TimingTask[],
  date: string,
  selected: string[],
) {
  const allowed = new Set(
    tasks
      .filter(
        (task) => task.date === date && task.status === "todo" && task.movable,
      )
      .map((task) => task.id),
  );
  return selected.filter((id) => allowed.has(id));
}

export function timingMinutes(value: string, max: number): number {
  const number = Number(value);
  if (
    !value.trim() ||
    !Number.isInteger(number) ||
    number < 5 ||
    number > max
  ) {
    throw new Error(`请输入 5–${max} 之间的整数分钟。`);
  }
  return number;
}

// getRandomValues remains available on local HTTP LAN origins where randomUUID is absent.
export function timingRequestKey(
  cryptoApi: Pick<Crypto, "getRandomValues"> &
    Partial<Pick<Crypto, "randomUUID">> = globalThis.crypto,
): string {
  if (typeof cryptoApi?.randomUUID === "function")
    return cryptoApi.randomUUID();
  if (!cryptoApi?.getRandomValues)
    throw new Error("当前浏览器无法生成请求编号，请使用 HTTPS 或更新浏览器。");
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
