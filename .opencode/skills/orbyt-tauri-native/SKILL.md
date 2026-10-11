---
name: orbyt-tauri-native
description: Change Orbyt's Rust domain, SQLite migrations and repositories, Tauri commands, filesystem validation, or native capabilities.
---

# Orbyt native implementation

Before editing, read root `AGENTS.md`, `docs/architecture.md`, the relevant Rust modules, migration files, and Tauri capability/configuration. Follow the current boundaries in `src-tauri/src/domain.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/integrations/`, and `src-tauri/migrations/`; do not add layers without evidence they are needed.

Keep commands typed, narrow, and validated. Privileged filesystem and process work remains in Rust. Canonicalize project paths and constrain relative scopes to the project root, including symlink escape checks. Use explicit typed errors and propagate recoverable failures rather than panicking. Keep database changes versioned and preserve migration history. Never pass arbitrary UI-provided shell commands or log credentials.

Check the exact crate and Tauri versions first. Query Context7 for relevant current APIs when available; otherwise consult official Rust/Tauri/OpenCode documentation and local crate sources. Local tasks require manual approval; sufficiently contextual GitHub Project tasks may auto-queue only with the configured writable scope assigned to them. For every ACP run, preserve the task revision snapshot, canonical path revalidation, durable scope locks, per-project concurrency, explicit cancellation, and restart reconciliation. Keep scheduler scopes separate from OS security claims, and follow the configured OpenCode permission policy. Add focused Rust tests for changed domain or persistence behavior and run the applicable `cargo fmt --check`, `cargo test`, or `cargo check` commands that are available. Report any ACP behavior that was not exercised against the installed OpenCode process.
