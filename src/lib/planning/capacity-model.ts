import { expandRecurringBlocks } from "@/lib/planning/recurring-time-blocks";

export type CapacitySegment = "morning" | "afternoon" | "evening";
export type CapacityTaskStatus = "todo" | "done" | "skipped" | "backlog";
export type ProtectedBlockKind = "course" | "exam" | "meeting" | "unavailable" | "routine" | "recovery";

export type CapacityTaskInput = {
  id: string;
  title: string;
  date: Date;
  daySegment: CapacitySegment;
  estimatedMinutes: number;
  status: CapacityTaskStatus;
};

export type CapacityTimeBlockInput = {
  id: string;
  title: string;
  kind: ProtectedBlockKind;
  startsAt: Date;
  endsAt: Date;
  recurrenceWeekdayMask?: number | null;
  protected?: boolean;
};

export type CapacityRoutineInput = {
  id: string;
  title: string;
  defaultTimeSegment: CapacitySegment | "specific_window";
  defaultStartTime: string | null;
  defaultEndTime: string | null;
  weekdayPattern?: string;
  estimatedMinutes: number;
};

export type CapacityDayInput = {
  date: Date;
  morningMinutes: number;
  afternoonMinutes: number;
  eveningMinutes: number;
};

export type CapacityBlock = {
  id: string;
  title: string;
  kind: ProtectedBlockKind | "task";
  minutes: number;
  protected: boolean;
};

export type CapacitySegmentResult = {
  baseAvailableMinutes: number;
  availableMinutes: number;
  capacityWindowMinutes: number;
  blockedMinutes: number;
  taskMinutes: number;
  protectedMinutes: number;
  totalUsedMinutes: number;
  remainingMinutes: number;
  state: "room" | "ok" | "full" | "over";
  blocks: CapacityBlock[];
};

export type CapacityDayResult = {
  dateKey: string;
  segments: Record<CapacitySegment, CapacitySegmentResult>;
};

export type CapacityWarning = {
  code: "over_capacity";
  dateKey: string;
  segment: CapacitySegment;
  message: string;
};

export type CapacityModelResult = {
  days: CapacityDayResult[];
  warnings: CapacityWarning[];
};

export type CapacityModelInput = {
  dates: Date[];
  capacities: CapacityDayInput[];
  tasks: CapacityTaskInput[];
  timeBlocks: CapacityTimeBlockInput[];
  routines: CapacityRoutineInput[];
  now?: Date;
};

const segments: CapacitySegment[] = ["morning", "afternoon", "evening"];
const fallbackCapacity: Record<CapacitySegment, number> = {
  morning: 180,
  afternoon: 240,
  evening: 120,
};

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function shanghaiDateParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  return {
    year: Number(parts.find((part) => part.type === "year")?.value),
    month: Number(parts.find((part) => part.type === "month")?.value),
    day: Number(parts.find((part) => part.type === "day")?.value),
  };
}

export function startOfShanghaiCapacityDay(date: Date) {
  const { year, month, day } = shanghaiDateParts(date);
  return new Date(Date.UTC(year, month - 1, day) - 8 * 60 * 60 * 1000);
}

