ALTER TABLE `tasks` ADD `limit_kind` text;--> statement-breakpoint
ALTER TABLE `usage` ADD `task_id` text REFERENCES tasks(id) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
CREATE INDEX `usage_task_idx` ON `usage` (`user_id`,`task_id`);--> statement-breakpoint
-- Hand-added: record the schema version this migration brings the database to.
INSERT INTO `schema_version` (`version`) VALUES (14);