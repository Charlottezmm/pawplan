ALTER TABLE "tasks" ADD COLUMN "scheduled_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "scheduled_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "target_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "checkpoint" text;--> statement-breakpoint
-- Older date-only writers must not leave a precise slot on the wrong day.
CREATE FUNCTION pawplan_guard_task_timing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND ((NEW.date AT TIME ZONE 'Asia/Shanghai')::date IS DISTINCT FROM (OLD.date AT TIME ZONE 'Asia/Shanghai')::date OR NEW.day_segment IS DISTINCT FROM OLD.day_segment) THEN
    IF NOT OLD.movable AND NOT NEW.movable AND OLD.scheduled_start IS NOT NULL THEN
      RAISE EXCEPTION 'Task time is protected; unlock it before rescheduling';
    END IF;
    IF NEW.scheduled_start IS NOT DISTINCT FROM OLD.scheduled_start THEN
      NEW.scheduled_start := NULL;
      NEW.scheduled_end := NULL;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = 'backlog' AND OLD.status <> 'backlog' AND NOT OLD.movable AND NOT NEW.movable AND OLD.scheduled_start IS NOT NULL THEN
    RAISE EXCEPTION 'Task time is protected; unlock it before moving to backlog';
  END IF;
  IF NEW.status = 'backlog' OR NEW.archived_at IS NOT NULL THEN
    NEW.scheduled_start := NULL;
    NEW.scheduled_end := NULL;
  END IF;
  IF (NEW.scheduled_start IS NULL) <> (NEW.scheduled_end IS NULL) OR
     (NEW.scheduled_start IS NOT NULL AND (NEW.scheduled_end <= NEW.scheduled_start OR
      (NEW.scheduled_start AT TIME ZONE 'Asia/Shanghai')::date <> (NEW.date AT TIME ZONE 'Asia/Shanghai')::date OR
      ((NEW.scheduled_end - interval '1 millisecond') AT TIME ZONE 'Asia/Shanghai')::date <> (NEW.date AT TIME ZONE 'Asia/Shanghai')::date)) THEN
    RAISE EXCEPTION 'Invalid task time window';
  END IF;
  IF NEW.deadline_at IS NOT NULL AND NEW.status = 'todo' AND
    (NEW.scheduled_end > NEW.deadline_at OR (NEW.date AT TIME ZONE 'Asia/Shanghai')::date > (NEW.deadline_at AT TIME ZONE 'Asia/Shanghai')::date) THEN
    RAISE EXCEPTION 'Task schedule exceeds deadline';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER tasks_timing_guard BEFORE INSERT OR UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION pawplan_guard_task_timing();
