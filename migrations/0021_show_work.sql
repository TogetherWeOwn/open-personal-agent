ALTER TABLE `user_settings` ADD `show_work` text DEFAULT 'collapsed' NOT NULL;--> statement-breakpoint
-- Hand-added: record the schema version this migration brings the database to.
INSERT INTO `schema_version` (`version`) VALUES (21);
