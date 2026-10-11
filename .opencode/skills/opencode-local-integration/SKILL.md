---
name: opencode-local-integration
description: Change Orbyt's OpenCode connectivity, read-only session discovery, stateless triage, or supervised and configured automatic ACP implementation sessions.
---

# OpenCode integration in Orbyt

Read `AGENTS.md`, `docs/architecture.md`, the relevant ADR, and `src-tauri/src/integrations/opencode.rs` before changing this integration. Orbyt must reuse the user's installed OpenCode service discovery, authentication, configuration, agents, skills, commands, MCP servers, and models. Never edit global OpenCode configuration, collect provider credentials, implement an LLM client, or send task prompts as part of a connectivity check.

Connectivity uses the fixed supported CLI request `api get /api/info`, with an optional explicitly configured loopback endpoint and bounded timeout. The same endpoint override is passed to CLI API calls for read-only session discovery and stateless triage; explain that task title/description go to the model provider on that service. Leave it unset to use OpenCode's default service discovery and authentication. ACP implementation runs use the private `opencode acp` subprocess and do not receive this API endpoint override. Read-only session discovery uses the `session.list` OpenAPI operation ID with an explicit canonical path for a registered project and a bounded result count. On OpenCode v2.0.26, raw `api GET /route --param ...` ignores query parameters; use operation IDs when parameters matter.

Task triage uses `experimental.generate.text` (OpenCode v2.0.26) with Issue text and linked GLPI ticket text, public follow-ups, and attachment metadata. This is an experimental, stateless operation using the service's default model; it does not accept a project location, inspect project files or attachment bytes, create a session, or run tools. Triage output is untrusted and must be validated before persistence or status changes.

Implementation runs use the installed executable's `opencode acp` child process with ACP v1 newline-delimited JSON-RPC over stdio. Local/manual tasks start only from the typed queue command after explicit approval. A GitHub Project configured with a writable Orbyt scope may auto-queue a task only after triage reports sufficient context and the task is still assigned to that exact scope. Revalidate the task revision and canonical project/scope paths when claiming the run. Persist run/session/permission lifecycle and scheduler locks. Use the project root for process/session cwd and include the authorized relative scope in the prompt. Never pass arbitrary UI shell commands, add external directories, or claim the scope is an OS sandbox. Handle `session/cancel`, one-time allow/reject permission requests, process-stop confirmation, and restart reconciliation. Effective OpenCode permission rules that already allow tools may bypass a separate ACP prompt; do not promise otherwise.

Explain that triage and implementation task content go to the provider configured by the user. Keep triage stateless and implementation session-bound; do not conflate their lifecycle or outputs.

Verify the installed OpenCode version and consult Context7 for relevant OpenCode APIs when available. If Context7 is unavailable, use official OpenCode documentation and local CLI help/source, and report material uncertainty. Add focused tests for behavior changes and run relevant Rust checks.
