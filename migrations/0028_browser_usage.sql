CREATE TABLE `browser_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`conversation_id` text,
	`task_id` text,
	`seconds` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `browser_usage_user_idx` ON `browser_usage` (`user_id`,`created_at`);
--> statement-breakpoint
-- Hand-added (as in 0015/0019): a browser-usage row must not point at another user's
-- conversation or task. SQLite can't add a composite foreign key without rebuilding the
-- table, so these triggers do what `FOREIGN KEY (x, user_id) REFERENCES t (id, user_id)` would.
CREATE TRIGGER `browser_usage_conversation_id_owner_insert` BEFORE INSERT ON `browser_usage`
WHEN NEW.`conversation_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `conversations` WHERE `id` = NEW.`conversation_id` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
CREATE TRIGGER `browser_usage_conversation_id_owner_update` BEFORE UPDATE OF `conversation_id`, `user_id` ON `browser_usage`
WHEN NEW.`conversation_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `conversations` WHERE `id` = NEW.`conversation_id` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
CREATE TRIGGER `browser_usage_task_id_owner_insert` BEFORE INSERT ON `browser_usage`
WHEN NEW.`task_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `tasks` WHERE `id` = NEW.`task_id` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
CREATE TRIGGER `browser_usage_task_id_owner_update` BEFORE UPDATE OF `task_id`, `user_id` ON `browser_usage`
WHEN NEW.`task_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `tasks` WHERE `id` = NEW.`task_id` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
-- Hand-added: record the schema version this migration brings the database to.
INSERT INTO `schema_version` (`version`) VALUES (28);
