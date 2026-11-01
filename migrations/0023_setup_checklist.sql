ALTER TABLE `user_settings` ADD `setup_skipped` text;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `setup_hidden` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Hand-added: record the schema version this migration brings the database to.
INSERT INTO `schema_version` (`version`) VALUES (23);
