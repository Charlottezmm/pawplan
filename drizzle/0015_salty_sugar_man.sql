CREATE TYPE "public"."time_block_exception_action" AS ENUM('cancel', 'override');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "plan_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"plan_id" uuid,
	"operation_kind" varchar(48) NOT NULL,
	"idempotency_key" varchar(200) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"group_id" uuid,
	"status" varchar(24) NOT NULL,
	"result_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_json" jsonb,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "plan_window_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"source_key" varchar(160) NOT NULL,
	"base_version_id" uuid,
	"request_hash" varchar(64) NOT NULL,
	"diff_json" jsonb NOT NULL,
	"result_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "plan_window_task_refs" (
	"workspace_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"source_key" varchar(160) NOT NULL,
	"external_task_key" varchar(200) NOT NULL,
	"task_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "time_block_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"series_id" uuid NOT NULL,
	"occurrence_date" date NOT NULL,
	"action" "time_block_exception_action" NOT NULL,
	"override_title" varchar(180),
	"override_kind" "time_block_kind",
	"override_starts_at" timestamp with time zone,
	"override_ends_at" timestamp with time zone,
	"override_protected" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX IF EXISTS "tasks_overdue_candidate_idx";--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "time_blocks" ADD COLUMN "protected" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "time_blocks" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "time_blocks" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "time_blocks" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "plan_operations" ADD CONSTRAINT "plan_operations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "plan_operations" ADD CONSTRAINT "plan_operations_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "plan_window_revisions" ADD CONSTRAINT "plan_window_revisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "plan_window_revisions" ADD CONSTRAINT "plan_window_revisions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "plan_window_revisions" ADD CONSTRAINT "plan_window_revisions_operation_id_plan_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."plan_operations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "plan_window_task_refs" ADD CONSTRAINT "plan_window_task_refs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "plan_window_task_refs" ADD CONSTRAINT "plan_window_task_refs_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "plan_window_task_refs" ADD CONSTRAINT "plan_window_task_refs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "plan_window_task_refs" ADD CONSTRAINT "plan_window_task_refs_revision_id_plan_window_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."plan_window_revisions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "time_block_exceptions" ADD CONSTRAINT "time_block_exceptions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "time_block_exceptions" ADD CONSTRAINT "time_block_exceptions_series_id_time_blocks_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."time_blocks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plan_operations_workspace_idempotency_unique" ON "plan_operations" USING btree ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plan_operations_workspace_created_idx" ON "plan_operations" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plan_operations_workspace_group_idx" ON "plan_operations" USING btree ("workspace_id","group_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plan_window_revisions_workspace_source_created_idx" ON "plan_window_revisions" USING btree ("workspace_id","source_key","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plan_window_task_refs_plan_source_external_unique" ON "plan_window_task_refs" USING btree ("plan_id","source_key","external_task_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plan_window_task_refs_workspace_task_idx" ON "plan_window_task_refs" USING btree ("workspace_id","task_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "time_block_exceptions_workspace_series_occurrence_unique" ON "time_block_exceptions" USING btree ("workspace_id","series_id","occurrence_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "time_block_exceptions_workspace_occurrence_idx" ON "time_block_exceptions" USING btree ("workspace_id","occurrence_date");--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "plan_versions"
    GROUP BY "plan_id", "version_number"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot add plan version uniqueness: duplicate plan/version rows exist';
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plan_versions_plan_version_unique" ON "plan_versions" USING btree ("plan_id","version_number");--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "plans"
    WHERE "status" = 'active'
    GROUP BY "workspace_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot add active-plan uniqueness: a workspace has multiple active plans';
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plans_workspace_active_unique" ON "plans" USING btree ("workspace_id") WHERE "plans"."status" = 'active';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_workspace_active_date_idx" ON "tasks" USING btree ("workspace_id","plan_id","date") WHERE "tasks"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_overdue_candidate_idx" ON "tasks" USING btree ("workspace_id","plan_id","status","date") WHERE "tasks"."status" = 'todo' AND "tasks"."archived_at" IS NULL;
