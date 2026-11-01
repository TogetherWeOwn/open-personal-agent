ALTER TABLE `tasks` ADD `outputs_removed_at` integer;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `message_retention_days` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `tool_output_retention_days` integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `memory_inbox_days` integer DEFAULT 14 NOT NULL;--> statement-breakpoint
-- Hand-added: record the schema version this migration brings the database to.
INSERT INTO `schema_version` (`version`) VALUES (11);
