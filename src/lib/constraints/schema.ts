import { z } from "zod";

export const editableTimeBlockKinds = ["course", "meeting", "unavailable", "routine", "recovery"] as const;
export const editableTimeBlockKindSchema = z.enum(editableTimeBlockKinds);

const dateTimeSchema = z.string().datetime({ offset: true }).transform((value) => new Date(value));

export const timeBlockInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    title: z.string().trim().min(1).max(180),
    kind: editableTimeBlockKindSchema,
    startsAt: dateTimeSchema,
    endsAt: dateTimeSchema,
    location: z.string().trim().max(240).nullish(),
    recurrenceRule: z.string().trim().max(240).nullish(),
    courseName: z.string().trim().max(120).nullish(),
    color: z.string().trim().max(32).nullish(),
  })
  .superRefine((block, context) => {
    const durationMs = block.endsAt.getTime() - block.startsAt.getTime();
    if (durationMs <= 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "endsAt must be after startsAt",
        path: ["endsAt"],
      });
    }
    if (durationMs > 12 * 60 * 60 * 1000) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "duration must be 12 hours or less",
        path: ["endsAt"],
      });
    }
    if (block.kind === "course" && !block.courseName?.trim()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "courseName is required for course blocks",
        path: ["courseName"],
      });
    }
  });

export const constraintsPostSchema = z.object({
  action: z.literal("upsert_time_block"),
  timeBlock: timeBlockInputSchema,
});

export const constraintsPatchSchema = z.object({
  action: z.literal("delete_time_block"),
  id: z.string().uuid(),
});

export type EditableTimeBlockKind = z.infer<typeof editableTimeBlockKindSchema>;
export type TimeBlockInput = z.infer<typeof timeBlockInputSchema>;
