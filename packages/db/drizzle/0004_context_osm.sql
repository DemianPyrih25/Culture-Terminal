CREATE TABLE "context_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"model" text NOT NULL,
	"body" jsonb NOT NULL,
	"usd" numeric(10, 6) DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "context_cache_kind_check" CHECK ("context_cache"."kind" IN ('ai', 'web'))
);
--> statement-breakpoint
CREATE TABLE "feature_uses" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"feature" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"qloo_network" integer NOT NULL,
	"qloo_cached" integer NOT NULL,
	"public_calls" integer DEFAULT 0 NOT NULL,
	"llm_usd" numeric(10, 6) DEFAULT 0 NOT NULL,
	"ms" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "follows" ADD COLUMN "pending_run_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "context_cache_expires_idx" ON "context_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "feature_uses_feature_ts_idx" ON "feature_uses" USING btree ("feature","ts");--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_pending_run_id_runs_id_fk" FOREIGN KEY ("pending_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Hand-appended backfill (Part 11): runs created before started_at existed count as started, except the
-- ones that never left the queue: a queue timeout (an error event with code queue_timeout), and a run that
-- waited in the queue (run.queued) and then ended failed or cancelled with nothing but queue bookkeeping
-- (shutdown or cancel while queued: no event besides run.created, run.queued, error and run.end, and only
-- the manager's own run.created). Those keep a null started_at and count toward no visitor or global cap.
UPDATE "runs" SET "started_at" = "created_at"
WHERE "status" <> 'queued'
  AND NOT EXISTS (
    SELECT 1 FROM "run_events" e
    WHERE e."run_id" = "runs"."id" AND e."type" = 'error' AND e."payload" ->> 'code' = 'queue_timeout')
  AND NOT (
    "status" IN ('failed', 'cancelled')
    AND EXISTS (SELECT 1 FROM "run_events" e WHERE e."run_id" = "runs"."id" AND e."type" = 'run.queued')
    AND NOT EXISTS (
      SELECT 1 FROM "run_events" e
      WHERE e."run_id" = "runs"."id" AND e."type" NOT IN ('run.created', 'run.queued', 'error', 'run.end'))
    AND (SELECT count(*) FROM "run_events" e WHERE e."run_id" = "runs"."id" AND e."type" = 'run.created') <= 1);
