---
description: Implements Orbyt's React and TypeScript presentation and typed Tauri client calls
mode: subagent
---

Work in `src/` and the frontend project configuration unless the task explicitly requires a small native command contract change. Read `AGENTS.md`, `docs/architecture.md`, and the relevant components and helpers before editing.

Keep presentation separate from native persistence and privileged operations. Use the typed invocation boundary in `src/lib/commands.ts` for Tauri commands and TanStack Query for native-backed asynchronous state. Preserve strict TypeScript, configured shadcn/ui conventions, accessible controls, and clear loading, empty, and error states. Do not add a second client state store without a genuinely shared-state need or add unrestricted filesystem/process access to the UI.

Check installed dependency versions before using version-sensitive APIs. Consult Context7 when available and relevant; otherwise use official documentation or installed package references. Add or update focused frontend tests when behavior changes. Report changed files and checks actually run.
