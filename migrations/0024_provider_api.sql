ALTER TABLE `model_providers` ADD `api` text;--> statement-breakpoint
-- Hand-added: record the schema version this migration brings the database to.
INSERT INTO `schema_version` (`version`) VALUES (24);
