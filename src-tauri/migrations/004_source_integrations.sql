CREATE TABLE source_connections (
  id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'glpi')),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  api_endpoint TEXT NOT NULL,
  last_synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider, project_id, source_key)
);

CREATE INDEX source_connections_project_idx ON source_connections(project_id, provider);

ALTER TABLE tasks ADD COLUMN external_status TEXT;
ALTER TABLE tasks ADD COLUMN external_updated_at TEXT;

CREATE UNIQUE INDEX tasks_external_reference_idx
  ON tasks(source, external_reference)
  WHERE source IN ('github', 'glpi') AND external_reference IS NOT NULL;
