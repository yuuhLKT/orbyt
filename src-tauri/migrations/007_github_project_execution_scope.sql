ALTER TABLE github_project_sources
ADD COLUMN execution_scope_id TEXT REFERENCES execution_scopes(id) ON DELETE SET NULL;
