-- M4-00a (AC3a): a capability token points at its owner's task, like every other
-- reference from one user's row to another user-owned row. These triggers do what
-- `FOREIGN KEY (task_id, user_id) REFERENCES tasks (id, user_id)` would: refuse a write that
-- points at another user's task. apps/worker/test/user-references.test.ts finds every
-- reference in the schema and checks each is bound.
CREATE TRIGGER `capability_tokens_task_id_owner_insert` BEFORE INSERT ON `capability_tokens`
WHEN NEW.`task_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `tasks` WHERE `id` = NEW.`task_id` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
CREATE TRIGGER `capability_tokens_task_id_owner_update` BEFORE UPDATE OF `task_id`, `user_id` ON `capability_tokens`
WHEN NEW.`task_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `tasks` WHERE `id` = NEW.`task_id` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
-- Hand-added: record the schema version this migration brings the database to.
INSERT INTO `schema_version` (`version`) VALUES (30);
