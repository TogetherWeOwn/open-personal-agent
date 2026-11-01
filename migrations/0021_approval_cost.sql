ALTER TABLE `approvals` ADD `cost_micro_usd` integer;--> statement-breakpoint
-- Hand-added: record the schema version this migration brings the database to.
INSERT INTO `schema_version` (`version`) VALUES (21);
