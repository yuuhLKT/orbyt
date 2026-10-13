# ADR 0007: GLPI-only intake and reviewed execution workflow

- Status: accepted
- Date: 2026-10-13

## Context

The prior GitHub Project workflow does not match the intended daily process for this workspace. GLPI is the external source of work. OpenCode project instructions, skills, and commands should remain authoritative, and implementation needs repository-wide context while still being coordinated against a writable scope.

## Decision

- Retire GitHub Project/Issue intake and automatic execution. Preserve legacy configuration, credentials, task records, execution records, and schema for history; do not perform GitHub source sync or auto-start from it.
- Poll configured GLPI 10 sources only while Orbyt is open, importing unresolved tickets. Keep intake bounded and disclose when results exceed the current limit.
- Persist a separate `glpi_auto_triage` preference, default off. When explicitly enabled, only newly imported GLPI task IDs are sent to stateless OpenCode triage. Ticket text, public follow-ups, and bounded attachment metadata may be sent; attachment bytes are excluded. Manual triage remains user initiated.
- Always require explicit user approval before ACP execution, regardless of source or triage result. Never post a GLPI follow-up without showing and receiving confirmation for the exact public text. Do not modify GLPI status or assignment.
- Start each ACP session at the canonical registered project root to preserve project context. Keep Orbyt's selected writable scope for scheduling and conflict coordination; it is not an OS sandbox and does not replace OpenCode's effective permissions.
- Let the Flow screen report bounded summaries of project-level instructions, skills, commands, agents, and OpenCode config files. Report these as files Orbyt found/read, not as proof OpenCode loaded them into an ACP session. Do not invent dedicated triage or executor agents.

## Consequences

- Imported GLPI work follows a visible lifecycle: intake → stateless triage → context request or explicit approval → ACP execution → human review.
- Automatic triage is a deliberate data-sharing opt-in, independent from approval to run implementation.
- Existing GitHub Projects data remains in the local database but is not presented as an active integration.
- The current unresolved-ticket query is capped at 100 results and may not provide fair paging; the UI warns when GLPI reports additional results.
- The Flow resource inventory is bounded and read-only. It does not parse full prompts into the UI or assert runtime agent/resource loading.
