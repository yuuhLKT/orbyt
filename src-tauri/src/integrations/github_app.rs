//! Read-only GitHub App integration for Orbyt.
//!
//! Production requests use only GitHub's official `github.com` and
//! `api.github.com` hosts. The endpoint and credential-store seams are private
//! and exist only so this module can exercise the protocol against local mocks.

use keyring::v1::Entry;
use reqwest::{header, redirect::Policy, Client, Response};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use thiserror::Error;
use url::Url;

const GITHUB_API_BASE: &str = "https://api.github.com/";
const GITHUB_WEB_BASE: &str = "https://github.com/";
const GITHUB_API_VERSION: &str = "2026-03-10";
const GITHUB_DEVICE_URI: &str = "https://github.com/login/device";
const DEVICE_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:device_code";
const CREDENTIAL_SERVICE: &str = "dev.orbyt.github-app";
const CREDENTIAL_ACCOUNT: &str = "user-session";
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const PAGE_SIZE: usize = 100;
const MAX_PAGES: usize = 100;
const MAX_PROJECTS_OR_FIELDS: usize = PAGE_SIZE * MAX_PAGES;
const MAX_PROJECT_ITEMS: usize = PAGE_SIZE * MAX_PAGES;
const MAX_ISSUE_BODY_CHARS: usize = 100_000;
const MAX_TITLE_CHARS: usize = 500;
const TOKEN_EARLY_REFRESH_SECS: u64 = 90;

#[derive(Debug, Error)]
pub enum GitHubAppError {
    #[error("invalid GitHub App configuration or request parameters")]
    InvalidConfiguration,
    #[error("the system credential store is unavailable")]
    CredentialStore,
    #[error("no GitHub App session is connected")]
    MissingCredentials,
    #[error("GitHub authorization expired; sign in again")]
    ReauthorizationRequired,
    #[error("the GitHub request could not be completed")]
    RequestFailed,
    #[error("GitHub Device Flow setup failed (HTTP 404); check the GitHub App Client ID (not the numeric App ID) and enable Device Flow for the app")]
    DeviceFlowSetup,
    #[error("GitHub returned an invalid response")]
    InvalidResponse,
    #[error("GitHub rejected the request (HTTP {0})")]
    RemoteStatus(u16),
    #[error("GitHub GraphQL rejected the request")]
    GraphqlFailed,
    #[error("the device authorization flow is already complete")]
    FlowAlreadyCompleted,
    #[error("the GitHub result exceeded the supported pagination limit")]
    ResultLimitExceeded,
}

/// Safe account identity returned to the application. It contains no tokens.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitHubAccount {
    pub id: u64,
    pub login: String,
}

/// Safe prompt data for the UI. The device code and tokens stay in Rust.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceFlowPrompt {
    pub verification_uri: String,
    pub user_code: String,
    pub expires_in: u64,
    pub interval: u64,
}

/// Opaque in-memory state for one Device Flow. Intentionally not serializable.
pub struct DeviceFlowState {
    client_id: String,
    device_code: String,
    expires_at: Instant,
    interval_secs: u64,
    next_poll_at: Instant,
    finished: bool,
    endpoints: GitHubEndpoints,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "status", content = "data", rename_all = "camelCase")]
