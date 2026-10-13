INSERT INTO settings(key, value, updated_at)
VALUES ('glpi_auto_triage', 'false', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(key) DO NOTHING;
