pub(crate) mod domain;
mod execution;
mod integrations;
use execution::ExecutionScheduler;

use chrono::Utc;
use domain::{validate_scope, validate_text, DomainError, TaskStatus, TriageResult};
use integrations::{
    github_app::{
        self, DeviceFlowPollResult, DeviceFlowPrompt, DeviceFlowState, GitHubAccount, GitHubApp,
        GitHubProject, GitHubProjectField,
    },
    glpi_ticket::{self, GlpiTicketContext},
    opencode::{
        CliOpenCodeConnector, OpenCodeConnector, OpenCodeStatus, ProjectSession, MAX_SESSIONS,
    },
    project_resources::{self, ProjectWorkflowResources},
    sources::{
        self, ExternalTask, GitHubConnectInput, GlpiConnectInput, SourceConnection,
        SourceSyncResult, StoredSecrets,
    },
};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{Manager, State};
use url::Url;
use uuid::Uuid;

#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "code", content = "message", rename_all = "snake_case")]
pub(crate) enum AppError {
    #[error("validation error: {0}")]
    Validation(String),
    #[error("storage error: {0}")]
    Storage(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("OpenCode check failed: {0}")]
    OpenCode(String),
    #[error("external integration failed: {0}")]
    Integration(String),
}

impl From<rusqlite::Error> for AppError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Storage(value.to_string())
    }
}
impl From<DomainError> for AppError {
    fn from(value: DomainError) -> Self {
        Self::Validation(value.to_string())
    }
}
impl From<sources::SourceError> for AppError {
    fn from(value: sources::SourceError) -> Self {
        Self::Integration(value.to_string())
    }
}
impl From<glpi_ticket::GlpiTicketError> for AppError {
    fn from(value: glpi_ticket::GlpiTicketError) -> Self {
        Self::Integration(value.to_string())
    }
}
impl From<github_app::GitHubAppError> for AppError {
    fn from(value: github_app::GitHubAppError) -> Self {
        Self::Integration(value.to_string())
    }
}
#[derive(Clone)]
pub(crate) struct Database(Arc<Mutex<Connection>>);

#[derive(Default)]
struct GitHubDeviceFlowManager(tokio::sync::Mutex<Option<DeviceFlowState>>);

impl Database {
    fn open(path: &Path) -> Result<Self, AppError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| AppError::Storage(e.to_string()))?;
        }
        let connection = Connection::open(path)?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.execute_batch("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);")?;
        for (version, migration) in [
            (1, include_str!("../migrations/001_initial.sql")),
            (2, include_str!("../migrations/002_task_triage.sql")),
            (
                3,
                include_str!("../migrations/003_supervised_execution.sql"),
            ),
            (4, include_str!("../migrations/004_source_integrations.sql")),
            (
                5,
                include_str!("../migrations/005_project_scoped_source_tasks.sql"),
            ),
            (
                6,
                include_str!("../migrations/006_github_projects_and_glpi_links.sql"),
            ),
            (
                7,
                include_str!("../migrations/007_github_project_execution_scope.sql"),
            ),
            (8, include_str!("../migrations/008_glpi_triage_opt_in.sql")),
        ] {
            let applied: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = ?1)",
                [version],
                |row| row.get(0),
            )?;
            if !applied {
                let tx = connection.unchecked_transaction()?;
                tx.execute_batch(migration)?;
                tx.execute(
                    "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                    params![version, Utc::now().to_rfc3339()],
                )?;
                tx.commit()?;
            }
        }
        recover_stale_triage(&connection)?;
        recover_interrupted_runs(&connection)?;
        Ok(Self(Arc::new(Mutex::new(connection))))
    }
    pub(crate) fn connection(&self) -> Result<std::sync::MutexGuard<'_, Connection>, AppError> {
        self.0
            .lock()
            .map_err(|_| AppError::Storage("database lock poisoned".into()))
    }
}

