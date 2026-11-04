CREATE TABLE `capability_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`task_id` text NOT NULL,
	`token_id` text NOT NULL,
	`computer_id` text NOT NULL,
	`client_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`master_id` text NOT NULL,
	`status` text NOT NULL,
	`response` text,
	`status_code` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `capability_calls_task_key_idx` ON `capability_calls` (`task_id`,`client_key`);--> statement-breakpoint
CREATE INDEX `capability_calls_token_idx` ON `capability_calls` (`token_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `capability_calls_pending_idx` ON `capability_calls` (`task_id`,`computer_id`,`request_hash`,`status`);--> statement-breakpoint
ALTER TABLE `capability_tokens` ADD `tool_allowlist` text;--> statement-breakpoint
CREATE TRIGGER `capability_calls_task_id_owner_insert` BEFORE INSERT ON `capability_calls`
WHEN NOT EXISTS (SELECT 1 FROM tasks WHERE id = NEW.task_id AND user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'cross_user_reference'); END;--> statement-breakpoint
CREATE TRIGGER `capability_calls_task_id_owner_update` BEFORE UPDATE OF task_id, user_id ON `capability_calls`
WHEN NOT EXISTS (SELECT 1 FROM tasks WHERE id = NEW.task_id AND user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'cross_user_reference'); END;--> statement-breakpoint
INSERT INTO `schema_version` (`version`) VALUES (33);