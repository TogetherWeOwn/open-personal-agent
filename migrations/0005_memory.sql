CREATE TABLE `memories` (
	`n` integer PRIMARY KEY NOT NULL,
	`id` text NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`trust` text NOT NULL,
	`status` text NOT NULL,
	`op` text NOT NULL,
	`source` text NOT NULL,
	`source_ref` text,
	`source_excerpt` text,
	`conversation_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`last_used_at` integer,
	`expires_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memories_id_unique` ON `memories` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `memories_id_user_idx` ON `memories` (`id`,`user_id`);--> statement-breakpoint
CREATE INDEX `memories_user_idx` ON `memories` (`user_id`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `memory_links` (
	`memory_id` text NOT NULL,
	`target_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`memory_id`, `target_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`memory_id`,`user_id`) REFERENCES `memories`(`id`,`user_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_id`,`user_id`) REFERENCES `memories`(`id`,`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memory_links_target_idx` ON `memory_links` (`user_id`,`target_id`);--> statement-breakpoint
-- Hand-written (drizzle-kit doesn't model virtual tables): the keyword index over `memories.text`
-- (ADR 0008 #1). External content, so the text is stored once; the triggers keep it in step with
-- every insert, delete (including the cascade from deleting a user) and text change, inside the
-- statement that made it, so a forgotten memory leaves the index at once (A-Me3). Back up with
-- the export (M3-20), never `wrangler d1 export`, which fails on virtual tables.
CREATE VIRTUAL TABLE `memories_fts` USING fts5(
	`text`,
	content='memories',
	content_rowid='n',
	tokenize='unicode61 remove_diacritics 2'
);--> statement-breakpoint
CREATE TRIGGER `memories_fts_insert` AFTER INSERT ON `memories` BEGIN
	INSERT INTO `memories_fts` (rowid, `text`) VALUES (new.`n`, new.`text`);
END;--> statement-breakpoint
CREATE TRIGGER `memories_fts_delete` AFTER DELETE ON `memories` BEGIN
	INSERT INTO `memories_fts` (`memories_fts`, rowid, `text`) VALUES ('delete', old.`n`, old.`text`);
END;--> statement-breakpoint
CREATE TRIGGER `memories_fts_update` AFTER UPDATE OF `text` ON `memories` BEGIN
	INSERT INTO `memories_fts` (`memories_fts`, rowid, `text`) VALUES ('delete', old.`n`, old.`text`);
	INSERT INTO `memories_fts` (rowid, `text`) VALUES (new.`n`, new.`text`);
END;--> statement-breakpoint
-- Hand-added: record the schema version this migration brings the database to.
INSERT INTO `schema_version` (`version`) VALUES (5);
