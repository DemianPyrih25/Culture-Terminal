ALTER TABLE "evidence" ADD COLUMN "quality_gate_drops" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "metrics" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "metrics" ADD COLUMN "comparator" text;--> statement-breakpoint
ALTER TABLE "metrics" ADD COLUMN "window" jsonb;