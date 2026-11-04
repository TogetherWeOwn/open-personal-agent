CREATE TABLE `capability_uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`task_id` text NOT NULL,
	`token_id` text NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `capability_uploads_token_idx` ON `capability_uploads` (`token_id`);--> statement-breakpoint
CREATE INDEX `capability_uploads_task_idx` ON `capability_uploads` (`task_id`);--> statement-breakpoint
CREATE TRIGGER `capability_uploads_task_id_owner_insert` BEFORE INSERT ON `capability_uploads`
WHEN NOT EXISTS (SELECT 1 FROM tasks WHERE id = NEW.task_id AND user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'cross_user_reference'); END;--> statement-breakpoint
CREATE TRIGGER `capability_uploads_task_id_owner_update` BEFORE UPDATE OF task_id, user_id ON `capability_uploads`
WHEN NOT EXISTS (SELECT 1 FROM tasks WHERE id = NEW.task_id AND user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'cross_user_reference'); END;--> statement-breakpoint
INSERT INTO `schema_version` (`version`) VALUES (32);