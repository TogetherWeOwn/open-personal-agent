CREATE TABLE `grants` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`tool` text NOT NULL,
	`scope` text NOT NULL,
	`task_id` text,
	`destination` text,
	`expires_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "grants_scope_target" CHECK(("grants"."scope" = 'task' AND "grants"."task_id" IS NOT NULL) OR ("grants"."scope" = 'hour' AND "grants"."expires_at" IS NOT NULL) OR ("grants"."scope" = 'destination' AND "grants"."destination" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `grants_user_tool_idx` ON `grants` (`user_id`,`tool`);--> statement-breakpoint
CREATE TABLE `tool_overrides` (
	`user_id` text NOT NULL,
	`tool` text NOT NULL,
	`decision` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`user_id`, `tool`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "tool_overrides_decision" CHECK("tool_overrides"."decision" IN ('auto', 'ask', 'never'))
);
--> statement-breakpoint
ALTER TABLE `sessions` ADD `step_up_at` integer;--> statement-breakpoint
-- Hand-added: record the schema version this migration brings the database to.
INSERT INTO `schema_version` (`version`) VALUES (5);
