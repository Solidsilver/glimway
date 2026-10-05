ALTER TABLE homestead_items ADD COLUMN location TEXT NOT NULL DEFAULT 'inventory' CHECK(location IN ('inventory','storage','mail'));
CREATE INDEX homestead_item_location ON homestead_items(habitica_id,location,item_def);
CREATE TABLE home_storage(
 habitica_id TEXT NOT NULL REFERENCES homesteads(habitica_id),
 kind TEXT NOT NULL CHECK(kind IN ('material','item')), item_def TEXT NOT NULL,
 qty INTEGER NOT NULL CHECK(qty>0), PRIMARY KEY(habitica_id,kind,item_def)
);
CREATE TABLE mail(
 id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds(id),
 from_id TEXT NOT NULL REFERENCES players(habitica_id), to_id TEXT NOT NULL REFERENCES players(habitica_id),
 kind TEXT NOT NULL CHECK(kind IN ('material','item','decoration')), item_def TEXT NOT NULL,
 qty INTEGER NOT NULL CHECK(qty>0), instance_ids TEXT NOT NULL DEFAULT '[]',
 sent_at INTEGER NOT NULL, claimed_at INTEGER,
 CHECK(from_id!=to_id)
);
CREATE INDEX mail_recipient ON mail(world_id,to_id,sent_at);
CREATE INDEX mail_sender ON mail(world_id,from_id,sent_at);
CREATE TABLE projects(
 world_id TEXT NOT NULL REFERENCES worlds(id), project_def TEXT NOT NULL,
 completed_at INTEGER, world_flag TEXT,
 PRIMARY KEY(world_id,project_def),
 CHECK((completed_at IS NULL AND world_flag IS NULL) OR (completed_at IS NOT NULL AND world_flag IS NOT NULL))
);
CREATE TABLE project_materials(
 world_id TEXT NOT NULL, project_def TEXT NOT NULL, material TEXT NOT NULL,
 qty INTEGER NOT NULL CHECK(qty>0), PRIMARY KEY(world_id,project_def,material),
 FOREIGN KEY(world_id,project_def) REFERENCES projects(world_id,project_def)
);
CREATE TABLE contributions(
 id TEXT PRIMARY KEY, world_id TEXT NOT NULL, project_def TEXT NOT NULL,
 habitica_id TEXT NOT NULL REFERENCES players(habitica_id), material TEXT NOT NULL,
 qty INTEGER NOT NULL CHECK(qty>0), at INTEGER NOT NULL,
 FOREIGN KEY(world_id,project_def) REFERENCES projects(world_id,project_def)
);
CREATE INDEX project_contributors ON contributions(world_id,project_def,habitica_id);
CREATE TABLE project_papers(
 world_id TEXT NOT NULL, project_def TEXT NOT NULL, paper_id TEXT NOT NULL,
 completed_at INTEGER NOT NULL, PRIMARY KEY(world_id,project_def,paper_id),
 FOREIGN KEY(world_id,project_def) REFERENCES projects(world_id,project_def)
);
