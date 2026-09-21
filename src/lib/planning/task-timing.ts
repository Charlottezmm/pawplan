import { z } from "zod";
import { addDaysToDateKey, shanghaiDateKey } from "./task-actions";

export const localDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    try {
      return addDaysToDateKey(s, 0) === s;
    } catch {
      return false;
    }
  }, "日期无效");
export const clockSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const windowShape = {
  date: localDateSchema,
  dateTo: localDateSchema.optional(),
  startTime: clockSchema.default("08:00"),
  endTime: clockSchema.default("22:00"),
  gapMinutes: z.number().int().min(0).max(60).default(10),
};
const timingEdit = z
  .object({
    taskId: z.string().uuid(),
    date: localDateSchema,
    startTime: clockSchema,
    minutes: z.number().int().min(5).max(480),
    locked: z.boolean(),
    deadlineAt: z.string().datetime({ offset: true }).nullable(),
    targetDate: localDateSchema.nullable(),
    checkpoint: z.string().max(2000).optional(),
  })
  .strict();
export const timingRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("schedule"),
      edits: z.array(timingEdit).min(1).max(60),
    })
    .strict(),
  z
    .object({
      action: z.literal("arrange"),
      ...windowShape,
      taskIds: z.array(z.string().uuid()).min(1).max(60),
    })
    .strict(),
  z
    .object({
      action: z.literal("defer"),
      ...windowShape,
      taskId: z.string().uuid(),
      minutes: z.number().int().min(5).max(480),
      checkpoint: z.string().trim().min(1).max(2000),
    })
    .strict(),
  z
    .object({
      action: z.literal("extend"),
      taskId: z.string().uuid(),
      minutes: z.number().int().min(5).max(120),
      endTime: clockSchema.default("22:00"),
    })
    .strict(),
  z
    .object({
      action: z.literal("pause"),
      taskId: z.string().uuid(),
      checkpoint: z.string().trim().min(1).max(2000),
    })
    .strict(),
  z
    .object({
      action: z.literal("complete"),
      taskId: z.string().uuid(),
      checkpoint: z.string().max(2000).optional(),
    })
    .strict(),
]);
export type TimingRequest = z.infer<typeof timingRequestSchema>;
export type TimingTask = {
  id: string;
  title: string;
  date: string;
  daySegment: "morning" | "afternoon" | "evening";
  status: string;
  movable: boolean;
  estimatedMinutes: number;
  updatedAt: string;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  deadlineAt: string | null;
  targetDate: string | null;
  checkpoint: string | null;
};
export type TimingBlock = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
};
export type TimingState = Pick<
  TimingTask,
  | "date"
  | "daySegment"
  | "status"
  | "movable"
  | "scheduledStart"
  | "scheduledEnd"
  | "deadlineAt"
  | "targetDate"
  | "checkpoint"
>;
export type TimingChange = {
  taskId: string;
  title: string;
  before: TimingState;
  after: TimingState;
};
export type TimingPreview = {
  approvalId: string;
  changes: TimingChange[];
  warnings: string[];
  liveUnchanged: true;
};
export class TimingError extends Error {
  constructor(
    message: string,
    public status = 409,
    public code?: "preview_stale",
  ) {
    super(message);
  }
}
export const clockMinute = (s: string) =>
  Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
