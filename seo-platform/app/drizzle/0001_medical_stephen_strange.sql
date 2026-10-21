ALTER TABLE "crawl_jobs" ADD COLUMN "options" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "crawl_jobs" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "website_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "source_engine" varchar(32) NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "url" text NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "canonical_url" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "http_status" integer;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "evidence" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "discovered_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "websites" ADD COLUMN "verification_token" text NOT NULL;--> statement-breakpoint
ALTER TABLE "websites" ADD COLUMN "verification_method" varchar(16);--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_website_id_websites_id_fk" FOREIGN KEY ("website_id") REFERENCES "public"."websites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" DROP COLUMN "details";