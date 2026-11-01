CREATE UNIQUE INDEX `exports_running_user_unique` ON `exports` (`user_id`) WHERE "exports"."status" = 'running';--> statement-breakpoint
-- Hand-added: record the schema version this migration brings the database to.
INSERT INTO `schema_version` (`version`) VALUES (13);
