use keyring::v1::Entry;
use reqwest::{header, redirect::Policy, Client, Response, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use thiserror::Error;
use url::Url;

const GITHUB_API: &str = "https://api.github.com/";
const GITHUB_API_VERSION: &str = "2026-03-10";
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const PAGE_SIZE: usize = 100;

#[derive(Debug, Error)]
pub enum SourceError {
    #[error("invalid integration configuration")]
    InvalidConfiguration,
    #[error("the system credential store is unavailable")]
    CredentialStore,
    #[error("credentials are missing or unavailable")]
    MissingCredentials,
    #[error("the remote service rejected the request (HTTP {0})")]
    RemoteStatus(u16),
    #[error("GLPI rejected authentication (HTTP 401); check the GLPI user token and, if configured, the App-Token")]
    GlpiAuthenticationRejected,
    #[error("GLPI denied this request (HTTP 403); check the account's API permissions and the configured App-Token")]
    GlpiPermissionDenied,
    #[error("the GLPI API endpoint was not found (HTTP 404); check the configured host, API path, and that the GLPI REST API is enabled")]
    GlpiEndpointNotFound,
    #[error("GLPI returned HTTP {0}; check the configured GLPI API endpoint, credentials, and account permissions")]
    GlpiRemoteStatus(u16),
    #[error("the remote service returned an invalid response")]
    InvalidResponse,
    #[error("the remote service could not be reached")]
    RequestFailed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceConnection {
    pub id: String,
    pub provider: String,
    pub project_id: String,
    pub source_key: String,
    pub display_name: String,
    pub api_endpoint: String,
    pub last_synced_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubConnectInput {
    pub project_id: String,
    pub owner: String,
    pub repository: String,
    pub token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlpiConnectInput {
    pub project_id: String,
    pub api_endpoint: String,
    pub user_token: String,
    #[serde(default)]
    pub app_token: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSyncResult {
    pub connection_id: String,
    pub provider: String,
    pub seen: usize,
    pub imported: usize,
    pub refreshed: usize,
    pub unchanged: usize,
    pub triage_task_ids: Vec<String>,
    pub truncated: bool,
    pub limit: usize,
    pub synced_at: String,
}

#[derive(Debug, Clone)]
pub struct ExternalTask {
    pub external_reference: String,
    pub external_url: String,
    pub title: String,
    pub description: String,
    pub external_status: String,
    pub external_updated_at: Option<String>,
    pub import_when_missing: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StoredSecrets {
    pub github_token: Option<String>,
    pub glpi_user_token: Option<String>,
    pub glpi_app_token: Option<String>,
}

fn client() -> Result<Client, SourceError> {
    Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(Policy::none())
        .user_agent(concat!("Orbyt/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| SourceError::RequestFailed)
}

pub fn normalize_glpi_endpoint(input: &str) -> Result<Url, SourceError> {
    if input.trim().len() > 2048 {
        return Err(SourceError::InvalidConfiguration);
    }
    let mut url = Url::parse(input.trim()).map_err(|_| SourceError::InvalidConfiguration)?;
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(SourceError::InvalidConfiguration);
    }
    if url.scheme() == "http" && !is_loopback_host(url.host_str().unwrap_or_default()) {
        return Err(SourceError::InvalidConfiguration);
    }
    let mut path = url.path().trim_end_matches('/').to_owned();
    if path.is_empty() {
        path.push_str("/apirest.php");
    } else if !(path.ends_with("/apirest.php") || path.ends_with("/api")) {
        path.push_str("/apirest.php");
    }
    if !path.ends_with('/') {
        path.push('/');
    }
    url.set_path(&path);
    Ok(url)
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

pub fn validate_github_input(
    owner: &str,
    repository: &str,
    token: &str,
) -> Result<(String, String), SourceError> {
    let valid_segment = |value: &str| {
        !value.is_empty()
            && value.len() <= 100
            && value != "."
            && value != ".."
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    };
    if !valid_segment(owner)
        || !valid_segment(repository)
        || token.trim().is_empty()
        || token.len() > 4096
        || token.chars().any(char::is_control)
    {
        return Err(SourceError::InvalidConfiguration);
    }
    Ok((owner.trim().to_owned(), repository.trim().to_owned()))
}

pub async fn verify_github_repository(
    owner: &str,
    repository: &str,
    token: &str,
) -> Result<String, SourceError> {
    let api_base = Url::parse(GITHUB_API).map_err(|_| SourceError::InvalidConfiguration)?;
    verify_github_repository_at(&api_base, owner, repository, token).await
}

async fn verify_github_repository_at(
    api_base: &Url,
    owner: &str,
    repository: &str,
    token: &str,
) -> Result<String, SourceError> {
    let (owner, repository) = validate_github_input(owner, repository, token)?;
    let url = api_base
        .join(&format!("repos/{owner}/{repository}"))
        .map_err(|_| SourceError::InvalidConfiguration)?;
    let mut request = client()?
        .get(url)
        .header(header::ACCEPT, "application/vnd.github+json")
        .header("X-GitHub-Api-Version", GITHUB_API_VERSION);
    if !token.trim().is_empty() {
        request = request.bearer_auth(token.trim());
    }
    let response = request
        .send()
        .await
        .map_err(|_| SourceError::RequestFailed)?;
    let body = read_json(response).await?;
    let full_name = body
        .get("full_name")
        .and_then(Value::as_str)
        .ok_or(SourceError::InvalidResponse)?;
    let (canonical_owner, canonical_repository) = full_name
        .split_once('/')
        .ok_or(SourceError::InvalidResponse)?;
    let (canonical_owner, canonical_repository) =
        validate_github_input(canonical_owner, canonical_repository, token)?;
    verify_github_issue_access_at(api_base, &canonical_owner, &canonical_repository, token).await?;
    Ok(format!("{canonical_owner}/{canonical_repository}"))
}

async fn verify_github_issue_access_at(
    api_base: &Url,
    owner: &str,
    repository: &str,
    token: &str,
) -> Result<(), SourceError> {
    let url = api_base
        .join(&format!("repos/{owner}/{repository}/issues"))
        .map_err(|_| SourceError::InvalidConfiguration)?;
    let mut request = client()?
        .get(url)
        .query(&[("state", "open"), ("per_page", "1")])
        .header(header::ACCEPT, "application/vnd.github+json")
        .header("X-GitHub-Api-Version", GITHUB_API_VERSION);
    if !token.trim().is_empty() {
        request = request.bearer_auth(token.trim());
    }
    let response = request
        .send()
        .await
        .map_err(|_| SourceError::RequestFailed)?;
    let body = read_json(response).await?;
    if body.is_array() {
        Ok(())
    } else {
        Err(SourceError::InvalidResponse)
    }
}

pub fn store_secrets(connection_id: &str, secrets: &StoredSecrets) -> Result<(), SourceError> {
    let entry = Entry::new("dev.orbyt.external-sources", connection_id)
        .map_err(|_| SourceError::CredentialStore)?;
    let serialized = serde_json::to_string(secrets).map_err(|_| SourceError::CredentialStore)?;
    entry
        .set_password(&serialized)
        .map_err(|_| SourceError::CredentialStore)
}

pub fn load_secrets(connection_id: &str) -> Result<StoredSecrets, SourceError> {
    let entry = Entry::new("dev.orbyt.external-sources", connection_id)
        .map_err(|_| SourceError::CredentialStore)?;
    let serialized = entry
        .get_password()
        .map_err(|_| SourceError::MissingCredentials)?;
    serde_json::from_str(&serialized).map_err(|_| SourceError::MissingCredentials)
}

pub fn delete_secrets(connection_id: &str) -> Result<(), SourceError> {
    let entry = Entry::new("dev.orbyt.external-sources", connection_id)
        .map_err(|_| SourceError::CredentialStore)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(SourceError::CredentialStore),
    }
}

pub async fn verify_glpi(endpoint: &Url, secrets: &StoredSecrets) -> Result<(), SourceError> {
    let session = open_glpi_session(endpoint, secrets).await?;
    let result = fetch_glpi_tickets_with_session(endpoint, secrets, &session)
        .await
        .map(|_| ());
    let close_result = close_glpi_session(endpoint, secrets, &session).await;
    result.and(close_result)
}

pub async fn fetch_glpi_tickets(
    endpoint: &Url,
    secrets: &StoredSecrets,
) -> Result<(Vec<ExternalTask>, bool), SourceError> {
    let session = open_glpi_session(endpoint, secrets).await?;
    let result = fetch_glpi_tickets_with_session(endpoint, secrets, &session).await;
    let close_result = close_glpi_session(endpoint, secrets, &session).await;
    match result {
        Err(error) => Err(error),
        Ok(tasks) => {
            close_result?;
            Ok(tasks)
        }
    }
}

async fn open_glpi_session(endpoint: &Url, secrets: &StoredSecrets) -> Result<String, SourceError> {
    let user_token = secrets
        .glpi_user_token
        .as_deref()
        .filter(|token| !token.trim().is_empty())
        .ok_or(SourceError::MissingCredentials)?;
    let mut request = client()?
        .get(
            endpoint
                .join("initSession/")
                .map_err(|_| SourceError::InvalidConfiguration)?,
        )
        .header("Authorization", format!("user_token {}", user_token.trim()));
    if let Some(app_token) = secrets
        .glpi_app_token
        .as_deref()
        .filter(|token| !token.trim().is_empty())
    {
        request = request.header("App-Token", app_token.trim());
    }
    let response = request
        .send()
        .await
        .map_err(|_| SourceError::RequestFailed)?;
    let body = read_glpi_json(response).await?;
    body.get("session_token")
        .and_then(Value::as_str)
        .filter(|token| !token.trim().is_empty())
        .map(str::to_owned)
        .ok_or(SourceError::InvalidResponse)
}

async fn close_glpi_session(
    endpoint: &Url,
    secrets: &StoredSecrets,
    session: &str,
) -> Result<(), SourceError> {
    let mut request = client()?
        .get(
            endpoint
                .join("killSession/")
                .map_err(|_| SourceError::InvalidConfiguration)?,
        )
        .header("Session-Token", session);
    if let Some(app_token) = secrets
        .glpi_app_token
        .as_deref()
        .filter(|token| !token.trim().is_empty())
    {
        request = request.header("App-Token", app_token.trim());
    }
    let response = request
        .send()
        .await
        .map_err(|_| SourceError::RequestFailed)?;
    ensure_glpi_success(response.status())
}

async fn fetch_glpi_tickets_with_session(
    endpoint: &Url,
    secrets: &StoredSecrets,
    session: &str,
) -> Result<(Vec<ExternalTask>, bool), SourceError> {
    let mut options_request = client()?
        .get(
            endpoint
                .join("listSearchOptions/Ticket")
                .map_err(|_| SourceError::InvalidConfiguration)?,
        )
        .header("Session-Token", session);
    if let Some(app_token) = secrets
        .glpi_app_token
        .as_deref()
        .filter(|token| !token.trim().is_empty())
    {
        options_request = options_request.header("App-Token", app_token.trim());
    }
    let options_response = options_request
        .send()
        .await
        .map_err(|_| SourceError::RequestFailed)?;
    let options = read_glpi_json(options_response).await?;
    let id_field = find_search_field(&options, "id").ok_or(SourceError::InvalidResponse)?;
    let name_field = find_search_field(&options, "name").ok_or(SourceError::InvalidResponse)?;
    let content_field =
        find_search_field(&options, "content").ok_or(SourceError::InvalidResponse)?;
    let status_field = find_search_field(&options, "status").ok_or(SourceError::InvalidResponse)?;
    let date_field = find_search_field(&options, "date_mod");
    let (open_rows, open_truncated) = search_glpi_tickets(
        endpoint,
        secrets,
        session,
        &id_field,
        &name_field,
        &content_field,
        &status_field,
        date_field.as_deref(),
        false,
    )
    .await?;
    let web_root = glpi_web_root(endpoint);
    let open_tasks = open_rows
        .into_iter()
        .filter_map(|row| {
            parse_glpi_ticket(
                &row,
                &id_field,
                &name_field,
                &content_field,
                &status_field,
                date_field.as_deref(),
                &web_root,
                true,
            )
        })
        .collect::<Vec<_>>();
    Ok((open_tasks, open_truncated))
}

#[allow(clippy::too_many_arguments)]
async fn search_glpi_tickets(
    endpoint: &Url,
    secrets: &StoredSecrets,
    session: &str,
    id_field: &str,
    name_field: &str,
    content_field: &str,
    status_field: &str,
    date_field: Option<&str>,
    closed: bool,
) -> Result<(Vec<Value>, bool), SourceError> {
    let mut url = endpoint
        .join("search/Ticket/")
        .map_err(|_| SourceError::InvalidConfiguration)?;
    {
        let mut query = url.query_pairs_mut();
        let link = if closed { "OR" } else { "AND" };
        let search_type = if closed { "equals" } else { "notequals" };
        for (index, value) in [(0, "5"), (1, "6")] {
            if index > 0 {
                query.append_pair(&format!("criteria[{index}][link]"), link);
            }
            query.append_pair(&format!("criteria[{index}][field]"), status_field);
            query.append_pair(&format!("criteria[{index}][searchtype]"), search_type);
            query.append_pair(&format!("criteria[{index}][value]"), value);
        }
        query.append_pair("sort", date_field.unwrap_or(id_field));
        query.append_pair("order", "DESC");
        query.append_pair("range", "0-99");
        for (index, field) in [id_field, name_field, content_field, status_field]
            .into_iter()
            .chain(date_field)
            .enumerate()
        {
            query.append_pair(&format!("forcedisplay[{index}]"), field);
        }
    }
    let mut request = client()?.get(url).header("Session-Token", session);
    if let Some(app_token) = secrets
        .glpi_app_token
        .as_deref()
        .filter(|token| !token.trim().is_empty())
    {
        request = request.header("App-Token", app_token.trim());
    }
    let response = request
        .send()
        .await
        .map_err(|_| SourceError::RequestFailed)?;
    let body = read_glpi_json(response).await?;
    let total = body.get("totalcount").and_then(Value::as_u64).unwrap_or(0) as usize;
    let rows = body
        .get("data")
        .and_then(Value::as_array)
        .map(|rows| rows.to_vec())
        .or_else(|| {
            body.get("data")
                .and_then(Value::as_object)
                .map(|rows| rows.values().cloned().collect())
        })
        .ok_or(SourceError::InvalidResponse)?;
    Ok((rows, total > PAGE_SIZE))
}

fn find_search_field(options: &Value, target: &str) -> Option<String> {
    options.as_object()?.iter().find_map(|(id, option)| {
        let field = option.get("field").and_then(Value::as_str)?;
        (field.eq_ignore_ascii_case(target) && id.parse::<u32>().is_ok()).then(|| id.clone())
    })
}

fn parse_glpi_ticket(
    row: &Value,
    id_field: &str,
    name_field: &str,
    content_field: &str,
    status_field: &str,
    date_field: Option<&str>,
    web_root: &Url,
    import_when_missing: bool,
) -> Option<ExternalTask> {
    let id = row.get(id_field)?.as_str().map(str::to_owned).or_else(|| {
        row.get(id_field)
            .and_then(Value::as_u64)
            .map(|value| value.to_string())
    })?;
    if id.is_empty() || id.len() > 20 || !id.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let title = row
        .get(name_field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(|value| bounded_text(value, 200))
        .unwrap_or_else(|| format!("GLPI ticket #{id}"));
    let description = row
        .get(content_field)
        .and_then(Value::as_str)
        .map(|value| bounded_text(value, 10_000))
        .unwrap_or_default();
    let external_status = row
        .get(status_field)
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| value.to_string())
        })
        .map(|value| bounded_text(&value, 120))
        .unwrap_or_else(|| "unknown".into());
    let external_updated_at = date_field
        .and_then(|field| row.get(field))
        .and_then(Value::as_str)
        .map(|value| bounded_text(value, 80));
    let mut ticket_url = web_root.clone();
    ticket_url.set_path(&format!("{}front/ticket.form.php", web_root.path()));
    ticket_url.query_pairs_mut().append_pair("id", &id);
    Some(ExternalTask {
        external_reference: format!("{}Ticket/{id}", web_root),
        external_url: ticket_url.to_string(),
        title,
        description,
        external_status,
        external_updated_at,
        import_when_missing,
    })
}

fn glpi_web_root(endpoint: &Url) -> Url {
    let mut root = endpoint.clone();
    let mut path = root.path().to_owned();
    for suffix in ["apirest.php/", "api/"] {
        if let Some(prefix) = path.strip_suffix(suffix) {
            path = prefix.to_owned();
            break;
        }
    }
    if !path.ends_with('/') {
        path.push('/');
    }
    root.set_path(&path);
    root
}

async fn read_json(response: Response) -> Result<Value, SourceError> {
    ensure_success(response.status())?;
    read_json_body(response).await
}

async fn read_glpi_json(response: Response) -> Result<Value, SourceError> {
    ensure_glpi_success(response.status())?;
    read_json_body(response).await
}

async fn read_json_body(response: Response) -> Result<Value, SourceError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(SourceError::InvalidResponse);
    }
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| SourceError::RequestFailed)?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(SourceError::InvalidResponse);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| SourceError::InvalidResponse)
}

fn ensure_success(status: StatusCode) -> Result<(), SourceError> {
    if status.is_success() {
        Ok(())
    } else {
        Err(SourceError::RemoteStatus(status.as_u16()))
    }
}

fn ensure_glpi_success(status: StatusCode) -> Result<(), SourceError> {
    if status.is_success() {
        return Ok(());
    }
    Err(match status.as_u16() {
        401 => SourceError::GlpiAuthenticationRejected,
        403 => SourceError::GlpiPermissionDenied,
        404 => SourceError::GlpiEndpointNotFound,
        status => SourceError::GlpiRemoteStatus(status),
    })
}

fn bounded_text(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::HashMap,
        io::{BufRead, BufReader, Write},
        net::TcpListener,
        thread::{self, JoinHandle},
        time::Instant,
    };

    #[test]
    fn glpi_http_errors_offer_safe_setup_and_permission_guidance() {
        for (status, expected) in [
            (401, "check the GLPI user token"),
            (403, "check the account's API permissions"),
            (404, "check the configured host, API path"),
            (503, "check the configured GLPI API endpoint"),
        ] {
            let status = StatusCode::from_u16(status).expect("test status is valid");
            let error = ensure_glpi_success(status).expect_err("non-success status is rejected");
            let message = error.to_string();
            assert!(message.contains(expected));
            assert!(!message.contains("response body"));
            assert!(!message.contains("token-value"));
        }
    }

    #[derive(Debug)]
    struct MockRequest {
        target: String,
        headers: HashMap<String, String>,
    }

    type MockResponse = (u16, String, Option<String>);

    fn mock_response(status: u16, body: Value) -> MockResponse {
        (status, body.to_string(), None)
    }

    fn start_mock_http_server(
        responses: Vec<MockResponse>,
        base_path: &str,
    ) -> (Url, JoinHandle<Vec<MockRequest>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("mock listener binds");
        listener
            .set_nonblocking(true)
            .expect("mock listener is nonblocking");
        let address = listener.local_addr().expect("mock address is readable");
        let server = thread::spawn(move || {
            let mut requests = Vec::with_capacity(responses.len());
            for (status, body, location) in responses {
                let deadline = Instant::now() + Duration::from_secs(3);
                let (mut stream, _) = loop {
                    match listener.accept() {
                        Ok(connection) => break connection,
                        Err(error)
                            if error.kind() == std::io::ErrorKind::WouldBlock
                                && Instant::now() < deadline =>
                        {
                            thread::sleep(Duration::from_millis(5));
                        }
                        Err(error) => panic!("mock request was not received: {error}"),
                    }
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .expect("mock stream timeout is set");
                let mut reader = BufReader::new(
                    stream
                        .try_clone()
                        .expect("mock stream can be cloned for reading"),
                );
                let mut request_line = String::new();
                reader
                    .read_line(&mut request_line)
                    .expect("request line is readable");
                let target = request_line
                    .split_whitespace()
                    .nth(1)
                    .expect("request target is present")
                    .to_owned();
                let mut headers = HashMap::new();
                loop {
                    let mut line = String::new();
                    reader
                        .read_line(&mut line)
                        .expect("request header is readable");
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                    if let Some((name, value)) = line.split_once(':') {
                        headers.insert(name.to_ascii_lowercase(), value.trim().to_owned());
                    }
                }
                let reason = match status {
                    200 => "OK",
                    302 => "Found",
                    403 => "Forbidden",
                    _ => "Mock",
                };
                let location_header = location
                    .map(|url| format!("Location: {url}\r\n"))
                    .unwrap_or_default();
                write!(
                    stream,
                    "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{location_header}\r\n{body}",
                    body.len()
                )
                .expect("mock response is written");
                stream.flush().expect("mock response is flushed");
                requests.push(MockRequest { target, headers });
            }
            requests
        });
        let endpoint =
            Url::parse(&format!("http://{address}{base_path}")).expect("mock HTTP endpoint parses");
        (endpoint, server)
    }

    fn mock_query(request: &MockRequest) -> HashMap<String, String> {
        let query = request
            .target
            .split_once('?')
            .map(|(_, query)| query)
            .unwrap_or_default();
        url::form_urlencoded::parse(query.as_bytes())
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect()
    }

    #[test]
    fn glpi_endpoint_is_normalized_and_requires_tls_off_loopback() {
        assert_eq!(
            normalize_glpi_endpoint("https://glpi.example.org/glpi")
                .expect("valid endpoint")
                .as_str(),
            "https://glpi.example.org/glpi/apirest.php/"
        );
        assert!(normalize_glpi_endpoint("http://glpi.example.org/apirest.php").is_err());
        assert!(normalize_glpi_endpoint("https://user:pass@glpi.example.org").is_err());
        assert!(normalize_glpi_endpoint("https://glpi.example.org/?token=secret").is_err());
        assert!(normalize_glpi_endpoint("http://127.0.0.1/glpi/apirest.php").is_ok());
    }

    #[tokio::test]
    async fn github_repository_verification_uses_read_only_auth() {
        let (api_base, server) = start_mock_http_server(
            vec![
                mock_response(200, serde_json::json!({"full_name":"Acme/Orbyt"})),
                mock_response(200, serde_json::json!([])),
            ],
            "/api/v3/",
        );

        let repository =
            verify_github_repository_at(&api_base, "acme", "orbyt", "mock-github-token")
                .await
                .expect("repository connection succeeds");
        let requests = server.join().expect("mock server finishes");

        assert_eq!(repository, "Acme/Orbyt");
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].target, "/api/v3/repos/acme/orbyt");
        for request in &requests {
            assert_eq!(
                request.headers.get("authorization").map(String::as_str),
                Some("Bearer mock-github-token")
            );
            assert_eq!(
                request
                    .headers
                    .get("x-github-api-version")
                    .map(String::as_str),
                Some(GITHUB_API_VERSION)
            );
        }
        let access_query = mock_query(&requests[1]);
        assert_eq!(access_query.get("state").map(String::as_str), Some("open"));
        assert_eq!(access_query.get("per_page").map(String::as_str), Some("1"));
    }

    #[test]
    fn glpi_search_options_resolve_status_and_ticket_fields_by_api_field_name() {
        let options = serde_json::json!({
            "1":{"name":"Name","field":"name"},
            "2":{"name":"ID","field":"id"},
            "12":{"name":"Status","field":"status"},
            "21":{"name":"Content","field":"content"},
            "19":{"name":"Last update","field":"date_mod"}
        });
        assert_eq!(find_search_field(&options, "status").as_deref(), Some("12"));
        assert_eq!(
            find_search_field(&options, "date_mod").as_deref(),
            Some("19")
        );
        assert_eq!(find_search_field(&options, "missing"), None);
    }

    #[test]
    fn closed_glpi_ticket_can_refresh_but_is_not_imported_as_a_new_task() {
        let api = normalize_glpi_endpoint("https://glpi.example.org/glpi/apirest.php")
            .expect("valid GLPI endpoint");
        let web_root = glpi_web_root(&api);
        let row = serde_json::json!({
            "2":"27",
            "1":"Resolved ticket",
            "21":"Ticket body",
            "12":"Solved",
            "19":"2026-10-10 12:00:00"
        });
        let task = parse_glpi_ticket(&row, "2", "1", "21", "12", Some("19"), &web_root, false)
            .expect("ticket maps");
        assert_eq!(
            task.external_reference,
            "https://glpi.example.org/glpi/Ticket/27"
        );
        assert_eq!(task.external_status, "Solved");
        assert!(!task.import_when_missing);
        assert!(task.external_url.contains("ticket.form.php?id=27"));
    }

    #[tokio::test]
    async fn glpi_sync_uses_v1_auth_dynamic_fields_and_closes_session() {
        let options = serde_json::json!({
            "1":{"name":"Name","field":"name"},
            "2":{"name":"ID","field":"id"},
            "12":{"name":"Status","field":"status"},
            "21":{"name":"Content","field":"content"},
            "19":{"name":"Last update","field":"date_mod"}
        });
        let open_results = serde_json::json!({
            "totalcount":1,
            "data":[{"2":"27","1":"Open ticket","21":"Open body","12":"2","19":"2026-10-10 10:00:00"}]
        });
        let (endpoint, server) = start_mock_http_server(
            vec![
                mock_response(200, serde_json::json!({"session_token":"mock-session"})),
                mock_response(200, options),
                mock_response(200, open_results),
                mock_response(200, serde_json::json!({"message":"Session terminated"})),
            ],
            "/glpi/apirest.php/",
        );
        let secrets = StoredSecrets {
            github_token: None,
            glpi_user_token: Some("mock-user-token".into()),
            glpi_app_token: Some("mock-app-token".into()),
        };

        let (tasks, truncated) = fetch_glpi_tickets(&endpoint, &secrets)
            .await
            .expect("GLPI sync succeeds");
        let requests = server.join().expect("mock server finishes");

        assert!(!truncated);
        assert_eq!(tasks.len(), 1);
        assert!(tasks[0].external_reference.ends_with("/glpi/Ticket/27"));
        assert!(tasks[0].import_when_missing);
        assert_eq!(requests.len(), 4);
        assert_eq!(requests[0].target, "/glpi/apirest.php/initSession/");
        assert_eq!(
            requests[0].headers.get("authorization").map(String::as_str),
            Some("user_token mock-user-token")
        );
        assert_eq!(
            requests[0].headers.get("app-token").map(String::as_str),
            Some("mock-app-token")
        );
        for request in &requests[1..] {
            assert_eq!(
                request.headers.get("session-token").map(String::as_str),
                Some("mock-session")
            );
            assert_eq!(
                request.headers.get("app-token").map(String::as_str),
                Some("mock-app-token")
            );
        }
        assert_eq!(
            requests[1].target,
            "/glpi/apirest.php/listSearchOptions/Ticket"
        );
        assert_eq!(
            requests[2].target.split('?').next(),
            Some("/glpi/apirest.php/search/Ticket/")
        );
        assert_eq!(requests[3].target, "/glpi/apirest.php/killSession/");

        let open_query = mock_query(&requests[2]);
        assert_eq!(
            open_query.get("criteria[0][field]").map(String::as_str),
            Some("12")
        );
        assert_eq!(
            open_query
                .get("criteria[0][searchtype]")
                .map(String::as_str),
            Some("notequals")
        );
        assert_eq!(
            open_query.get("criteria[1][link]").map(String::as_str),
            Some("AND")
        );
        assert_eq!(open_query.get("range").map(String::as_str), Some("0-99"));
        assert_eq!(
            open_query.get("forcedisplay[4]").map(String::as_str),
            Some("19")
        );
    }

    #[tokio::test]
    async fn glpi_sync_reports_truncation_when_unresolved_result_exceeds_bounded_page() {
        let (endpoint, server) = start_mock_http_server(
            vec![mock_response(
                200,
                serde_json::json!({"totalcount":101,"data": []}),
            )],
            "/glpi/apirest.php/",
        );
        let secrets = StoredSecrets {
            github_token: None,
            glpi_user_token: None,
            glpi_app_token: None,
        };
        let (rows, truncated) = search_glpi_tickets(
            &endpoint,
            &secrets,
            "mock-session",
            "2",
            "1",
            "21",
            "12",
            Some("19"),
            false,
        )
        .await
        .expect("bounded GLPI search succeeds");
        let requests = server.join().expect("mock server finishes");
        assert!(rows.is_empty());
        assert!(truncated);
        let query = mock_query(&requests[0]);
        assert_eq!(query.get("range").map(String::as_str), Some("0-99"));
        assert_eq!(query.get("order").map(String::as_str), Some("DESC"));
    }

    #[tokio::test]
    async fn glpi_sync_kills_session_after_ticket_search_fails() {
        let options = serde_json::json!({
            "1":{"name":"Name","field":"name"},
            "2":{"name":"ID","field":"id"},
            "12":{"name":"Status","field":"status"},
            "21":{"name":"Content","field":"content"}
        });
        let (endpoint, server) = start_mock_http_server(
            vec![
                mock_response(200, serde_json::json!({"session_token":"mock-session"})),
                mock_response(200, options),
                mock_response(403, serde_json::json!({"error":"permission denied"})),
                mock_response(200, serde_json::json!({"message":"Session terminated"})),
            ],
            "/glpi/apirest.php/",
        );
        let secrets = StoredSecrets {
            github_token: None,
            glpi_user_token: Some("mock-user-token".into()),
            glpi_app_token: None,
        };

        let result = fetch_glpi_tickets(&endpoint, &secrets).await;
        let requests = server.join().expect("mock server finishes");

        assert!(matches!(result, Err(SourceError::GlpiPermissionDenied)));
        assert_eq!(requests.len(), 4);
        assert_eq!(
            requests.last().map(|request| request.target.as_str()),
            Some("/glpi/apirest.php/killSession/")
        );
    }

    #[tokio::test]
    async fn glpi_authenticated_requests_do_not_follow_redirects() {
        let (endpoint, server) = start_mock_http_server(
            vec![(
                302,
                "{}".into(),
                Some("https://example.invalid/collect".into()),
            )],
            "/glpi/apirest.php/",
        );
        let secrets = StoredSecrets {
            github_token: None,
            glpi_user_token: Some("mock-user-token".into()),
            glpi_app_token: None,
        };

        let result = fetch_glpi_tickets(&endpoint, &secrets).await;
        let requests = server.join().expect("mock server finishes");

        assert!(matches!(result, Err(SourceError::GlpiRemoteStatus(302))));
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].target, "/glpi/apirest.php/initSession/");
    }
}
