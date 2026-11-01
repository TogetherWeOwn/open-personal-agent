PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`conversation_id` text,
	`message_id` text,
	`provider_id` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cached_input_tokens` integer DEFAULT 0 NOT NULL,
	`cost_micro_usd` integer,
	`cost_source` text,
	`price_verified_at` text,
	`neurons` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
-- Hand-edited: rows from before the price table carry a placeholder cost of 0, so they become
-- "no price on file". The new columns don't exist in the old table.
INSERT INTO `__new_usage`("id", "user_id", "conversation_id", "message_id", "provider_id", "model", "input_tokens", "output_tokens", "cached_input_tokens", "cost_micro_usd", "cost_source", "price_verified_at", "neurons", "created_at") SELECT "id", "user_id", "conversation_id", "message_id", "provider_id", "model", "input_tokens", "output_tokens", "cached_input_tokens", NULL, NULL, NULL, NULL, "created_at" FROM `usage`;--> statement-breakpoint
DROP TABLE `usage`;--> statement-breakpoint
ALTER TABLE `__new_usage` RENAME TO `usage`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `usage_user_idx` ON `usage` (`user_id`,`created_at`);--> statement-breakpoint
-- Hand-added: record the schema version this migration brings the database to.
INSERT INTO `schema_version` (`version`) VALUES (4);