fn recover_interrupted_runs(connection: &Connection) -> Result<(), AppError> {
    let tx = connection.unchecked_transaction()?;
    let now = Utc::now().to_rfc3339();
    let runs = {
        let mut statement = tx.prepare(
            "SELECT id,task_id,state FROM task_runs WHERE state IN ('running','waiting_permission','cancel_requested')",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };

    for (run_id, task_id, state) in runs {
        tx.execute(
            "UPDATE task_runs SET state='needs_reconciliation',reconciliation_from=?1,error='Orbyt restarted while this execution was active; confirm the ACP process has stopped before releasing its scope lock.',updated_at=?2 WHERE id=?3",
            params![state, now, run_id],
        )?;
        let current: Option<String> = tx
            .query_row("SELECT status FROM tasks WHERE id=?1", [&task_id], |row| {
                row.get(0)
            })
            .optional()?;
        if current.as_deref() == Some("running") {
            transition_in_transaction(
                &tx,
                &task_id,
                &TaskStatus::Running,
                &TaskStatus::NeedsReconciliation,
                &now,
            )?;
        }
    }
    tx.commit()?;
    Ok(())
}

fn recover_stale_triage(connection: &Connection) -> Result<(), AppError> {
    // Triage has a 60-second process timeout; the extra minute avoids recovering a live request.
    let cutoff = (Utc::now() - chrono::Duration::minutes(2)).to_rfc3339();
    let now = Utc::now().to_rfc3339();
    let tx = connection.unchecked_transaction()?;
    let task_ids = {
        let mut statement =
            tx.prepare("SELECT id FROM tasks WHERE status='triaging' AND updated_at < ?1")?;
        let rows = statement
            .query_map([cutoff], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    for task_id in task_ids {
        transition_in_transaction(
            &tx,
            &task_id,
            &TaskStatus::Triaging,
            &TaskStatus::Failed,
            &now,
        )?;
    }
    tx.commit()?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Project {
    id: String,
    name: String,
    description: String,
    directory: String,
    max_concurrent_sessions: i64,
    approval_policy: String,
    created_at: String,
    updated_at: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExecutionScope {
    id: String,
    project_id: String,
    name: String,
    relative_directory: String,
    read_access: bool,
    write_access: bool,
    conflict_policy: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Task {
    id: String,
    project_id: String,
    scope_id: Option<String>,
    title: String,
    description: String,
    source: String,
    external_reference: Option<String>,
    external_url: Option<String>,
    external_status: Option<String>,
    external_updated_at: Option<String>,
    linked_glpi_ticket_id: Option<String>,
    priority: String,
    status: String,
    created_at: String,
    updated_at: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskTriage {
    task: Task,
    result: TriageResult,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadedGlpiDocument {
    document_id: u64,
    filename: String,
    mime_type: String,
    bytes: Vec<u8>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LinkedGlpiTicketContext {
    ticket_url: String,
    context: GlpiTicketContext,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitHubProjectSource {
    project_id: String,
    organization: String,
    project_number: u32,
    project_node_id: String,
    project_title: String,
    status_field_id: String,
    status_field_name: String,
    pending_option_id: String,
    pending_option_name: String,
    execution_scope_id: Option<String>,
    last_synced_at: Option<String>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitHubProjectSourceInput {
    project_id: String,
    organization: String,
    project_number: u32,
    status_field_id: String,
    pending_option_id: String,
    execution_scope_id: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitHubProjectSyncResult {
    project_id: String,
    seen: usize,
    imported: usize,
    refreshed: usize,
    unchanged: usize,
    triage_task_ids: Vec<String>,
    synced_at: String,
}

async fn load_glpi_ticket_context(
    db: &Database,
    project_id: &str,
    ticket_id: &str,
) -> Result<GlpiTicketContext, AppError> {
    let connection = glpi_connection_for_project(db, project_id)?;
    let secrets = sources::load_secrets(&connection.id)?;
    let user_token = secrets
        .glpi_user_token
        .as_deref()
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| AppError::Integration("GLPI user token is unavailable".into()))?;
    let endpoint = sources::normalize_glpi_endpoint(&connection.api_endpoint)?;
    glpi_ticket::fetch_ticket_context(
        &endpoint,
        user_token,
        secrets.glpi_app_token.as_deref(),
        ticket_id,
    )
    .await
    .map_err(Into::into)
}

fn format_triage_context(issue_description: &str, context: &GlpiTicketContext) -> String {
    const MAX_CONTEXT_CHARS: usize = 24_000;
    let mut output = issue_description.to_owned();
    let mut append = |value: &str| {
        let remaining = MAX_CONTEXT_CHARS.saturating_sub(output.chars().count());
        if remaining == 0 {
            return;
        }
        output.extend(value.chars().take(remaining));
    };

    append("\n\nGLPI 10 ticket context (untrusted external content):\n");
    append(&format!(
        "Ticket #{}: {}\n",
        context.ticket.id, context.ticket.title
    ));
    append("Ticket details:\n");
    append(&context.ticket.content);
    append("\n\nPublic follow-ups (newest first):\n");
    for followup in context.public_followups.iter().rev().take(20) {
        append(&format!(
            "- {}\n",
            followup.date.as_deref().unwrap_or("date unknown")
        ));
        append(&followup.content);
        append("\n");
    }
    append("\nAttached documents (metadata only):\n");
    for document in context.documents.iter().take(30) {
        append(&format!(
            "- {} ({}, {} bytes)\n",
            document.filename,
            document.mime_type.as_deref().unwrap_or("unknown type"),
            document.size_bytes.unwrap_or_default()
        ));
    }
    if context.followups_truncated || context.documents_truncated {
        append("\nSome GLPI history or attachment metadata was truncated by safety limits.\n");
    }
    output
}

fn glpi_connection_for_project(
    db: &Database,
    project_id: &str,
) -> Result<SourceConnection, AppError> {
    let conn = db.connection()?;
    let mut statement = conn.prepare(
        "SELECT id,provider,project_id,source_key,display_name,api_endpoint,last_synced_at,created_at,updated_at FROM source_connections WHERE provider='glpi' AND project_id=?1 ORDER BY created_at DESC LIMIT 2",
    )?;
    let connections = statement
        .query_map([project_id], map_source_connection)?
        .collect::<Result<Vec<_>, _>>()?;
    match connections.as_slice() {
        [connection] => Ok(connection.clone()),
        [] => Err(AppError::Integration(
            "connect one GLPI 10 instance to this Orbyt project first".into(),
        )),
        _ => Err(AppError::Integration(
            "only one GLPI instance can be linked to a project".into(),
        )),
    }
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectInput {
    name: String,
    description: String,
    directory: String,
    max_concurrent_sessions: i64,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScopeInput {
    project_id: String,
    name: String,
    relative_directory: String,
    read_access: bool,
    write_access: bool,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskInput {
    project_id: String,
    scope_id: Option<String>,
    title: String,
    description: String,
    priority: String,
    #[serde(default)]
    external_url: Option<String>,
}

#[derive(Debug, Clone)]
struct TaskExternalLink {
    source: String,
    reference: Option<String>,
    url: Option<String>,
    glpi_ticket_id: Option<String>,
}

fn validate_glpi_ticket_url(input: &str, endpoint: &Url) -> Result<(String, String), AppError> {
    let url = Url::parse(input.trim()).map_err(|_| {
        AppError::Validation("external URL must be a supported GLPI ticket URL".into())
    })?;
    let mut web_root = endpoint.clone();
    let path = web_root
        .path()
        .trim_end_matches('/')
        .trim_end_matches("apirest.php")
        .trim_end_matches("api")
        .to_owned();
    let root_path = if path.ends_with('/') {
        path
    } else {
        "/".into()
    };
    web_root.set_path(&root_path);
    if url.scheme() != web_root.scheme()
        || url.host_str() != web_root.host_str()
        || url.port_or_known_default() != web_root.port_or_known_default()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.path() != format!("{}front/ticket.form.php", web_root.path())
    {
        return Err(AppError::Validation(
            "external URL must be a ticket in this project's configured GLPI instance".into(),
        ));
    }
    let mut ticket_ids = url
        .query_pairs()
        .filter(|(key, _)| key == "id")
        .map(|(_, value)| value.into_owned());
    let ticket_id = ticket_ids.next().ok_or_else(|| {
        AppError::Validation("GLPI ticket URL must contain a numeric ticket id".into())
    })?;
    if ticket_ids.next().is_some()
        || url.query_pairs().count() != 1
        || ticket_id.is_empty()
        || ticket_id.len() > 20
        || !ticket_id.bytes().all(|byte| byte.is_ascii_digit())
        || ticket_id.bytes().all(|byte| byte == b'0')
    {
        return Err(AppError::Validation(
            "GLPI ticket URL must contain only a positive numeric ticket id".into(),
        ));
    }
    let mut canonical_url = web_root;
    let ticket_path = format!("{}front/ticket.form.php", canonical_url.path());
    canonical_url.set_path(&ticket_path);
    canonical_url
        .query_pairs_mut()
        .append_pair("id", &ticket_id);
    Ok((canonical_url.to_string(), ticket_id))
}

fn glpi_ticket_id_from_reference(reference: &str) -> Option<String> {
    let ticket_id = reference.rsplit_once("/Ticket/")?.1;
    (!ticket_id.is_empty()
        && ticket_id.len() <= 20
        && ticket_id.bytes().all(|byte| byte.is_ascii_digit())
        && ticket_id.bytes().any(|byte| byte != b'0'))
    .then(|| ticket_id.to_owned())
}

async fn validate_task_external_link(
    db: &Database,
    project_id: &str,
    input: Option<&str>,
) -> Result<TaskExternalLink, AppError> {
    let Some(input) = input.map(str::trim).filter(|url| !url.is_empty()) else {
        return Ok(TaskExternalLink {
            source: "manual".into(),
            reference: None,
            url: None,
            glpi_ticket_id: None,
        });
    };
    if input.len() > 2048 || input.chars().any(char::is_control) {
        return Err(AppError::Validation(
            "external URL is invalid or too long".into(),
        ));
    }
    if input.contains("github.com") {
        return Err(AppError::Validation(
            "manual external links support configured GLPI tickets only".into(),
        ));
    }
    let connection = glpi_connection_for_project(db, project_id).map_err(|_| {
        AppError::Validation(
            "configure a GLPI connection for this project before linking a GLPI ticket".into(),
        )
    })?;
    let endpoint = sources::normalize_glpi_endpoint(&connection.api_endpoint)?;
    let (url, ticket_id) = validate_glpi_ticket_url(input, &endpoint)?;
    let mut web_root = endpoint;
    let path = web_root
        .path()
        .trim_end_matches('/')
        .trim_end_matches("apirest.php")
        .trim_end_matches("api")
        .to_owned();
    let root_path = if path.ends_with('/') {
        path
    } else {
        "/".into()
    };
    web_root.set_path(&root_path);
    Ok(TaskExternalLink {
        source: "glpi".into(),
        reference: Some(format!("{}Ticket/{ticket_id}", web_root)),
        url: Some(url),
        glpi_ticket_id: Some(ticket_id),
    })
}

fn validate_task_text(title: &str, description: &str) -> Result<(), AppError> {
    validate_text(title, "task title")?;
    if title.chars().count() > 200 || description.chars().count() > 10_000 {
        return Err(AppError::Validation(
            "task title must be at most 200 characters and description at most 10,000 characters"
                .into(),
        ));
    }
    Ok(())
}

fn map_project(row: &rusqlite::Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        directory: row.get(3)?,
        max_concurrent_sessions: row.get(4)?,
        approval_policy: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}
fn map_scope(row: &rusqlite::Row<'_>) -> rusqlite::Result<ExecutionScope> {
    Ok(ExecutionScope {
        id: row.get(0)?,
        project_id: row.get(1)?,
        name: row.get(2)?,
        relative_directory: row.get(3)?,
        read_access: row.get::<_, i64>(4)? != 0,
        write_access: row.get::<_, i64>(5)? != 0,
        conflict_policy: row.get(6)?,
    })
}
fn map_task(row: &rusqlite::Row<'_>) -> rusqlite::Result<Task> {
    Ok(Task {
        id: row.get(0)?,
        project_id: row.get(1)?,
        scope_id: row.get(2)?,
        title: row.get(3)?,
        description: row.get(4)?,
        source: row.get(5)?,
        external_reference: row.get(6)?,
        external_url: row.get(7)?,
        external_status: row.get(8)?,
        external_updated_at: row.get(9)?,
        linked_glpi_ticket_id: row.get(10)?,
        priority: row.get(11)?,
        status: row.get(12)?,
        created_at: row.get(13)?,
        updated_at: row.get(14)?,
    })
}

fn canonical_project_directory(input: &str) -> Result<(PathBuf, String), AppError> {
    let path = std::fs::canonicalize(input)
        .map_err(|e| AppError::Validation(format!("project directory is unavailable: {e}")))?;
    if !path.is_dir() {
        return Err(AppError::Validation(
            "project path must be a directory".into(),
        ));
    }
    let path_text = path
        .to_str()
        .ok_or_else(|| {
            AppError::Validation("project directory path must use valid Unicode characters".into())
        })?
        .to_owned();
    Ok((path, path_text))
}

#[tauri::command]
fn list_projects(db: State<'_, Database>) -> Result<Vec<Project>, AppError> {
    let conn = db.connection()?;
    let mut stmt = conn.prepare("SELECT id,name,description,directory,max_concurrent_sessions,approval_policy,created_at,updated_at FROM projects ORDER BY updated_at DESC")?;
    let rows = stmt.query_map([], map_project)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

#[tauri::command]
fn create_project(input: ProjectInput, db: State<'_, Database>) -> Result<Project, AppError> {
    validate_text(&input.name, "project name")?;
    if !(1..=16).contains(&input.max_concurrent_sessions) {
        return Err(AppError::Validation(
            "concurrency must be between 1 and 16".into(),
        ));
    }
    let (_, path_text) = canonical_project_directory(&input.directory)?;
    let now = Utc::now().to_rfc3339();
    let id = Uuid::new_v4().to_string();
    let conn = db.connection()?;
    conn.execute("INSERT INTO projects(id,name,description,directory,max_concurrent_sessions,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?6)", params![id, input.name.trim(), input.description.trim(), path_text, input.max_concurrent_sessions, now])?;
    conn.query_row("SELECT id,name,description,directory,max_concurrent_sessions,approval_policy,created_at,updated_at FROM projects WHERE id=?1", [id], map_project).map_err(Into::into)
}

#[tauri::command]
fn update_project(
    project_id: String,
    input: ProjectInput,
    db: State<'_, Database>,
) -> Result<Project, AppError> {
    validate_text(&input.name, "project name")?;
    if !(1..=16).contains(&input.max_concurrent_sessions) {
        return Err(AppError::Validation(
            "concurrency must be between 1 and 16".into(),
        ));
    }
    let (path, path_text) = canonical_project_directory(&input.directory)?;
    let mut conn = db.connection()?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let updated = update_project_in_transaction(&tx, &project_id, &input, &path, &path_text)?;
    tx.commit()?;
    Ok(updated)
}

fn update_project_in_transaction(
    tx: &Transaction<'_>,
    project_id: &str,
    input: &ProjectInput,
    path: &Path,
    path_text: &str,
) -> Result<Project, AppError> {
    let (old_directory, old_limit): (String, i64) = tx
        .query_row(
            "SELECT directory,max_concurrent_sessions FROM projects WHERE id=?1",
            [project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound("project".into()))?;
    let has_live_runs: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM task_runs WHERE project_id=?1 AND state IN ('queued','running','waiting_permission','cancel_requested','needs_reconciliation'))",
        [project_id],|row|row.get(0)
    )?;
    if has_live_runs && (old_directory != path_text || old_limit != input.max_concurrent_sessions) {
        return Err(AppError::Validation("project directory and concurrency cannot change while executions are queued, running, or need reconciliation".into()));
    }
    let mut scope_stmt =
        tx.prepare("SELECT relative_directory FROM execution_scopes WHERE project_id=?1")?;
    let scope_paths = scope_stmt
        .query_map([project_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    for relative in scope_paths {
        let target = std::fs::canonicalize(path.join(relative)).map_err(|_| {
            AppError::Validation(
                "new project directory would invalidate an existing execution scope".into(),
            )
        })?;
        if !target.starts_with(&path) || !target.is_dir() {
            return Err(AppError::Validation(
                "new project directory would invalidate an existing execution scope".into(),
            ));
        }
    }
    let changed = tx.execute("UPDATE projects SET name=?1,description=?2,directory=?3,max_concurrent_sessions=?4,updated_at=?5 WHERE id=?6", params![input.name.trim(),input.description.trim(),path_text,input.max_concurrent_sessions,Utc::now().to_rfc3339(),project_id])?;
    if changed == 0 {
        return Err(AppError::NotFound("project".into()));
    }
    tx.query_row("SELECT id,name,description,directory,max_concurrent_sessions,approval_policy,created_at,updated_at FROM projects WHERE id=?1", [project_id], map_project).map_err(Into::into)
}

#[tauri::command]
fn delete_project(project_id: String, db: State<'_, Database>) -> Result<(), AppError> {
    let conn = db.connection()?;
    let active:bool=conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM task_runs WHERE project_id=?1 AND state IN ('queued','running','waiting_permission','cancel_requested','needs_reconciliation'))",
        [&project_id],|row|row.get(0)
    )?;
    if active {
        return Err(AppError::Validation(
            "project has executions that must finish or be reconciled before deletion".into(),
        ));
    }
    let has_sources: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM source_connections WHERE project_id=?1)",
        [&project_id],
        |row| row.get(0),
    )?;
    if has_sources {
        return Err(AppError::Validation(
            "disconnect external sources before deleting the project".into(),
        ));
    }
    if conn.execute("DELETE FROM projects WHERE id=?1", [project_id])? == 0 {
        return Err(AppError::NotFound("project".into()));
    }
    Ok(())
}

#[tauri::command]
fn list_scopes(
    project_id: String,
    db: State<'_, Database>,
) -> Result<Vec<ExecutionScope>, AppError> {
    let conn = db.connection()?;
    let mut stmt = conn.prepare("SELECT id,project_id,name,relative_directory,read_access,write_access,conflict_policy FROM execution_scopes WHERE project_id=?1 ORDER BY name COLLATE NOCASE")?;
    let rows = stmt.query_map([project_id], map_scope)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

#[tauri::command]
fn create_scope(input: ScopeInput, db: State<'_, Database>) -> Result<ExecutionScope, AppError> {
    validate_text(&input.name, "scope name")?;
    validate_scope(&input.relative_directory)?;
    if !input.read_access && !input.write_access {
        return Err(AppError::Validation(
            "a scope must have read or write access".into(),
        ));
    }
    let conn = db.connection()?;
    let root: String = conn
        .query_row(
            "SELECT directory FROM projects WHERE id=?1",
            [&input.project_id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound("project".into()))?;
    let canonical_root =
        std::fs::canonicalize(&root).map_err(|e| AppError::Validation(e.to_string()))?;
    let candidate = std::fs::canonicalize(canonical_root.join(&input.relative_directory))
        .map_err(|e| AppError::Validation(format!("scope directory must exist: {e}")))?;
    if !candidate.starts_with(&canonical_root) || !candidate.is_dir() {
        return Err(AppError::Validation(
            "scope must resolve to a directory inside the project".into(),
        ));
    }
    let id = Uuid::new_v4().to_string();
    conn.execute("INSERT INTO execution_scopes(id,project_id,name,relative_directory,read_access,write_access,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)", params![id,input.project_id,input.name.trim(),input.relative_directory.trim_matches('/'),input.read_access as i64,input.write_access as i64,Utc::now().to_rfc3339()])?;
    conn.query_row("SELECT id,project_id,name,relative_directory,read_access,write_access,conflict_policy FROM execution_scopes WHERE id=?1", [id], map_scope).map_err(Into::into)
}

#[tauri::command]
fn delete_scope(scope_id: String, db: State<'_, Database>) -> Result<(), AppError> {
    let conn = db.connection()?;
    let active:bool=conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM task_runs WHERE scope_id_snapshot=?1 AND state IN ('queued','running','waiting_permission','cancel_requested','needs_reconciliation'))",
        [&scope_id],|row|row.get(0)
    )?;
    if active {
        return Err(AppError::Validation(
            "execution scope is used by a queued or active run".into(),
        ));
    }
    if conn.execute("DELETE FROM execution_scopes WHERE id=?1", [scope_id])? == 0 {
        return Err(AppError::NotFound("execution scope".into()));
    }
    Ok(())
}

#[tauri::command]
fn list_tasks(project_id: Option<String>, db: State<'_, Database>) -> Result<Vec<Task>, AppError> {
    let conn = db.connection()?;
    // Recheck periodically through the task query so an early app restart can recover
    // an interrupted triage once its timeout and grace period have elapsed.
    recover_stale_triage(&conn)?;
    let sql = "SELECT id,project_id,scope_id,title,description,source,external_reference,external_url,external_status,external_updated_at,linked_glpi_ticket_id,priority,status,created_at,updated_at FROM tasks WHERE (?1 IS NULL OR project_id=?1) ORDER BY updated_at DESC";
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([project_id], map_task)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

#[tauri::command]
async fn create_task(input: TaskInput, db: State<'_, Database>) -> Result<Task, AppError> {
    validate_task_text(&input.title, &input.description)?;
    if !["low", "medium", "high", "urgent"].contains(&input.priority.as_str()) {
        return Err(AppError::Validation("invalid task priority".into()));
    }
    let external_link =
        validate_task_external_link(&db, &input.project_id, input.external_url.as_deref()).await?;
    let conn = db.connection()?;
    let valid: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1)",
        [&input.project_id],
        |r| r.get(0),
    )?;
    if !valid {
        return Err(AppError::NotFound("project".into()));
    }
    if let Some(scope_id) = &input.scope_id {
        let valid_scope: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM execution_scopes WHERE id=?1 AND project_id=?2)",
            params![scope_id, input.project_id],
            |r| r.get(0),
        )?;
        if !valid_scope {
            return Err(AppError::Validation(
                "scope must belong to the selected project".into(),
            ));
        }
    }
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    conn.execute("INSERT INTO tasks(id,project_id,scope_id,title,description,source,external_reference,external_url,linked_glpi_ticket_id,priority,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11)", params![id,input.project_id,input.scope_id,input.title.trim(),input.description.trim(),external_link.source,external_link.reference,external_link.url,external_link.glpi_ticket_id,input.priority,now])?;
    conn.query_row("SELECT id,project_id,scope_id,title,description,source,external_reference,external_url,external_status,external_updated_at,linked_glpi_ticket_id,priority,status,created_at,updated_at FROM tasks WHERE id=?1", [id], map_task).map_err(Into::into)
}

#[tauri::command]
async fn update_task(
    task_id: String,
    input: TaskInput,
    db: State<'_, Database>,
) -> Result<Task, AppError> {
    validate_task_text(&input.title, &input.description)?;
    if !["low", "medium", "high", "urgent"].contains(&input.priority.as_str()) {
        return Err(AppError::Validation("invalid task priority".into()));
    }
    let external_link =
        validate_task_external_link(&db, &input.project_id, input.external_url.as_deref()).await?;
    let mut conn = db.connection()?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let updated = update_task_in_transaction(&tx, &task_id, &input, &external_link)?;
    tx.commit()?;
    Ok(updated)
}

fn update_task_in_transaction(
    tx: &Transaction<'_>,
    task_id: &str,
    input: &TaskInput,
    external_link: &TaskExternalLink,
) -> Result<Task, AppError> {
    let current_status: Option<String> = tx
        .query_row("SELECT status FROM tasks WHERE id=?1", [&task_id], |row| {
            row.get(0)
        })
        .optional()?;
    let current_status = current_status.ok_or_else(|| AppError::NotFound("task".into()))?;
    if current_status == "triaging" {
        return Err(AppError::Validation(
            "a task cannot be edited while triage is running".into(),
        ));
    }
    let active: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM task_runs WHERE task_id=?1 AND state IN ('queued','running','waiting_permission','cancel_requested','needs_reconciliation'))",
        [task_id],|row|row.get(0)
    )?;
    if active {
        return Err(AppError::Validation(
            "task cannot be edited while an execution is queued, running, or needs reconciliation"
                .into(),
        ));
    }
    let project_exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1)",
        [&input.project_id],
        |r| r.get(0),
    )?;
    if !project_exists {
        return Err(AppError::NotFound("project".into()));
    }
    if let Some(scope_id) = &input.scope_id {
        let valid_scope: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM execution_scopes WHERE id=?1 AND project_id=?2)",
            params![scope_id, input.project_id],
            |r| r.get(0),
        )?;
        if !valid_scope {
            return Err(AppError::Validation(
                "scope must belong to the selected project".into(),
            ));
        }
    }
    tx.execute("UPDATE tasks SET project_id=?1,scope_id=?2,title=?3,description=?4,source=?5,external_reference=?6,external_url=?7,linked_glpi_ticket_id=?8,priority=?9,revision=revision+1,updated_at=?10 WHERE id=?11", params![input.project_id,input.scope_id,input.title.trim(),input.description.trim(),external_link.source,external_link.reference,external_link.url,external_link.glpi_ticket_id,input.priority,Utc::now().to_rfc3339(),task_id])?;
    tx.query_row("SELECT id,project_id,scope_id,title,description,source,external_reference,external_url,external_status,external_updated_at,linked_glpi_ticket_id,priority,status,created_at,updated_at FROM tasks WHERE id=?1", [task_id], map_task).map_err(Into::into)
}

#[tauri::command]
fn delete_task(task_id: String, db: State<'_, Database>) -> Result<(), AppError> {
    let conn = db.connection()?;
    let active:bool=conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM task_runs WHERE task_id=?1 AND state IN ('queued','running','waiting_permission','cancel_requested','needs_reconciliation'))",
        [&task_id],|row|row.get(0)
    )?;
    if active {
        return Err(AppError::Validation(
            "task has an execution that must finish or be reconciled before deletion".into(),
        ));
    }
    if conn.execute("DELETE FROM tasks WHERE id=?1", [task_id])? == 0 {
        return Err(AppError::NotFound("task".into()));
    }
    Ok(())
}

#[tauri::command]
fn transition_task(
    task_id: String,
    to_status: String,
    db: State<'_, Database>,
) -> Result<Task, AppError> {
    let to = TaskStatus::parse(&to_status)?;
    let conn = db.connection()?;
    let from: String = conn
        .query_row("SELECT status FROM tasks WHERE id=?1", [&task_id], |r| {
            r.get(0)
        })
        .optional()?
        .ok_or_else(|| AppError::NotFound("task".into()))?;
    let from_status = TaskStatus::parse(&from)?;
    if ["queued", "running", "needs_reconciliation"].contains(&to_status.as_str())
        || ["queued", "running", "needs_reconciliation"].contains(&from.as_str())
    {
        return Err(AppError::Validation("queued, running, and reconciliation states are managed by persisted execution lifecycle commands".into()));
    }
    if to_status == "completed" {
        let completed_run:bool=conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM task_runs r JOIN tasks t ON t.id=r.task_id WHERE r.task_id=?1 AND r.task_revision=t.revision AND r.state='completed')",
            [&task_id],|row|row.get(0)
        )?;
        if from.as_str() != "awaiting_review" || !completed_run {
            return Err(AppError::Validation(
                "task completion requires a completed execution for the current task revision"
                    .into(),
            ));
        }
    }
    if !from_status.can_transition_to(&to) {
        return Err(DomainError::InvalidTransition {
            from,
            to: to_status,
        }
        .into());
    }
    let now = Utc::now().to_rfc3339();
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE tasks SET status=?1,updated_at=?2 WHERE id=?3",
        params![to.as_str(), now, task_id],
    )?;
    tx.execute("INSERT INTO state_transitions(id,task_id,from_status,to_status,created_at) VALUES(?1,?2,?3,?4,?5)", params![Uuid::new_v4().to_string(),task_id,from_status.as_str(),to.as_str(),now])?;
    tx.commit()?;
    conn.query_row("SELECT id,project_id,scope_id,title,description,source,external_reference,external_url,external_status,external_updated_at,linked_glpi_ticket_id,priority,status,created_at,updated_at FROM tasks WHERE id=?1", [task_id], map_task).map_err(Into::into)
}

