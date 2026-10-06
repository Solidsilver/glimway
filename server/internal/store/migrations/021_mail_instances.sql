-- Parcels can carry an instance (a tool with its fittings), and stacks keep
-- who made them: makers is a JSON list of {maker, qty} summing to qty.
CREATE TABLE mail_v2(
 id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds(id),
 from_id TEXT NOT NULL REFERENCES players(habitica_id), to_id TEXT NOT NULL REFERENCES players(habitica_id),
 kind TEXT NOT NULL CHECK(kind IN ('material','item','decoration','instance')), item_def TEXT NOT NULL,
 qty INTEGER NOT NULL CHECK(qty>0), instance_ids TEXT NOT NULL DEFAULT '[]',
 sent_at INTEGER NOT NULL, claimed_at INTEGER,
 returned_at INTEGER CHECK(returned_at IS NULL OR claimed_at IS NULL),
 return_reason TEXT CHECK(
  (returned_at IS NULL AND return_reason IS NULL) OR
  (returned_at IS NOT NULL AND return_reason IS NOT NULL AND return_reason IN ('recalled','expired','recipient-removed'))
 ),
 makers TEXT NOT NULL DEFAULT '[]',
 CHECK(from_id!=to_id)
);
INSERT INTO mail_v2(id,world_id,from_id,to_id,kind,item_def,qty,instance_ids,sent_at,claimed_at,returned_at,return_reason,makers)
 SELECT id,world_id,from_id,to_id,kind,item_def,qty,instance_ids,sent_at,claimed_at,returned_at,return_reason,
 CASE WHEN kind IN ('material','item') THEN json_array(json_object('maker','','qty',qty)) ELSE '[]' END FROM mail;
DROP TABLE mail;
ALTER TABLE mail_v2 RENAME TO mail;
CREATE INDEX mail_recipient ON mail(world_id,to_id,sent_at);
CREATE INDEX mail_sender ON mail(world_id,from_id,sent_at);
CREATE INDEX mail_pending_sender ON mail(from_id,sent_at DESC,id DESC) WHERE claimed_at IS NULL AND returned_at IS NULL;
CREATE INDEX mail_pending_recipient ON mail(to_id,sent_at DESC,id DESC) WHERE claimed_at IS NULL AND returned_at IS NULL;
CREATE INDEX mail_pending_expiry ON mail(sent_at,id) WHERE claimed_at IS NULL AND returned_at IS NULL;
CREATE INDEX mail_history_sender ON mail(from_id,world_id,sent_at DESC,id DESC) WHERE claimed_at IS NOT NULL OR returned_at IS NOT NULL;
CREATE INDEX mail_history_recipient ON mail(to_id,world_id,sent_at DESC,id DESC) WHERE claimed_at IS NOT NULL OR returned_at IS NOT NULL;
CREATE INDEX mail_send_rate ON mail(from_id,sent_at);
