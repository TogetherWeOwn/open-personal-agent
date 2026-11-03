CREATE TABLE `capability_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`user_id` text NOT NULL,
	`task_id` text NOT NULL,
	`computer_id` text NOT NULL,
	`aud` text NOT NULL,
	`model_allowlist` text,
	`task_epoch` integer DEFAULT 0 NOT NULL,
	`user_epoch` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`revoked_at` integer,
	`revoked_reason` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `capability_tokens_token_hash_unique` ON `capability_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `capability_tokens_task_idx` ON `capability_tokens` (`task_id`,`aud`,`computer_id`);--> statement-breakpoint
CREATE INDEX `capability_tokens_user_idx` ON `capability_tokens` (`user_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `token_epoch` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `token_epoch` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Hand-added: record the schema version this migration brings the database to.
INSERT INTO `schema_version` (`version`) VALUES (26);
