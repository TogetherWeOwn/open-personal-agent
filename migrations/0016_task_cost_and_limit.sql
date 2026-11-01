ALTER TABLE `tasks` ADD `limit_kind` text;--> statement-breakpoint
ALTER TABLE `usage` ADD `task_id` text REFERENCES tasks(id) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
CREATE INDEX `usage_task_idx` ON `usage` (`user_id`,`task_id`);--> statement-breakpoint
-- Hand-added (TWO-427 L-4, like migration 0015): a usage row must not point at another user's
-- task. SQLite can't add a composite foreign key without rebuilding the table, so these
-- triggers do what `FOREIGN KEY (task_id, user_id) REFERENCES tasks (id, user_id)` would.
CREATE TRIGGER `usage_task_id_owner_insert` BEFORE INSERT ON `usage`
WHEN NEW.`task_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `tasks` WHERE `id` = NEW.`task_id` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
CREATE TRIGGER `usage_task_id_owner_update` BEFORE UPDATE OF `task_id`, `user_id` ON `usage`
WHEN NEW.`task_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `tasks` WHERE `id` = NEW.`task_id` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
-- Hand-added: record the schema version this migration brings the database to.
INSERT INTO `schema_version` (`version`) VALUES (16);
