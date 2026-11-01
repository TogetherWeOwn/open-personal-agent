CREATE TABLE `task_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`instance_id` text NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `task_events_instance_idx` ON `task_events` (`instance_id`,`id`);--> statement-breakpoint
CREATE TABLE `task_steps` (
	`instance_id` text NOT NULL,
	`name` text NOT NULL,
	`output` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`instance_id`, `name`)
);
--> statement-breakpoint
-- Hand-added: record the schema version this migration brings the database to.
INSERT INTO `schema_version` (`version`) VALUES (10);
