CREATE TABLE IF NOT EXISTS "operation_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"operation_kind" varchar(48) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"preview_hash" varchar(64) NOT NULL,
	"status" varchar(24) DEFAULT 'pending' NOT NULL,
	"summary_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "operation_approvals" ADD CONSTRAINT "operation_approvals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "operation_approvals_workspace_status_created_idx" ON "operation_approvals" USING btree ("workspace_id","status","created_at");