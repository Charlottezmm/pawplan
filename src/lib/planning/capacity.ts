type Segment = "morning" | "afternoon" | "evening";

type CapacityInput = {
  base: Record<Segment, number>;
  tasks: Array<{ segment: Segment; minutes: number }>;
  blocks: Array<{
    segment: Segment;
    minutes: number;
    kind: "routine" | "recovery" | "course" | "exam" | "meeting" | "unavailable";
  }>;
};

export function calculateRemainingCapacity(input: CapacityInput) {
  const remaining = { ...input.base };

  for (const task of input.tasks) {
    remaining[task.segment] -= task.minutes;
  }

  for (const block of input.blocks) {
    remaining[block.segment] -= block.minutes;
  }

  return {
    morning: Math.max(0, remaining.morning),
    afternoon: Math.max(0, remaining.afternoon),
    evening: Math.max(0, remaining.evening),
  };
}