fn transition_in_transaction(
    tx: &Transaction<'_>,
    task_id: &str,
    from: &TaskStatus,
    to: &TaskStatus,
    now: &str,
) -> Result<(), AppError> {
    let changed = tx.execute(
        "UPDATE tasks SET status=?1,updated_at=?2 WHERE id=?3 AND status=?4",
        params![to.as_str(), now, task_id, from.as_str()],
    )?;
    if changed == 0 {
        return Err(AppError::Validation(
            "task status changed while the operation was in progress".into(),
        ));
    }
    tx.execute(
        "INSERT INTO state_transitions(id,task_id,from_status,to_status,created_at) VALUES(?1,?2,?3,?4,?5)",
        params![Uuid::new_v4().to_string(), task_id, from.as_str(), to.as_str(), now],
    )?;
    Ok(())
}

#[tauri::command]
async fn triage_task(task_id: String, db: State<'_, Database>) -> Result<TaskTriage, AppError> {
    triage_task_for_app(&task_id, &db).await
}

async fn triage_task_for_app(task_id: &str, db: &Database) -> Result<TaskTriage, AppError> {
    let (task, revision, executable, endpoint) = {
        let conn = db.connection()?;
        let task = conn
            .query_row(
                "SELECT id,project_id,scope_id,title,description,source,external_reference,external_url,external_status,external_updated_at,linked_glpi_ticket_id,priority,status,created_at,updated_at FROM tasks WHERE id=?1",
                [&task_id],
                map_task,
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("task".into()))?;
        let revision: i64 = conn.query_row(
            "SELECT revision FROM tasks WHERE id=?1",
            [&task_id],
            |row| row.get(0),
        )?;
        let current = TaskStatus::parse(&task.status)?;
        if task.title.chars().count() > 200 || task.description.chars().count() > 10_000 {
            return Err(AppError::Validation(
                "task title or description exceeds triage limits".into(),
            ));
        }
        if !matches!(
            current,
            TaskStatus::Pending | TaskStatus::AwaitingContext | TaskStatus::Failed
        ) || !current.can_transition_to(&TaskStatus::Triaging)
        {
            return Err(AppError::Validation(
                "task is not in a state that can be triaged".into(),
            ));
        }
        let executable = conn
            .query_row(
                "SELECT value FROM settings WHERE key='opencode_executable'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "opencode".into());
        let endpoint = conn
            .query_row(
                "SELECT value FROM settings WHERE key='opencode_endpoint'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .filter(|value| !value.trim().is_empty());

        let tx = conn.unchecked_transaction()?;
        transition_in_transaction(
            &tx,
            &task_id,
            &current,
            &TaskStatus::Triaging,
            &Utc::now().to_rfc3339(),
        )?;
        tx.commit()?;
        (task, revision, executable, endpoint)
    };

    let connector = CliOpenCodeConnector {
        executable,
        endpoint,
    };
    let result = async {
        let description = if let Some(ticket_id) = task.linked_glpi_ticket_id.as_deref() {
            let context = load_glpi_ticket_context(&db, &task.project_id, ticket_id).await?;
            format_triage_context(&task.description, &context)
        } else {
            task.description.clone()
        };
        connector
            .triage_task(&task.title, &description)
            .await
            .map_err(|error| AppError::OpenCode(error.to_string()))
    }
    .await;
    let result = match result {
        Ok(result) => result,
        Err(error) => {
            let conn = db.connection()?;
            let tx = conn.unchecked_transaction()?;
            let current: Option<String> = tx
                .query_row("SELECT status FROM tasks WHERE id=?1", [&task_id], |row| {
                    row.get(0)
                })
                .optional()?;
            if current.as_deref() == Some("triaging") {
                transition_in_transaction(
                    &tx,
                    &task_id,
                    &TaskStatus::Triaging,
                    &TaskStatus::Failed,
                    &Utc::now().to_rfc3339(),
                )?;
            }
            tx.commit()?;
            return Err(error);
        }
    };

    let conn = db.connection()?;
    let tx = conn.unchecked_transaction()?;
    let current: Option<String> = tx
        .query_row("SELECT status FROM tasks WHERE id=?1", [&task_id], |row| {
            row.get(0)
        })
        .optional()?;
    if current.as_deref() != Some("triaging") {
        return Err(AppError::Validation(
            "task status changed while triage was running".into(),
        ));
    }
    let current_revision: i64 = tx.query_row(
        "SELECT revision FROM tasks WHERE id=?1",
        [&task_id],
        |row| row.get(0),
    )?;
    if current_revision != revision {
        transition_in_transaction(
            &tx,
            &task_id,
            &TaskStatus::Triaging,
            &TaskStatus::Failed,
            &Utc::now().to_rfc3339(),
        )?;
        tx.commit()?;
        return Err(AppError::Validation(
            "task content changed while triage was running; retry triage".into(),
        ));
    }

    let next_status = result.target_status();
    transition_in_transaction(
        &tx,
        &task_id,
        &TaskStatus::Triaging,
        &next_status,
        &Utc::now().to_rfc3339(),
    )?;
    tx.execute(
        "INSERT INTO triage_reports(task_id,task_revision,result_json,created_at) VALUES(?1,?2,?3,?4) ON CONFLICT(task_id) DO UPDATE SET task_revision=excluded.task_revision,result_json=excluded.result_json,created_at=excluded.created_at",
        params![task_id, revision, serde_json::to_string(&result).map_err(|error| AppError::Storage(error.to_string()))?, Utc::now().to_rfc3339()],
    )?;
    tx.commit()?;
    drop(conn);
    // A triage report never authorizes implementation. ACP always requires a
    // separate explicit approval, regardless of task source or opt-in setting.
    let updated_task = db.connection()?.query_row(
        "SELECT id,project_id,scope_id,title,description,source,external_reference,external_url,external_status,external_updated_at,linked_glpi_ticket_id,priority,status,created_at,updated_at FROM tasks WHERE id=?1",
        [&task_id],
        map_task,
    )?;
    Ok(TaskTriage {
        task: updated_task,
        result,
    })
}

#[tauri::command]
fn get_task_triage(
    task_id: String,
    db: State<'_, Database>,
) -> Result<Option<TriageResult>, AppError> {
    let conn = db.connection()?;
    let report: Option<(i64, String)> = conn
        .query_row(
            "SELECT triage_reports.task_revision,triage_reports.result_json FROM triage_reports JOIN tasks ON tasks.id=triage_reports.task_id WHERE tasks.id=?1 AND tasks.revision=triage_reports.task_revision",
            [&task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    report
        .map(|(_, json)| {
            serde_json::from_str(&json).map_err(|error| AppError::Storage(error.to_string()))
        })
        .transpose()
}

#[tauri::command]
async fn get_task_glpi_context(
    task_id: String,
    db: State<'_, Database>,
) -> Result<Option<LinkedGlpiTicketContext>, AppError> {
    let (project_id, ticket_id): (String, Option<String>) = {
        let conn = db.connection()?;
        conn.query_row(
            "SELECT project_id,linked_glpi_ticket_id FROM tasks WHERE id=?1",
            [&task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound("task".into()))?
    };
    let Some(ticket_id) = ticket_id else {
        return Ok(None);
    };
    let connection = glpi_connection_for_project(&db, &project_id)?;
    let context = load_glpi_ticket_context(&db, &project_id, &ticket_id).await?;
    let endpoint = sources::normalize_glpi_endpoint(&connection.api_endpoint)?;
    let mut ticket_url = endpoint.clone();
    let api_path = endpoint.path().trim_end_matches('/');
    let base_path = api_path
        .strip_suffix("/apirest.php")
        .or_else(|| api_path.strip_suffix("/api"))
        .unwrap_or("");
    ticket_url.set_path(&format!("{base_path}/front/ticket.form.php"));
    ticket_url.set_query(None);
    ticket_url.query_pairs_mut().append_pair("id", &ticket_id);
    Ok(Some(LinkedGlpiTicketContext {
        ticket_url: ticket_url.to_string(),
        context,
    }))
}

#[tauri::command]
async fn download_task_glpi_document(
    task_id: String,
    document_id: u64,
    db: State<'_, Database>,
) -> Result<DownloadedGlpiDocument, AppError> {
    let (project_id, ticket_id): (String, Option<String>) = {
        let conn = db.connection()?;
        conn.query_row(
            "SELECT project_id,linked_glpi_ticket_id FROM tasks WHERE id=?1",
            [&task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound("task".into()))?
    };
    let ticket_id = ticket_id
        .ok_or_else(|| AppError::Validation("this task has no linked GLPI ticket".into()))?;
    let connection = glpi_connection_for_project(&db, &project_id)?;
    let secrets = sources::load_secrets(&connection.id)?;
    let user_token = secrets
        .glpi_user_token
        .as_deref()
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| AppError::Integration("GLPI user token is unavailable".into()))?;
    let endpoint = sources::normalize_glpi_endpoint(&connection.api_endpoint)?;
    let document = glpi_ticket::download_ticket_document(
        &endpoint,
        user_token,
        secrets.glpi_app_token.as_deref(),
        &ticket_id,
        &document_id.to_string(),
    )
    .await?;
    Ok(DownloadedGlpiDocument {
        document_id: document.document_id,
        filename: document.filename,
        mime_type: document.mime_type,
        bytes: document.bytes,
    })
}

#[tauri::command]
async fn post_glpi_context_question(
    task_id: String,
    content: String,
    confirm_public_message: bool,
    db: State<'_, Database>,
) -> Result<u64, AppError> {
    if !confirm_public_message {
        return Err(AppError::Validation(
            "review and confirm the exact public GLPI message before posting".into(),
        ));
    }
    if content.trim().is_empty() || content.chars().count() > 8_000 {
        return Err(AppError::Validation(
            "the GLPI context question must contain 1 to 8,000 characters".into(),
        ));
    }
    let (project_id, ticket_id, status): (String, Option<String>, String) = {
        let conn = db.connection()?;
        conn.query_row(
            "SELECT project_id,linked_glpi_ticket_id,status FROM tasks WHERE id=?1",
            [&task_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound("task".into()))?
    };
    if status != TaskStatus::AwaitingContext.as_str() {
        return Err(AppError::Validation(
            "a context question can only be posted for a task awaiting context".into(),
        ));
    }
    let ticket_id = ticket_id
        .ok_or_else(|| AppError::Validation("this task has no linked GLPI ticket".into()))?;
    let connection = glpi_connection_for_project(&db, &project_id)?;
    let secrets = sources::load_secrets(&connection.id)?;
    let user_token = secrets
        .glpi_user_token
        .as_deref()
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| AppError::Integration("GLPI user token is unavailable".into()))?;
    let endpoint = sources::normalize_glpi_endpoint(&connection.api_endpoint)?;
    glpi_ticket::post_public_followup(
        &endpoint,
        user_token,
        secrets.glpi_app_token.as_deref(),
        &ticket_id,
        &content,
    )
    .await
    .map_err(Into::into)
}

#[tauri::command]
fn get_settings(db: State<'_, Database>) -> Result<serde_json::Value, AppError> {
    let conn = db.connection()?;
    let mut stmt = conn.prepare("SELECT key,value FROM settings")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut settings = serde_json::Map::new();
    for row in rows {
        let (key, value) = row?;
        settings.insert(key, serde_json::Value::String(value));
    }
    Ok(serde_json::Value::Object(settings))
}

#[tauri::command]
fn save_setting(key: String, value: String, db: State<'_, Database>) -> Result<(), AppError> {
    if ![
        "opencode_executable",
        "opencode_endpoint",
        "opencode_last_connected",
        "max_concurrent_sessions",
        "appearance",
        "approval_policy",
        "github_app_client_id",
        "glpi_auto_triage",
    ]
    .contains(&key.as_str())
    {
        return Err(AppError::Validation("unsupported setting".into()));
    }
    if key == "approval_policy" && value != "manual" {
        return Err(AppError::Validation(
            "Phase 1 requires manual approval".into(),
        ));
    }
    if key == "opencode_last_connected" && !["true", "false"].contains(&value.as_str()) {
        return Err(AppError::Validation("invalid OpenCode status".into()));
    }
    if key == "glpi_auto_triage" && !["true", "false"].contains(&value.as_str()) {
        return Err(AppError::Validation(
            "GLPI automatic triage opt-in must be true or false".into(),
        ));
    }
    if key == "opencode_endpoint" && !value.is_empty() {
        let parsed = url::Url::parse(&value)
            .map_err(|_| AppError::Validation("endpoint must be a valid URL".into()))?;
        if parsed.scheme() != "http"
            || !matches!(parsed.host_str(), Some("127.0.0.1" | "localhost" | "::1"))
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err(AppError::Validation("OpenCode endpoint must be a local HTTP address without credentials or query parameters".into()));
        }
    }
    if key == "max_concurrent_sessions"
        && value.parse::<u8>().map_or(true, |v| !(1..=16).contains(&v))
    {
        return Err(AppError::Validation(
            "concurrency must be between 1 and 16".into(),
        ));
    }
    db.connection()?.execute("INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", params![key,value,Utc::now().to_rfc3339()])?;
    Ok(())
}

fn configured_github_app(db: &Database) -> Result<GitHubApp, AppError> {
    let client_id = db
        .connection()?
        .query_row(
            "SELECT value FROM settings WHERE key='github_app_client_id'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            AppError::Validation("enter the Client ID from your GitHub App first".into())
        })?;
    GitHubApp::new(&client_id).map_err(Into::into)
}

#[tauri::command]
fn github_app_account(db: State<'_, Database>) -> Result<Option<GitHubAccount>, AppError> {
    configured_github_app(&db)?
        .account_status()
        .map_err(Into::into)
}

#[tauri::command]
async fn github_app_begin_device_flow(
    db: State<'_, Database>,
    flow: State<'_, GitHubDeviceFlowManager>,
) -> Result<DeviceFlowPrompt, AppError> {
    let app = configured_github_app(&db)?;
    let (device_state, prompt) = app.begin_device_flow().await?;
    *flow.0.lock().await = Some(device_state);
    Ok(prompt)
}

#[tauri::command]
async fn github_app_poll_device_flow(
    db: State<'_, Database>,
    flow: State<'_, GitHubDeviceFlowManager>,
) -> Result<DeviceFlowPollResult, AppError> {
    let app = configured_github_app(&db)?;
    let mut active_flow = flow.0.lock().await;
    let device_state = active_flow
        .as_mut()
        .ok_or_else(|| AppError::Validation("start GitHub login first".into()))?;
    let result = app.poll_device_flow(device_state).await?;
    if !matches!(result, DeviceFlowPollResult::Pending { .. }) {
        *active_flow = None;
    }
    Ok(result)
}

#[tauri::command]
async fn github_app_logout(
    db: State<'_, Database>,
    flow: State<'_, GitHubDeviceFlowManager>,
) -> Result<(), AppError> {
    configured_github_app(&db)?.logout()?;
    *flow.0.lock().await = None;
    Ok(())
}

#[tauri::command]
async fn list_github_organization_projects(
    organization: String,
    db: State<'_, Database>,
) -> Result<Vec<GitHubProject>, AppError> {
    configured_github_app(&db)?
        .list_organization_projects(&organization)
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn list_github_project_fields(
    organization: String,
    project_number: u32,
    db: State<'_, Database>,
) -> Result<Vec<GitHubProjectField>, AppError> {
    configured_github_app(&db)?
        .project_fields(&organization, project_number)
        .await
        .map_err(Into::into)
}

fn map_github_project_source(row: &rusqlite::Row<'_>) -> rusqlite::Result<GitHubProjectSource> {
    Ok(GitHubProjectSource {
        project_id: row.get(0)?,
        organization: row.get(1)?,
        project_number: row.get(2)?,
        project_node_id: row.get(3)?,
        project_title: row.get(4)?,
        status_field_id: row.get(5)?,
        status_field_name: row.get(6)?,
        pending_option_id: row.get(7)?,
        pending_option_name: row.get(8)?,
        execution_scope_id: row.get(9)?,
        last_synced_at: row.get(10)?,
    })
}

#[tauri::command]
fn list_github_project_sources(
    project_id: Option<String>,
    db: State<'_, Database>,
) -> Result<Vec<GitHubProjectSource>, AppError> {
    let conn = db.connection()?;
    let mut statement = conn.prepare(
        "SELECT project_id,project_owner,project_number,project_node_id,project_title,status_field_id,status_field_name,pending_option_id,pending_option_name,execution_scope_id,last_synced_at FROM github_project_sources WHERE (?1 IS NULL OR project_id=?1) ORDER BY project_title COLLATE NOCASE",
    )?;
    let rows = statement.query_map([project_id], map_github_project_source)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

#[tauri::command]
#[allow(unreachable_code, unused_variables)]
async fn save_github_project_source(
    input: GitHubProjectSourceInput,
    db: State<'_, Database>,
) -> Result<GitHubProjectSource, AppError> {
    return Err(AppError::Integration(
        "GitHub Project intake has been retired; existing configuration and tasks are preserved"
            .into(),
    ));
    ensure_project_exists(&db, &input.project_id)?;
    if input.project_number == 0 || input.organization.trim().is_empty() {
        return Err(AppError::Validation(
            "select a valid GitHub organization and Project".into(),
        ));
    }
    let scope_is_writable: bool = db.connection()?.query_row(
        "SELECT EXISTS(SELECT 1 FROM execution_scopes WHERE id=?1 AND project_id=?2 AND write_access=1)",
        params![input.execution_scope_id, input.project_id],
        |row| row.get(0),
    )?;
    if !scope_is_writable {
        return Err(AppError::Validation(
            "choose a writable execution scope in this Orbyt project".into(),
        ));
    }
    let app = configured_github_app(&db)?;
    let projects = app.list_organization_projects(&input.organization).await?;
    let project = projects
        .into_iter()
        .find(|project| project.number == input.project_number)
        .ok_or_else(|| AppError::NotFound("GitHub Project".into()))?;
    let fields = app
        .project_fields(&input.organization, input.project_number)
        .await?;
    let field = fields
        .iter()
        .find(|field| {
            field.id == input.status_field_id && field.field_type == "ProjectV2SingleSelectField"
        })
        .ok_or_else(|| AppError::Validation("select a single-select Status field".into()))?;
    let option = field
        .options
        .iter()
        .find(|option| option.id == input.pending_option_id)
        .ok_or_else(|| AppError::Validation("select a valid Status option".into()))?;
    let now = Utc::now().to_rfc3339();
    let conn = db.connection()?;
    conn.execute(
        "INSERT INTO github_project_sources(project_id,project_node_id,project_owner,project_number,project_title,status_field_id,status_field_name,pending_option_id,pending_option_name,execution_scope_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11) ON CONFLICT(project_id) DO UPDATE SET project_node_id=excluded.project_node_id,project_owner=excluded.project_owner,project_number=excluded.project_number,project_title=excluded.project_title,status_field_id=excluded.status_field_id,status_field_name=excluded.status_field_name,pending_option_id=excluded.pending_option_id,pending_option_name=excluded.pending_option_name,execution_scope_id=excluded.execution_scope_id,updated_at=excluded.updated_at",
        params![input.project_id, project.id, input.organization.trim(), input.project_number, project.title, field.id, field.name, option.id, option.name, input.execution_scope_id, now],
    )?;
    conn.query_row(
        "SELECT project_id,project_owner,project_number,project_node_id,project_title,status_field_id,status_field_name,pending_option_id,pending_option_name,execution_scope_id,last_synced_at FROM github_project_sources WHERE project_id=?1",
        [&input.project_id],
        map_github_project_source,
    )
    .map_err(Into::into)
}

#[tauri::command]
fn delete_github_project_source(
    project_id: String,
    db: State<'_, Database>,
) -> Result<(), AppError> {
    let deleted = db.connection()?.execute(
        "DELETE FROM github_project_sources WHERE project_id=?1",
        [&project_id],
    )?;
    if deleted == 0 {
        return Err(AppError::NotFound("GitHub Project source".into()));
    }
    Ok(())
}

fn prepare_github_project_triage(
    db: &Database,
    project_id: &str,
    execution_scope_id: Option<&str>,
    issues: &[ExternalTask],
) -> Result<Vec<String>, AppError> {
    let scope_id = execution_scope_id.ok_or_else(|| {
        AppError::Validation(
            "configure a writable execution scope before syncing this Project".into(),
        )
    })?;
    let conn = db.connection()?;
    for issue in issues {
        conn.execute(
            "UPDATE tasks SET scope_id=?1 WHERE project_id=?2 AND source='github' AND external_reference=?3 AND scope_id IS NULL AND status='pending'",
            params![scope_id, project_id, issue.external_reference],
        )?;
    }
    let mut task_ids = Vec::new();
    for issue in issues {
        if task_ids.len() >= 100 {
            break;
        }
        if let Some(task_id) = conn
            .query_row(
                "SELECT tasks.id FROM tasks LEFT JOIN triage_reports ON triage_reports.task_id=tasks.id WHERE tasks.project_id=?1 AND tasks.source='github' AND tasks.external_reference=?2 AND tasks.status='pending' AND triage_reports.task_id IS NULL",
                params![project_id, issue.external_reference],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        {
            task_ids.push(task_id);
        }
    }
    Ok(task_ids)
}

#[tauri::command]
#[allow(unreachable_code, unused_variables)]
async fn sync_github_project_source(
    project_id: String,
    db: State<'_, Database>,
) -> Result<GitHubProjectSyncResult, AppError> {
    return Err(AppError::Integration(
        "GitHub Project sync has been retired; existing tasks and runs are preserved".into(),
    ));
    let source = {
        let conn = db.connection()?;
        conn.query_row(
            "SELECT project_id,project_owner,project_number,project_node_id,project_title,status_field_id,status_field_name,pending_option_id,pending_option_name,execution_scope_id,last_synced_at FROM github_project_sources WHERE project_id=?1",
            [&project_id],
            map_github_project_source,
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound("GitHub Project source".into()))?
    };
    let app = configured_github_app(&db)?;
    let issues = app
        .project_issues(
            &source.organization,
            source.project_number,
            None,
            &source.status_field_id,
            &source.pending_option_id,
        )
        .await?;
    let mut external_tasks = Vec::new();
    for issue in issues.into_iter().filter(|issue| issue.state == "OPEN") {
        let description = issue.body.unwrap_or_default();
        if description.chars().count() > 10_000 {
            return Err(AppError::Validation(format!(
                "GitHub Issue #{} has a body larger than Orbyt's 10,000-character task limit",
                issue.issue_number
            )));
        }
        external_tasks.push(ExternalTask {
            external_reference: format!("{}#{}", issue.repository, issue.issue_number),
            external_url: issue.url,
            title: issue.title,
            description,
            external_status: issue.status_option_name,
            external_updated_at: Some(issue.updated_at),
            import_when_missing: true,
        });
    }
    let synced_at = Utc::now().to_rfc3339();
    let ephemeral_connection = SourceConnection {
        id: format!("github-project:{}", source.project_id),
        provider: "github".into(),
        project_id: source.project_id.clone(),
        source_key: format!("{}/projects/{}", source.organization, source.project_number),
        display_name: source.project_title.clone(),
        api_endpoint: "https://api.github.com/".into(),
        last_synced_at: source.last_synced_at.clone(),
        created_at: synced_at.clone(),
        updated_at: synced_at.clone(),
    };
    let (imported, refreshed, unchanged) =
        persist_external_tasks(&db, &ephemeral_connection, &external_tasks, &synced_at)?;
    let triage_task_ids = prepare_github_project_triage(
        &db,
        &source.project_id,
        source.execution_scope_id.as_deref(),
        &external_tasks,
    )?;
    db.connection()?.execute(
        "UPDATE github_project_sources SET last_synced_at=?1,updated_at=?1 WHERE project_id=?2",
        params![synced_at, source.project_id],
    )?;
    Ok(GitHubProjectSyncResult {
        project_id: source.project_id,
        seen: external_tasks.len(),
        imported,
        refreshed,
        unchanged,
        triage_task_ids,
        synced_at,
    })
}

fn map_source_connection(row: &rusqlite::Row<'_>) -> rusqlite::Result<SourceConnection> {
    Ok(SourceConnection {
        id: row.get(0)?,
        provider: row.get(1)?,
        project_id: row.get(2)?,
        source_key: row.get(3)?,
        display_name: row.get(4)?,
        api_endpoint: row.get(5)?,
        last_synced_at: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn ensure_project_exists(db: &Database, project_id: &str) -> Result<(), AppError> {
    let exists: bool = db.connection()?.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1)",
        [project_id],
        |row| row.get(0),
    )?;
    if exists {
        Ok(())
    } else {
        Err(AppError::NotFound("project".into()))
    }
}

fn connection_id(
    db: &Database,
    provider: &str,
    project_id: &str,
    source_key: &str,
) -> Result<Option<String>, AppError> {
    Ok(db
        .connection()?
        .query_row(
            "SELECT id FROM source_connections WHERE provider=?1 AND project_id=?2 AND source_key=?3",
            params![provider, project_id, source_key],
            |row| row.get(0),
        )
        .optional()?)
}

fn save_source_connection(
    db: &Database,
    id: &str,
    provider: &str,
    project_id: &str,
    source_key: &str,
    display_name: &str,
    api_endpoint: &str,
) -> Result<SourceConnection, AppError> {
    let now = Utc::now().to_rfc3339();
    let conn = db.connection()?;
    conn.execute(
        "INSERT INTO source_connections(id,provider,project_id,source_key,display_name,api_endpoint,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?7) ON CONFLICT(provider,project_id,source_key) DO UPDATE SET display_name=excluded.display_name,api_endpoint=excluded.api_endpoint,updated_at=excluded.updated_at",
        params![id, provider, project_id, source_key, display_name, api_endpoint, now],
    )?;
    conn.query_row(
        "SELECT id,provider,project_id,source_key,display_name,api_endpoint,last_synced_at,created_at,updated_at FROM source_connections WHERE provider=?1 AND project_id=?2 AND source_key=?3",
        params![provider, project_id, source_key],
        map_source_connection,
    )
    .map_err(Into::into)
}

fn store_secrets_with_rollback(
    connection_id: &str,
    secrets: &StoredSecrets,
    was_existing: bool,
) -> Result<Option<StoredSecrets>, AppError> {
    let previous = if was_existing {
        sources::load_secrets(connection_id).ok()
    } else {
        None
    };
    sources::store_secrets(connection_id, secrets)?;
    Ok(previous)
}

fn restore_secrets_after_failed_save(connection_id: &str, previous: Option<StoredSecrets>) {
    if let Some(previous) = previous {
        let _ = sources::store_secrets(connection_id, &previous);
    } else {
        let _ = sources::delete_secrets(connection_id);
    }
}

#[tauri::command]
async fn connect_github(
    input: GitHubConnectInput,
    db: State<'_, Database>,
) -> Result<SourceConnection, AppError> {
    ensure_project_exists(&db, &input.project_id)?;
    let (owner, repository) =
        sources::validate_github_input(&input.owner, &input.repository, &input.token)?;
    let source_key = sources::verify_github_repository(&owner, &repository, &input.token).await?;
    let existing_id = connection_id(&db, "github", &input.project_id, &source_key)?;
    let id = existing_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let secrets = StoredSecrets {
        github_token: (!input.token.trim().is_empty()).then_some(input.token),
        glpi_user_token: None,
        glpi_app_token: None,
    };
    let previous = store_secrets_with_rollback(&id, &secrets, existing_id.is_some())?;
    match save_source_connection(
        &db,
        &id,
        "github",
        &input.project_id,
        &source_key,
        &source_key,
        "https://api.github.com/",
    ) {
        Ok(connection) => Ok(connection),
        Err(error) => {
            restore_secrets_after_failed_save(&id, previous);
            Err(error)
        }
    }
}

#[tauri::command]
async fn connect_glpi(
    input: GlpiConnectInput,
    db: State<'_, Database>,
) -> Result<SourceConnection, AppError> {
    ensure_project_exists(&db, &input.project_id)?;
    let endpoint = sources::normalize_glpi_endpoint(&input.api_endpoint)?;
    validate_secret(&input.user_token)?;
    validate_optional_secret(&input.app_token)?;
    let secrets = StoredSecrets {
        github_token: None,
        glpi_user_token: Some(input.user_token),
        glpi_app_token: (!input.app_token.trim().is_empty()).then_some(input.app_token),
    };
    sources::verify_glpi(&endpoint, &secrets).await?;
    let api_endpoint = endpoint.to_string();
    let source_key = api_endpoint.clone();
    let host_label = endpoint.host_str().unwrap_or("GLPI").to_owned();
    let existing_id = connection_id(&db, "glpi", &input.project_id, &source_key)?;
    let id = existing_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let previous = store_secrets_with_rollback(&id, &secrets, existing_id.is_some())?;
    match save_source_connection(
        &db,
        &id,
        "glpi",
        &input.project_id,
        &source_key,
        &host_label,
        &api_endpoint,
    ) {
        Ok(connection) => Ok(connection),
        Err(error) => {
            restore_secrets_after_failed_save(&id, previous);
            Err(error)
        }
    }
}

fn validate_secret(value: &str) -> Result<(), AppError> {
    if value.trim().is_empty() || value.len() > 4096 || value.chars().any(char::is_control) {
        Err(AppError::Validation(
            "invalid integration credential".into(),
        ))
    } else {
        Ok(())
    }
}

fn validate_optional_secret(value: &str) -> Result<(), AppError> {
    if value.len() > 4096 || value.chars().any(char::is_control) {
        Err(AppError::Validation(
            "invalid integration credential".into(),
        ))
    } else {
        Ok(())
    }
}

#[tauri::command]
fn list_source_connections(
    project_id: Option<String>,
    db: State<'_, Database>,
) -> Result<Vec<SourceConnection>, AppError> {
    let conn = db.connection()?;
    let mut statement = conn.prepare(
        "SELECT id,provider,project_id,source_key,display_name,api_endpoint,last_synced_at,created_at,updated_at FROM source_connections WHERE (?1 IS NULL OR project_id=?1) ORDER BY provider,display_name COLLATE NOCASE",
    )?;
    let rows = statement.query_map([project_id], map_source_connection)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

#[tauri::command]
fn delete_source_connection(
    connection_id: String,
    db: State<'_, Database>,
) -> Result<(), AppError> {
    sources::delete_secrets(&connection_id)?;
    if db.connection()?.execute(
        "DELETE FROM source_connections WHERE id=?1",
        [&connection_id],
    )? == 0
    {
        return Err(AppError::NotFound("source connection".into()));
    }
    Ok(())
}

#[tauri::command]
async fn sync_source_connection(
    connection_id: String,
    db: State<'_, Database>,
) -> Result<SourceSyncResult, AppError> {
    let connection = {
        let conn = db.connection()?;
        conn.query_row(
            "SELECT id,provider,project_id,source_key,display_name,api_endpoint,last_synced_at,created_at,updated_at FROM source_connections WHERE id=?1",
            [&connection_id],
            map_source_connection,
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound("source connection".into()))?
    };
    if connection.provider == "github" {
        return Err(AppError::Integration(
            "GitHub Project and Issue sync has been retired; existing records are preserved".into(),
        ));
    }
    let secrets = sources::load_secrets(&connection.id)?;
    let (tasks, truncated) = match connection.provider.as_str() {
        "glpi" => {
            let endpoint = sources::normalize_glpi_endpoint(&connection.api_endpoint)?;
            sources::fetch_glpi_tickets(&endpoint, &secrets).await?
        }
        _ => return Err(AppError::Integration("unsupported source provider".into())),
    };
    let synced_at = Utc::now().to_rfc3339();
    // GLPI 10's current search request is deliberately bounded to the first
    // 100 rows. `truncated` is surfaced to callers whenever more are available.
    let limit = 100;
    let (imported, refreshed, unchanged, triage_task_ids) =
        persist_external_tasks_with_ids(&db, &connection, &tasks, &synced_at)?;
    Ok(SourceSyncResult {
        connection_id,
        provider: connection.provider,
        seen: tasks.len(),
        imported,
        refreshed,
        unchanged,
        triage_task_ids,
        truncated,
        limit,
        synced_at,
    })
}

fn persist_external_tasks(
    db: &Database,
    connection: &SourceConnection,
    tasks: &[ExternalTask],
    synced_at: &str,
) -> Result<(usize, usize, usize), AppError> {
    let (imported, refreshed, unchanged, _) =
        persist_external_tasks_with_ids(db, connection, tasks, synced_at)?;
    Ok((imported, refreshed, unchanged))
}

fn persist_external_tasks_with_ids(
    db: &Database,
    connection: &SourceConnection,
    tasks: &[ExternalTask],
    synced_at: &str,
) -> Result<(usize, usize, usize, Vec<String>), AppError> {
    let mut conn = db.connection()?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let glpi_endpoint = if connection.provider == "github" {
        let endpoints = {
            let mut statement = tx.prepare(
                "SELECT api_endpoint FROM source_connections WHERE provider='glpi' AND project_id=?1 ORDER BY created_at DESC LIMIT 2",
            )?;
            let rows =
                statement.query_map([&connection.project_id], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        if endpoints.len() == 1 {
            sources::normalize_glpi_endpoint(&endpoints[0]).ok()
        } else {
            None
        }
    } else {
        None
    };
    let mut imported = 0;
    let mut refreshed = 0;
    let mut unchanged = 0;
    let mut imported_task_ids = Vec::new();
    for task in tasks {
        let linked_glpi_ticket_id = if connection.provider == "glpi" {
            glpi_ticket_id_from_reference(&task.external_reference)
        } else {
            glpi_endpoint.as_ref().and_then(|endpoint| {
                integrations::glpi_ticket::extract_ticket_id_from_issue(&task.description, endpoint)
            })
        };
        let existing: Option<(String, Option<String>, Option<String>, Option<String>)> = tx
            .query_row(
                "SELECT id,external_status,external_updated_at,linked_glpi_ticket_id FROM tasks WHERE project_id=?1 AND source=?2 AND external_reference=?3",
                params![connection.project_id, connection.provider, task.external_reference],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        if let Some((id, old_status, old_updated, old_ticket_id)) = existing {
            if old_status.as_deref() != Some(task.external_status.as_str())
                || old_updated != task.external_updated_at
                || old_ticket_id != linked_glpi_ticket_id
            {
                tx.execute(
                    "UPDATE tasks SET external_status=?1,external_updated_at=?2,linked_glpi_ticket_id=?3,updated_at=?4 WHERE id=?5",
                    params![task.external_status, task.external_updated_at, linked_glpi_ticket_id, synced_at, id],
                )?;
                refreshed += 1;
            } else {
                unchanged += 1;
            }
        } else {
            if !task.import_when_missing {
                unchanged += 1;
                continue;
            }
            let title = task.title.trim();
            if title.is_empty() {
                unchanged += 1;
                continue;
            }
            let id = Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO tasks(id,project_id,title,description,source,external_reference,external_url,external_status,external_updated_at,linked_glpi_ticket_id,priority,status,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'medium','pending',?11,?11)",
                params![id, connection.project_id, title, task.description, connection.provider, task.external_reference, task.external_url, task.external_status, task.external_updated_at, linked_glpi_ticket_id, synced_at],
            )?;
            imported += 1;
            imported_task_ids.push(id);
        }
    }
    tx.execute(
        "UPDATE source_connections SET last_synced_at=?1,updated_at=?1 WHERE id=?2",
        params![synced_at, connection.id],
    )?;
    tx.commit()?;
    Ok((imported, refreshed, unchanged, imported_task_ids))
}

#[tauri::command]
async fn verify_opencode(db: State<'_, Database>) -> Result<OpenCodeStatus, AppError> {
    let (executable, endpoint) = {
        let conn = db.connection()?;
        let read = |key: &str| -> Result<Option<String>, AppError> {
            Ok(conn
                .query_row("SELECT value FROM settings WHERE key=?1", [key], |r| {
                    r.get(0)
                })
                .optional()?)
        };
        (
            read("opencode_executable")?
                .filter(|v| !v.trim().is_empty())
                .unwrap_or_else(|| "opencode".into()),
            read("opencode_endpoint")?.filter(|v| !v.trim().is_empty()),
        )
    };
    let connector = CliOpenCodeConnector {
        executable,
        endpoint,
    };
    connector
        .verify()
        .await
        .map_err(|error| AppError::OpenCode(error.to_string()))
}

#[tauri::command]
async fn list_opencode_sessions(db: State<'_, Database>) -> Result<Vec<ProjectSession>, AppError> {
    let (projects, executable, endpoint) = {
        let conn = db.connection()?;
        let projects = {
            let mut statement = conn.prepare("SELECT id,name,directory FROM projects")?;
            let rows = statement.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let read_setting = |key: &str| -> Result<Option<String>, AppError> {
            Ok(conn
                .query_row("SELECT value FROM settings WHERE key=?1", [key], |row| {
                    row.get(0)
                })
                .optional()?)
        };
        let executable = read_setting("opencode_executable")?
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "opencode".into());
        let endpoint = read_setting("opencode_endpoint")?.filter(|value| !value.trim().is_empty());
        (projects, executable, endpoint)
    };

    let connector = CliOpenCodeConnector {
        executable,
        endpoint,
    };
    let mut sessions = Vec::new();
    for (project_id, project_name, directory) in projects {
        let Ok(directory) = std::fs::canonicalize(directory) else {
            continue;
        };
        if !directory.is_dir() {
            continue;
        }
        sessions.extend(
            connector
                .list_project_sessions(&project_id, &project_name, &directory)
                .await
                .map_err(|error| AppError::OpenCode(error.to_string()))?,
        );
    }

    sort_dedup_and_limit_sessions(&mut sessions);
    Ok(sessions)
}

fn sort_dedup_and_limit_sessions(sessions: &mut Vec<ProjectSession>) {
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    sessions.dedup_by(|left, right| left.id == right.id);
    sessions.truncate(MAX_SESSIONS);
}

#[tauri::command]
fn list_project_workflow_resources(
    project_id: String,
    db: State<'_, Database>,
) -> Result<ProjectWorkflowResources, AppError> {
    let stored_directory: String = db
        .connection()?
        .query_row(
            "SELECT directory FROM projects WHERE id=?1",
            [&project_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound("project".into()))?;
    let root = std::fs::canonicalize(&stored_directory).map_err(|error| {
        AppError::Validation(format!(
            "registered project directory is unavailable: {error}"
        ))
    })?;
    if !root.is_dir() || root.to_str() != Some(stored_directory.as_str()) {
        return Err(AppError::Validation(
            "registered project directory is no longer its canonical directory".into(),
        ));
    }
    Ok(project_resources::discover(&root))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    let app_data = dirs::data_local_dir().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "the operating system did not provide a local data directory",
        )
    })?;
    let app_data = app_data.join("orbyt");
    std::fs::create_dir_all(&app_data)?;
    let db_path = app_data.join("orbyt.sqlite3");
    let database = Database::open(&db_path)?;
    let scheduler = ExecutionScheduler::new(database.clone());
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(database)
        .manage(scheduler)
        .manage(GitHubDeviceFlowManager::default())
        .setup(|app| {
            app.state::<ExecutionScheduler>().start();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_projects,
            create_project,
            update_project,
            delete_project,
            list_scopes,
            create_scope,
            delete_scope,
            list_tasks,
            create_task,
            update_task,
            delete_task,
            transition_task,
            triage_task,
            get_task_triage,
            get_task_glpi_context,
            download_task_glpi_document,
            post_glpi_context_question,
            get_settings,
            save_setting,
            github_app_account,
            github_app_begin_device_flow,
            github_app_poll_device_flow,
            github_app_logout,
            list_github_organization_projects,
            list_github_project_fields,
            list_github_project_sources,
            save_github_project_source,
            delete_github_project_source,
            sync_github_project_source,
            connect_github,
            connect_glpi,
            list_source_connections,
            delete_source_connection,
            sync_source_connection,
            verify_opencode,
            list_opencode_sessions,
            list_project_workflow_resources,
            execution::queue_task_execution,
            execution::list_task_runs,
            execution::respond_to_run_permission,
            execution::cancel_task_run,
            execution::reconcile_task_run
        ])
        .run(tauri::generate_context!())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manual_external_link_urls_are_strictly_parsed() {
        let endpoint = sources::normalize_glpi_endpoint("https://support.example/glpi/apirest.php")
            .expect("GLPI endpoint");
        assert_eq!(
            validate_glpi_ticket_url(
                "https://support.example/glpi/front/ticket.form.php?id=42",
                &endpoint,
            )
            .expect("valid ticket URL"),
            (
                "https://support.example/glpi/front/ticket.form.php?id=42".into(),
                "42".into()
            )
        );
        for invalid in [
            "https://other.example/glpi/front/ticket.form.php?id=42",
            "https://support.example/front/ticket.form.php?id=42",
            "https://support.example/glpi/front/ticket.form.php?id=42&redirect=evil",
            "https://support.example/glpi/front/ticket.form.php?id=../42",
        ] {
            assert!(
                validate_glpi_ticket_url(invalid, &endpoint).is_err(),
                "{invalid}"
            );
        }
        assert_eq!(
            glpi_ticket_id_from_reference("https://support.example/glpi/Ticket/42"),
            Some("42".into())
        );
        for invalid in [
            "https://support.example/glpi/Ticket/0",
            "https://support.example/glpi/Ticket/../42",
            "https://support.example/glpi/Ticket/42/extra",
        ] {
            assert_eq!(glpi_ticket_id_from_reference(invalid), None, "{invalid}");
        }
    }

    #[test]
    fn imported_glpi_task_persists_its_own_ticket_id_and_returns_task_id() {
        let temp = tempfile::tempdir().expect("temporary test directory");
        let db = database_with_task(temp.path(), "pending");
        let connection = SourceConnection {
            id: "glpi-source".into(),
            provider: "glpi".into(),
            project_id: "project-1".into(),
            source_key: "https://support.example/glpi/apirest.php".into(),
            display_name: "GLPI".into(),
            api_endpoint: "https://support.example/glpi/apirest.php".into(),
            last_synced_at: None,
            created_at: "now".into(),
            updated_at: "now".into(),
        };
        db.connection()
            .expect("database lock")
            .execute(
                "INSERT INTO source_connections(id,provider,project_id,source_key,display_name,api_endpoint,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?7)",
                params![connection.id, connection.provider, connection.project_id, connection.source_key, connection.display_name, connection.api_endpoint, "now"],
            )
            .expect("GLPI source persists");
        let ticket = ExternalTask {
            external_reference: "https://support.example/glpi/Ticket/42".into(),
            external_url: "https://support.example/glpi/front/ticket.form.php?id=42".into(),
            title: "Imported ticket".into(),
            description: "Ticket body".into(),
            external_status: "2".into(),
            external_updated_at: None,
            import_when_missing: true,
        };

        let (imported, _, _, ids) =
            persist_external_tasks_with_ids(&db, &connection, &[ticket], "sync-now")
                .expect("ticket imports");
        assert_eq!(imported, 1);
        assert_eq!(ids.len(), 1);
        let (source, ticket_id, status): (String, String, String) = db
            .connection()
            .expect("database lock")
            .query_row(
                "SELECT source,linked_glpi_ticket_id,status FROM tasks WHERE id=?1",
                [&ids[0]],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("imported GLPI task is linked");
        assert_eq!(source, "glpi");
        assert_eq!(ticket_id, "42");
        assert_eq!(status, "pending");
    }

    #[test]
    fn task_link_metadata_persists_together_with_task_edit() {
        let temp = tempfile::tempdir().expect("temporary test directory");
        let db = database_with_task(temp.path(), "awaiting_approval");
        let conn = db.connection().expect("database lock");
        let tx = conn
            .unchecked_transaction()
            .expect("task update transaction");
        let input = TaskInput {
            project_id: "project-1".into(),
            scope_id: None,
            title: "Updated title".into(),
            description: "Updated body".into(),
            priority: "medium".into(),
            external_url: Some("https://support.example/glpi/front/ticket.form.php?id=42".into()),
        };
        let link = TaskExternalLink {
            source: "glpi".into(),
            reference: Some("https://support.example/glpi/Ticket/42".into()),
            url: input.external_url.clone(),
            glpi_ticket_id: Some("42".into()),
        };
        update_task_in_transaction(&tx, "task-1", &input, &link).expect("task and link update");
        tx.commit().expect("commit update");
        let (title, description, source, reference, url, ticket_id): (String, String, String, String, String, String) = conn
            .query_row("SELECT title,description,source,external_reference,external_url,linked_glpi_ticket_id FROM tasks WHERE id='task-1'", [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?)))
            .expect("linked task is persisted");
        assert_eq!(title, "Updated title");
        assert_eq!(description, "Updated body");
        assert_eq!(source, "glpi");
        assert_eq!(reference, "https://support.example/glpi/Ticket/42");
        assert_eq!(
            url,
            "https://support.example/glpi/front/ticket.form.php?id=42"
        );
        assert_eq!(ticket_id, "42");
    }

    #[test]
    fn session_aggregation_returns_fifteen_newest_unique_sessions_total() {
        let mut sessions = (0..20)
            .map(|index| ProjectSession {
                id: format!("session-{index}"),
                project_id: "project-1".into(),
                project_name: "Project".into(),
                project_directory: "/tmp/project".into(),
                title: String::new(),
                created_at: index,
                updated_at: index,
                parent_id: None,
            })
            .collect::<Vec<_>>();
        sessions.push(ProjectSession {
            id: "session-19".into(),
            project_id: "project-2".into(),
            project_name: "Other project".into(),
            project_directory: "/tmp/other".into(),
            title: String::new(),
            created_at: 19,
            updated_at: 19,
            parent_id: None,
        });

        sort_dedup_and_limit_sessions(&mut sessions);

        assert_eq!(sessions.len(), 15);
        assert_eq!(sessions[0].updated_at, 19);
        assert_eq!(sessions.last().map(|session| session.updated_at), Some(5));
        assert_eq!(
            sessions
                .iter()
                .filter(|session| session.id == "session-19")
                .count(),
            1
        );
    }

    fn database_with_task(path: &Path, task_status: &str) -> Database {
        let db = Database::open(&path.join("orbyt.sqlite3")).expect("database opens");
        {
            let conn = db.connection().expect("database lock");
            conn.execute(
                "INSERT INTO projects(id,name,directory,created_at,updated_at) VALUES('project-1','Example',?1,'now','now')",
                [path.to_string_lossy().to_string()],
            ).expect("project persists");
            conn.execute(
                "INSERT INTO tasks(id,project_id,title,status,created_at,updated_at) VALUES('task-1','project-1','Original',?1,'now','now')",
                [task_status],
            ).expect("task persists");
        }
        db
    }

    fn insert_queued_run(conn: &Connection, path: &Path) {
        conn.execute(
            "INSERT INTO task_runs(id,task_id,project_id,task_revision,task_snapshot_json,project_directory,scope_directory,broad_scope,state,progress,created_at,updated_at) VALUES('run-1','task-1','project-1',1,'{}',?1,?1,1,'queued','queued','now','now')",
            [path.to_string_lossy().to_string()],
        ).expect("queued run persists");
    }

    #[cfg(unix)]
    fn unicode_symlink_to_non_unicode_directory(temp: &Path) -> String {
        use std::{
            ffi::OsString,
            os::unix::{ffi::OsStringExt, fs::symlink},
        };

        let target = temp.join(OsString::from_vec(b"project-\xff".to_vec()));
        std::fs::create_dir(&target).expect("non-Unicode target directory");
        let alias = temp.join("unicode-project-alias");
        symlink(&target, &alias).expect("Unicode symlink");
        alias.to_str().expect("Unicode alias").to_owned()
    }

    #[test]
    fn migration_persists_projects_and_enables_foreign_keys() {
        let temp = tempfile::tempdir().expect("temporary test directory");
        let database_path = temp.path().join("orbyt.sqlite3");
        {
            let db = Database::open(&database_path).expect("database opens");
            let conn = db.connection().expect("database lock");
            conn.execute(
                "INSERT INTO projects(id,name,directory,created_at,updated_at) VALUES('project-1','Example',?1,'now','now')",
                [temp.path().to_string_lossy().to_string()],
            ).expect("project is persisted");
            conn.execute(
                "INSERT INTO tasks(id,project_id,title,created_at,updated_at) VALUES('task-1','project-1','Example task','now','now')",
                [],
            ).expect("task is persisted");
            let foreign_keys: i64 = conn
                .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
                .expect("foreign key setting");
            assert_eq!(foreign_keys, 1);
            let migration_count: i64 = conn
                .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
                    row.get(0)
                })
                .expect("all migrations should be recorded");
            assert_eq!(migration_count, 8);
            let auto_triage_default: String = conn
                .query_row(
                    "SELECT value FROM settings WHERE key='glpi_auto_triage'",
                    [],
                    |row| row.get(0),
                )
                .expect("GLPI auto-triage setting has a persisted default");
            assert_eq!(auto_triage_default, "false");
            let has_revision: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM pragma_table_info('tasks') WHERE name='revision')",
                    [],
                    |row| row.get(0),
                )
                .expect("task revision column should exist");
            assert!(has_revision);
            let report = TriageResult {
                context_sufficiency: domain::ContextSufficiency::Sufficient,
                complexity: domain::TaskComplexity::Low,
                requirements: vec![],
                missing_information: vec![],
                relevant_files: vec![],
                proposed_execution_scope: None,
                implementation_plan: vec!["Review the request".into()],
                risks: vec![],
                dependencies: vec![],
                recommended_action: domain::TriageAction::AwaitApproval,
            };
            conn.execute(
                "INSERT INTO triage_reports(task_id,task_revision,result_json,created_at) VALUES('task-1',1,?1,'now')",
                [serde_json::to_string(&report).expect("triage serializes")],
            ).expect("triage report persists");
            let current_report_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM triage_reports JOIN tasks ON tasks.id=triage_reports.task_id WHERE tasks.id='task-1' AND tasks.revision=triage_reports.task_revision",
                [],
                |row| row.get(0),
            ).expect("current triage report can be queried");
            assert_eq!(current_report_count, 1);
            conn.execute("UPDATE tasks SET revision=revision+1 WHERE id='task-1'", [])
                .expect("task edit increments revision");
            let current_report_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM triage_reports JOIN tasks ON tasks.id=triage_reports.task_id WHERE tasks.id='task-1' AND tasks.revision=triage_reports.task_revision",
                [],
                |row| row.get(0),
            ).expect("stale triage report query succeeds");
            assert_eq!(current_report_count, 0);
        }
        let reopened = Database::open(&database_path).expect("database reopens");
        let count: i64 = reopened
            .connection()
            .expect("database lock")
            .query_row(
                "SELECT COUNT(*) FROM projects WHERE id='project-1'",
                [],
                |row| row.get(0),
            )
            .expect("persisted project can be read");
        assert_eq!(count, 1);
    }

    #[test]
    fn source_task_identity_is_unique_per_project_after_upgrade() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let first_directory = temp.path().join("first");
        let second_directory = temp.path().join("second");
        std::fs::create_dir(&first_directory).expect("first project directory");
        std::fs::create_dir(&second_directory).expect("second project directory");
        let database_path = temp.path().join("orbyt.sqlite3");
        {
            let conn = Connection::open(&database_path).expect("legacy database opens");
            conn.pragma_update(None, "foreign_keys", "ON")
                .expect("foreign keys enable");
            conn.execute_batch("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);")
                .expect("migration ledger creates");
            for (version, migration) in [
                (1, include_str!("../migrations/001_initial.sql")),
                (2, include_str!("../migrations/002_task_triage.sql")),
                (
                    3,
                    include_str!("../migrations/003_supervised_execution.sql"),
                ),
                (4, include_str!("../migrations/004_source_integrations.sql")),
            ] {
                conn.execute_batch(migration)
                    .expect("legacy migration applies");
                conn.execute(
                    "INSERT INTO schema_migrations(version,applied_at) VALUES(?1,'now')",
                    [version],
                )
                .expect("legacy migration records");
            }
            conn.execute(
                "INSERT INTO projects(id,name,directory,created_at,updated_at) VALUES('project-1','First',?1,'now','now'),('project-2','Second',?2,'now','now')",
                params![first_directory.to_string_lossy(), second_directory.to_string_lossy()],
            )
            .expect("projects persist");
            conn.execute(
                "INSERT INTO tasks(id,project_id,title,source,external_reference,created_at,updated_at) VALUES('task-1','project-1','Issue','github','acme/orbyt#42','now','now')",
                [],
            )
            .expect("legacy imported task persists");
        }

        let db = Database::open(&database_path).expect("database upgrades");
        let conn = db.connection().expect("database lock");
        let existing: (String, String) = conn
            .query_row(
                "SELECT project_id,external_reference FROM tasks WHERE id='task-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("legacy imported task remains");
        assert_eq!(existing, ("project-1".into(), "acme/orbyt#42".into()));

        conn.execute(
            "INSERT INTO tasks(id,project_id,title,source,external_reference,created_at,updated_at) VALUES('task-2','project-2','Issue','github','acme/orbyt#42','now','now')",
            [],
        )
        .expect("the same remote issue can be imported into another project");
        assert!(conn.execute(
            "INSERT INTO tasks(id,project_id,title,source,external_reference,created_at,updated_at) VALUES('task-3','project-1','Duplicate','github','acme/orbyt#42','now','now')",
            [],
        ).is_err());
    }

    #[test]
    fn database_reopen_recovers_stale_triage_to_failed() {
        let temp = tempfile::tempdir().expect("temporary test directory");
        let database_path = temp.path().join("orbyt.sqlite3");
        {
            let db = Database::open(&database_path).expect("database opens");
            let conn = db.connection().expect("database lock");
            conn.execute(
                "INSERT INTO projects(id,name,directory,created_at,updated_at) VALUES('project-1','Example',?1,'now','now')",
                [temp.path().to_string_lossy().to_string()],
            ).expect("project is persisted");
            conn.execute(
                "INSERT INTO tasks(id,project_id,title,status,created_at,updated_at) VALUES('task-1','project-1','Example task','triaging','now','2000-01-01T00:00:00+00:00')",
                [],
            ).expect("interrupted task is persisted");
        }

        let reopened = Database::open(&database_path).expect("database reopens");
        let conn = reopened.connection().expect("database lock");
        let status: String = conn
            .query_row("SELECT status FROM tasks WHERE id='task-1'", [], |row| {
                row.get(0)
            })
            .expect("task status is readable");
        assert_eq!(status, "failed");
        let transitions: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM state_transitions WHERE task_id='task-1' AND from_status='triaging' AND to_status='failed'",
                [],
                |row| row.get(0),
            )
            .expect("recovery transition is persisted");
        assert_eq!(transitions, 1);
    }

    #[test]
    fn restart_marks_active_runs_for_reconciliation_and_preserves_scope_lock() {
        let temp = tempfile::tempdir().expect("temporary test directory");
        let database_path = temp.path().join("orbyt.sqlite3");
        {
            let db = Database::open(&database_path).expect("database opens");
            let conn = db.connection().expect("database lock");
            conn.execute(
                "INSERT INTO projects(id,name,directory,created_at,updated_at) VALUES('project-1','Example',?1,'now','now')",
                [temp.path().to_string_lossy().to_string()],
            ).expect("project");
            conn.execute(
                "INSERT INTO tasks(id,project_id,title,status,created_at,updated_at) VALUES('task-1','project-1','Example task','running','now','now')",
                [],
            ).expect("running task");
            conn.execute(
                "INSERT INTO task_runs(id,task_id,project_id,task_revision,task_snapshot_json,project_directory,scope_directory,broad_scope,state,progress,created_at,updated_at) VALUES('run-1','task-1','project-1',1,'{}',?1,?1,1,'running','Working','now','now')",
                [temp.path().to_string_lossy().to_string()],
            ).expect("active run");
            conn.execute(
                "INSERT INTO execution_scope_locks(run_id,project_id,canonical_directory,access_mode,acquired_at) VALUES('run-1','project-1',?1,'write','now')",
                [temp.path().to_string_lossy().to_string()],
            ).expect("active scope lock");
        }

        let reopened = Database::open(&database_path).expect("database recovers interrupted run");
        let conn = reopened.connection().expect("database lock");
        let (run_state, source): (String, Option<String>) = conn
            .query_row(
                "SELECT state,reconciliation_from FROM task_runs WHERE id='run-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("reconciled run");
        assert_eq!(run_state, "needs_reconciliation");
        assert_eq!(source.as_deref(), Some("running"));
        let task_state: String = conn
            .query_row("SELECT status FROM tasks WHERE id='task-1'", [], |row| {
                row.get(0)
            })
            .expect("task state");
        assert_eq!(task_state, "needs_reconciliation");
        let lock_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM execution_scope_locks WHERE run_id='run-1'",
                [],
                |row| row.get(0),
            )
            .expect("preserved lock");
        assert_eq!(lock_count, 1);
        assert!(
            conn.execute("DELETE FROM task_runs WHERE id='run-1'", [])
                .is_err(),
            "active reconciliation record cannot be deleted"
        );
    }

    #[test]
    fn task_update_and_active_run_check_share_an_immediate_transaction() {
        let temp = tempfile::tempdir().expect("temporary test directory");
        let db = database_with_task(temp.path(), "queued");
        {
            let conn = db.connection().expect("database lock");
            insert_queued_run(&conn, temp.path());
        }

        let mut conn = db.connection().expect("database lock");
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .expect("immediate update transaction");
        let input = TaskInput {
            project_id: "project-1".into(),
            scope_id: None,
            title: "Changed".into(),
            description: "Changed description".into(),
            priority: "high".into(),
            external_url: None,
        };
        let result = update_task_in_transaction(
            &tx,
            "task-1",
            &input,
            &TaskExternalLink {
                source: "manual".into(),
                reference: None,
                url: None,
                glpi_ticket_id: None,
            },
        );
        assert!(matches!(result, Err(AppError::Validation(_))));
        drop(tx);

        let (title, revision): (String, i64) = conn
            .query_row(
                "SELECT title,revision FROM tasks WHERE id='task-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("task remains unchanged");
        assert_eq!(title, "Original");
        assert_eq!(revision, 1);
    }

    #[test]
    fn project_directory_and_concurrency_updates_reject_queued_runs_atomically() {
        let temp = tempfile::tempdir().expect("temporary test directory");
        let original_directory = temp.path().join("project");
        let changed_directory = temp.path().join("moved");
        std::fs::create_dir_all(&original_directory).expect("original project directory");
        std::fs::create_dir_all(&changed_directory).expect("changed project directory");
        let db = database_with_task(&original_directory, "queued");
        {
            let conn = db.connection().expect("database lock");
            insert_queued_run(&conn, &original_directory);
        }

        for (directory, concurrency) in [
            (original_directory.as_path(), 4),
            (changed_directory.as_path(), 2),
        ] {
            let mut conn = db.connection().expect("database lock");
            let tx = conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .expect("immediate update transaction");
            let input = ProjectInput {
                name: "Example".into(),
                description: String::new(),
                directory: directory.to_string_lossy().into_owned(),
                max_concurrent_sessions: concurrency,
            };
            let canonical_path = std::fs::canonicalize(directory).expect("canonical directory");
            let canonical_text = canonical_path.to_str().expect("test directory is Unicode");
            assert!(matches!(
                update_project_in_transaction(
                    &tx,
                    "project-1",
                    &input,
                    &canonical_path,
                    canonical_text,
                ),
                Err(AppError::Validation(_))
            ));
            drop(tx);
        }

        let conn = db.connection().expect("database lock");
        let (directory, concurrency): (String, i64) = conn
            .query_row(
                "SELECT directory,max_concurrent_sessions FROM projects WHERE id='project-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("project remains unchanged");
        assert_eq!(
            directory,
            std::fs::canonicalize(original_directory)
                .unwrap()
                .to_string_lossy()
        );
        assert_eq!(concurrency, 2);
    }

    #[test]
    fn immediate_update_transaction_serializes_a_competing_scheduler_writer() {
        let temp = tempfile::tempdir().expect("temporary test directory");
        let database_path = temp.path().join("orbyt.sqlite3");
        let db = database_with_task(temp.path(), "awaiting_approval");
        let mut update_connection = db.connection().expect("database lock");
        let tx = update_connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .expect("update reserves write transaction");
        let input = TaskInput {
            project_id: "project-1".into(),
            scope_id: None,
            title: "Revised before approval".into(),
            description: "Updated".into(),
            priority: "medium".into(),
            external_url: None,
        };
        update_task_in_transaction(
            &tx,
            "task-1",
            &input,
            &TaskExternalLink {
                source: "manual".into(),
                reference: None,
                url: None,
                glpi_ticket_id: None,
            },
        )
        .expect("task changes inside transaction");

        let mut scheduler_connection = Connection::open(&database_path).expect("second connection");
        scheduler_connection
            .busy_timeout(std::time::Duration::ZERO)
            .expect("disable lock wait for deterministic assertion");
        assert!(
            scheduler_connection
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .is_err(),
            "a scheduler writer cannot claim the task before the update commits"
        );
        tx.commit().expect("update commits");

        let scheduler_tx = scheduler_connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .expect("scheduler proceeds after update commit");
        let (title, revision): (String, i64) = scheduler_tx
            .query_row(
                "SELECT title,revision FROM tasks WHERE id='task-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("scheduler sees committed task revision");
        assert_eq!(title, "Revised before approval");
        assert_eq!(revision, 2);
        scheduler_tx
            .commit()
            .expect("scheduler transaction commits");
    }

    #[cfg(unix)]
    #[test]
    fn create_project_rejects_non_unicode_canonical_directory_before_persisting() {
        let temp = tempfile::tempdir().expect("temporary test directory");
        let input_path = unicode_symlink_to_non_unicode_directory(temp.path());
        let result = canonical_project_directory(&input_path);
        assert!(matches!(
            result,
            Err(AppError::Validation(message)) if message.contains("Unicode")
        ));

        let db = Database::open(&temp.path().join("orbyt.sqlite3")).expect("database opens");
        let count: i64 = db
            .connection()
            .expect("database lock")
            .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
            .expect("project count");
        assert_eq!(count, 0);
    }

    #[cfg(unix)]
    #[test]
    fn update_project_rejects_non_unicode_canonical_directory_without_mutation() {
        let temp = tempfile::tempdir().expect("temporary test directory");
        let original = temp.path().join("existing-project");
        std::fs::create_dir(&original).expect("existing project directory");
        let input_path = unicode_symlink_to_non_unicode_directory(temp.path());
        let db = database_with_task(&original, "pending");
        let input = ProjectInput {
            name: "Changed".into(),
            description: String::new(),
            directory: input_path,
            max_concurrent_sessions: 3,
        };

        let result = canonical_project_directory(&input.directory);
        assert!(matches!(
            result,
            Err(AppError::Validation(message)) if message.contains("Unicode")
        ));
        let conn = db.connection().expect("database lock");
        let (name, directory): (String, String) = conn
            .query_row(
                "SELECT name,directory FROM projects WHERE id='project-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("project remains available");
        assert_eq!(name, "Example");
        assert_eq!(
            directory,
            std::fs::canonicalize(original)
                .expect("canonical original path")
                .to_str()
                .expect("Unicode original path")
        );
    }

    #[test]
    fn task_text_has_backend_limits_for_triage_arguments() {
        assert!(validate_task_text("A task", &"x".repeat(10_001)).is_err());
        assert!(validate_task_text(&"x".repeat(201), "").is_err());
        assert!(validate_task_text("A task", &"x".repeat(10_000)).is_ok());
    }

    #[test]
    fn github_project_triage_assigns_only_matching_pending_tasks_to_writable_scope() {
        let temp = tempfile::tempdir().expect("temporary test directory");
        let db = database_with_task(temp.path(), "pending");
        let scope_dir = temp.path().join("src");
        std::fs::create_dir(&scope_dir).expect("scope directory exists");
        db.connection()
            .expect("database lock")
            .execute(
                "INSERT INTO execution_scopes(id,project_id,name,relative_directory,read_access,write_access,created_at) VALUES('scope-1','project-1','Source','src',1,1,'now')",
                [],
            )
            .expect("scope persists");
        let connection = SourceConnection {
            id: "project-source-1".into(),
            provider: "github".into(),
            project_id: "project-1".into(),
            source_key: "acme/orbyt".into(),
            display_name: "acme/orbyt".into(),
            api_endpoint: "https://api.github.com/".into(),
            last_synced_at: None,
            created_at: "now".into(),
            updated_at: "now".into(),
        };
        let issue = ExternalTask {
            external_reference: "acme/orbyt#42".into(),
            external_url: "https://github.com/acme/orbyt/issues/42".into(),
            title: "Fix the plugin".into(),
            description: "Linked request details".into(),
            external_status: "Não Iniciado".into(),
            external_updated_at: Some("2026-10-11T12:00:00Z".into()),
            import_when_missing: true,
        };
        persist_external_tasks(&db, &connection, std::slice::from_ref(&issue), "sync-1")
            .expect("issue imports");

        let candidates = prepare_github_project_triage(
            &db,
            "project-1",
            Some("scope-1"),
            std::slice::from_ref(&issue),
        )
        .expect("new issue is ready for triage");
        assert_eq!(candidates.len(), 1);
        let (task_scope, task_status): (Option<String>, String) = db
            .connection()
            .expect("database lock")
            .query_row(
                "SELECT scope_id,status FROM tasks WHERE id=?1",
                [&candidates[0]],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("task is readable");
        assert_eq!(task_scope.as_deref(), Some("scope-1"));
        assert_eq!(task_status, "pending");
        assert!(matches!(
            prepare_github_project_triage(&db, "project-1", None, std::slice::from_ref(&issue)),
            Err(AppError::Validation(_))
        ));
    }

    #[test]
    fn external_sync_is_idempotent_and_preserves_local_task_workflow() {
        let temp = tempfile::tempdir().expect("temporary test directory");
        let db = database_with_task(temp.path(), "pending");
        let connection = SourceConnection {
            id: "source-1".into(),
            provider: "github".into(),
            project_id: "project-1".into(),
            source_key: "acme/orbyt".into(),
            display_name: "acme/orbyt".into(),
            api_endpoint: "https://api.github.com/".into(),
            last_synced_at: None,
            created_at: "now".into(),
            updated_at: "now".into(),
        };
        db.connection()
            .expect("database lock")
            .execute("DELETE FROM tasks WHERE id='task-1'", [])
            .expect("remove helper task");
        db.connection()
            .expect("database lock")
            .execute(
                "INSERT INTO source_connections(id,provider,project_id,source_key,display_name,api_endpoint,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?7)",
                params![connection.id, connection.provider, connection.project_id, connection.source_key, connection.display_name, connection.api_endpoint, "now"],
            )
            .expect("connection persists");

        let issue = ExternalTask {
            external_reference: "acme/orbyt#42".into(),
            external_url: "https://github.com/acme/orbyt/issues/42".into(),
            title: "Original issue title".into(),
            description: "Original issue body".into(),
            external_status: "open".into(),
            external_updated_at: Some("2026-10-10T12:00:00Z".into()),
            import_when_missing: true,
        };
        assert_eq!(
            persist_external_tasks(&db, &connection, std::slice::from_ref(&issue), "sync-1")
                .expect("first sync"),
            (1, 0, 0)
        );

        let second_project_directory = temp.path().join("second-project");
        std::fs::create_dir(&second_project_directory).expect("second project directory");
        db.connection()
            .expect("database lock")
            .execute(
                "INSERT INTO projects(id,name,directory,created_at,updated_at) VALUES('project-2','Second',?1,'now','now')",
                [second_project_directory.to_string_lossy()],
            )
            .expect("second project persists");
        let second_connection = SourceConnection {
            id: "source-2".into(),
            project_id: "project-2".into(),
            ..connection.clone()
        };
        db.connection()
            .expect("database lock")
            .execute(
                "INSERT INTO source_connections(id,provider,project_id,source_key,display_name,api_endpoint,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?7)",
                params![second_connection.id, second_connection.provider, second_connection.project_id, second_connection.source_key, second_connection.display_name, second_connection.api_endpoint, "now"],
            )
            .expect("second connection persists");
        assert_eq!(
            persist_external_tasks(
                &db,
                &second_connection,
                std::slice::from_ref(&issue),
                "sync-project-2-1"
            )
            .expect("same issue imports independently for the second project"),
            (1, 0, 0)
        );

        db.connection()
            .expect("database lock")
            .execute(
                "UPDATE tasks SET title='Local title',description='Local notes',status='awaiting_approval' WHERE project_id='project-1' AND external_reference=?1",
                [&issue.external_reference],
            )
            .expect("simulate local review work");

        let changed_issue = ExternalTask {
            external_status: "closed".into(),
            external_updated_at: Some("2026-10-11T12:00:00Z".into()),
            ..issue.clone()
        };
        assert_eq!(
            persist_external_tasks(
                &db,
                &connection,
                std::slice::from_ref(&changed_issue),
                "sync-2"
            )
            .expect("refresh sync"),
            (0, 1, 0)
        );
        assert_eq!(
            persist_external_tasks(
                &db,
                &connection,
                std::slice::from_ref(&changed_issue),
                "sync-3"
            )
            .expect("repeat sync"),
            (0, 0, 1)
        );
        let (title, description, local_status, external_status): (String, String, String, String) =
            db.connection()
                .expect("database lock")
                .query_row(
                    "SELECT title,description,status,external_status FROM tasks WHERE project_id='project-1' AND external_reference=?1",
                    [&issue.external_reference],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .expect("imported issue remains present");
        assert_eq!(title, "Local title");
        assert_eq!(description, "Local notes");
        assert_eq!(local_status, "awaiting_approval");
        assert_eq!(external_status, "closed");
        let second_project_status: String = db
            .connection()
            .expect("database lock")
            .query_row(
                "SELECT external_status FROM tasks WHERE project_id='project-2' AND external_reference=?1",
                [&issue.external_reference],
                |row| row.get(0),
            )
            .expect("second project's imported issue remains independent");
        assert_eq!(second_project_status, "open");
    }
}
