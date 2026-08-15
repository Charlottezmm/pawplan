CREATE TYPE "public"."milestone_status" AS ENUM('planned', 'in_progress', 'completed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('active', 'paused', 'completed', 'archived');--> statement-breakpoint
ALTER TYPE "public"."agent_run_kind" ADD VALUE 'overdue_replan';--> statement-breakpoint
ALTER TYPE "public"."agent_run_status" ADD VALUE 'needs_decision';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"title" varchar(180) NOT NULL,
	"objective" text,
	"success_criteria" text,
	"target_date" timestamp with time zone,
	"status" "milestone_status" DEFAULT 'planned' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "category" varchar(80);--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "objective" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "success_criteria" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "status" "project_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "priority" "priority" DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "start_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "target_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "weekly_target_minutes" integer;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "needs_definition" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "milestone_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "original_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "rollover_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "last_rollover_at" timestamp with time zone;--> statement-breakpoint
UPDATE "tasks" SET "original_date" = "date" WHERE "original_date" IS NULL;--> statement-breakpoint
DO $$
DECLARE
  orphan_parent_count integer;
BEGIN
  SELECT count(*) INTO orphan_parent_count
  FROM "tasks" child
  WHERE child."parent_task_id" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM "tasks" parent WHERE parent."id" = child."parent_task_id"
    );

  IF orphan_parent_count > 0 THEN
    RAISE NOTICE 'Clearing % orphaned tasks.parent_task_id values before adding the self-reference', orphan_parent_count;
    UPDATE "tasks" child
    SET "parent_task_id" = NULL
    WHERE child."parent_task_id" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "tasks" parent WHERE parent."id" = child."parent_task_id"
      );
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_milestones_workspace_project_position_idx" ON "project_milestones" USING btree ("workspace_id","project_id","position");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_milestones_workspace_status_target_idx" ON "project_milestones" USING btree ("workspace_id","status","target_date");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tasks" ADD CONSTRAINT "tasks_milestone_id_project_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."project_milestones"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_task_id_tasks_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_workspace_project_idx" ON "tasks" USING btree ("workspace_id","project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_workspace_milestone_idx" ON "tasks" USING btree ("workspace_id","milestone_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_overdue_candidate_idx" ON "tasks" USING btree ("workspace_id","status","date") WHERE "tasks"."status" = 'todo';
