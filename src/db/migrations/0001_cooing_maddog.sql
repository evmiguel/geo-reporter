CREATE INDEX IF NOT EXISTS "grades_user_id_idx" ON "grades" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "grades_cookie_idx" ON "grades" USING btree ("cookie","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "probes_grade_id_idx" ON "probes" USING btree ("grade_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recommendations_grade_id_idx" ON "recommendations" USING btree ("grade_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stripe_payments_grade_id_idx" ON "stripe_payments" USING btree ("grade_id");