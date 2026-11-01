CREATE TABLE `exports` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`workflow_instance_id` text,
	`size_bytes` integer,
	`error` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`ready_at` integer,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exports_workflow_instance_id_unique` ON `exports` (`workflow_instance_id`);--> statement-breakpoint
CREATE INDEX `exports_user_idx` ON `exports` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `exports_sweep_idx` ON `exports` (`status`,`expires_at`);
--> statement-breakpoint
-- Hand-added: record the schema version this migration brings the database to.
INSERT INTO `schema_version` (`version`) VALUES (10);