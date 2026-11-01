CREATE TABLE `meters` (
	`meter` text NOT NULL,
	`day` integer NOT NULL,
	`amount` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`meter`, `day`)
);
--> statement-breakpoint
-- Hand-added: record the schema version this migration brings the database to.
INSERT INTO `schema_version` (`version`) VALUES (20);
