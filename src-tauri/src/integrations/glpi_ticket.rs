//! GLPI 10 ticket context access through the configured legacy REST API.
//!
//! The endpoint is supplied by the saved source connection. Callers pass only a
//! numeric GLPI ID from the issue body; this module never accepts a URL per task.

use reqwest::{header, redirect::Policy, Client, Response, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{net::IpAddr, time::Duration};
use thiserror::Error;
use url::Url;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_JSON_BYTES: usize = 4 * 1024 * 1024;
const MAX_DOCUMENT_BYTES: usize = 8 * 1024 * 1024;
const PAGE_SIZE: usize = 50;
const MAX_FOLLOWUP_ROWS: usize = 300;
const MAX_DOCUMENT_ROWS: usize = 100;
const MAX_TICKET_TITLE_BYTES: usize = 2 * 1024;
const MAX_TICKET_CONTENT_BYTES: usize = 64 * 1024;
const MAX_FOLLOWUP_CONTENT_BYTES: usize = 16 * 1024;
const MAX_TOTAL_FOLLOWUP_CONTENT_BYTES: usize = 256 * 1024;
const MAX_FOLLOWUP_TEXT_BYTES: usize = 8 * 1024;
const MAX_METADATA_TEXT_BYTES: usize = 1024;
const MAX_TOKEN_BYTES: usize = 4096;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum GlpiTicketError {
    #[error("invalid GLPI API endpoint")]
    InvalidEndpoint,
    #[error("invalid GLPI ticket ID")]
    InvalidTicketId,
    #[error("invalid GLPI document ID")]
    InvalidDocumentId,
    #[error("GLPI credentials are missing or invalid")]
    InvalidCredentials,
    #[error("follow-up text is empty or exceeds the supported limit")]
    InvalidFollowup,
    #[error("the GLPI response is invalid or exceeds the supported limit")]
    InvalidResponse,
    #[error("the GLPI document is not attached to this ticket")]
    DocumentNotAttached,
    #[error("the GLPI document exceeds the supported download limit")]
    DocumentTooLarge,
    #[error("GLPI returned HTTP status {0}")]
    RemoteStatus(u16),
    #[error("the GLPI API request failed")]
    RequestFailed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GlpiTicket {
    pub id: u64,
    pub title: String,
    pub content: String,
    pub status: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GlpiPublicFollowup {
    pub id: u64,
    pub date: Option<String>,
    pub author_user_id: Option<u64>,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GlpiDocumentMetadata {
    pub id: u64,
    pub name: String,
    pub filename: String,
    pub mime_type: Option<String>,
    pub size_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GlpiTicketContext {
    pub ticket: GlpiTicket,
    pub public_followups: Vec<GlpiPublicFollowup>,
    pub documents: Vec<GlpiDocumentMetadata>,
    pub followups_truncated: bool,
    pub documents_truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GlpiDocumentFile {
    pub document_id: u64,
    pub filename: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

/// Fetch one ticket's fields, public timeline entries, and attached document metadata.
///
/// `endpoint` must be the configured GLPI API base (normally ending in
/// `/apirest.php/`); `ticket_id` is parsed as a positive decimal ID. Private
/// follow-ups are excluded before returning context.
pub async fn fetch_ticket_context(
    endpoint: &Url,
    user_token: &str,
    app_token: Option<&str>,
    ticket_id: &str,
) -> Result<GlpiTicketContext, GlpiTicketError> {
    let ticket_id = parse_ticket_id(ticket_id)?;
    let client = build_client()?;
    let endpoint = validate_endpoint(endpoint)?;
    let credentials = Credentials::new(user_token, app_token)?;
    let session = open_session(&client, &endpoint, &credentials, false).await?;

    let result =
        fetch_ticket_context_with_session(&client, &endpoint, &credentials, &session, ticket_id)
            .await;
    let cleanup = close_session(&client, &endpoint, &credentials, &session).await;
    finish_with_cleanup(result, cleanup)
}

/// Download a bounded document only after verifying it is attached to `ticket_id`.
pub async fn download_ticket_document(
    endpoint: &Url,
    user_token: &str,
    app_token: Option<&str>,
    ticket_id: &str,
    document_id: &str,
) -> Result<GlpiDocumentFile, GlpiTicketError> {
    let ticket_id = parse_ticket_id(ticket_id)?;
    let document_id = parse_document_id(document_id)?;
    let client = build_client()?;
    let endpoint = validate_endpoint(endpoint)?;
    let credentials = Credentials::new(user_token, app_token)?;
    let session = open_session(&client, &endpoint, &credentials, false).await?;

    let result = download_ticket_document_with_session(
        &client,
        &endpoint,
        &credentials,
        &session,
        ticket_id,
        document_id,
    )
    .await;
    let cleanup = close_session(&client, &endpoint, &credentials, &session).await;
    finish_with_cleanup(result, cleanup)
}

/// Post one public follow-up to a specific ticket.
///
/// The caller must present the exact message to the user and obtain confirmation
/// before calling this write operation. This function never changes ticket fields
/// and always sends `is_private: 0`.
pub async fn post_public_followup(
    endpoint: &Url,
    user_token: &str,
    app_token: Option<&str>,
    ticket_id: &str,
    content: &str,
) -> Result<u64, GlpiTicketError> {
    let ticket_id = parse_ticket_id(ticket_id)?;
    validate_followup_text(content)?;
    let client = build_client()?;
    let endpoint = validate_endpoint(endpoint)?;
    let credentials = Credentials::new(user_token, app_token)?;
    let session = open_session(&client, &endpoint, &credentials, true).await?;

    let result = post_public_followup_with_session(
        &client,
        &endpoint,
        &credentials,
        &session,
        ticket_id,
        content.trim(),
    )
    .await;
    let cleanup = close_session(&client, &endpoint, &credentials, &session).await;
    finish_with_cleanup(result, cleanup)
}

fn build_client() -> Result<Client, GlpiTicketError> {
    Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .redirect(Policy::none())
        .user_agent(concat!("Orbyt/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| GlpiTicketError::RequestFailed)
}

fn validate_endpoint(endpoint: &Url) -> Result<Url, GlpiTicketError> {
    if !matches!(endpoint.scheme(), "https" | "http")
        || endpoint.host_str().is_none()
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.query().is_some()
        || endpoint.fragment().is_some()
        || !(endpoint.path().ends_with("/apirest.php/") || endpoint.path().ends_with("/api/"))
    {
        return Err(GlpiTicketError::InvalidEndpoint);
    }
    if endpoint.scheme() == "http" && !is_loopback_host(endpoint.host_str().unwrap_or_default()) {
        return Err(GlpiTicketError::InvalidEndpoint);
    }
    Ok(endpoint.clone())
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

#[derive(Clone)]
struct Credentials {
    user_token: String,
    app_token: Option<String>,
}

impl Credentials {
    fn new(user_token: &str, app_token: Option<&str>) -> Result<Self, GlpiTicketError> {
        let user_token = checked_token(user_token).ok_or(GlpiTicketError::InvalidCredentials)?;
        let app_token = match app_token.filter(|value| !value.trim().is_empty()) {
            Some(value) => Some(checked_token(value).ok_or(GlpiTicketError::InvalidCredentials)?),
            None => None,
        };
        Ok(Self {
            user_token,
            app_token,
        })
    }

    fn apply(
        &self,
        request: reqwest::RequestBuilder,
        session: Option<&str>,
    ) -> reqwest::RequestBuilder {
        let request = match session {
            Some(session) => request.header("Session-Token", session),
            None => request.header(
                header::AUTHORIZATION,
                format!("user_token {}", self.user_token),
            ),
        };
        if let Some(app_token) = &self.app_token {
            request.header("App-Token", app_token)
        } else {
            request
        }
    }
}

fn checked_token(value: &str) -> Option<String> {
    let token = value.trim();
    (!token.is_empty() && token.len() <= MAX_TOKEN_BYTES && !token.chars().any(char::is_control))
        .then(|| token.to_owned())
}

fn parse_ticket_id(value: &str) -> Result<u64, GlpiTicketError> {
    parse_positive_id(value).ok_or(GlpiTicketError::InvalidTicketId)
}

fn parse_document_id(value: &str) -> Result<u64, GlpiTicketError> {
    parse_positive_id(value).ok_or(GlpiTicketError::InvalidDocumentId)
}

fn parse_positive_id(value: &str) -> Option<u64> {
    if value.is_empty() || value.len() > 20 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse::<u64>().ok().filter(|id| *id > 0)
}

/// Extracts one GLPI ticket link from an Issue body, restricted to the configured instance.
/// The caller must still use the numeric ID only with the configured API endpoint.
pub fn extract_ticket_id_from_issue(body: &str, endpoint: &Url) -> Option<String> {
    if body.len() > 20_000 {
        return None;
    }

    let configured_origin = endpoint.origin();
    for token in body.split_whitespace() {
        let start = ["https://", "http://"]
            .iter()
            .filter_map(|scheme| token.find(scheme))
            .min();
        let Some(start) = start else {
            continue;
        };
        let candidate = token[start..]
            .trim_start_matches(|character: char| matches!(character, '<' | '(' | '[' | '"' | '\''))
            .trim_end_matches(|character: char| {
                matches!(character, '>' | ')' | ']' | '"' | '\'' | ',' | ';' | '.')
            });
        let Ok(link) = Url::parse(candidate) else {
            continue;
        };
        if link.origin() != configured_origin || !link.path().ends_with("/front/ticket.form.php") {
            continue;
        }

        let mut ticket_ids = link
            .query_pairs()
            .filter_map(|(key, value)| (key == "id").then(|| value.into_owned()));
        let Some(ticket_id) = ticket_ids.next() else {
            continue;
        };
        if ticket_ids.next().is_some() || parse_ticket_id(&ticket_id).is_err() {
            continue;
        }
        return Some(ticket_id);
    }
    None
}

fn validate_followup_text(content: &str) -> Result<(), GlpiTicketError> {
    let trimmed = content.trim();
    if trimmed.is_empty()
        || trimmed.len() > MAX_FOLLOWUP_TEXT_BYTES
        || content
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(GlpiTicketError::InvalidFollowup);
    }
    Ok(())
}

async fn open_session(
    client: &Client,
    endpoint: &Url,
    credentials: &Credentials,
    write_access: bool,
) -> Result<String, GlpiTicketError> {
    let mut url = endpoint
        .join("initSession/")
        .map_err(|_| GlpiTicketError::InvalidEndpoint)?;
    if write_access {
        url.query_pairs_mut().append_pair("session_write", "true");
    }
    let response = credentials
        .apply(client.get(url), None)
        .send()
        .await
        .map_err(|_| GlpiTicketError::RequestFailed)?;
    let body = read_json(response).await?;
    let session = body
        .get("session_token")
        .and_then(Value::as_str)
        .filter(|value| {
            !value.trim().is_empty()
                && value.len() <= MAX_TOKEN_BYTES
                && !value.chars().any(char::is_control)
        })
        .ok_or(GlpiTicketError::InvalidResponse)?;
    Ok(session.to_owned())
}

async fn close_session(
    client: &Client,
    endpoint: &Url,
    credentials: &Credentials,
    session: &str,
) -> Result<(), GlpiTicketError> {
    let url = endpoint
        .join("killSession/")
        .map_err(|_| GlpiTicketError::InvalidEndpoint)?;
    let response = credentials
        .apply(client.get(url), Some(session))
        .send()
        .await
        .map_err(|_| GlpiTicketError::RequestFailed)?;
    ensure_success(response.status())
}

fn finish_with_cleanup<T>(
    result: Result<T, GlpiTicketError>,
    cleanup: Result<(), GlpiTicketError>,
) -> Result<T, GlpiTicketError> {
    match result {
        Err(error) => Err(error),
        Ok(value) => {
            cleanup?;
            Ok(value)
        }
    }
}

async fn fetch_ticket_context_with_session(
    client: &Client,
    endpoint: &Url,
    credentials: &Credentials,
    session: &str,
    ticket_id: u64,
) -> Result<GlpiTicketContext, GlpiTicketError> {
    let ticket_value =
        get_item(client, endpoint, credentials, session, "Ticket", ticket_id).await?;
    let ticket = parse_ticket(ticket_value, ticket_id)?;
    let (followup_rows, followups_truncated) = get_subitems(
        client,
        endpoint,
        credentials,
        session,
        "Ticket",
        ticket_id,
        "ITILFollowup",
        MAX_FOLLOWUP_ROWS,
    )
    .await?;
    let (public_followups, content_truncated) = parse_public_followups(&followup_rows)?;
    let (document_rows, documents_truncated) = get_subitems(
        client,
        endpoint,
        credentials,
        session,
        "Ticket",
        ticket_id,
        "Document_Item",
        MAX_DOCUMENT_ROWS,
    )
    .await?;
    let mut document_ids = document_rows
        .iter()
        .filter_map(|row| row.get("documents_id").and_then(parse_id_value))
        .collect::<Vec<_>>();
    document_ids.sort_unstable();
    document_ids.dedup();
    if document_ids.len() > MAX_DOCUMENT_ROWS {
        document_ids.truncate(MAX_DOCUMENT_ROWS);
    }
    let documents =
        fetch_document_metadata(client, endpoint, credentials, session, &document_ids).await?;

    Ok(GlpiTicketContext {
        ticket,
        public_followups,
        documents,
        followups_truncated: followups_truncated || content_truncated,
        documents_truncated,
    })
}

async fn get_item(
    client: &Client,
    endpoint: &Url,
    credentials: &Credentials,
    session: &str,
    item_type: &str,
    id: u64,
) -> Result<Value, GlpiTicketError> {
    let url = endpoint
        .join(&format!("{item_type}/{id}"))
        .map_err(|_| GlpiTicketError::InvalidEndpoint)?;
    let response = credentials
        .apply(client.get(url), Some(session))
        .send()
        .await
        .map_err(|_| GlpiTicketError::RequestFailed)?;
    read_json(response).await
}

async fn get_subitems(
    client: &Client,
    endpoint: &Url,
    credentials: &Credentials,
    session: &str,
    item_type: &str,
    parent_id: u64,
    sub_item_type: &str,
    maximum: usize,
) -> Result<(Vec<Value>, bool), GlpiTicketError> {
    let mut items = Vec::new();
    let pages = maximum.div_ceil(PAGE_SIZE);
    for page in 0..pages {
        let start = page * PAGE_SIZE;
        let end = (start + PAGE_SIZE - 1).min(maximum - 1);
        let mut url = endpoint
            .join(&format!("{item_type}/{parent_id}/{sub_item_type}"))
            .map_err(|_| GlpiTicketError::InvalidEndpoint)?;
        let url = url
            .query_pairs_mut()
            .append_pair("range", &format!("{start}-{end}"))
            .finish()
            .to_owned();
        let response = credentials
            .apply(client.get(url), Some(session))
            .send()
            .await
            .map_err(|_| GlpiTicketError::RequestFailed)?;
        let body = read_json(response).await?;
        let rows = body.as_array().ok_or(GlpiTicketError::InvalidResponse)?;
        if rows.len() > end - start + 1 {
            return Err(GlpiTicketError::InvalidResponse);
        }
        items.extend(rows.iter().cloned());
        if rows.len() < end - start + 1 {
            return Ok((items, false));
        }
        if items.len() >= maximum {
            return Ok((items, true));
        }
    }
    Ok((items, false))
}

async fn fetch_document_metadata(
    client: &Client,
    endpoint: &Url,
    credentials: &Credentials,
    session: &str,
    document_ids: &[u64],
) -> Result<Vec<GlpiDocumentMetadata>, GlpiTicketError> {
    let mut documents = Vec::with_capacity(document_ids.len());
    for id in document_ids {
        let value = get_item(client, endpoint, credentials, session, "Document", *id).await?;
        documents.push(parse_document_metadata(value, *id)?);
    }
    Ok(documents)
}

fn parse_ticket(value: Value, requested_id: u64) -> Result<GlpiTicket, GlpiTicketError> {
    let id = value
        .get("id")
        .and_then(parse_id_value)
        .ok_or(GlpiTicketError::InvalidResponse)?;
    if id != requested_id {
        return Err(GlpiTicketError::InvalidResponse);
    }
    Ok(GlpiTicket {
        id,
        title: bounded_value_text(value.get("name"), MAX_TICKET_TITLE_BYTES),
        content: bounded_value_text(value.get("content"), MAX_TICKET_CONTENT_BYTES),
        status: optional_bounded_value_text(value.get("status"), 128),
        updated_at: optional_bounded_value_text(value.get("date_mod"), 128),
    })
}

fn parse_public_followup(value: &Value) -> Result<GlpiPublicFollowup, GlpiTicketError> {
    Ok(GlpiPublicFollowup {
        id: value
            .get("id")
            .and_then(parse_id_value)
            .ok_or(GlpiTicketError::InvalidResponse)?,
        date: optional_bounded_value_text(value.get("date"), 128),
        author_user_id: value.get("users_id").and_then(parse_id_value),
        content: bounded_value_text(value.get("content"), MAX_FOLLOWUP_CONTENT_BYTES),
    })
}

fn parse_public_followups(
    rows: &[Value],
) -> Result<(Vec<GlpiPublicFollowup>, bool), GlpiTicketError> {
    let mut followups = Vec::new();
    let mut content_bytes = 0;
    let mut truncated = false;
    for row in rows.iter().filter(|row| !is_private_followup(row)) {
        if content_bytes >= MAX_TOTAL_FOLLOWUP_CONTENT_BYTES {
            truncated = true;
            break;
        }
        let mut followup = parse_public_followup(row)?;
        let remaining = MAX_TOTAL_FOLLOWUP_CONTENT_BYTES - content_bytes;
        if followup.content.len() > remaining {
            followup.content = bounded_text(&followup.content, remaining);
            truncated = true;
        }
        content_bytes += followup.content.len();
        followups.push(followup);
        if truncated {
            break;
        }
    }
    Ok((followups, truncated))
}

fn is_private_followup(value: &Value) -> bool {
    match value.get("is_private") {
        Some(Value::Bool(true)) => true,
        Some(Value::Number(number)) => number.as_u64().is_some_and(|value| value != 0),
        Some(Value::String(value)) => matches!(value.as_str(), "1" | "true" | "TRUE"),
        _ => false,
    }
}

fn parse_document_metadata(
    value: Value,
    requested_id: u64,
) -> Result<GlpiDocumentMetadata, GlpiTicketError> {
    let id = value
        .get("id")
        .and_then(parse_id_value)
        .ok_or(GlpiTicketError::InvalidResponse)?;
    if id != requested_id {
        return Err(GlpiTicketError::InvalidResponse);
    }
    Ok(GlpiDocumentMetadata {
        id,
        name: bounded_value_text(value.get("name"), MAX_METADATA_TEXT_BYTES),
        filename: bounded_value_text(value.get("filename"), MAX_METADATA_TEXT_BYTES),
        mime_type: optional_bounded_value_text(value.get("mime"), 256),
        size_bytes: value.get("filesize").and_then(parse_id_value),
    })
}

fn parse_id_value(value: &Value) -> Option<u64> {
    match value {
        Value::Number(number) => number.as_u64().filter(|id| *id > 0),
        Value::String(string) => parse_positive_id(string),
        _ => None,
    }
}

fn bounded_value_text(value: Option<&Value>, maximum_bytes: usize) -> String {
    optional_bounded_value_text(value, maximum_bytes).unwrap_or_default()
}

fn optional_bounded_value_text(value: Option<&Value>, maximum_bytes: usize) -> Option<String> {
    let string = match value? {
        Value::String(string) => string.as_str().to_owned(),
        Value::Number(number) => number.to_string(),
        Value::Bool(boolean) => boolean.to_string(),
        _ => return None,
    };
    Some(bounded_text(&string, maximum_bytes))
}

fn bounded_text(value: &str, maximum_bytes: usize) -> String {
    let mut end = value.len().min(maximum_bytes);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

async fn download_ticket_document_with_session(
    client: &Client,
    endpoint: &Url,
    credentials: &Credentials,
    session: &str,
    ticket_id: u64,
    document_id: u64,
) -> Result<GlpiDocumentFile, GlpiTicketError> {
    let (relations, _) = get_subitems(
        client,
        endpoint,
        credentials,
        session,
        "Ticket",
        ticket_id,
        "Document_Item",
        MAX_DOCUMENT_ROWS,
    )
    .await?;
    let attached = relations
        .iter()
        .filter_map(|row| row.get("documents_id").and_then(parse_id_value))
        .any(|id| id == document_id);
    if !attached {
        return Err(GlpiTicketError::DocumentNotAttached);
    }
    let metadata = parse_document_metadata(
        get_item(
            client,
            endpoint,
            credentials,
            session,
            "Document",
            document_id,
        )
        .await?,
        document_id,
    )?;
    if metadata
        .size_bytes
        .is_some_and(|size| size > MAX_DOCUMENT_BYTES as u64)
    {
        return Err(GlpiTicketError::DocumentTooLarge);
    }
    let url = endpoint
        .join(&format!("Document/{document_id}"))
        .map_err(|_| GlpiTicketError::InvalidEndpoint)?;
    let response = credentials
        .apply(client.get(url), Some(session))
        .header(header::ACCEPT, "application/octet-stream")
        .send()
        .await
        .map_err(|_| GlpiTicketError::RequestFailed)?;
    let mime_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| bounded_text(value, 256))
        .filter(|value| !value.is_empty())
        .or(metadata.mime_type)
        .unwrap_or_else(|| "application/octet-stream".to_owned());
    let bytes = read_binary(response).await?;
    Ok(GlpiDocumentFile {
        document_id,
        filename: metadata.filename,
        mime_type,
        bytes,
    })
}

async fn post_public_followup_with_session(
    client: &Client,
    endpoint: &Url,
    credentials: &Credentials,
    session: &str,
    ticket_id: u64,
    content: &str,
) -> Result<u64, GlpiTicketError> {
    let url = endpoint
        .join("ITILFollowup/")
        .map_err(|_| GlpiTicketError::InvalidEndpoint)?;
    let response = credentials
        .apply(client.post(url), Some(session))
        .json(&json!({
            "input": {
                "itemtype": "Ticket",
                "items_id": ticket_id,
                "content": content,
                "is_private": 0
            }
        }))
        .send()
        .await
        .map_err(|_| GlpiTicketError::RequestFailed)?;
    let body = read_json(response).await?;
    let id = body
        .get("id")
        .and_then(parse_id_value)
        .or_else(|| body.as_array()?.first()?.get("id").and_then(parse_id_value))
        .ok_or(GlpiTicketError::InvalidResponse)?;
    Ok(id)
}

async fn read_json(response: Response) -> Result<Value, GlpiTicketError> {
    ensure_success(response.status())?;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_JSON_BYTES as u64)
    {
        return Err(GlpiTicketError::InvalidResponse);
    }
    let bytes = read_bounded_body(response, MAX_JSON_BYTES).await?;
    serde_json::from_slice(&bytes).map_err(|_| GlpiTicketError::InvalidResponse)
}

async fn read_binary(response: Response) -> Result<Vec<u8>, GlpiTicketError> {
    ensure_success(response.status())?;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_DOCUMENT_BYTES as u64)
    {
        return Err(GlpiTicketError::DocumentTooLarge);
    }
    read_bounded_body(response, MAX_DOCUMENT_BYTES)
        .await
        .map_err(|error| match error {
            GlpiTicketError::InvalidResponse => GlpiTicketError::DocumentTooLarge,
            other => other,
        })
}

async fn read_bounded_body(
    mut response: Response,
    maximum: usize,
) -> Result<Vec<u8>, GlpiTicketError> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| GlpiTicketError::RequestFailed)?
    {
        if bytes.len().saturating_add(chunk.len()) > maximum {
            return Err(GlpiTicketError::InvalidResponse);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn ensure_success(status: StatusCode) -> Result<(), GlpiTicketError> {
    if status.is_success() {
        Ok(())
    } else {
        Err(GlpiTicketError::RemoteStatus(status.as_u16()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::HashMap,
        io::{BufRead, BufReader, Read, Write},
        net::TcpListener,
        thread::{self, JoinHandle},
        time::Instant,
    };

    struct MockRequest {
        method: String,
        target: String,
        headers: HashMap<String, String>,
        body: Vec<u8>,
    }

    struct MockResponse {
        status: u16,
        content_type: String,
        body: Vec<u8>,
        location: Option<String>,
    }

    fn json_response(status: u16, value: Value) -> MockResponse {
        MockResponse {
            status,
            content_type: "application/json".to_owned(),
            body: value.to_string().into_bytes(),
            location: None,
        }
    }

    fn start_mock_server(responses: Vec<MockResponse>) -> (Url, JoinHandle<Vec<MockRequest>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("mock listener binds");
        listener
            .set_nonblocking(true)
            .expect("mock listener is nonblocking");
        let address = listener.local_addr().expect("mock address is readable");
        let server = thread::spawn(move || {
            let mut requests = Vec::with_capacity(responses.len());
            for response in responses {
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
                let mut parts = request_line.split_whitespace();
                let method = parts.next().expect("request method is present").to_owned();
                let target = parts.next().expect("request target is present").to_owned();
                let mut headers = HashMap::new();
                loop {
                    let mut line = String::new();
                    reader
                        .read_line(&mut line)
                        .expect("request headers are readable");
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                    if let Some((name, value)) = line.split_once(':') {
                        headers.insert(name.to_ascii_lowercase(), value.trim().to_owned());
                    }
                }
                let content_length = headers
                    .get("content-length")
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or(0);
                let mut body = vec![0; content_length];
                reader
                    .read_exact(&mut body)
                    .expect("request body is readable");
                requests.push(MockRequest {
                    method,
                    target,
                    headers,
                    body,
                });

                let reason = match response.status {
                    200 => "OK",
                    201 => "Created",
                    302 => "Found",
                    403 => "Forbidden",
                    _ => "Mock",
                };
                let location = response
                    .location
                    .map(|value| format!("Location: {value}\r\n"))
                    .unwrap_or_default();
                write!(
                    stream,
                    "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n{}\r\n",
                    response.status,
                    reason,
                    response.content_type,
                    response.body.len(),
                    location
                )
                .expect("mock response headers are written");
                stream
                    .write_all(&response.body)
                    .expect("mock response body is written");
                stream.flush().expect("mock response is flushed");
            }
            requests
        });
        let endpoint = Url::parse(&format!("http://{address}/glpi/apirest.php/"))
            .expect("loopback API endpoint parses");
        (endpoint, server)
    }

    fn json_mock(status: u16, value: Value) -> MockResponse {
        json_response(status, value)
    }

    fn credentials() -> (&'static str, Option<&'static str>) {
        ("mock-user-token", Some("mock-app-token"))
    }

    #[test]
    fn configured_endpoint_and_ids_are_validated() {
        assert!(validate_endpoint(
            &Url::parse("https://glpi.example.org/glpi/apirest.php/").expect("valid URL")
        )
        .is_ok());
        assert!(validate_endpoint(
            &Url::parse("http://glpi.example.org/glpi/apirest.php/").expect("valid URL")
        )
        .is_err());
        assert!(parse_ticket_id("8440").is_ok());
        assert!(parse_ticket_id("../8440").is_err());
        assert!(parse_ticket_id("0").is_err());
        assert!(parse_document_id("31").is_ok());
        assert!(parse_document_id("31?host=evil").is_err());
        assert!(validate_followup_text("Pergunta de contexto?").is_ok());
        assert!(validate_followup_text(" \n ").is_err());
        assert!(validate_followup_text(&"x".repeat(MAX_FOLLOWUP_TEXT_BYTES + 1)).is_err());
    }

    #[test]
    fn issue_link_extraction_requires_the_configured_glpi_origin_and_numeric_id() {
        let endpoint = Url::parse("https://support.example.org/glpi/apirest.php/")
            .expect("valid GLPI API URL");
        assert_eq!(
            extract_ticket_id_from_issue(
                "https://support.example.org/glpi/front/ticket.form.php?id=8440",
                &endpoint
            ),
            Some("8440".into())
        );
        assert_eq!(
            extract_ticket_id_from_issue(
                "[ticket](https://support.example.org/glpi/front/ticket.form.php?id=8440)",
                &endpoint
            ),
            Some("8440".into())
        );
        assert_eq!(
            extract_ticket_id_from_issue(
                "https://attacker.example/glpi/front/ticket.form.php?id=8440",
                &endpoint
            ),
            None
        );
        assert_eq!(
            extract_ticket_id_from_issue(
                "https://support.example.org/glpi/front/ticket.form.php?id=../8440",
                &endpoint
            ),
            None
        );
        assert_eq!(
            extract_ticket_id_from_issue(
                "https://support.example.org/glpi/front/ticket.form.php?id=8440&id=4",
                &endpoint
            ),
            None
        );
    }

    #[tokio::test]
    async fn fetches_ticket_public_followups_documents_and_kills_session() {
        let (endpoint, server) = start_mock_server(vec![
            json_mock(200, json!({"session_token":"mock-session"})),
            json_mock(
                200,
                json!({"id":8440,"name":"Correção de Plugin","content":"Detalhes","status":2,"date_mod":"2026-10-11 10:00:00"}),
            ),
            json_mock(
                200,
                json!([
                    {"id":8,"is_private":0,"users_id":12,"date":"2026-10-10 09:00:00","content":"Público"},
                    {"id":9,"is_private":1,"users_id":13,"date":"2026-10-10 10:00:00","content":"Privado"}
                ]),
            ),
            json_mock(
                200,
                json!([{"id":40,"documents_id":31,"itemtype":"Ticket","items_id":8440}]),
            ),
            json_mock(
                200,
                json!({"id":31,"name":"Captura","filename":"captura.png","mime":"image/png","filesize":128}),
            ),
            json_mock(200, json!({"message":"Session terminated"})),
        ]);

        let (user_token, app_token) = credentials();
        let context = fetch_ticket_context(&endpoint, user_token, app_token, "8440")
            .await
            .expect("mock ticket context loads");
        let requests = server.join().expect("mock server finishes");

        assert_eq!(context.ticket.id, 8440);
        assert_eq!(context.ticket.title, "Correção de Plugin");
        assert_eq!(context.public_followups.len(), 1);
        assert_eq!(context.public_followups[0].content, "Público");
        assert_eq!(context.documents[0].filename, "captura.png");
        assert!(!context.followups_truncated);
        assert!(!context.documents_truncated);
        assert_eq!(requests.len(), 6);
        assert_eq!(requests[0].method, "GET");
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
            requests[2].target,
            "/glpi/apirest.php/Ticket/8440/ITILFollowup?range=0-49"
        );
        assert_eq!(
            requests[3].target,
            "/glpi/apirest.php/Ticket/8440/Document_Item?range=0-49"
        );
        assert_eq!(requests[5].target, "/glpi/apirest.php/killSession/");
    }

    #[tokio::test]
    async fn posts_only_a_public_followup_to_the_validated_ticket() {
        let (endpoint, server) = start_mock_server(vec![
            json_mock(200, json!({"session_token":"mock-session"})),
            json_mock(201, json!({"id":92})),
            json_mock(200, json!({"message":"Session terminated"})),
        ]);
        let (user_token, app_token) = credentials();
        let followup_id = post_public_followup(
            &endpoint,
            user_token,
            app_token,
            "8440",
            "Poderia informar qual ambiente apresenta o problema?",
        )
        .await
        .expect("mock follow-up posts");
        let requests = server.join().expect("mock server finishes");
        let submitted: Value = serde_json::from_slice(&requests[1].body).expect("JSON body parses");

        assert_eq!(followup_id, 92);
        assert_eq!(
            requests[0].target,
            "/glpi/apirest.php/initSession/?session_write=true"
        );
        assert_eq!(requests[1].method, "POST");
        assert_eq!(requests[1].target, "/glpi/apirest.php/ITILFollowup/");
        assert_eq!(submitted["input"]["itemtype"], "Ticket");
        assert_eq!(submitted["input"]["items_id"], 8440);
        assert_eq!(submitted["input"]["is_private"], 0);
        assert_eq!(
            submitted["input"]["content"],
            "Poderia informar qual ambiente apresenta o problema?"
        );
    }

    #[tokio::test]
    async fn authenticated_requests_do_not_follow_redirects() {
        let mut redirect = json_mock(302, json!({}));
        redirect.location = Some("http://127.0.0.1:9/redirect-target".to_owned());
        let (endpoint, server) = start_mock_server(vec![redirect]);
        let (user_token, app_token) = credentials();
        let result = fetch_ticket_context(&endpoint, user_token, app_token, "8440").await;
        let requests = server.join().expect("mock server finishes");

        assert_eq!(result, Err(GlpiTicketError::RemoteStatus(302)));
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].target, "/glpi/apirest.php/initSession/");
    }

    #[tokio::test]
    async fn downloads_only_a_bounded_document_attached_to_ticket() {
        let mut binary = MockResponse {
            status: 200,
            content_type: "image/png".to_owned(),
            body: vec![1, 2, 3, 4],
            location: None,
        };
        let (endpoint, server) = start_mock_server(vec![
            json_mock(200, json!({"session_token":"mock-session"})),
            json_mock(200, json!([{"documents_id":31}])),
            json_mock(
                200,
                json!({"id":31,"name":"Screenshot","filename":"screen.png","mime":"image/png","filesize":4}),
            ),
            {
                binary.body.shrink_to_fit();
                binary
            },
            json_mock(200, json!({"message":"Session terminated"})),
        ]);
        let (user_token, app_token) = credentials();
        let file = download_ticket_document(&endpoint, user_token, app_token, "8440", "31")
            .await
            .expect("attached file downloads");
        let requests = server.join().expect("mock server finishes");

        assert_eq!(file.filename, "screen.png");
        assert_eq!(file.mime_type, "image/png");
        assert_eq!(file.bytes, vec![1, 2, 3, 4]);
        assert_eq!(
            requests[3].headers.get("accept").map(String::as_str),
            Some("application/octet-stream")
        );
        assert_eq!(requests[3].target, "/glpi/apirest.php/Document/31");
    }
}