pub enum DeviceFlowPollResult {
    Pending { interval: u64 },
    Authorized { account: GitHubAccount },
    Expired,
    Denied,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitHubProject {
    pub id: String,
    pub number: u32,
    pub title: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitHubSingleSelectOption {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitHubProjectField {
    pub id: String,
    pub name: String,
    pub field_type: String,
    pub options: Vec<GitHubSingleSelectOption>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitHubProjectIssue {
    pub project_item_id: String,
    pub repository: String,
    pub issue_number: u32,
    pub title: String,
    pub body: Option<String>,
    pub url: String,
    pub state: String,
    pub updated_at: String,
    pub assignees: Vec<String>,
    pub status_field_id: String,
    pub status_field_name: String,
    pub status_option_id: String,
    pub status_option_name: String,
}

#[derive(Clone)]
struct GitHubEndpoints {
    api_base: Url,
    web_base: Url,
}

impl GitHubEndpoints {
    fn official() -> Result<Self, GitHubAppError> {
        Ok(Self {
            api_base: Url::parse(GITHUB_API_BASE)
                .map_err(|_| GitHubAppError::InvalidConfiguration)?,
            web_base: Url::parse(GITHUB_WEB_BASE)
                .map_err(|_| GitHubAppError::InvalidConfiguration)?,
        })
    }

    fn url(&self, base: &Url, path: &str) -> Result<Url, GitHubAppError> {
        base.join(path)
            .map_err(|_| GitHubAppError::InvalidConfiguration)
    }
}

#[derive(Serialize, Deserialize)]
struct StoredSession {
    access_token: String,
    access_expires_at: Option<u64>,
    refresh_token: Option<String>,
    refresh_expires_at: Option<u64>,
    account: GitHubAccount,
}

trait SessionStore: Send + Sync {
    fn load(&self) -> Result<Option<StoredSession>, GitHubAppError>;
    fn save(&self, session: &StoredSession) -> Result<(), GitHubAppError>;
    fn delete(&self) -> Result<(), GitHubAppError>;
}

struct KeyringSessionStore;

impl KeyringSessionStore {
    fn entry(&self) -> Result<Entry, GitHubAppError> {
        Entry::new(CREDENTIAL_SERVICE, CREDENTIAL_ACCOUNT)
            .map_err(|_| GitHubAppError::CredentialStore)
    }
}

impl SessionStore for KeyringSessionStore {
    fn load(&self) -> Result<Option<StoredSession>, GitHubAppError> {
        let entry = self.entry()?;
        match entry.get_password() {
            Ok(value) => {
                let session: StoredSession =
                    serde_json::from_str(&value).map_err(|_| GitHubAppError::CredentialStore)?;
                validate_session(&session)?;
                Ok(Some(session))
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(GitHubAppError::CredentialStore),
        }
    }

    fn save(&self, session: &StoredSession) -> Result<(), GitHubAppError> {
        let serialized =
            serde_json::to_string(session).map_err(|_| GitHubAppError::CredentialStore)?;
        self.entry()?
            .set_password(&serialized)
            .map_err(|_| GitHubAppError::CredentialStore)
    }

    fn delete(&self) -> Result<(), GitHubAppError> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(GitHubAppError::CredentialStore),
        }
    }
}

/// GitHub App API client. Its public constructor can only target official GitHub hosts.
pub struct GitHubApp {
    client_id: String,
    client: Client,
    endpoints: GitHubEndpoints,
    store: Arc<dyn SessionStore>,
    refresh_lock: tokio::sync::Mutex<()>,
}

impl GitHubApp {
    pub fn new(client_id: &str) -> Result<Self, GitHubAppError> {
        Self::with_parts(
            client_id,
            GitHubEndpoints::official()?,
            Arc::new(KeyringSessionStore),
        )
    }

    fn with_parts(
        client_id: &str,
        endpoints: GitHubEndpoints,
        store: Arc<dyn SessionStore>,
    ) -> Result<Self, GitHubAppError> {
        validate_client_id(client_id)?;
        let client = Client::builder()
            .timeout(Duration::from_secs(20))
            .connect_timeout(Duration::from_secs(10))
            .redirect(Policy::none())
            .user_agent(concat!("Orbyt/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| GitHubAppError::RequestFailed)?;
        Ok(Self {
            client_id: client_id.to_owned(),
            client,
            endpoints,
            store,
            refresh_lock: tokio::sync::Mutex::new(()),
        })
    }

    /// Starts GitHub's OAuth 2.0 Device Authorization Grant.
    pub async fn begin_device_flow(
        &self,
    ) -> Result<(DeviceFlowState, DeviceFlowPrompt), GitHubAppError> {
        self.begin_device_flow_at(&self.endpoints).await
    }

    async fn begin_device_flow_at(
        &self,
        endpoints: &GitHubEndpoints,
    ) -> Result<(DeviceFlowState, DeviceFlowPrompt), GitHubAppError> {
        let url = endpoints.url(&endpoints.web_base, "login/device/code")?;
        let response = self
            .client
            .post(url)
            .query(&[
                ("client_id", self.client_id.as_str()),
                ("scope", "offline_access"),
            ])
            .header(header::ACCEPT, "application/json")
            .send()
            .await
            .map_err(|_| GitHubAppError::RequestFailed)?;
        let body = read_device_flow_json(response).await?;

        let device_code = required_string(&body, "device_code", 256)?;
        let user_code = required_string(&body, "user_code", 32)?;
        validate_user_code(&user_code)?;
        let expires_in = required_bounded_u64(&body, "expires_in", 1, 86_400)?;
        let interval = required_bounded_u64(&body, "interval", 1, 3_600)?;
        let verification_uri = body
            .get("verification_uri")
            .and_then(Value::as_str)
            .ok_or(GitHubAppError::InvalidResponse)?;
        if verification_uri != GITHUB_DEVICE_URI {
            return Err(GitHubAppError::InvalidResponse);
        }

        let prompt = DeviceFlowPrompt {
            verification_uri: GITHUB_DEVICE_URI.to_owned(),
            user_code,
            expires_in,
            interval,
        };
        let state = DeviceFlowState {
            client_id: self.client_id.clone(),
            device_code,
            expires_at: Instant::now() + Duration::from_secs(expires_in),
            interval_secs: interval,
            next_poll_at: Instant::now() + Duration::from_secs(interval),
            finished: false,
            endpoints: endpoints.clone(),
        };
        Ok((state, prompt))
    }

    /// Polls no faster than GitHub's interval. The device/access tokens never leave Rust.
    pub async fn poll_device_flow(
        &self,
        state: &mut DeviceFlowState,
    ) -> Result<DeviceFlowPollResult, GitHubAppError> {
        if state.client_id != self.client_id {
            return Err(GitHubAppError::InvalidConfiguration);
        }
        if state.finished {
            return Err(GitHubAppError::FlowAlreadyCompleted);
        }
        if Instant::now() >= state.expires_at {
            state.finished = true;
            return Ok(DeviceFlowPollResult::Expired);
        }
        let now = Instant::now();
        if now < state.next_poll_at {
            let remaining = state.next_poll_at.duration_since(now).as_secs().max(1);
            return Ok(DeviceFlowPollResult::Pending {
                interval: remaining,
            });
        }

        let url = state
            .endpoints
            .url(&state.endpoints.web_base, "login/oauth/access_token")?;
        let response = self
            .client
            .post(url)
            .query(&[
                ("client_id", state.client_id.as_str()),
                ("device_code", state.device_code.as_str()),
                ("grant_type", DEVICE_GRANT_TYPE),
            ])
            .header(header::ACCEPT, "application/json")
            .send()
            .await
            .map_err(|_| GitHubAppError::RequestFailed)?;
        let body = read_device_flow_json(response).await?;

        match body.get("error").and_then(Value::as_str) {
            Some("authorization_pending") => {
                state.next_poll_at = Instant::now() + Duration::from_secs(state.interval_secs);
                Ok(DeviceFlowPollResult::Pending {
                    interval: state.interval_secs,
                })
            }
            Some("slow_down") => {
                let minimum = state.interval_secs.saturating_add(5).min(3_600);
                state.interval_secs = body
                    .get("interval")
                    .and_then(Value::as_u64)
                    .filter(|interval| (*interval >= minimum) && (*interval <= 3_600))
                    .unwrap_or(minimum);
                state.next_poll_at = Instant::now() + Duration::from_secs(state.interval_secs);
                Ok(DeviceFlowPollResult::Pending {
                    interval: state.interval_secs,
                })
            }
            Some("expired_token" | "token_expired") => {
                state.finished = true;
                Ok(DeviceFlowPollResult::Expired)
            }
            Some("access_denied") => {
                state.finished = true;
                Ok(DeviceFlowPollResult::Denied)
            }
            Some("device_flow_disabled" | "incorrect_client_credentials") => {
                Err(GitHubAppError::InvalidConfiguration)
            }
            Some(_) => Err(GitHubAppError::InvalidResponse),
            None => {
                let session_tokens = parse_token_response(&body)?;
                let account = self
                    .fetch_account_with_token_at(&state.endpoints, &session_tokens.access_token)
                    .await?;
                let session = StoredSession {
                    access_token: session_tokens.access_token,
                    access_expires_at: session_tokens.access_expires_at,
                    refresh_token: session_tokens.refresh_token,
                    refresh_expires_at: session_tokens.refresh_expires_at,
                    account: account.clone(),
                };
                self.store.save(&session)?;
                state.finished = true;
                Ok(DeviceFlowPollResult::Authorized { account })
            }
        }
    }

    /// Returns the last verified account identity without exposing credentials.
    pub fn account_status(&self) -> Result<Option<GitHubAccount>, GitHubAppError> {
        Ok(self.store.load()?.map(|session| session.account))
    }

    /// Removes the GitHub App session from the OS credential store.
    pub fn logout(&self) -> Result<(), GitHubAppError> {
        self.store.delete()
    }

    pub async fn list_organization_projects(
        &self,
        organization: &str,
    ) -> Result<Vec<GitHubProject>, GitHubAppError> {
        validate_segment(organization)?;
        let (token, _) = self.current_access().await?;
        let query = r#"
          query OrbytOrganizationProjects($organization: String!, $after: String) {
            organization(login: $organization) {
              projectsV2(first: 100, after: $after) {
                nodes { id number title url }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        "#;
        let mut after: Option<String> = None;
        let mut projects = Vec::new();
        let mut pages = 0usize;
        loop {
            pages += 1;
            if pages > MAX_PAGES {
                return Err(GitHubAppError::ResultLimitExceeded);
            }
            let response = self
                .graphql(
                    &self.endpoints,
                    &token,
                    query,
                    json!({"organization": organization, "after": after}),
                )
                .await?;
            let connection = response
                .pointer("/data/organization/projectsV2")
                .ok_or(GitHubAppError::InvalidResponse)?;
            let nodes = connection
                .get("nodes")
                .and_then(Value::as_array)
                .ok_or(GitHubAppError::InvalidResponse)?;
            for node in nodes {
                projects.push(parse_project(node)?);
                if projects.len() > MAX_PROJECTS_OR_FIELDS {
                    return Err(GitHubAppError::ResultLimitExceeded);
                }
            }
            let page = parse_page_info(connection)?;
            if !page.has_next_page {
                return Ok(projects);
            }
            after = Some(page.end_cursor.ok_or(GitHubAppError::InvalidResponse)?);
        }
    }

    pub async fn project_fields(
        &self,
        organization: &str,
        project_number: u32,
    ) -> Result<Vec<GitHubProjectField>, GitHubAppError> {
        validate_segment(organization)?;
        validate_project_number(project_number)?;
        let (token, _) = self.current_access().await?;
        let query = r#"
          query OrbytProjectFields($organization: String!, $number: Int!, $after: String) {
            organization(login: $organization) {
              projectV2(number: $number) {
                fields(first: 100, after: $after) {
                  nodes {
                    __typename
                    ... on ProjectV2FieldCommon { id name }
                    ... on ProjectV2SingleSelectField { id name options { id name } }
                  }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }
          }
        "#;
        let mut after: Option<String> = None;
        let mut fields = Vec::new();
        let mut pages = 0usize;
        loop {
            pages += 1;
            if pages > MAX_PAGES {
                return Err(GitHubAppError::ResultLimitExceeded);
            }
            let response = self
                .graphql(
                    &self.endpoints,
                    &token,
                    query,
                    json!({
                        "organization": organization,
                        "number": project_number,
                        "after": after
                    }),
                )
                .await?;
            let connection = response
                .pointer("/data/organization/projectV2/fields")
                .ok_or(GitHubAppError::InvalidResponse)?;
            let nodes = connection
                .get("nodes")
                .and_then(Value::as_array)
                .ok_or(GitHubAppError::InvalidResponse)?;
            for node in nodes {
                fields.push(parse_project_field(node)?);
                if fields.len() > MAX_PROJECTS_OR_FIELDS {
                    return Err(GitHubAppError::ResultLimitExceeded);
                }
            }
            let page = parse_page_info(connection)?;
            if !page.has_next_page {
                return Ok(fields);
            }
            after = Some(page.end_cursor.ok_or(GitHubAppError::InvalidResponse)?);
        }
    }

    /// Reads ProjectV2 issues and retains the configured repository (when supplied), user, and status.
    pub async fn project_issues(
        &self,
        organization: &str,
        project_number: u32,
        repository: Option<&str>,
        status_field_id: &str,
        status_option_id: &str,
    ) -> Result<Vec<GitHubProjectIssue>, GitHubAppError> {
        validate_segment(organization)?;
        validate_project_number(project_number)?;
        let repository_filter = repository
            .map(|repository| {
                let (owner, repo) = repository
                    .split_once('/')
                    .ok_or(GitHubAppError::InvalidConfiguration)?;
                validate_segment(owner)?;
                validate_segment(repo)?;
                Ok::<_, GitHubAppError>(format!("{owner}/{repo}"))
            })
            .transpose()?;
        validate_opaque_id(status_field_id)?;
        validate_opaque_id(status_option_id)?;

        let (token, account) = self.current_access().await?;
        let query = r#"
          query OrbytProjectIssues($organization: String!, $number: Int!, $after: String) {
            organization(login: $organization) {
              projectV2(number: $number) {
                items(first: 100, after: $after) {
                  nodes {
                    id
                    content {
                      __typename
                      ... on Issue {
                        number title body url state updatedAt
                        repository { nameWithOwner }
                        assignees(first: 100) { nodes { login } }
                      }
                    }
                    fieldValues(first: 100) {
                      nodes {
                        __typename
                        ... on ProjectV2ItemFieldSingleSelectValue {
                          name optionId
                          field { ... on ProjectV2SingleSelectField { id name } }
                        }
                      }
                    }
                  }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }
          }
        "#;

        let mut after: Option<String> = None;
        let mut results = Vec::new();
        let mut items_seen = 0usize;
        let mut pages = 0usize;
        loop {
            pages += 1;
            if pages > MAX_PAGES {
                return Err(GitHubAppError::ResultLimitExceeded);
            }
            let response = self
                .graphql(
                    &self.endpoints,
                    &token,
                    query,
                    json!({
                        "organization": organization,
                        "number": project_number,
                        "after": after
                    }),
                )
                .await?;
            let connection = response
                .pointer("/data/organization/projectV2/items")
                .ok_or(GitHubAppError::InvalidResponse)?;
            let nodes = connection
                .get("nodes")
                .and_then(Value::as_array)
                .ok_or(GitHubAppError::InvalidResponse)?;
            for node in nodes {
                items_seen = items_seen.saturating_add(1);
                if items_seen > MAX_PROJECT_ITEMS {
                    return Err(GitHubAppError::ResultLimitExceeded);
                }
                if let Some(issue) = parse_project_issue(
                    node,
                    &account.login,
                    repository_filter.as_deref(),
                    status_field_id,
                    status_option_id,
                )? {
                    results.push(issue);
                }
            }
            let page = parse_page_info(connection)?;
            if !page.has_next_page {
                return Ok(results);
            }
            after = Some(page.end_cursor.ok_or(GitHubAppError::InvalidResponse)?);
        }
    }

    async fn current_access(&self) -> Result<(String, GitHubAccount), GitHubAppError> {
        let _guard = self.refresh_lock.lock().await;
        let mut session = self
            .store
            .load()?
            .ok_or(GitHubAppError::MissingCredentials)?;
        let now = unix_now();
        let needs_refresh = session
            .access_expires_at
            .is_some_and(|expiry| expiry <= now.saturating_add(TOKEN_EARLY_REFRESH_SECS));
        if needs_refresh {
            self.rotate_session(&self.endpoints, &mut session).await?;
        }
        Ok((session.access_token, session.account))
    }

    async fn rotate_session(
        &self,
        endpoints: &GitHubEndpoints,
        session: &mut StoredSession,
    ) -> Result<(), GitHubAppError> {
        let Some(refresh_token) = session.refresh_token.as_deref() else {
            self.store.delete()?;
            return Err(GitHubAppError::ReauthorizationRequired);
        };
        if session
            .refresh_expires_at
            .is_some_and(|expiry| expiry <= unix_now())
        {
            self.store.delete()?;
            return Err(GitHubAppError::ReauthorizationRequired);
        }
        let url = endpoints.url(&endpoints.web_base, "login/oauth/access_token")?;
        let response = self
            .client
            .post(url)
            .query(&[
                ("client_id", self.client_id.as_str()),
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh_token),
            ])
            .header(header::ACCEPT, "application/json")
            .send()
            .await
            .map_err(|_| GitHubAppError::RequestFailed)?;
        let body = read_json(response).await?;
        if body.get("error").and_then(Value::as_str) == Some("bad_refresh_token") {
            self.store.delete()?;
            return Err(GitHubAppError::ReauthorizationRequired);
        }
        let tokens = parse_token_response(&body)?;
        session.access_token = tokens.access_token;
        session.access_expires_at = tokens.access_expires_at;
        session.refresh_token = tokens.refresh_token;
        session.refresh_expires_at = tokens.refresh_expires_at;
        self.store.save(session)
    }

    async fn fetch_account_with_token_at(
        &self,
        endpoints: &GitHubEndpoints,
        token: &str,
    ) -> Result<GitHubAccount, GitHubAppError> {
        let url = endpoints.url(&endpoints.api_base, "user")?;
        let response = self
            .api_request(self.client.get(url), token)
            .send()
            .await
            .map_err(|_| GitHubAppError::RequestFailed)?;
        let body = read_json(response).await?;
        let id = body
            .get("id")
            .and_then(Value::as_u64)
            .filter(|id| *id > 0)
            .ok_or(GitHubAppError::InvalidResponse)?;
        let login = required_string(&body, "login", 100)?;
        validate_segment(&login)?;
        Ok(GitHubAccount { id, login })
    }

    async fn graphql(
        &self,
        endpoints: &GitHubEndpoints,
        token: &str,
        query: &str,
        variables: Value,
    ) -> Result<Value, GitHubAppError> {
        let url = endpoints.url(&endpoints.api_base, "graphql")?;
        let response = self
            .api_request(
                self.client
                    .post(url)
                    .json(&json!({"query": query, "variables": variables})),
                token,
            )
            .send()
            .await
            .map_err(|_| GitHubAppError::RequestFailed)?;
        let body = read_json(response).await?;
        if body
            .get("errors")
            .and_then(Value::as_array)
            .is_some_and(|errors| !errors.is_empty())
        {
            return Err(GitHubAppError::GraphqlFailed);
        }
        Ok(body)
    }

    fn api_request(
        &self,
        request: reqwest::RequestBuilder,
        token: &str,
    ) -> reqwest::RequestBuilder {
        request
            .bearer_auth(token)
            .header(header::ACCEPT, "application/vnd.github+json")
            .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
    }
}

struct TokenResponse {
    access_token: String,
    access_expires_at: Option<u64>,
    refresh_token: Option<String>,
    refresh_expires_at: Option<u64>,
}

fn parse_token_response(body: &Value) -> Result<TokenResponse, GitHubAppError> {
    let access_token = required_string(body, "access_token", 4096)?;
    validate_token(&access_token)?;
    let access_expires_at = optional_expiry(body, "expires_in")?;
    let refresh_token = body
        .get("refresh_token")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if let Some(value) = refresh_token.as_deref() {
        validate_token(value)?;
    }
    let refresh_expires_at = optional_expiry(body, "refresh_token_expires_in")?;
    Ok(TokenResponse {
        access_token,
        access_expires_at,
        refresh_token,
        refresh_expires_at,
    })
}

fn validate_session(session: &StoredSession) -> Result<(), GitHubAppError> {
    validate_token(&session.access_token).map_err(|_| GitHubAppError::CredentialStore)?;
    if let Some(token) = session.refresh_token.as_deref() {
        validate_token(token).map_err(|_| GitHubAppError::CredentialStore)?;
    }
    if session.account.id == 0 {
        return Err(GitHubAppError::CredentialStore);
    }
    validate_segment(&session.account.login).map_err(|_| GitHubAppError::CredentialStore)
}

fn optional_expiry(body: &Value, key: &str) -> Result<Option<u64>, GitHubAppError> {
    match body.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => {
            let seconds = value
                .as_u64()
                .filter(|seconds| (1..=31_536_000).contains(seconds))
                .ok_or(GitHubAppError::InvalidResponse)?;
            Ok(Some(unix_now().saturating_add(seconds)))
        }
    }
}

fn required_string(body: &Value, key: &str, max_bytes: usize) -> Result<String, GitHubAppError> {
    let value = body
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| {
            !value.trim().is_empty()
                && value.len() <= max_bytes
                && !value.chars().any(char::is_control)
        })
        .ok_or(GitHubAppError::InvalidResponse)?;
    Ok(value.to_owned())
}

fn required_bounded_u64(
    body: &Value,
    key: &str,
    min: u64,
    max: u64,
) -> Result<u64, GitHubAppError> {
    body.get(key)
        .and_then(Value::as_u64)
        .filter(|value| (min..=max).contains(value))
        .ok_or(GitHubAppError::InvalidResponse)
}

fn validate_client_id(client_id: &str) -> Result<(), GitHubAppError> {
    if client_id.trim().is_empty()
        || client_id.len() > 256
        || client_id
            .bytes()
            .any(|byte| !(byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')))
    {
        return Err(GitHubAppError::InvalidConfiguration);
    }
    Ok(())
}

fn validate_token(token: &str) -> Result<(), GitHubAppError> {
    if token.trim().is_empty() || token.len() > 4096 || token.chars().any(char::is_control) {
        return Err(GitHubAppError::InvalidResponse);
    }
    Ok(())
}

fn validate_user_code(user_code: &str) -> Result<(), GitHubAppError> {
    if user_code.len() != 9
        || user_code.as_bytes().get(4) != Some(&b'-')
        || !user_code
            .bytes()
            .enumerate()
            .all(|(index, byte)| index == 4 || byte.is_ascii_alphanumeric())
    {
        return Err(GitHubAppError::InvalidResponse);
    }
    Ok(())
}

fn validate_segment(value: &str) -> Result<(), GitHubAppError> {
    if value.is_empty()
        || value.len() > 100
        || value == "."
        || value == ".."
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(GitHubAppError::InvalidConfiguration);
    }
    Ok(())
}

fn validate_opaque_id(value: &str) -> Result<(), GitHubAppError> {
    if value.trim().is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        return Err(GitHubAppError::InvalidConfiguration);
    }
    Ok(())
}

fn validate_project_number(number: u32) -> Result<(), GitHubAppError> {
    if number == 0 {
        Err(GitHubAppError::InvalidConfiguration)
    } else {
        Ok(())
    }
}

async fn read_json(response: Response) -> Result<Value, GitHubAppError> {
    let status = response.status();
    if !status.is_success() {
        return Err(GitHubAppError::RemoteStatus(status.as_u16()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(GitHubAppError::InvalidResponse);
    }
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| GitHubAppError::RequestFailed)?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(GitHubAppError::InvalidResponse);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| GitHubAppError::InvalidResponse)
}

async fn read_device_flow_json(response: Response) -> Result<Value, GitHubAppError> {
    if response.status().as_u16() == 404 {
        return Err(GitHubAppError::DeviceFlowSetup);
    }
    read_json(response).await
}

struct PageInfo {
    has_next_page: bool,
    end_cursor: Option<String>,
}

fn parse_page_info(connection: &Value) -> Result<PageInfo, GitHubAppError> {
    let page_info = connection
        .get("pageInfo")
        .ok_or(GitHubAppError::InvalidResponse)?;
    let has_next_page = page_info
        .get("hasNextPage")
        .and_then(Value::as_bool)
        .ok_or(GitHubAppError::InvalidResponse)?;
    let end_cursor = page_info
        .get("endCursor")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if has_next_page
        && end_cursor
            .as_deref()
            .map_or(true, |cursor| cursor.is_empty() || cursor.len() > 2048)
    {
        return Err(GitHubAppError::InvalidResponse);
    }
    Ok(PageInfo {
        has_next_page,
        end_cursor,
    })
}

fn parse_project(value: &Value) -> Result<GitHubProject, GitHubAppError> {
    let id = required_string(value, "id", 256)?;
    let number = value
        .get("number")
        .and_then(Value::as_u64)
        .and_then(|number| u32::try_from(number).ok())
        .filter(|number| *number > 0)
        .ok_or(GitHubAppError::InvalidResponse)?;
    let title = bounded_required_text(value, "title", MAX_TITLE_CHARS)?;
    let url = required_github_url(value, "url")?;
    Ok(GitHubProject {
        id,
        number,
        title,
        url,
    })
}

fn parse_project_field(value: &Value) -> Result<GitHubProjectField, GitHubAppError> {
    let id = required_string(value, "id", 256)?;
    let name = bounded_required_text(value, "name", MAX_TITLE_CHARS)?;
    let field_type = required_string(value, "__typename", 100)?;
    let options = if field_type == "ProjectV2SingleSelectField" {
        let values = value
            .get("options")
            .and_then(Value::as_array)
            .ok_or(GitHubAppError::InvalidResponse)?;
        values
            .iter()
            .map(|option| {
                Ok(GitHubSingleSelectOption {
                    id: required_string(option, "id", 512)?,
                    name: bounded_required_text(option, "name", MAX_TITLE_CHARS)?,
                })
            })
            .collect::<Result<Vec<_>, GitHubAppError>>()?
    } else {
        Vec::new()
    };
    Ok(GitHubProjectField {
        id,
        name,
        field_type,
        options,
    })
}

fn parse_project_issue(
    item: &Value,
    authenticated_login: &str,
    repository_filter: Option<&str>,
    status_field_id: &str,
    status_option_id: &str,
) -> Result<Option<GitHubProjectIssue>, GitHubAppError> {
    let content = item
        .get("content")
        .filter(|content| content.get("__typename").and_then(Value::as_str) == Some("Issue"));
    let Some(issue) = content else {
        return Ok(None);
    };

    let repository = required_string(
        issue
            .get("repository")
            .ok_or(GitHubAppError::InvalidResponse)?,
        "nameWithOwner",
        220,
    )?;
    if repository_filter.is_some_and(|filter| !repository.eq_ignore_ascii_case(filter)) {
        return Ok(None);
    }

    let assignees = issue
        .pointer("/assignees/nodes")
        .and_then(Value::as_array)
        .ok_or(GitHubAppError::InvalidResponse)?
        .iter()
        .map(|value| required_string(value, "login", 100))
        .collect::<Result<Vec<_>, _>>()?;
    if !assignees
        .iter()
        .any(|login| login.eq_ignore_ascii_case(authenticated_login))
    {
        return Ok(None);
    }

    let field_values = item
        .pointer("/fieldValues/nodes")
        .and_then(Value::as_array)
        .ok_or(GitHubAppError::InvalidResponse)?;
    let selected_status = field_values.iter().find_map(|value| {
        if value.get("__typename").and_then(Value::as_str)
            != Some("ProjectV2ItemFieldSingleSelectValue")
        {
            return None;
        }
        let field = value.get("field")?;
        let id = field.get("id")?.as_str()?;
        let option_id = value.get("optionId")?.as_str()?;
        (id == status_field_id && option_id == status_option_id).then_some((field, value))
    });
    let Some((field, selected)) = selected_status else {
        return Ok(None);
    };

    let issue_number = issue
        .get("number")
        .and_then(Value::as_u64)
        .and_then(|number| u32::try_from(number).ok())
        .filter(|number| *number > 0)
        .ok_or(GitHubAppError::InvalidResponse)?;
    let title = bounded_required_text(issue, "title", MAX_TITLE_CHARS)?;
    let body = issue.get("body").and_then(Value::as_str).map(str::to_owned);
    if body
        .as_deref()
        .is_some_and(|body| body.chars().count() > MAX_ISSUE_BODY_CHARS)
    {
        return Err(GitHubAppError::InvalidResponse);
    }
    let url = required_github_url(issue, "url")?;
    let state = required_string(issue, "state", 32)?;
    if !matches!(state.as_str(), "OPEN" | "CLOSED") {
        return Err(GitHubAppError::InvalidResponse);
    }
    let updated_at = required_string(issue, "updatedAt", 64)?;
    let project_item_id = required_string(item, "id", 256)?;
    let status_field_id = required_string(field, "id", 256)?;
    let status_field_name = bounded_required_text(field, "name", MAX_TITLE_CHARS)?;
    let status_option_id = required_string(selected, "optionId", 512)?;
    let status_option_name = bounded_required_text(selected, "name", MAX_TITLE_CHARS)?;

    Ok(Some(GitHubProjectIssue {
        project_item_id,
        repository,
        issue_number,
        title,
        body,
        url,
        state,
        updated_at,
        assignees,
        status_field_id,
        status_field_name,
        status_option_id,
        status_option_name,
    }))
}

fn bounded_required_text(
    value: &Value,
    key: &str,
    max_chars: usize,
) -> Result<String, GitHubAppError> {
    let text = value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .ok_or(GitHubAppError::InvalidResponse)?;
    if text.chars().count() > max_chars || text.chars().any(char::is_control) {
        return Err(GitHubAppError::InvalidResponse);
    }
    Ok(text.to_owned())
}

fn required_github_url(value: &Value, key: &str) -> Result<String, GitHubAppError> {
    let raw = required_string(value, key, 2048)?;
    let parsed = Url::parse(&raw).map_err(|_| GitHubAppError::InvalidResponse)?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("github.com")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(GitHubAppError::InvalidResponse);
    }
    Ok(raw)
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::HashMap,
        io::{BufRead, BufReader, Read, Write},
        net::TcpListener,
        sync::Mutex,
        thread::{self, JoinHandle},
    };

    #[derive(Default)]
    struct MemoryStore(Mutex<Option<String>>);

    impl MemoryStore {
        fn with_session(session: &StoredSession) -> Self {
            Self(Mutex::new(Some(
                serde_json::to_string(session).expect("test session serializes"),
            )))
        }

        fn serialized(&self) -> Option<String> {
            self.0.lock().expect("test store lock").clone()
        }
    }

    impl SessionStore for MemoryStore {
        fn load(&self) -> Result<Option<StoredSession>, GitHubAppError> {
            self.0
                .lock()
                .map_err(|_| GitHubAppError::CredentialStore)?
                .as_deref()
                .map(serde_json::from_str)
                .transpose()
                .map_err(|_| GitHubAppError::CredentialStore)
        }

        fn save(&self, session: &StoredSession) -> Result<(), GitHubAppError> {
            let serialized =
                serde_json::to_string(session).map_err(|_| GitHubAppError::CredentialStore)?;
            *self.0.lock().map_err(|_| GitHubAppError::CredentialStore)? = Some(serialized);
            Ok(())
        }

        fn delete(&self) -> Result<(), GitHubAppError> {
            *self.0.lock().map_err(|_| GitHubAppError::CredentialStore)? = None;
            Ok(())
        }
    }

    #[derive(Debug)]
    struct MockRequest {
        method: String,
        target: String,
        headers: HashMap<String, String>,
        body: String,
    }

    type MockResponse = (u16, Value, Option<String>);

    fn start_mock_server(responses: Vec<MockResponse>) -> (Url, JoinHandle<Vec<MockRequest>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("mock listener binds");
        listener
            .set_nonblocking(true)
            .expect("mock listener is nonblocking");
        let address = listener.local_addr().expect("mock address is readable");
        let thread = thread::spawn(move || {
            let mut requests = Vec::with_capacity(responses.len());
            for (status, response_json, location) in responses {
                let deadline = Instant::now() + Duration::from_secs(5);
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
                    .set_read_timeout(Some(Duration::from_secs(5)))
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
                let mut pieces = request_line.split_whitespace();
                let method = pieces.next().expect("method exists").to_owned();
                let target = pieces.next().expect("target exists").to_owned();
                let mut headers = HashMap::new();
                let mut content_length = 0usize;
                loop {
                    let mut line = String::new();
                    reader
                        .read_line(&mut line)
                        .expect("request headers are readable");
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                    if let Some((name, value)) = line.split_once(':') {
                        let name = name.to_ascii_lowercase();
                        let value = value.trim().to_owned();
                        if name == "content-length" {
                            content_length = value.parse().unwrap_or_default();
                        }
                        headers.insert(name, value);
                    }
                }
                let mut body = vec![0; content_length];
                reader
                    .read_exact(&mut body)
                    .expect("request body is readable");
                let request_body = String::from_utf8(body).expect("request body is UTF-8");
                let location_header = location
                    .map(|url| format!("Location: {url}\r\n"))
                    .unwrap_or_default();
                let response_body = response_json.to_string();
                let reason = if status == 200 { "OK" } else { "Mock" };
                write!(
                    stream,
                    "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{location_header}\r\n{response_body}",
                    response_body.len()
                )
                .expect("mock response is written");
                stream.flush().expect("mock response is flushed");
                requests.push(MockRequest {
                    method,
                    target,
                    headers,
                    body: request_body,
                });
            }
            requests
        });
        let base = Url::parse(&format!("http://{address}/")).expect("mock URL parses");
        (base, thread)
    }

    fn test_app(client_id: &str, base: Url, store: Arc<dyn SessionStore>) -> GitHubApp {
        let endpoints = GitHubEndpoints {
            api_base: base.clone(),
            web_base: base,
        };
        GitHubApp::with_parts(client_id, endpoints, store).expect("test app initializes")
    }

    fn project_item(
        id: &str,
        repo: &str,
        assignee: &str,
        option_id: &str,
        title: &str,
        issue_number: u32,
    ) -> Value {
        json!({
            "id": id,
            "content": {
                "__typename": "Issue",
                "number": issue_number,
                "title": title,
                "body": "Issue body with https://support.example/ticket?id=44",
                "url": format!("https://github.com/{repo}/issues/{issue_number}"),
                "state": "OPEN",
                "updatedAt": "2026-10-11T10:00:00Z",
                "repository": {"nameWithOwner": repo},
                "assignees": {"nodes": [{"login": assignee}]}
            },
            "fieldValues": {"nodes": [{
                "__typename": "ProjectV2ItemFieldSingleSelectValue",
                "name": if option_id == "not-started" { "Não Iniciado" } else { "Em andamento" },
                "optionId": option_id,
                "field": {"id": "status-field", "name": "Status"}
            }]}
        })
    }

    #[test]
    fn flow_prompt_is_only_safe_ui_data_and_user_code_is_validated() {
        let prompt = DeviceFlowPrompt {
            verification_uri: GITHUB_DEVICE_URI.to_owned(),
            user_code: "ABCD-1234".to_owned(),
            expires_in: 900,
            interval: 5,
        };
        let json = serde_json::to_value(prompt).expect("prompt serializes");
        assert_eq!(json["verificationUri"], GITHUB_DEVICE_URI);
        assert!(json.get("deviceCode").is_none());
        assert!(validate_user_code("ABCD-1234").is_ok());
        assert!(validate_user_code("https://evil").is_err());
    }

    #[tokio::test]
    async fn device_flow_404_explains_safe_app_setup_diagnostic() {
        let (base, server) =
            start_mock_server(vec![(404, json!({"message":"secret response text"}), None)]);
        let app = test_app("Iv1.test-client", base, Arc::new(MemoryStore::default()));

        let error = app
            .begin_device_flow()
            .await
            .err()
            .expect("a missing Device Flow endpoint is rejected");
        let message = error.to_string();
        assert!(message.contains("Client ID (not the numeric App ID)"));
        assert!(message.contains("enable Device Flow"));
        assert!(!message.contains("secret response text"));
        assert!(matches!(error, GitHubAppError::DeviceFlowSetup));
        server.join().expect("mock server completes");
    }

    #[tokio::test]
    async fn device_flow_pending_then_authorized_stores_tokens_and_account_only() {
        let responses = vec![
            (
                200,
                json!({
                    "device_code": "secret-device-code",
                    "user_code": "ABCD-1234",
                    "verification_uri": GITHUB_DEVICE_URI,
                    "expires_in": 900,
                    "interval": 1
                }),
                None,
            ),
            (200, json!({"error": "authorization_pending"}), None),
            (
                200,
                json!({
                    "access_token": "ghu_test_access",
                    "expires_in": 28800,
                    "refresh_token": "ghr_test_refresh",
                    "refresh_token_expires_in": 15897600,
                    "token_type": "bearer"
                }),
                None,
            ),
            (200, json!({"id": 7, "login": "yuuhLKT"}), None),
        ];
        let (base, server) = start_mock_server(responses);
        let store = Arc::new(MemoryStore::default());
        let app = test_app("Iv1.test-client", base, store.clone());

        let (mut state, prompt) = app.begin_device_flow().await.expect("flow starts");
        assert_eq!(prompt.user_code, "ABCD-1234");
        let initial = app
            .poll_device_flow(&mut state)
            .await
            .expect("first interval is respected without a network poll");
        assert_eq!(initial, DeviceFlowPollResult::Pending { interval: 1 });
        std::thread::sleep(Duration::from_millis(1_050));
        let pending = app
            .poll_device_flow(&mut state)
            .await
            .expect("pending response");
        assert_eq!(pending, DeviceFlowPollResult::Pending { interval: 1 });
        std::thread::sleep(Duration::from_millis(1_050));
        let authorized = app
            .poll_device_flow(&mut state)
            .await
            .expect("authorized response");
        assert_eq!(
            authorized,
            DeviceFlowPollResult::Authorized {
                account: GitHubAccount {
                    id: 7,
                    login: "yuuhLKT".to_owned()
                }
            }
        );
        assert_eq!(
            app.account_status().expect("account loads").unwrap().login,
            "yuuhLKT"
        );
        let saved = store.serialized().expect("session was stored");
        assert!(saved.contains("ghu_test_access"));
        assert!(saved.contains("ghr_test_refresh"));
        assert!(!serde_json::to_string(&authorized)
            .expect("result serializes")
            .contains("ghu_test_access"));
        let requests = server.join().expect("mock server completes");
        let start_query = requests[0]
            .target
            .split_once('?')
            .map(|(_, query)| query)
            .unwrap_or_default();
        let start_query: HashMap<_, _> = url::form_urlencoded::parse(start_query.as_bytes())
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        assert_eq!(
            start_query.get("scope").map(String::as_str),
            Some("offline_access")
        );
        assert_eq!(
            requests[3].headers.get("authorization").map(String::as_str),
            Some("Bearer ghu_test_access")
        );
        assert!(!requests[2].target.contains("ghu_test_access"));
    }

    #[tokio::test]
    async fn device_flow_distinguishes_denial_and_expiration() {
        let responses = vec![
            (
                200,
                json!({
                    "device_code": "device-one",
                    "user_code": "ABCD-1234",
                    "verification_uri": GITHUB_DEVICE_URI,
                    "expires_in": 900,
                    "interval": 1
                }),
                None,
            ),
            (200, json!({"error": "access_denied"}), None),
            (
                200,
                json!({
                    "device_code": "device-two",
                    "user_code": "EFGH-5678",
                    "verification_uri": GITHUB_DEVICE_URI,
                    "expires_in": 900,
                    "interval": 1
                }),
                None,
            ),
        ];
        let (base, server) = start_mock_server(responses);
        let app = test_app("Iv1.test-client", base, Arc::new(MemoryStore::default()));
        let (mut denied_state, _) = app.begin_device_flow().await.expect("flow starts");
        denied_state.next_poll_at = Instant::now();
        assert_eq!(
            app.poll_device_flow(&mut denied_state)
                .await
                .expect("denial is a terminal result"),
            DeviceFlowPollResult::Denied
        );
        let (mut expired_state, _) = app.begin_device_flow().await.expect("second flow starts");
        expired_state.expires_at = Instant::now();
        assert_eq!(
            app.poll_device_flow(&mut expired_state)
                .await
                .expect("expiry is a terminal result"),
            DeviceFlowPollResult::Expired
        );
        assert_eq!(server.join().expect("mock server completes").len(), 3);
    }

    #[tokio::test]
    async fn current_access_rotates_token_and_logout_deletes_session() {
        let responses = vec![(
            200,
            json!({
                "access_token": "ghu_rotated",
                "expires_in": 28800,
                "refresh_token": "ghr_rotated",
                "refresh_token_expires_in": 15897600
            }),
            None,
        )];
        let (base, server) = start_mock_server(responses);
        let store = Arc::new(MemoryStore::with_session(&StoredSession {
            access_token: "ghu_old".to_owned(),
            access_expires_at: Some(unix_now() + 60),
            refresh_token: Some("ghr_old".to_owned()),
            refresh_expires_at: Some(unix_now() + 100_000),
            account: GitHubAccount {
                id: 5,
                login: "octocat".to_owned(),
            },
        }));
        let app = test_app("Iv1.test-client", base, store.clone());
        let (access_token, account) = app.current_access().await.expect("refresh succeeds");
        assert_eq!(account.login, "octocat");
        assert_eq!(access_token, "ghu_rotated");
        let stored = store
            .load()
            .expect("session reads")
            .expect("session exists");
        assert_eq!(stored.access_token, "ghu_rotated");
        assert_eq!(stored.refresh_token.as_deref(), Some("ghr_rotated"));
        app.logout().expect("logout succeeds");
        assert!(app.account_status().expect("status loads").is_none());
        let requests = server.join().expect("mock server completes");
        let query = requests[0]
            .target
            .split_once('?')
            .map(|(_, query)| query)
            .unwrap_or_default();
        let query: HashMap<_, _> = url::form_urlencoded::parse(query.as_bytes())
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        assert_eq!(
            query.get("grant_type").map(String::as_str),
            Some("refresh_token")
        );
    }

    #[tokio::test]
    async fn projects_fields_and_issue_items_are_paginated_and_filtered_exactly() {
        let project_response = json!({"data":{"organization":{"projectsV2":{
            "nodes":[{"id":"PVT_kw1","number":12,"title":"Unitá Soluções","url":"https://github.com/orgs/unita/projects/12"}],
            "pageInfo":{"hasNextPage":false,"endCursor":null}
        }}}});
        let fields_response = json!({"data":{"organization":{"projectV2":{"fields":{
            "nodes":[
                {"__typename":"ProjectV2Field","id":"priority-field","name":"Priority"},
                {"__typename":"ProjectV2SingleSelectField","id":"status-field","name":"Status","options":[
                    {"id":"not-started","name":"Não Iniciado"},
                    {"id":"in-progress","name":"Em andamento"}
                ]}
            ],"pageInfo":{"hasNextPage":false,"endCursor":null}
        }}}}});
        let item_page_one = json!({"data":{"organization":{"projectV2":{"items":{
            "nodes":[
                project_item("item-1","unita/app","yuuhLKT","not-started","Correção do plugin",283),
                project_item("item-2","unita/other","yuuhLKT","not-started","Outro repo",284),
                project_item("item-3","unita/app","someone-else","not-started","Outra pessoa",285),
                project_item("item-4","unita/app","yuuhLKT","in-progress","Em andamento",286)
            ],"pageInfo":{"hasNextPage":true,"endCursor":"cursor-1"}
        }}}}});
        let item_page_two = json!({"data":{"organization":{"projectV2":{"items":{
            "nodes":[project_item("item-5","UNITA/APP","yuuhlkt","not-started","Segundo item",287)],
            "pageInfo":{"hasNextPage":false,"endCursor":"cursor-2"}
        }}}}});
        let responses = vec![
            (200, project_response, None),
            (200, fields_response, None),
            (200, item_page_one, None),
            (200, item_page_two, None),
        ];
        let (base, server) = start_mock_server(responses);
        let store = Arc::new(MemoryStore::with_session(&StoredSession {
            access_token: "ghu_test_access".to_owned(),
            access_expires_at: Some(unix_now() + 10_000),
            refresh_token: Some("ghr_test_refresh".to_owned()),
            refresh_expires_at: Some(unix_now() + 100_000),
            account: GitHubAccount {
                id: 42,
                login: "yuuhLKT".to_owned(),
            },
        }));
        let app = test_app("Iv1.test-client", base, store);
        let projects = app
            .list_organization_projects("unita")
            .await
            .expect("projects list succeeds");
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].number, 12);
        let fields = app.project_fields("unita", 12).await.expect("fields load");
        assert_eq!(fields.len(), 2);
        assert_eq!(fields[1].options[0].name, "Não Iniciado");
        let issues = app
            .project_issues(
                "unita",
                12,
                Some("unita/app"),
                "status-field",
                "not-started",
            )
            .await
            .expect("project issues load");
        assert_eq!(issues.len(), 2);
        assert_eq!(issues[0].issue_number, 283);
        assert_eq!(issues[0].status_field_name, "Status");
        assert_eq!(issues[0].status_option_name, "Não Iniciado");
        let requests = server.join().expect("mock server completes");
        assert_eq!(requests.len(), 4);
        assert!(requests.iter().all(|request| request.method == "POST"));
        assert!(requests[3].body.contains("cursor-1"));
        assert!(requests.iter().all(|request| {
            request.headers.get("authorization").map(String::as_str)
                == Some("Bearer ghu_test_access")
        }));
    }

    #[test]
    fn validates_inputs_and_only_accepts_official_github_links() {
        assert!(validate_client_id("Iv1.valid-client").is_ok());
        assert!(validate_client_id("client id").is_err());
        assert!(validate_segment("org/repo").is_err());
        assert!(validate_opaque_id("Status\nadmin").is_err());
        assert!(required_github_url(
            &json!({"url":"https://github.com/org/repo/issues/3"}),
            "url"
        )
        .is_ok());
        assert!(required_github_url(
            &json!({"url":"https://evil.example/org/repo/issues/3"}),
            "url"
        )
        .is_err());
    }
}
