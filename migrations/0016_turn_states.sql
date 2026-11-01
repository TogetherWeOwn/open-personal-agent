CREATE TABLE `turn_states` (
	`turn_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`reply_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`model` text NOT NULL,
	`status` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `turn_states_user_conversation_idx` ON `turn_states` (`user_id`,`conversation_id`);--> statement-breakpoint
-- Hand-added (TWO-427 L-4, as in 0015): a stopped turn's conversation must be the same user's.
CREATE TRIGGER `turn_states_conversation_id_owner_insert` BEFORE INSERT ON `turn_states`
WHEN NOT EXISTS (SELECT 1 FROM `conversations` WHERE `id` = NEW.`conversation_id` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
CREATE TRIGGER `turn_states_conversation_id_owner_update` BEFORE UPDATE OF `conversation_id`, `user_id` ON `turn_states`
WHEN NOT EXISTS (SELECT 1 FROM `conversations` WHERE `id` = NEW.`conversation_id` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
-- Hand-added: record the schema version this migration brings the database to.
INSERT INTO `schema_version` (`version`) VALUES (16);
