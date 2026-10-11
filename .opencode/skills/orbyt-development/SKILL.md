---
name: orbyt-development
description: Implement or review Orbyt features while preserving the repository's architecture, phase boundary, and verification practices.
---

# Orbyt development

Use this skill for cross-cutting Orbyt implementation work. Start with the root `AGENTS.md`, then inspect `docs/architecture.md`, relevant decision records, and the existing implementation before choosing a design. Keep changes incremental and within the request.

Orbyt is a local-first Tauri desktop app. Verify the current app behavior in code before describing it. Keep Rust domain rules, application services, infrastructure, typed Tauri adapters, and React presentation in their current boundaries. The requested workflow may read GitHub Issues/Projects and GLPI 10 tickets; it may publish a public GLPI follow-up only after the user reviews and confirms the exact context question. Never change external ticket status/assignment or write back GitHub Project fields.

Check `package.json` and `src-tauri/Cargo.toml` for installed versions and available commands. For relevant unfamiliar or version-sensitive APIs, resolve and query Context7 when that MCP is available; otherwise prefer official documentation and installed package sources. Do not invent commands. Use Bun for JavaScript and Cargo for Rust.

For source integrations, keep credentials in the OS credential store, never in SQLite or logs. Use validated endpoints, no redirects on authenticated requests, bounded time/response/text, and preserve local task fields during sync. GitHub App Device Flow access/refresh tokens are secrets; never bundle an App private key. Parse only a numeric GLPI ticket ID from a linked Issue and call the configured GLPI host, never a host supplied in task content. Treat generated follow-up text as untrusted and require user review before posting it publicly.

Make the smallest useful change, add focused tests when behavior changes, and run relevant checks that exist in the repository. Report what changed, the checks actually run, and any material limitations. Update maintained docs only when behavior or an architectural decision changes.
