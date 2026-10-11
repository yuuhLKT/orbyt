DROP INDEX tasks_external_reference_idx;

CREATE UNIQUE INDEX tasks_external_project_reference_idx
  ON tasks(project_id, source, external_reference)
  WHERE source IN ('github', 'glpi') AND external_reference IS NOT NULL;
