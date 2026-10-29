CREATE TABLE "public_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"path" text NOT NULL,
	"params" jsonb NOT NULL,
	"status" integer NOT NULL,
	"body" "bytea" NOT NULL,
	"reference" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"pinned" boolean DEFAULT false NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	"last_hit_at" timestamp with time zone,
	"origin_run_id" text
);
--> statement-breakpoint
CREATE TABLE "public_calls" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"env" text NOT NULL,
	"tag" text,
	"run_id" text,
	"source" text NOT NULL,
	"path" text NOT NULL,
	"params" jsonb NOT NULL,
	"cache_key" text,
	"cache_status" text NOT NULL,
	"http_status" integer,
	"ms" integer,
	"reference" text,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "source" text DEFAULT 'qloo' NOT NULL;--> statement-breakpoint
ALTER TABLE "metrics" ADD COLUMN "period" text;--> statement-breakpoint
CREATE INDEX "public_cache_expires_idx" ON "public_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "public_calls_ts_idx" ON "public_calls" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "public_calls_run_idx" ON "public_calls" USING btree ("run_id","ts");--> statement-breakpoint
CREATE INDEX "public_calls_source_ts_idx" ON "public_calls" USING btree ("source","ts");