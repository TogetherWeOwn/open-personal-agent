CREATE TABLE `approvals` (
	`batch_id` text NOT NULL,
	`approval_id` text NOT NULL,
	`position` integer NOT NULL,
	`user_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`turn_id` text,
	`task_id` text,
	`tool` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`target` text,
	`risk` text NOT NULL,
	`rule` text NOT NULL,
	`step_up` integer NOT NULL,
	`scopes` text NOT NULL,
	`taint` text,
	`canonical` text NOT NULL,
	`binding_hash` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`scope` text,
	`reason` text,
	`nonce` text,
	`step_up_digest` text,
	`step_up_expires_at` integer,
	`step_up_session_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`decided_at` integer,
	`finished_at` integer,
	PRIMARY KEY(`batch_id`, `approval_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "approvals_one_context" CHECK(("approvals"."turn_id" IS NULL) <> ("approvals"."task_id" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `approvals_user_status_idx` ON `approvals` (`user_id`,`status`,`expires_at`);--> statement-breakpoint
-- Hand-added (TWO-427 L-4, as in 0015): an approval's conversation and task must be the same user's.
CREATE TRIGGER `approvals_conversation_id_owner_insert` BEFORE INSERT ON `approvals`
WHEN NOT EXISTS (SELECT 1 FROM `conversations` WHERE `id` = NEW.`conversation_id` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
CREATE TRIGGER `approvals_conversation_id_owner_update` BEFORE UPDATE OF `conversation_id`, `user_id` ON `approvals`
WHEN NOT EXISTS (SELECT 1 FROM `conversations` WHERE `id` = NEW.`conversation_id` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
CREATE TRIGGER `approvals_task_id_owner_insert` BEFORE INSERT ON `approvals`
WHEN NEW.`task_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `tasks` WHERE `id` = NEW.`task_id` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
CREATE TRIGGER `approvals_task_id_owner_update` BEFORE UPDATE OF `task_id`, `user_id` ON `approvals`
WHEN NEW.`task_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `tasks` WHERE `id` = NEW.`task_id` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
-- Hand-added: record the schema version this migration brings the database to.
INSERT INTO `schema_version` (`version`) VALUES (17);
