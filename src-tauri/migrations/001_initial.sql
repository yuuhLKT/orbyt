CREATE TABLE projects (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  directory TEXT NOT NULL UNIQUE,
  max_concurrent_sessions INTEGER NOT NULL DEFAULT 2 CHECK (max_concurrent_sessions BETWEEN 1 AND 16),
  approval_policy TEXT NOT NULL DEFAULT 'manual' CHECK (approval_policy = 'manual'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE execution_scopes (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  relative_directory TEXT NOT NULL,
  read_access INTEGER NOT NULL DEFAULT 1 CHECK (read_access IN (0, 1)),
  write_access INTEGER NOT NULL DEFAULT 1 CHECK (write_access IN (0, 1)),
  conflict_policy TEXT NOT NULL DEFAULT 'serialize',
  created_at TEXT NOT NULL,
  UNIQUE(project_id, relative_directory)
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope_id TEXT REFERENCES execution_scopes(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'github', 'glpi')),
  external_reference TEXT,
  external_url TEXT,
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE state_transitions (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX tasks_project_status_idx ON tasks(project_id, status);
CREATE INDEX scopes_project_idx ON execution_scopes(project_id);
