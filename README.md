# Orbyt

Orbyt is a local-first desktop control center for development projects and tasks, designed to supervise an existing OpenCode installation. Its external task intake is GLPI 10: unresolved tickets can be imported, triaged, explicitly approved for execution, and reviewed when finished. GitHub Projects intake has been retired; existing GitHub-linked records are retained for history.

## Current foundation

- Register existing local project directories without copying or modifying their contents.
- Define read/write execution scopes with native canonical-path and symlink-escape checks.
- Create, filter, and persist manual tasks associated with projects and scopes.
- Set a global concurrency default for new projects while retaining a per-project limit.
- Validate task state transitions in the native domain layer and record transition history.
- Store application data in a versioned SQLite database under the operating system's local application-data directory.
- Configure the OpenCode executable/optional local endpoint and verify connectivity through OpenCode's supported CLI API command, reusing its service discovery and authentication.
- Browse existing OpenCode sessions read-only for registered project directories.
- Run stateless task triage with task text and linked GLPI ticket text, public follow-ups, and attachment metadata. The report is persisted against the task's content revision and routes the task to more context, approval, or blocked.
- Explicitly approve tasks before ACP execution. The scheduler revalidates the task revision and canonical scope, enforces per-project concurrency, and serializes overlapping write scopes.
- Follow execution progress/output, respond to OpenCode permission requests once or reject them, request cancellation, and reconcile runs after an uncertain stop or application restart.
- Configure GLPI 10 with its API URL, User Token, and optional App Token to import unresolved tickets and load linked-ticket context. Context questions are reviewed before Orbyt posts them as public follow-ups.
- Use the Flow screen to view task stages and inspect bounded summaries of project skills, commands, agents, instructions, and configuration files.
- Persistent dark desktop UI with overview, projects/scopes, tasks, Flow, sessions, and settings.

GLPI sync runs every five minutes only while Orbyt is open and imports unresolved tickets up to a bounded result limit; the Flow screen warns when more tickets may remain. Automatic triage of newly imported tickets is an explicit opt-in, off by default. Sufficient context still waits for your approval before an ACP run; if context is missing, the task waits while you review a draft public GLPI follow-up. The app notifies you when a run reaches `awaiting_review`. Triage uses OpenCode's stateless text generation endpoint and does not inspect project files, create a session, or execute tools. Ticket text, public follow-ups, and attachment metadata are sent to the configured OpenCode model provider; attachment bytes are not sent. Implementation also sends the task and relative scope instruction. The ACP session starts at the registered project root; Orbyt's writable scope coordinates runs but is **not** OS-level isolation. OpenCode's existing permission policy remains authoritative.

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

## First launch

When the local database has no registered projects, the Overview opens a guided setup. Register an existing project folder, add an appropriate writable execution scope, and optionally verify OpenCode and connect GLPI. Setup progress is saved locally without credentials, can resume after restarting Orbyt, and can be deferred; GLPI can also be configured later under Settings.

## GLPI source

Open **Settings → External sources** and choose a local Orbyt project. Configure the GLPI 10 API base URL (usually ending in `/apirest.php`), User Token, and optional App Token. Use HTTPS for remote GLPI instances; plain HTTP is accepted only for loopback development instances. GLPI must allow API access and the user must have permission to read linked tickets, public follow-ups, and attachment metadata. Posting a context question also needs GLPI follow-up write permission; Orbyt shows the exact public message and waits for your confirmation.

Credentials are stored through the operating system credential store and are not written to Orbyt's SQLite database. Sync preserves local task title, description, and workflow state, and does not change GLPI status or assignment. Imported tasks retain their ticket link. Disconnecting GLPI stops future imports but leaves imported tasks in Orbyt; disconnect GLPI before deleting its owning project.

Ticket content is untrusted. Automatic triage is opt-in and sends task/ticket text, public follow-ups, and attachment metadata (not file bytes) to the model provider configured in OpenCode. Triage never starts implementation on its own; explicitly approve each task and review your OpenCode permission policy before starting it.

## Local data and safety

Orbyt creates its SQLite database in the platform local-data directory (Linux: normally `~/.local/share/orbyt/orbyt.sqlite3`). Migrations are under `src-tauri/migrations/` and tracked in `schema_migrations`. Removing a project from Orbyt only removes its database records; it never deletes project source files.

The optional loopback HTTP endpoint is used by OpenCode CLI API calls for connectivity checks, session listing, and triage. Triage sends the task title and description to the model provider configured on that service. Leave the endpoint blank to use OpenCode's own service discovery and authentication. Implementation starts the installed executable's `opencode acp` stdio protocol in a private child process, with the canonical project directory as its working directory. Both paths reuse the existing OpenCode installation; Orbyt does not store model/provider credentials or edit OpenCode's global configuration. A successful connection check does not prove that a model request will succeed.

## Architecture

See [docs/architecture.md](docs/architecture.md) and [docs/decisions/](docs/decisions/) for boundaries, persistence, source selection, and security choices.
