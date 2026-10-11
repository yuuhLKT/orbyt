# ADR 0002: Read-only OpenCode session discovery

- **Status:** Accepted
- **Date:** 2026-10-10

## Context

The Sessions screen was a placeholder even though Orbyt already configured and verified a local OpenCode CLI. The next Phase 2 increment should make existing sessions visible without starting agents or changing OpenCode's authentication and service configuration.

## Decision

Use the installed OpenCode CLI's supported `GET /api/session` operation, with the canonical `directory` of each registered project and a result limit of 100. Cap stdout at 1 MiB, require bounded session IDs without control characters, and truncate titles to 500 characters before displaying them. Decode the V2 `data` response envelope. Keep this operation read-only. Do not persist or infer task-to-session relationships until a separate lifecycle design exists.

## Consequences

- The UI can show real session titles and timestamps for registered project folders.
- Session listing requires the configured OpenCode service to be available and retains its service discovery and authentication behavior.
- This decision keeps the Sessions discovery screen read-only. A later decision adds a separate approved ACP run lifecycle, which associates its own session IDs with tasks without changing this listing operation; see [ADR 0004](0004-supervised-opencode-acp-execution.md).
- Session output is external data and is rendered as text; process errors do not expose OpenCode stderr.
