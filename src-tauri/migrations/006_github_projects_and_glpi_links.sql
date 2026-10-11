CREATE TABLE github_project_sources (
  project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_node_id TEXT NOT NULL,
  project_owner TEXT NOT NULL,
  project_number INTEGER NOT NULL CHECK (project_number > 0),
  project_title TEXT NOT NULL,
  status_field_id TEXT NOT NULL,
  status_field_name TEXT NOT NULL,
  pending_option_id TEXT NOT NULL,
  pending_option_name TEXT NOT NULL,
  last_synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE tasks ADD COLUMN linked_glpi_ticket_id TEXT;