export function capacityDateKey(date: Date) {
  const { year, month, day } = shanghaiDateParts(date);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function minutesBetween(start: Date, end: Date) {
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
}

function timeOnDay(date: Date, time: string) {
  const [hour, minute] = time.split(":").map(Number);
  const start = startOfShanghaiCapacityDay(date);
  return new Date(start.getTime() + (hour || 0) * 60 * 60 * 1000 + (minute || 0) * 60 * 1000);
}

function segmentWindows(date: Date): Record<CapacitySegment, { start: Date; end: Date }> {
  const start = startOfShanghaiCapacityDay(date);
  return {
    morning: { start, end: timeOnDay(date, "12:00") },
    afternoon: { start: timeOnDay(date, "12:00"), end: timeOnDay(date, "18:00") },
    evening: { start: timeOnDay(date, "18:00"), end: addDays(start, 1) },
  };
}

function minutesInSegment(start: Date, end: Date, window: { start: Date; end: Date }) {
  const clippedStart = new Date(Math.max(start.getTime(), window.start.getTime()));
  const clippedEnd = new Date(Math.min(end.getTime(), window.end.getTime()));
  return minutesBetween(clippedStart, clippedEnd);
}

function segmentForTime(date: Date, time: string): CapacitySegment {
  const start = timeOnDay(date, time);
  const windows = segmentWindows(date);
  if (start >= windows.afternoon.start && start < windows.evening.start) return "afternoon";
  if (start >= windows.evening.start) return "evening";
  return "morning";
}

function weekdayForShanghaiDay(date: Date) {
  const start = startOfShanghaiCapacityDay(date);
  const noon = new Date(start.getTime() + 20 * 60 * 60 * 1000);
  return noon.getUTCDay();
}

function routineAppliesOnDate(routine: CapacityRoutineInput, date: Date) {
  const pattern = routine.weekdayPattern?.trim().toLowerCase();
  if (!pattern || pattern === "daily" || pattern === "*") return true;

  const weekday = weekdayForShanghaiDay(date);
  const names = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const tokens = pattern.split(/[\s,，/|]+/).filter(Boolean);
  return tokens.some((token) => token === names[weekday] || token === String(weekday) || (weekday === 0 && token === "7"));
}

function emptySegment(availableMinutes: number): CapacitySegmentResult {
  return {
    baseAvailableMinutes: availableMinutes,
    availableMinutes,
    capacityWindowMinutes: 0,
    blockedMinutes: 0,
    taskMinutes: 0,
    protectedMinutes: 0,
    totalUsedMinutes: 0,
    remainingMinutes: availableMinutes,
    state: availableMinutes === 0 ? "full" : "room",
    blocks: [],
  };
}

function addBlock(
  day: CapacityDayResult,
  segment: CapacitySegment,
  block: CapacityBlock,
  role: "task" | "capacity_window" | "blocked",
) {
  const target = day.segments[segment];
  target.blocks.push(block);
  if (role === "capacity_window") {
    target.protectedMinutes += block.minutes;
    target.capacityWindowMinutes += block.minutes;
  } else if (role === "blocked") {
    target.protectedMinutes += block.minutes;
    target.blockedMinutes += block.minutes;
  } else {
    target.taskMinutes += block.minutes;
  }
}

function finalizeSegment(segment: CapacitySegmentResult) {
  segment.availableMinutes = segment.capacityWindowMinutes > 0 ? segment.capacityWindowMinutes : segment.baseAvailableMinutes;
  segment.totalUsedMinutes = segment.taskMinutes + segment.blockedMinutes;
  segment.remainingMinutes = Math.max(0, segment.availableMinutes - segment.totalUsedMinutes);
  if (segment.totalUsedMinutes > segment.availableMinutes) {
    segment.state = "over";
  } else if (segment.remainingMinutes === 0) {
    segment.state = "full";
  } else if (segment.totalUsedMinutes / Math.max(segment.availableMinutes, 1) >= 0.6) {
    segment.state = "ok";
  } else {
    segment.state = "room";
  }
}

export function buildCapacityModel(input: CapacityModelInput): CapacityModelResult {
  const capacityByDate = new Map(input.capacities.map((capacity) => [capacityDateKey(capacity.date), capacity]));
  const days = input.dates.map((date) => {
    const dateKey = capacityDateKey(date);
    const capacity = capacityByDate.get(dateKey);
    return {
      dateKey,
      segments: {
        morning: emptySegment(capacity?.morningMinutes ?? fallbackCapacity.morning),
        afternoon: emptySegment(capacity?.afternoonMinutes ?? fallbackCapacity.afternoon),
        evening: emptySegment(capacity?.eveningMinutes ?? fallbackCapacity.evening),
      },
    };
  });
  const dayByKey = new Map(days.map((day) => [day.dateKey, day]));
  const nowKey = capacityDateKey(input.now ?? new Date());

  for (const task of input.tasks) {
    if (task.status === "backlog" || task.status === "skipped") continue;
    const taskDateKey = capacityDateKey(task.date);
    if (task.status === "done" && taskDateKey > nowKey) continue;
    const day = dayByKey.get(taskDateKey);
    if (!day) continue;
    addBlock(
      day,
      task.daySegment,
      {
        id: task.id,
        title: task.title,
        kind: "task",
        minutes: task.estimatedMinutes,
        protected: false,
      },
      "task",
    );
  }

  const rangeStart = input.dates.length > 0 ? startOfShanghaiCapacityDay(input.dates[0]) : new Date();
  const rangeEnd = input.dates.length > 0
    ? addDays(startOfShanghaiCapacityDay(input.dates[input.dates.length - 1]), 1)
    : new Date();
  const timeBlocks = expandRecurringBlocks(input.timeBlocks, rangeStart, rangeEnd);

  for (const block of timeBlocks) {
    for (const day of days) {
      const date = startOfShanghaiCapacityDay(new Date(`${day.dateKey}T00:00:00.000+08:00`));
      const windows = segmentWindows(date);
      for (const segment of segments) {
        const minutes = minutesInSegment(block.startsAt, block.endsAt, windows[segment]);
        if (minutes <= 0) continue;
        addBlock(
          day,
          segment,
          {
            id: block.id,
            title: block.title,
            kind: block.kind,
            minutes,
            protected: block.protected ?? true,
          },
          block.kind === "routine" ? "capacity_window" : "blocked",
        );
      }
    }
  }

  for (const routine of input.routines) {
    for (const date of input.dates) {
      if (!routineAppliesOnDate(routine, date)) continue;
      const day = dayByKey.get(capacityDateKey(date));
      if (!day) continue;

      if (routine.defaultTimeSegment === "specific_window" && routine.defaultStartTime && routine.defaultEndTime) {
        const segment = segmentForTime(date, routine.defaultStartTime);
        const minutes = minutesBetween(timeOnDay(date, routine.defaultStartTime), timeOnDay(date, routine.defaultEndTime));
        addBlock(
          day,
          segment,
          {
            id: routine.id,
            title: routine.title,
            kind: "routine",
            minutes: minutes || routine.estimatedMinutes,
            protected: true,
          },
          "blocked",
        );
      } else if (routine.defaultTimeSegment !== "specific_window") {
        addBlock(
          day,
          routine.defaultTimeSegment,
          {
            id: routine.id,
            title: routine.title,
            kind: "routine",
            minutes: routine.estimatedMinutes,
            protected: true,
          },
          "blocked",
        );
      }
    }
  }

  const warnings: CapacityWarning[] = [];
  for (const day of days) {
    for (const segment of segments) {
      const result = day.segments[segment];
      finalizeSegment(result);
      if (result.state !== "over") continue;
      warnings.push({
        code: "over_capacity",
        dateKey: day.dateKey,
        segment,
        message: `${day.dateKey} ${segment} is over capacity by ${result.totalUsedMinutes - result.availableMinutes}m.`,
      });
    }
  }

  return {
    days,
    warnings: warnings.filter((warning) => {
      if (warning.dateKey <= nowKey) return true;
      const day = dayByKey.get(warning.dateKey);
      const segment = day?.segments[warning.segment];
      return Boolean(segment && segment.taskMinutes + segment.protectedMinutes > segment.availableMinutes);
    }),
  };
}