export function localInstant(date: string, minute: number) {
  return new Date(
    new Date(`${date}T00:00:00+08:00`).getTime() + minute * 60_000,
  ).toISOString();
}
export function localClock(iso: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}
export function segmentFor(minute: number): TimingTask["daySegment"] {
  return minute < 12 * 60
    ? "morning"
    : minute < 18 * 60
      ? "afternoon"
      : "evening";
}
export function timingState(task: TimingTask): TimingState {
  const {
    date,
    daySegment,
    status,
    movable,
    scheduledStart,
    scheduledEnd,
    deadlineAt,
    targetDate,
    checkpoint,
  } = task;
  return {
    date,
    daySegment,
    status,
    movable,
    scheduledStart,
    scheduledEnd,
    deadlineAt,
    targetDate,
    checkpoint,
  };
}
export function timingLabel(state: TimingState) {
  const when =
    state.scheduledStart && state.scheduledEnd
      ? `${shanghaiDateKey(new Date(state.scheduledStart))} ${localClock(state.scheduledStart)}–${localClock(state.scheduledEnd)}`
      : `${state.date} · ${state.status === "backlog" ? "Backlog" : "未排具体时段"}`;
  return `${when}${!state.movable ? " · 已保护" : ""}${state.status === "done" ? " · 已完成" : ""}`;
}
export function timingRange(request: TimingRequest, tasks: TimingTask[]) {
  const dates =
    request.action === "schedule"
      ? request.edits.map((e) => e.date)
      : "date" in request
        ? [request.date, request.dateTo ?? request.date]
        : [
            tasks.find((t) => t.id === request.taskId)?.date ??
              shanghaiDateKey(),
          ];
  const from = [...dates].sort()[0];
  const to = [...dates].sort().at(-1)!;
  if ("dateTo" in request && request.dateTo && request.dateTo < request.date)
    throw new TimingError("结束日期不能早于开始日期", 400);
  if (new Date(to).getTime() - new Date(from).getTime() > 31 * 86400000)
    throw new TimingError("一次最多安排 31 天，请缩小范围", 400);
  if (
    "startTime" in request &&
    clockMinute(request.startTime) >= clockMinute(request.endTime)
  )
    throw new TimingError("结束时间必须晚于开始时间", 400);
  return { from, to };
}
function overlap(
  a: { start: number; end: number },
  b: { start: number; end: number },
) {
  return a.start < b.end && b.start < a.end;
}
function interval(task: TimingTask) {
  return task.scheduledStart && task.scheduledEnd
    ? {
        start: Date.parse(task.scheduledStart),
        end: Date.parse(task.scheduledEnd),
      }
    : null;
}
export function buildTimingChanges(
  request: TimingRequest,
  tasks: TimingTask[],
  fixed: TimingBlock[],
  now = new Date(),
  capacityAllows?: (
    task: TimingTask,
    start: number,
    minutes: number,
    working: TimingTask[],
  ) => boolean,
) {
  const range = timingRange(request, tasks);
  const original = new Map(tasks.map((t) => [t.id, t]));
  const working = tasks.map((t) => ({ ...t }));
  const warnings: string[] = [];
  const find = (id: string) => {
    const task = working.find((t) => t.id === id);
    if (!task || !["todo", "backlog"].includes(task.status))
      throw new TimingError("任务不存在、已完成或已离开当前计划");
    return task;
  };
  const fixedIntervals = fixed.map((b) => ({
    start: Date.parse(b.startsAt),
    end: Date.parse(b.endsAt),
  }));
  const occupied = (exclude: Set<string> = new Set()) => [
    ...fixedIntervals,
    ...working
      .filter((t) => t.status !== "backlog" && !exclude.has(t.id))
      .flatMap((t) => {
        const i = interval(t);
        return i ? [i] : [];
      }),
  ];
  const setSlot = (task: TimingTask, start: number, minutes: number) => {
    const end = start + minutes * 60000;
    if (task.deadlineAt && end > Date.parse(task.deadlineAt))
      throw new TimingError(`${task.title}：不能排到正式截止时间之后`);
    task.scheduledStart = new Date(start).toISOString();
    task.scheduledEnd = new Date(end).toISOString();
    task.date = shanghaiDateKey(new Date(start));
    task.daySegment = segmentFor(clockMinute(localClock(task.scheduledStart)));
    task.status = "todo";
    if (shanghaiDateKey(new Date(end - 1)) !== task.date)
      throw new TimingError("任务时段不能跨天", 400);
  };
  const fit = (
    task: TimingTask,
    date: string,
    duration: number,
    earliest: number,
    latest: number,
    gap: number,
    exclude = new Set([task.id]),
  ) => {
    const day = Date.parse(localInstant(date, 0));
    let start = Math.max(
      day + earliest * 60000,
      Math.ceil(now.getTime() / 300000) * 300000,
    );
    const limit = Math.min(
      day + latest * 60000,
      task.deadlineAt ? Date.parse(task.deadlineAt) : Infinity,
    );
    const busy = occupied(exclude).sort((a, b) => a.start - b.start);
    while (start + duration * 60000 <= limit) {
      for (const b of busy) {
        if (b.end + gap * 60000 <= start) continue;
        if (start + duration * 60000 + gap * 60000 <= b.start) break;
        start = b.end + gap * 60000;
      }
      if (start + duration * 60000 > limit) return null;
      if (
        request.action === "extend" ||
        !capacityAllows ||
        capacityAllows(task, start, duration, working)
      )
        return start;
      // Try the next segment rather than confusing free clock time with capacity.
      const minute = (start - day) / 60000;
      start = day + (minute < 720 ? 720 : minute < 1080 ? 1080 : 1440) * 60000;
    }
    return null;
  };
  const assertMovable = (task: TimingTask) => {
    if (!task.movable)
      throw new TimingError(`${task.title} 已保护，请先明确解除保护再调整`);
  };
  if (request.action === "schedule") {
    if (
      new Set(request.edits.map((e) => e.taskId)).size !== request.edits.length
    )
      throw new TimingError("不能重复安排同一个任务", 400);
    for (const edit of request.edits) {
      const task = find(edit.taskId);
      const nextStart = localInstant(edit.date, clockMinute(edit.startTime));
      if (
        !task.movable &&
        edit.locked &&
        (task.scheduledStart !== nextStart ||
          task.scheduledEnd !==
            localInstant(edit.date, clockMinute(edit.startTime) + edit.minutes))
      )
        assertMovable(task);
      task.deadlineAt = edit.deadlineAt
        ? new Date(edit.deadlineAt).toISOString()
        : null;
      task.targetDate = edit.targetDate;
      task.movable = !edit.locked;
      if (edit.checkpoint !== undefined) task.checkpoint = edit.checkpoint;
      const old = original.get(task.id)!;
      if (
        Date.parse(nextStart) < now.getTime() &&
        nextStart !== old.scheduledStart
      )
        throw new TimingError("新的时段不能安排到已经过去的时间");
      setSlot(task, Date.parse(nextStart), edit.minutes);
    }
  } else if (request.action === "pause" || request.action === "complete") {
    const task = find(request.taskId);
    task.checkpoint = request.checkpoint ?? task.checkpoint;
    if (request.action === "complete") task.status = "done";
    else {
      task.scheduledStart = null;
      task.scheduledEnd = null;
    }
  } else if (request.action === "extend") {
    const task = find(request.taskId);
    assertMovable(task);
    if (!task.scheduledStart || !task.scheduledEnd)
      throw new TimingError("请先为任务安排具体时段");
    const start = Date.parse(task.scheduledStart);
    const end = Date.parse(task.scheduledEnd) + request.minutes * 60000;
    if (end > Date.parse(localInstant(task.date, clockMinute(request.endTime))))
      throw new TimingError("继续时间超过今天的结束时间，请选择后续日期");
    if (end <= now.getTime())
      throw new TimingError("原时段已经过去，请重新安排开始时间");
    const affected = working
      .filter(
        (t) =>
          t.id !== task.id &&
          t.status === "todo" &&
          t.date === task.date &&
          t.scheduledStart &&
          t.movable &&
          Date.parse(t.scheduledStart) >= start,
      )
      .sort((a, b) => a.scheduledStart!.localeCompare(b.scheduledStart!));
    const ids = new Set([task.id, ...affected.map((t) => t.id)]);
    if (occupied(ids).some((b) => overlap({ start, end }, b)))
      throw new TimingError(
        "继续这段时间会碰到固定或受保护安排，请选择后续时间",
      );
    setSlot(task, start, (end - start) / 60000);
    let cursor = end;
    for (const other of affected) {
      const oldStart = Date.parse(other.scheduledStart!);
      const duration = (Date.parse(other.scheduledEnd!) - oldStart) / 60000;
      if (oldStart >= cursor) {
        cursor = Date.parse(other.scheduledEnd!);
        ids.delete(other.id);
        continue;
      }
      ids.delete(task.id);
      ids.delete(other.id);
      const slot = fit(
        other,
        other.date,
        duration,
        (cursor - Date.parse(localInstant(other.date, 0))) / 60000,
        clockMinute(request.endTime),
        0,
        new Set([other.id, ...ids]),
      );
      if (slot === null)
        throw new TimingError(
          `${other.title} 今天排不下；本次没有修改，请先为它选择后续日期`,
        );
      setSlot(other, slot, duration);
      cursor = Date.parse(other.scheduledEnd!);
    }
  } else {
    const ids =
      request.action === "arrange" ? request.taskIds : [request.taskId];
    if (new Set(ids).size !== ids.length)
      throw new TimingError("任务不能重复", 400);
    // Existing unslotted planned work reserves capacity before a backlog candidate.
    const selected = new Set(ids);
    const reserving = working.filter(
      (t) =>
        t.status === "todo" &&
        !t.scheduledStart &&
        !selected.has(t.id) &&
        t.date >= range.from &&
        t.date <= range.to,
    );
    const bounds = {
      morning: [8 * 60, 12 * 60],
      afternoon: [14 * 60, 18 * 60],
      evening: [19 * 60, 22 * 60],
    };
    const virtual: TimingTask[] = [];
    const fullDays = new Set<string>();
    for (const t of reserving) {
      const [a, b] = bounds[t.daySegment];
      const slot = fit(
        t,
        t.date,
        t.estimatedMinutes,
        Math.max(a, clockMinute(request.startTime)),
        Math.min(b, clockMinute(request.endTime)),
        request.gapMinutes,
      ) ?? fit(t, t.date, t.estimatedMinutes, clockMinute(request.startTime), clockMinute(request.endTime), request.gapMinutes);
      if (slot === null) fullDays.add(t.date);
      else {
        setSlot(t, slot, t.estimatedMinutes);
        virtual.push(t);
      }
    }
    for (const id of ids) {
      const task = find(id);
      assertMovable(task);
      const duration =
        request.action === "defer" ? request.minutes : task.estimatedMinutes;
      const wasBacklog = task.status === "backlog";
      let chosen: number | null = null;
      for (
        let date = range.from;
        date <= range.to;
        date = addDaysToDateKey(date, 1)
      ) {
        if (fullDays.has(date)) continue;
        let a = clockMinute(request.startTime);
        let b = clockMinute(request.endTime);
        if (request.action === "arrange" && !wasBacklog) {
          const preferred = bounds[task.daySegment];
          chosen = fit(task, date, duration, Math.max(a, preferred[0]), Math.min(b, preferred[1]), request.gapMinutes);
        }
        // Day segments are preferences; the user-selected clock window is authoritative.
        if (chosen === null) chosen = fit(task, date, duration, a, b, request.gapMinutes);
        if (chosen !== null) break;
      }
      if (chosen === null) {
        warnings.push(`${task.title}：所选日期内没有可用时段，保持原安排。`);
        continue;
      }
      const preferred = bounds[task.daySegment];
      const chosenMinute = clockMinute(localClock(new Date(chosen).toISOString()));
      if (request.action === "arrange" && !wasBacklog && (chosenMinute < preferred[0] || chosenMinute + duration > preferred[1])) {
        warnings.push(`${task.title}：原时段偏好无法容纳，已在所选时间范围内安排，请确认。`);
      }
      setSlot(task, chosen, duration);
      if (request.action === "defer") task.checkpoint = request.checkpoint;
    }
    for (const task of virtual) Object.assign(task, original.get(task.id));
  }
  const changes: TimingChange[] = [];
  for (const task of working) {
    const before = timingState(original.get(task.id)!);
    const after = timingState(task);
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    const slot = interval(task);
    const timingChanged =
      before.scheduledStart !== after.scheduledStart ||
      before.scheduledEnd !== after.scheduledEnd;
    if (
      slot &&
      timingChanged &&
      occupied(new Set([task.id])).some((b) => overlap(slot, b))
    )
      throw new TimingError(`${task.title} 与其他时段冲突，请调整时间`);
    if (task.targetDate && task.date > task.targetDate)
      warnings.push(`${task.title}：晚于希望完成日期 ${task.targetDate}。`);
    changes.push({ taskId: task.id, title: task.title, before, after });
  }
  return { changes, warnings };
}
