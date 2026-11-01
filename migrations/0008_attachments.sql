CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`conversation_id` text,
	`message_id` text,
	`name` text NOT NULL,
	`media_type` text NOT NULL,
	`kind` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sent_to_model` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `attachments_user_message_idx` ON `attachments` (`user_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `attachments_user_created_idx` ON `attachments` (`user_id`,`created_at`);
--> statement-breakpoint
-- Hand-added: record the schema version this migration brings the database to.
INSERT INTO `schema_version` (`version`) VALUES (8);
