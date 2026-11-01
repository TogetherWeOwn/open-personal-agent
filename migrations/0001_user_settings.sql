CREATE TABLE `user_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`about` text,
	`model_kind` text,
	`provider_id` text,
	`base_url` text,
	`model` text,
	`model_key_secret_id` text,
	`onboarded_at` integer,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`model_key_secret_id`) REFERENCES `secrets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
-- Hand-added: record the schema version this migration brings the database to.
INSERT INTO `schema_version` (`version`) VALUES (1);
