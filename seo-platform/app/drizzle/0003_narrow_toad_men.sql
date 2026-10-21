CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"website_id" uuid NOT NULL,
	"crawl_job_id" uuid,
	"type" varchar(32) NOT NULL,
	"severity" varchar(16),
	"title" text NOT NULL,
	"body" text NOT NULL,
	"is_read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crawl_jobs" ADD COLUMN "trigger" varchar(16) DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "crawl_jobs" ADD COLUMN "pg_boss_job_id" text;--> statement-breakpoint
ALTER TABLE "crawl_jobs" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "websites" ADD COLUMN "audit_schedule" varchar(16) DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "websites" ADD COLUMN "last_scheduled_crawl_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "websites" ADD COLUMN "last_homepage_etag" text;--> statement-breakpoint
ALTER TABLE "websites" ADD COLUMN "last_homepage_last_modified" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_website_id_websites_id_fk" FOREIGN KEY ("website_id") REFERENCES "public"."websites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_crawl_job_id_crawl_jobs_id_fk" FOREIGN KEY ("crawl_job_id") REFERENCES "public"."crawl_jobs"("id") ON DELETE cascade ON UPDATE no action;