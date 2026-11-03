CREATE UNIQUE INDEX `computer_sessions_computer_unique` ON `computer_sessions` (`computer_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `computers_live_user_unique` ON `computers` (`user_id`) WHERE "computers"."state" <> 'destroyed';--> statement-breakpoint
-- Hand-added: record the schema version this migration brings the database to.
INSERT INTO `schema_version` (`version`) VALUES (27);