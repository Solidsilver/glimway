ALTER TABLE mail ADD COLUMN returned_at INTEGER CHECK(returned_at IS NULL OR claimed_at IS NULL);
ALTER TABLE mail ADD COLUMN return_reason TEXT CHECK(
 (returned_at IS NULL AND return_reason IS NULL) OR
 (returned_at IS NOT NULL AND return_reason IS NOT NULL AND return_reason IN ('recalled','expired','recipient-removed'))
);
CREATE INDEX mail_pending_sender ON mail(from_id,sent_at DESC,id DESC) WHERE claimed_at IS NULL AND returned_at IS NULL;
CREATE INDEX mail_pending_recipient ON mail(to_id,sent_at DESC,id DESC) WHERE claimed_at IS NULL AND returned_at IS NULL;
CREATE INDEX mail_pending_expiry ON mail(sent_at,id) WHERE claimed_at IS NULL AND returned_at IS NULL;
CREATE INDEX mail_history_sender ON mail(from_id,world_id,sent_at DESC,id DESC) WHERE claimed_at IS NOT NULL OR returned_at IS NOT NULL;
CREATE INDEX mail_history_recipient ON mail(to_id,world_id,sent_at DESC,id DESC) WHERE claimed_at IS NOT NULL OR returned_at IS NOT NULL;
CREATE INDEX mail_send_rate ON mail(from_id,sent_at);
CREATE INDEX region_epoch_interval ON region_epochs(world_id,region_id,starts_at,ends_at);
