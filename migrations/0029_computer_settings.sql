CREATE TABLE `computer_egress_hosts` (
	`user_id` text NOT NULL,
	`host` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`user_id`, `host`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `tasks` ADD `computer_provider` text;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `computer_default_provider` text;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `computer_persistence` text DEFAULT 'ephemeral' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `computer_size` text;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `computer_idle_timeout_seconds` integer DEFAULT 300 NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `computer_max_lifetime_seconds` integer DEFAULT 3600 NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `computer_internet_allowed` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Hand-added: record the schema version this migration brings the database to.
INSERT INTO `schema_version` (`version`) VALUES (29);