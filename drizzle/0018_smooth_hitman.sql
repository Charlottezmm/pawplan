ALTER TABLE "time_block_exceptions" ADD COLUMN "override_location" varchar(240);--> statement-breakpoint
ALTER TABLE "time_blocks" ADD COLUMN "location" varchar(240);