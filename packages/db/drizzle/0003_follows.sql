CREATE TABLE "follows" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"visitor_key" text NOT NULL,
	"kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"label" text NOT NULL,
	"question" text NOT NULL,
	"job" text,
	"metro" text,
	"latest_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follows_kind_check" CHECK ("follows"."kind" IN ('brand', 'place', 'question'))
);
--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_latest_run_id_runs_id_fk" FOREIGN KEY ("latest_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "follows_visitor_subject_uq" ON "follows" USING btree ("visitor_key","kind","subject_key");--> statement-breakpoint
CREATE INDEX "follows_visitor_created_idx" ON "follows" USING btree ("visitor_key","created_at");--> statement-breakpoint
CREATE INDEX "follows_latest_run_idx" ON "follows" USING btree ("latest_run_id");