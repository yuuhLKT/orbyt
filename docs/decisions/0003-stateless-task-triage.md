# ADR 0003: Stateless OpenCode task triage

> GitHub Project tasks can be auto-queued after sufficient-context triage when the Project has an explicit writable Orbyt scope. See [ADR 0006](0006-github-project-glpi-context-workflow.md). Local tasks keep the manual-approval behavior described here.

## Status

Accepted

## Context

Orbyt needs a triage report before a task enters manual approval, while preserving the boundary between triage and implementation. OpenCode v2.0.26 exposes `experimental.generate.text` as a stateless generation operation that accepts prompt text and returns generated text without creating a session or invoking tools. It does not accept a project location, so it cannot inspect project files or reliably identify relevant files.

## Decision

- The user starts triage explicitly from a task.
- Orbyt passes only the task title and description through the existing OpenCode CLI and service configuration; the CLI retains responsibility for local service discovery and authentication.
- The operation is pinned to the v2.0.26 CLI operation ID `experimental.generate.text`. The API is experimental and may change; compatibility must be checked against the installed version.
- The report is parsed as a strict JSON schema, bounds checked, and path fields are rejected if absolute or traversing outside a project-relative scope.
- Reports are stored with the task content revision, and status transitions plus report persistence commit atomically. A report is exposed only for the current task revision.
- Incomplete context routes to `awaiting_context`; a sufficient report can request manual approval or mark the task blocked. Nothing in this flow starts a session or executes work.

## Consequences

The user is told that task title and description are sent to the model provider configured in OpenCode. When the optional loopback service endpoint is configured, triage uses that service; otherwise it uses OpenCode's own service discovery. Triage does not use repository files; suggested paths are not verified. A future project-aware triage requires a separate, narrowly scoped file-reading design and cannot be inferred from this stateless endpoint. Because this OpenCode operation is experimental, a version upgrade may require updating the integration and its tests.

## References

- [OpenCode v2.0.26 generation route](https://github.com/anomalyco/opencode/blob/v2.0.26/packages/protocol/src/groups/generate.ts)
- [OpenCode v2.0.26 generation handler](https://github.com/anomalyco/opencode/blob/v2.0.26/packages/server/src/handlers/generate.ts)
- [OpenCode v2.0.26 OpenAPI specification](https://github.com/anomalyco/opencode/blob/v2.0.26/packages/protocol/openapi.json)
