CREATE TABLE `model_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`provider_id` text,
	`base_url` text,
	`model` text,
	`key_secret_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`key_secret_id`) REFERENCES `secrets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `model_providers_user_idx` ON `model_providers` (`user_id`,`created_at`);--> statement-breakpoint
-- Hand-edited: drizzle-kit drops the ON DELETE clause from an added column's reference.
ALTER TABLE `conversations` ADD `model_provider` text REFERENCES model_providers(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `conversations` ADD `model` text;--> statement-breakpoint
-- Hand-added: each saved model becomes a provider row. A starter user's key was kept for
-- switching back, so it gets its own row, with no model: the starter overwrote it.
INSERT INTO `model_providers` ("id", "user_id", "kind", "provider_id", "base_url", "model", "key_secret_id") SELECT lower(hex(randomblob(16))), "user_id", 'openai-chat', "provider_id", "base_url", CASE WHEN "model_kind" = 'openai-chat' THEN "model" END, "model_key_secret_id" FROM `user_settings` WHERE "provider_id" IS NOT NULL AND "base_url" IS NOT NULL AND ("model_kind" = 'openai-chat' OR "model_key_secret_id" IS NOT NULL);--> statement-breakpoint
INSERT INTO `model_providers` ("id", "user_id", "kind", "model") SELECT lower(hex(randomblob(16))), "user_id", 'workers-ai', "model" FROM `user_settings` WHERE "model_kind" = 'workers-ai';--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_user_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`about` text,
	`chat_provider` text,
	`chat_model` text,
	`background_provider` text,
	`background_model` text,
	`onboarded_at` integer,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chat_provider`) REFERENCES `model_providers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`background_provider`) REFERENCES `model_providers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
-- Hand-edited: the saved model becomes the Chat role. Background stays null, the cheapest.
INSERT INTO `__new_user_settings`("user_id", "about", "chat_provider", "chat_model", "onboarded_at", "updated_at") SELECT s."user_id", s."about", (SELECT p."id" FROM `model_providers` p WHERE p."user_id" = s."user_id" AND p."kind" = s."model_kind"), CASE WHEN s."model_kind" IS NOT NULL THEN s."model" END, s."onboarded_at", s."updated_at" FROM `user_settings` s;--> statement-breakpoint
DROP TABLE `user_settings`;--> statement-breakpoint
ALTER TABLE `__new_user_settings` RENAME TO `user_settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
-- Hand-added: record the schema version this migration brings the database to.
INSERT INTO `schema_version` (`version`) VALUES (5);
