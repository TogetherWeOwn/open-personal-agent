CREATE TABLE `computer_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`computer_id` text NOT NULL,
	`task_id` text,
	`provider` text NOT NULL,
	`profile` text NOT NULL,
	`provider_computer_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer NOT NULL,
	`end_reason` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`computer_id`) REFERENCES `computers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `computer_sessions_user_idx` ON `computer_sessions` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `computers` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`profile` text NOT NULL,
	`provider_computer_id` text NOT NULL,
	`task_id` text,
	`disks` text DEFAULT '[]' NOT NULL,
	`snapshots` text DEFAULT '[]' NOT NULL,
	`idle_timeout_seconds` integer NOT NULL,
	`max_lifetime_seconds` integer NOT NULL,
	`state` text DEFAULT 'ready' NOT NULL,
	`last_used_at` integer NOT NULL,
	`idle_deadline` integer NOT NULL,
	`lifetime_deadline` integer NOT NULL,
	`ended_at` integer,
	`end_reason` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `computers_user_idx` ON `computers` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `computers_sweep_idx` ON `computers` (`state`,`idle_deadline`,`lifetime_deadline`);--> statement-breakpoint
-- Hand-added (TWO-427 L-4, as in 0015): a computer's task, and a session's computer and task,
-- must be the same user's. The user-references test finds every such reference and checks each
-- is bound.
CREATE TRIGGER `computers_task_id_owner_insert` BEFORE INSERT ON `computers`
WHEN NEW.`task_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `tasks` WHERE `id` = NEW.`task_id` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
CREATE TRIGGER `computers_task_id_owner_update` BEFORE UPDATE OF `task_id`, `user_id` ON `computers`
WHEN NEW.`task_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `tasks` WHERE `id` = NEW.`task_id` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
CREATE TRIGGER `computer_sessions_computer_id_owner_insert` BEFORE INSERT ON `computer_sessions`
WHEN NOT EXISTS (SELECT 1 FROM `computers` WHERE `id` = NEW.`computer_id` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
CREATE TRIGGER `computer_sessions_computer_id_owner_update` BEFORE UPDATE OF `computer_id`, `user_id` ON `computer_sessions`
WHEN NOT EXISTS (SELECT 1 FROM `computers` WHERE `id` = NEW.`computer_id` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
CREATE TRIGGER `computer_sessions_task_id_owner_insert` BEFORE INSERT ON `computer_sessions`
WHEN NEW.`task_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `tasks` WHERE `id` = NEW.`task_id` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
CREATE TRIGGER `computer_sessions_task_id_owner_update` BEFORE UPDATE OF `task_id`, `user_id` ON `computer_sessions`
WHEN NEW.`task_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `tasks` WHERE `id` = NEW.`task_id` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
-- Hand-added: record the schema version this migration brings the database to.
INSERT INTO `schema_version` (`version`) VALUES (26);