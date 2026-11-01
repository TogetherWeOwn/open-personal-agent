ALTER TABLE `user_settings` ADD `learn_from_chats` integer DEFAULT true NOT NULL;--> statement-breakpoint
-- Hand-added: record the schema version this migration brings the database to.
INSERT INTO `schema_version` (`version`) VALUES (16);
