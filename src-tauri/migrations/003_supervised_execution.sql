CREATE TABLE task_runs (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_revision INTEGER NOT NULL,
  task_snapshot_json TEXT NOT NULL,
  project_directory TEXT NOT NULL,
  scope_id_snapshot TEXT,
  scope_directory TEXT NOT NULL,
  broad_scope INTEGER NOT NULL CHECK (broad_scope IN (0, 1)),
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'running', 'waiting_permission', 'cancel_requested',
    'completed', 'failed', 'canceled', 'needs_reconciliation'
  )),
  session_id TEXT,
  process_id INTEGER,
  progress TEXT NOT NULL DEFAULT '',
  output TEXT NOT NULL DEFAULT '',
  error TEXT,
  reconciliation_from TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE INDEX task_runs_task_created_idx ON task_runs(task_id, created_at DESC);
CREATE INDEX task_runs_project_state_idx ON task_runs(project_id, state, created_at);
CREATE UNIQUE INDEX task_runs_one_live_per_task_idx ON task_runs(task_id)
  WHERE state IN ('queued', 'running', 'waiting_permission', 'cancel_requested', 'needs_reconciliation');

CREATE TABLE execution_scope_locks (
  run_id TEXT PRIMARY KEY NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  canonical_directory TEXT NOT NULL,
  access_mode TEXT NOT NULL CHECK (access_mode IN ('read', 'write')),
  acquired_at TEXT NOT NULL
);

CREATE INDEX execution_scope_locks_project_idx ON execution_scope_locks(project_id);

CREATE TABLE run_permissions (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  rpc_request_id TEXT NOT NULL,
  tool_call_id TEXT,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  option_ids_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'resolving', 'allow_once', 'rejected', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE(run_id, rpc_request_id)
);

CREATE INDEX run_permissions_pending_idx ON run_permissions(run_id, state, created_at);

CREATE TRIGGER task_runs_restrict_live_delete
BEFORE DELETE ON task_runs
WHEN OLD.state IN ('queued', 'running', 'waiting_permission', 'cancel_requested', 'needs_reconciliation')
BEGIN
  SELECT RAISE(ABORT, 'cannot delete an active task run');
END;
