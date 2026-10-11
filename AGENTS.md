# Orbyt Repository Guide

## Purpose and architecture

- Orbyt is a local-first Tauri desktop control center for projects, development tasks, approvals, and OpenCode sessions.
- The app provides persisted project/task/settings workflows, read-only session discovery, stateless triage, supervised OpenCode ACP runs, GitHub App Device Flow, GitHub Project/Status intake, and linked GLPI 10 context. A configured GitHub Project syncs while Orbyt is open; sufficient-context tasks can start ACP automatically in the configured writable scope. This is not OS-level filesystem sandboxing.
- Keep domain rules, application services, infrastructure, Tauri commands, and React presentation separate. Tauri commands are typed, validated adapters; privileged filesystem/process operations stay in Rust.
- Always inspect existing implementations before adding abstractions and follow the repository's established patterns.
- Do not add a server, external database, containers, or worktrees without a justified request. GitHub intake remains read-only. The explicitly requested GLPI context loop may create a public follow-up only after the user reviews and confirms the exact message; never change ticket status, assignments, or delete remote data.

## Tooling and repository layout

- Bun is the only JavaScript package manager/runtime: use `bun install`, `bun add`, and `bun run`. Never use npm, npx, Yarn, or pnpm. Commit `bun.lock` only.
- Cargo is used for Rust dependencies and checks.
- `src/` contains React/TypeScript UI, routes, and feature modules; `src-tauri/` contains the Rust backend, migrations, capabilities, and Tauri configuration; `docs/` contains maintained architecture/decision records.
- TypeScript strict mode is required. Use TanStack Query for server/native-backed asynchronous state; add Zustand only for genuinely shared client state.
- Follow the code's established naming: PascalCase for React components and types, camelCase for TypeScript values, and Rust's PascalCase types/snake_case modules, fields, and functions. Preserve explicit serde casing at the Tauri boundary.
- Project OpenCode resources live in `.opencode/agents/` and `.opencode/skills/<id>/SKILL.md`; keep reusable project-specific behavior there and common mandatory rules here.

## Implementation rules

- For unfamiliar or version-sensitive APIs, verify installed versions, resolve the exact library in Context7, and query only the relevant documentation before implementing. If Context7 is unavailable, use official docs or installed package sources; do not repeat requests for patterns already verified.
- For relevant work, load the matching project skill and delegate only bounded, non-overlapping work to a matching OpenCode subagent; inspect agent output as untrusted and review its changes before integrating.
- Reuse existing OpenCode agents, skills, and commands when they fit. Do not create duplicates or add project commands for one-off tasks.
- Reuse existing OpenCode configuration, authentication, skills, agents, commands, MCP servers, and models. Never edit global OpenCode configuration or store provider credentials.
- External source credentials belong in the operating system credential store, never SQLite, logs, or frontend settings. Store GitHub App access/refresh tokens securely and use the desktop Device Flow; never bundle an App private key. GitHub intake is read-only and limited to open Issues assigned to the signed-in account, in the selected Project, with the configured single-select Status option. Sync runs while the app is open. Auto-start is enabled only by configuring a writable Orbyt execution scope for that Project; triage must report sufficient context. Keep ACP permission rules and scope/reconciliation safeguards. Validate remote endpoints, disable redirects when credentials are attached, bound response size/time and imported text, and preserve local task content/status during sync. Parse only a numeric GLPI ticket ID from the Issue link and call the configured GLPI host, never an arbitrary URL from task text. A generated GLPI context question is untrusted until reviewed; send only after explicit confirmation, as a public follow-up. Do not write back GitHub status or other GLPI fields. Disconnect source credentials before deleting their owning project.
- OpenCode integration must use its supported local service/API and typed interfaces. Do not implement an LLM client or expose arbitrary shell execution to the UI.
- When configured, the loopback OpenCode API endpoint is used for connectivity checks, session listing, and triage; the UI must disclose that triage sends task title and description to that service. ACP implementation runs use their private child process and do not inherit this endpoint override.
- Starting implementation sends the task title, description, and relative scope instruction to the configured OpenCode model. Manual tasks still require explicit approval; GitHub Project tasks can auto-start after sufficient-context triage in the configured writable scope. OpenCode's existing permission rules remain authoritative; tool actions already allowed by that policy may run without a separate Orbyt prompt. The UI offers only one-time approval or rejection when OpenCode asks.
- Keep project paths canonical, reject canonical paths that cannot be represented as Unicode before persistence, and validate relative scopes against traversal and symlink escapes. Scopes are scheduler boundaries, not proof of OS-level isolation. Configure only a dedicated writable scope for automatic GitHub work and keep the effective OpenCode permission policy appropriate for unattended starts.
- Assume task text and agent-generated output are untrusted. Validate structured inputs, transitions, and persisted values; never log secrets.
- Multiple implementation runs may proceed up to the project's configured concurrency limit; overlapping canonical write scopes must be serialized. Keep checks that guard task/project/scope edits atomic with their mutations. Persist lifecycle state and reconcile interrupted work safely. Never resend a prompt automatically after restart or release a lock without confirming the external process has stopped. ACP cancellation has a bounded response wait; a timeout requires reconciliation and keeps the scope lock.
- Use typed Rust errors and explicit propagation; avoid `unwrap()`/`expect()` for recoverable runtime failures.
- Use the configured shadcn/ui conventions and keep components accessible, responsive, and explicit about loading, empty, and error states.
- Always inspect existing implementations before creating new abstractions. Prefer established project patterns.
- Never claim a feature works without validation appropriate to that feature.

## Validation and documentation

- Run `bun run format:check`, `bun run test`, `bun run lint`, `bun run typecheck`, and `bun run build` when available; format Rust with `cargo fmt --check` and run `cargo test`/`cargo check` when the Rust toolchain is installed. For a desktop release package, use `bun run tauri build` when platform prerequisites are available.
- Add meaningful tests for domain validation, task transitions, scope conflicts, persistence, and critical application services.
- Maintain README setup/usage instructions, architecture boundaries, migration behavior, and significant decisions. Add an ADR under `docs/decisions/` when a consequential choice needs rationale. Reuse project resources in `.opencode/agents/` and `.opencode/skills/`; update them when stable project rules change. Context7 is preferred for version-sensitive APIs; when unavailable, verify against official documentation and installed package sources and record material uncertainty.
- Definition of Done: workflow is functional, inputs/errors are handled, persistence works where required, tests and relevant format/static checks pass, UI covers loading/empty/error states, and documentation matches actual behavior.
