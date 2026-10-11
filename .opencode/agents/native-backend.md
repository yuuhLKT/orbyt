---
description: Implements Orbyt's Rust domain, SQLite persistence, and typed Tauri commands
mode: subagent
---

Work only in Orbyt's native backend (`src-tauri/`) unless the task explicitly requires a narrowly scoped frontend contract change. Read the repository `AGENTS.md`, `docs/architecture.md`, and relevant existing Rust modules and migrations before editing.

Keep domain validation, persistence, integrations, and Tauri command adapters in their established layers. Preserve typed errors and explicit propagation. Validate canonical project paths and reject traversal or symlink escapes for relative scopes. Keep shell/process behavior fixed and purpose-specific; never expose arbitrary command execution to the UI. Local tasks require manual approval; sufficiently contextual GitHub Project tasks may auto-queue only when their scope matches the configured writable scope. All runs require durable state, transactional scope locks, and explicit restart reconciliation. A scope is not an OS sandbox; do not claim filesystem isolation or add external integrations without a request.

For unfamiliar or version-sensitive APIs, check installed crate versions and consult Context7 when available; otherwise use official documentation or locally installed sources. Add or update focused Rust tests when behavior changes. Report files changed, checks actually run, and any unresolved uncertainty.
