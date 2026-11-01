-- TWO-427 L-4 (M3-21 AC6): a reference from one user's row to another row must stay inside
-- that user. SQLite can't add a composite foreign key without rebuilding each table, so these
-- triggers do what `FOREIGN KEY (col, user_id) REFERENCES parent (id, user_id)` would: refuse a
-- write that points at another user's row, and refuse moving a referenced row to another user.
-- apps/worker/test/user-references.test.ts finds every reference and checks each is bound.
CREATE TRIGGER `conversations_model_provider_owner_insert` BEFORE INSERT ON `conversations`
WHEN NEW.`model_provider` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `model_providers` WHERE `id` = NEW.`model_provider` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
CREATE TRIGGER `conversations_model_provider_owner_update` BEFORE UPDATE OF `model_provider`, `user_id` ON `conversations`
WHEN NEW.`model_provider` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `model_providers` WHERE `id` = NEW.`model_provider` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
CREATE TRIGGER `messages_conversation_id_owner_insert` BEFORE INSERT ON `messages`
WHEN NEW.`conversation_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `conversations` WHERE `id` = NEW.`conversation_id` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
CREATE TRIGGER `messages_conversation_id_owner_update` BEFORE UPDATE OF `conversation_id`, `user_id` ON `messages`
WHEN NEW.`conversation_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `conversations` WHERE `id` = NEW.`conversation_id` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
CREATE TRIGGER `attachments_conversation_id_owner_insert` BEFORE INSERT ON `attachments`
WHEN NEW.`conversation_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `conversations` WHERE `id` = NEW.`conversation_id` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
CREATE TRIGGER `attachments_conversation_id_owner_update` BEFORE UPDATE OF `conversation_id`, `user_id` ON `attachments`
WHEN NEW.`conversation_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `conversations` WHERE `id` = NEW.`conversation_id` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
CREATE TRIGGER `attachments_message_id_owner_insert` BEFORE INSERT ON `attachments`
WHEN NEW.`message_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `messages` WHERE `id` = NEW.`message_id` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
CREATE TRIGGER `attachments_message_id_owner_update` BEFORE UPDATE OF `message_id`, `user_id` ON `attachments`
WHEN NEW.`message_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `messages` WHERE `id` = NEW.`message_id` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
CREATE TRIGGER `usage_conversation_id_owner_insert` BEFORE INSERT ON `usage`
WHEN NEW.`conversation_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `conversations` WHERE `id` = NEW.`conversation_id` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
CREATE TRIGGER `usage_conversation_id_owner_update` BEFORE UPDATE OF `conversation_id`, `user_id` ON `usage`
WHEN NEW.`conversation_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `conversations` WHERE `id` = NEW.`conversation_id` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
CREATE TRIGGER `usage_message_id_owner_insert` BEFORE INSERT ON `usage`
WHEN NEW.`message_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `messages` WHERE `id` = NEW.`message_id` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
CREATE TRIGGER `usage_message_id_owner_update` BEFORE UPDATE OF `message_id`, `user_id` ON `usage`
WHEN NEW.`message_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `messages` WHERE `id` = NEW.`message_id` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
CREATE TRIGGER `model_providers_key_secret_id_owner_insert` BEFORE INSERT ON `model_providers`
WHEN NEW.`key_secret_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `secrets` WHERE `id` = NEW.`key_secret_id` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
CREATE TRIGGER `model_providers_key_secret_id_owner_update` BEFORE UPDATE OF `key_secret_id`, `user_id` ON `model_providers`
WHEN NEW.`key_secret_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `secrets` WHERE `id` = NEW.`key_secret_id` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
CREATE TRIGGER `tasks_conversation_id_owner_insert` BEFORE INSERT ON `tasks`
WHEN NEW.`conversation_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `conversations` WHERE `id` = NEW.`conversation_id` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
CREATE TRIGGER `tasks_conversation_id_owner_update` BEFORE UPDATE OF `conversation_id`, `user_id` ON `tasks`
WHEN NEW.`conversation_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `conversations` WHERE `id` = NEW.`conversation_id` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
CREATE TRIGGER `user_settings_chat_provider_owner_insert` BEFORE INSERT ON `user_settings`
WHEN NEW.`chat_provider` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `model_providers` WHERE `id` = NEW.`chat_provider` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
CREATE TRIGGER `user_settings_chat_provider_owner_update` BEFORE UPDATE OF `chat_provider`, `user_id` ON `user_settings`
WHEN NEW.`chat_provider` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `model_providers` WHERE `id` = NEW.`chat_provider` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
CREATE TRIGGER `user_settings_background_provider_owner_insert` BEFORE INSERT ON `user_settings`
WHEN NEW.`background_provider` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `model_providers` WHERE `id` = NEW.`background_provider` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
CREATE TRIGGER `user_settings_background_provider_owner_update` BEFORE UPDATE OF `background_provider`, `user_id` ON `user_settings`
WHEN NEW.`background_provider` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `model_providers` WHERE `id` = NEW.`background_provider` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
CREATE TRIGGER `memories_conversation_id_owner_insert` BEFORE INSERT ON `memories`
WHEN NEW.`conversation_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `conversations` WHERE `id` = NEW.`conversation_id` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
CREATE TRIGGER `memories_conversation_id_owner_update` BEFORE UPDATE OF `conversation_id`, `user_id` ON `memories`
WHEN NEW.`conversation_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `conversations` WHERE `id` = NEW.`conversation_id` AND `user_id` = NEW.`user_id`)
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
CREATE TRIGGER `conversations_user_id_fixed` BEFORE UPDATE OF `user_id` ON `conversations`
WHEN NEW.`user_id` IS NOT OLD.`user_id`
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
CREATE TRIGGER `messages_user_id_fixed` BEFORE UPDATE OF `user_id` ON `messages`
WHEN NEW.`user_id` IS NOT OLD.`user_id`
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
CREATE TRIGGER `model_providers_user_id_fixed` BEFORE UPDATE OF `user_id` ON `model_providers`
WHEN NEW.`user_id` IS NOT OLD.`user_id`
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
CREATE TRIGGER `secrets_user_id_fixed` BEFORE UPDATE OF `user_id` ON `secrets`
WHEN NEW.`user_id` IS NOT OLD.`user_id`
BEGIN
	SELECT RAISE(ABORT, 'cross_user_reference');
END;--> statement-breakpoint
-- Hand-added: record the schema version this migration brings the database to.
INSERT INTO `schema_version` (`version`) VALUES (11);
