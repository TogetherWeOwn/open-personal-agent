CREATE TABLE `used_setup_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`used_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `webauthn_challenges` ADD `token_hash` text;--> statement-breakpoint
-- Hand-added: the hash a deployment was claimed or recovered with counts as used.
INSERT INTO `used_setup_tokens` (`token_hash`) SELECT `claim_token_hash` FROM `setup_state` WHERE `claim_token_hash` IS NOT NULL;--> statement-breakpoint
-- Hand-added: record the schema version this migration brings the database to.
INSERT INTO `schema_version` (`version`) VALUES (2);
