# 0005: Legacy GitHub and GLPI task sources

- Status: superseded for GitHub intake and linked GLPI context by [ADR 0006](0006-github-project-glpi-context-workflow.md); existing repository-token imports remain available only as legacy records for disconnect/retention.
- Date: 2026-10-11

## Context

Orbyt needs to bring existing development issues and support tickets into its local task workflow without making external changes or storing provider credentials in the application database. The requested GLPI version is 10.

## Decision

This decision describes the original source-import implementation. The application workflow now uses GitHub App ProjectV2 intake and linked GLPI context as defined in ADR 0006.

- Support GitHub repositories through the REST issues API and GLPI 10 through its legacy REST API (`initSession`, search options, ticket search, and `killSession`).
- Treat each connection as a read-only source associated with one Orbyt project. Sync is user-triggered; no background polling or remote write operation is provided.
- Allow the same remote source to be connected to multiple projects. Each project owns an independent imported copy, unique by project, provider, and external reference.
- Import open GitHub issues and GLPI tickets as pending Orbyt tasks. Exclude pull requests. Closed remote records may refresh the remote status and last-updated timestamp of a previously imported task, but are not imported as new tasks.
- Preserve Orbyt's local task title, description, and workflow status when refreshing remote metadata. Keep the external URL, reference, provider, and remote status/timestamp as provenance.
- Store GitHub PATs, GLPI user tokens, and optional GLPI App-Tokens in the operating system credential store. Persist only connection metadata and task provenance in SQLite.
- Require HTTPS for non-loopback GLPI endpoints; allow HTTP only for loopback. Use a fixed GitHub API host. Authenticated requests do not follow redirects, have a 20-second timeout, and cap response bodies at 4 MiB. Bound imported titles and descriptions.
- Limit each GitHub sync to 500 issue records and each GLPI sync to 100 open plus 100 closed tickets; report possible truncation. Disconnect removes the connection and its credentials but leaves imported tasks. A project with a saved source connection cannot be deleted until that source is disconnected.

## Consequences

Sync is safe to repeat and does not overwrite local task edits. Remote status is informational and does not drive Orbyt task transitions. Imported text remains untrusted; it reaches the configured OpenCode model only if the user later requests triage or starts an approved implementation run. The keyring must be available for connecting and syncing sources. Live behavior still depends on the user's GitHub permissions and GLPI API configuration.

## Verification and references

The implementation has focused Rust tests for endpoint validation, pull-request exclusion, bounded text, dynamic GLPI search fields, closed ticket behavior, and idempotent task refresh. Loopback HTTP tests exercise GitHub repository verification, bearer authentication, issue pagination, pull-request exclusion, GLPI 10 authentication headers, open/closed search criteria, session cleanup after errors, and redirect rejection. UI tests verify credentials are sent to native commands rather than persisted in settings.

- [GitHub REST API: issues](https://docs.github.com/en/rest/issues/issues)
- [GitHub OAuth app best practices](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/best-practices-for-creating-an-oauth-app)
- [GLPI REST API v1 documentation](https://help.glpi-project.org/documentation/modules/configuration/general/api/api)
- [keyring crate documentation](https://docs.rs/keyring/4.2.0/keyring/)
- [reqwest crate documentation](https://docs.rs/reqwest/latest/reqwest/)

Context7 was unavailable in the implementation environment, so current official API and crate documentation was used and the installed Rust crate version was verified through Cargo.
