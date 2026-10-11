# Orbyt

Orbyt is a local-first desktop control center for development projects and tasks, designed to supervise an existing OpenCode installation. It receives assigned work from a configured GitHub Project, reads linked GLPI 10 tickets, triages context, and can start OpenCode automatically in a configured project scope.

## Current foundation

- Register existing local project directories without copying or modifying their contents.
- Define read/write execution scopes with native canonical-path and symlink-escape checks.
- Create, filter, and persist manual tasks associated with projects and scopes.
- Set a global concurrency default for new projects while retaining a per-project limit.
- Validate task state transitions in the native domain layer and record transition history.
- Store application data in a versioned SQLite database under the operating system's local application-data directory.
- Configure the OpenCode executable/optional local endpoint and verify connectivity through OpenCode's supported CLI API command, reusing its service discovery and authentication.
- Browse existing OpenCode sessions read-only for registered project directories.
- Run stateless task triage with the Issue text and, when linked, GLPI ticket text, public follow-ups, and attachment metadata. The report is persisted against the task's content revision and routes the task to more context, implementation, or blocked.
- Manually approve local tasks or automatically enqueue sufficiently contextual GitHub Project tasks in their configured writable scope. The scheduler revalidates the task revision and canonical scope, enforces per-project concurrency, and serializes overlapping write scopes.
- Follow execution progress/output, respond to OpenCode permission requests once or reject them, request cancellation, and reconcile runs after an uncertain stop or application restart.
- Connect a GitHub App with Device Flow and select an organization Project, dynamic Status field/option, and writable Orbyt execution scope. Orbyt syncs matching assigned open Issues while it is running and does not write back to GitHub.
- Configure GLPI 10 with its API URL, User Token, and optional App Token to load linked tickets, public follow-ups, and attachment metadata. Context questions are reviewed before Orbyt posts them as public follow-ups.
- Persistent dark desktop UI with overview, projects/scopes, tasks, sessions, and settings.

GitHub sync runs every five minutes only while Orbyt is open; it triages at most three pending matching Issues in each sync cycle. Sufficient context can start a supervised ACP run automatically; if context is missing, the task waits while the user reviews a draft public GLPI follow-up. A new public GLPI reply triggers triage while the ticket panel is open. The app notifies the user when a run reaches `awaiting_review`. Triage uses OpenCode's stateless text generation endpoint and does not inspect project files, create a session, or execute tools. Issue text and linked GLPI ticket text, public follow-ups, and attachment metadata are sent to the model provider selected in the existing OpenCode configuration; attachment bytes are not sent. Implementation also sends the task and relative scope instruction. The Sessions screen reads existing session metadata read-only; task execution sessions are shown on their task cards. Execution scopes are scheduler boundaries and **not** OS security boundaries. OpenCode's existing permission policy remains authoritative and can permit tool actions without an additional prompt.

ACP tool prompts follow the effective permissions configured in OpenCode. Orbyt can show **Allow once** or **Reject** when OpenCode asks; rules that already allow a tool action can let it proceed without a separate Orbyt prompt. Approving a task authorizes its implementation run, so review the task and your OpenCode permission settings before starting it.

## Requirements

- Bun 1.4+ (JavaScript package manager/runtime; do not use npm, npx, Yarn, or pnpm)
- Rust stable toolchain and Cargo
- Tauri 2 platform prerequisites; on Arch Linux this includes GTK 3 and WebKitGTK 4.1 development libraries, a C toolchain, and the usual Linux desktop/WebKit build dependencies
- OpenCode installed for connectivity verification (optional for project/task management)

## Development

```bash
bun install
bun run tauri dev
```

Build desktop release bundles for the current platform:

```bash
bun run tauri build
```

Tauri writes generated bundles under `src-tauri/target/release/bundle/`; the available formats depend on the build platform.

Frontend-only development/build and checks:

```bash
bun run dev
bun run build
bun run typecheck
bun run lint
bun run test
bun run format:check
```

Rust validation:

```bash
cd src-tauri
cargo fmt --check
cargo test
cargo check
```

`bun.lock` is the JavaScript dependency lockfile. Cargo uses `src-tauri/Cargo.toml` and its generated `Cargo.lock` for native dependencies.

## GitHub and GLPI sources

Open **Settings → External sources** and choose a local Orbyt project. For GitHub, create a GitHub App, enable Device Flow, request read-only access to Issues and Projects, install it in the organization/repositories, and enter its Client ID. Sign in with GitHub, enter the organization login, and choose the Project. Orbyt discovers single-select fields and options; it preselects `Status` and `Não Iniciado` when present. Select the desired Status option and a writable execution scope. Only open Issues assigned to the signed-in account and present in that Project with that Status are synced. GitHub App tokens are stored in the operating system credential store; Orbyt never needs the App private key or a Client Secret.

For GLPI 10, provide the API base URL (usually ending in `/apirest.php`), User Token, and optional App Token. Use HTTPS for remote GLPI instances; plain HTTP is accepted only for loopback development instances. GLPI must allow API access and the user must have permission to read the linked ticket, its public follow-ups, and attachments. Posting a context question also needs GLPI follow-up write permission; Orbyt shows the exact public message and waits for the user to confirm it.

Credentials are stored through the operating system credential store and are not written to Orbyt's SQLite database. GitHub sync is read-only, runs every five minutes while Orbyt is open, and preserves task title, description, and workflow status. New Issues are triaged automatically, up to three per cycle. When context is sufficient, Orbyt queues an ACP run in the chosen writable scope; otherwise the task waits for context. New matching Issues may be picked up over later sync cycles. Disconnecting the Project stops future imports but leaves imported tasks in Orbyt. Disconnect GLPI before deleting its owning project.

Issue and GLPI content is untrusted. Triage sends the linked request text and public history plus attachment metadata (not file bytes) to the model provider configured in OpenCode. Auto-start delegates tool behavior to the user's existing OpenCode permission rules; review those rules and choose a narrow writable scope before enabling a Project.

## Local data and safety

Orbyt creates its SQLite database in the platform local-data directory (Linux: normally `~/.local/share/orbyt/orbyt.sqlite3`). Migrations are under `src-tauri/migrations/` and tracked in `schema_migrations`. Removing a project from Orbyt only removes its database records; it never deletes project source files.

The optional loopback HTTP endpoint is used by OpenCode CLI API calls for connectivity checks, session listing, and triage. Triage sends the task title and description to the model provider configured on that service. Leave the endpoint blank to use OpenCode's own service discovery and authentication. Implementation starts the installed executable's `opencode acp` stdio protocol in a private child process, with the canonical project directory as its working directory. Both paths reuse the existing OpenCode installation; Orbyt does not store model/provider credentials or edit OpenCode's global configuration. A successful connection check does not prove that a model request will succeed.

## Architecture

See [docs/architecture.md](docs/architecture.md), [decision 0005](docs/decisions/0005-read-only-github-glpi-task-sources.md), and [decision 0006](docs/decisions/0006-github-project-glpi-context-workflow.md) for boundaries, persistence, source selection, and security choices.
