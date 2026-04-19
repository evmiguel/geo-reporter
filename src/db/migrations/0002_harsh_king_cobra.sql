ALTER TABLE "stripe_payments" ALTER COLUMN "grade_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "stripe_payments" ADD COLUMN "kind" text DEFAULT 'report' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "credits" integer DEFAULT 0 NOT NULL;