# ADR 0001: Native SQLite persistence and OpenCode CLI connectivity

- **Status:** Accepted
- **Date:** 2026-10-09

## Context

Phase 1 requires a local-first desktop foundation with persisted projects/tasks and a reliable way to verify an existing OpenCode install without replacing its authentication or global setup. The frontend must not be granted unrestricted native access.

## Decision

Use Rust-owned SQLite (`rusqlite`) with versioned SQL migrations and typed Tauri commands. For the initial OpenCode check, call the installed OpenCode CLI's supported `api get /api/info` command, with a bounded timeout, a 64 KiB stdout cap, and optional explicit loopback server URL. Do not add an independent LLM client or SDK sidecar for a connectivity-only milestone.

## Consequences

- Database input validation and filesystem path checks stay in the privileged backend.
- The CLI preserves OpenCode service discovery/auth configuration; Orbyt does not retain provider credentials.
- Session execution was outside the original connectivity milestone. It was later added through the separate ACP lifecycle in [ADR 0004](0004-supervised-opencode-acp-execution.md), without changing the connectivity command into a prompt API.
- SQLite access is synchronous and serialized behind a mutex in this foundation; future workload should evaluate connection-per-operation/async access if measured contention warrants it.
