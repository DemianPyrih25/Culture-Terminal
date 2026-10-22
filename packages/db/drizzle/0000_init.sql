CREATE TABLE "datasets" (
	"run_id" text NOT NULL,
	"id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"bytes" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "datasets_pk" PRIMARY KEY("run_id","id")
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"run_id" text NOT NULL,
	"id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"skill" text NOT NULL,
	"purpose" text,
	"status" text,
	"qloo_call_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"cached" boolean DEFAULT false NOT NULL,
	"request_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"provenance" jsonb,
	"summary" text,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "evidence_pk" PRIMARY KEY("run_id","id")
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"run_id" text NOT NULL,
	"id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"severity" text,
	"text" text NOT NULL,
	"metric_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"suggestion" jsonb,
	CONSTRAINT "findings_pk" PRIMARY KEY("run_id","id")
);
--> statement-breakpoint
CREATE TABLE "ip_usage" (
	"day" date NOT NULL,
	"ip_hash" text NOT NULL,
	"runs" integer DEFAULT 0 NOT NULL,
	"qloo_calls" integer DEFAULT 0 NOT NULL,
	"llm_usd" double precision DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ip_usage_pk" PRIMARY KEY("day","ip_hash")
);
--> statement-breakpoint
CREATE TABLE "kv" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metrics" (
	"run_id" text NOT NULL,
	"id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"subject_refs" text[] DEFAULT '{}'::text[] NOT NULL,
	"value" double precision,
	"display" text,
	"unit" text,
	"badge" text NOT NULL,
	"formula_id" text,
	"evidence_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"n" integer,
	"conf" double precision,
	CONSTRAINT "metrics_pk" PRIMARY KEY("run_id","id")
);
--> statement-breakpoint
CREATE TABLE "qloo_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"path" text NOT NULL,
	"params" jsonb NOT NULL,
	"status" integer NOT NULL,
	"body" "bytea" NOT NULL,
	"request_id" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"pinned" boolean DEFAULT false NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	"last_hit_at" timestamp with time zone,
	"origin_run_id" text
);
--> statement-breakpoint
CREATE TABLE "qloo_calls" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"env" text NOT NULL,
	"tag" text,
	"run_id" text,
	"path" text NOT NULL,
	"filter_type" text,
	"params" jsonb NOT NULL,
	"cache_key" text,
	"cache_status" text NOT NULL,
	"http_status" integer,
	"ms" integer,
	"request_id" text,
	"month_remaining" integer,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "run_events_pk" PRIMARY KEY("run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"question" text NOT NULL,
	"question_hash" text NOT NULL,
	"pillar" text,
	"job" text,
	"intent" jsonb,
	"pins" jsonb,
	"mode" text DEFAULT 'live' NOT NULL,
	"is_showcase" boolean DEFAULT false NOT NULL,
	"showcase_slug" text,
	"showcase_order" integer,
	"parent_run_id" text,
	"ip_hash" text,
	"lane" text DEFAULT 'public' NOT NULL,
	"model" text,
	"effort" text,
	"wall_ms" integer,
	"llm_usd" double precision DEFAULT 0 NOT NULL,
	"tokens" integer DEFAULT 0 NOT NULL,
	"qloo_network" integer DEFAULT 0 NOT NULL,
	"qloo_cached" integer DEFAULT 0 NOT NULL,
	"report" jsonb,
	"validation" jsonb,
	"ghost" jsonb,
	"transcript" jsonb,
	"error" jsonb,
	"cancel_requested_at" timestamp with time zone,
	CONSTRAINT "runs_status_check" CHECK ("runs"."status" IN ('queued', 'needs_input', 'running', 'completed', 'incomplete', 'failed', 'cancelled', 'refused'))
);
--> statement-breakpoint
CREATE TABLE "showcase_pins" (
	"slug" text NOT NULL,
	"mention" text NOT NULL,
	"entity_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"pinned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "showcase_pins_pk" PRIMARY KEY("slug","mention")
);
--> statement-breakpoint
CREATE TABLE "usage_daily" (
	"day" date NOT NULL,
	"metric" text NOT NULL,
	"lane" text DEFAULT 'all' NOT NULL,
	"value" double precision DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_daily_pk" PRIMARY KEY("day","metric","lane")
);
--> statement-breakpoint
ALTER TABLE "datasets" ADD CONSTRAINT "datasets_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metrics" ADD CONSTRAINT "metrics_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_parent_run_id_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "qloo_cache_expires_idx" ON "qloo_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "qloo_calls_ts_idx" ON "qloo_calls" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "qloo_calls_run_idx" ON "qloo_calls" USING btree ("run_id","ts");--> statement-breakpoint
CREATE INDEX "qloo_calls_tag_ts_idx" ON "qloo_calls" USING btree ("tag","ts");--> statement-breakpoint
CREATE INDEX "runs_answer_cache_idx" ON "runs" USING btree ("question_hash","status","created_at");--> statement-breakpoint
CREATE INDEX "runs_status_created_idx" ON "runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "runs_ip_created_idx" ON "runs" USING btree ("ip_hash","created_at");--> statement-breakpoint
CREATE INDEX "runs_parent_idx" ON "runs" USING btree ("parent_run_id");--> statement-breakpoint
CREATE INDEX "runs_showcase_idx" ON "runs" USING btree ("showcase_slug","showcase_order") WHERE "runs"."is_showcase";