export type TimetableInterval = {
  id: string;
  startMinute: number;
  endMinute: number;
};

export type TimetableLayoutItem<T extends TimetableInterval> = T & {
  lane: number;
  laneCount: number;
  top: number;
  height: number;
  conflict: boolean;
};

export type TimetableAxis = {
  startMinute: number;
  endMinute: number;
};

const defaultAxisStart = 6 * 60;
const defaultAxisEnd = 23 * 60;

function clampMinute(value: number) {
  return Math.max(0, Math.min(24 * 60, value));
}

export function buildTimetableAxis(intervals: TimetableInterval[]): TimetableAxis {
  if (intervals.length === 0) {
    return { startMinute: defaultAxisStart, endMinute: defaultAxisEnd };
  }

  const earliest = Math.min(...intervals.map((item) => item.startMinute));
  const latest = Math.max(...intervals.map((item) => item.endMinute));
  const extendedStart = Math.floor((earliest - 30) / 60) * 60;
  const extendedEnd = Math.ceil((latest + 30) / 60) * 60;

  return {
    startMinute: clampMinute(Math.min(defaultAxisStart, extendedStart)),
    endMinute: clampMinute(Math.max(defaultAxisEnd, extendedEnd)),
  };
}

function validateInterval(interval: TimetableInterval) {
  if (
    !Number.isFinite(interval.startMinute) ||
    !Number.isFinite(interval.endMinute) ||
    interval.startMinute < 0 ||
    interval.endMinute > 24 * 60 ||
    interval.endMinute <= interval.startMinute
  ) {
    throw new Error(`Invalid timetable interval: ${interval.id}`);
  }
}

export function layoutTimetableIntervals<T extends TimetableInterval>(
  intervals: T[],
  axis: TimetableAxis = buildTimetableAxis(intervals),
): Array<TimetableLayoutItem<T>> {
  if (axis.endMinute <= axis.startMinute) throw new Error("Invalid timetable axis");
  for (const interval of intervals) validateInterval(interval);

  const sorted = [...intervals].sort(
    (first, second) =>
      first.startMinute - second.startMinute ||
      first.endMinute - second.endMinute ||
      first.id.localeCompare(second.id),
  );
  const result: Array<TimetableLayoutItem<T>> = [];

  for (let startIndex = 0; startIndex < sorted.length;) {
    let endIndex = startIndex + 1;
    let componentEnd = sorted[startIndex].endMinute;

    while (endIndex < sorted.length && sorted[endIndex].startMinute < componentEnd) {
      componentEnd = Math.max(componentEnd, sorted[endIndex].endMinute);
      endIndex += 1;
    }

    const component = sorted.slice(startIndex, endIndex);
    const laneEnds: number[] = [];
    const assigned = component.map((interval) => {
      let lane = laneEnds.findIndex((laneEnd) => laneEnd <= interval.startMinute);
      if (lane === -1) lane = laneEnds.length;
      laneEnds[lane] = interval.endMinute;
      return { interval, lane };
    });
    const laneCount = laneEnds.length;

    for (const { interval, lane } of assigned) {
      result.push({
        ...interval,
        lane,
        laneCount,
        top: interval.startMinute - axis.startMinute,
        height: interval.endMinute - interval.startMinute,
        conflict: laneCount > 1,
      });
    }

    startIndex = endIndex;
  }

  return result.sort(
    (first, second) =>
      first.startMinute - second.startMinute ||
      first.endMinute - second.endMinute ||
      first.id.localeCompare(second.id),
  );
}

export function minuteLabel(minute: number) {
  const hours = Math.floor(minute / 60);
  const minutes = minute % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}
