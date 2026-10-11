# ADR 0006: GitHub Project intake, GLPI context, and supervised automatic runs

- Status: accepted
- Date: 2026-10-11

## Context

The team lead creates and assigns GitHub Issues manually, adds them to an organization GitHub Project, and places a GLPI 10 ticket link in the Issue body. Orbyt should work only on Issues assigned to the signed-in user and in the configured Project Status option. It must determine whether the GLPI request has enough context, ask for clarification when necessary, start implementation when ready, and notify the user for review when implementation finishes.

## Decision

- Authenticate desktop users through GitHub App OAuth Device Flow. The user supplies the App Client ID; access and refresh tokens are held in the operating system credential store. Orbyt does not contain the App private key or Client Secret.
- Configure one organization ProjectV2 per local Orbyt project. Discover its fields and single-select options dynamically. Default to a field named `Status` and an option named `Não Iniciado` when they exist, while allowing the user to choose the discovered alternatives.
- Read only open Issues that belong to that Project, are assigned to the authenticated account, and match the configured field/option. Do not create Issues, change assignments, or write GitHub Project fields.
- Sync at app startup and every five minutes while Orbyt is open. Triage at most three pending matching Issues per sync cycle so each run remains bounded; later cycles continue with the remaining pending items.
- Extract only one numeric ticket ID from a link on the configured GLPI origin and `/front/ticket.form.php` route. Read the GLPI 10 ticket, public follow-ups, and attachment metadata through the configured API URL, User Token, and optional App Token. Never call a host supplied by issue text.
- Triage the Issue and linked ticket text/history plus attachment metadata through the existing stateless OpenCode API. Do not send attachment bytes or inspect project files. If context is missing, wait in `awaiting_context`; let the user review and explicitly publish the generated text as a public GLPI follow-up. New public replies trigger triage while the linked ticket panel is open.
- Require a writable Orbyt execution scope when configuring the GitHub Project. If triage reports sufficient context and the task still uses that exact scope, queue a supervised ACP run automatically. Local/manual tasks continue to require explicit approval. Existing ACP permission handling, concurrency, overlap locks, cancellation, and reconciliation continue to apply.
- Move successful runs to `awaiting_review` and send a desktop notification, including after restart if that task has not already been notified on this device.

## Consequences and limits

Configuring the GitHub Project and writable scope is the user's opt-in to auto-start for matching Issues. An execution scope coordinates Orbyt runs but is not an OS sandbox. OpenCode's effective tool permission rules remain authoritative and may allow tool actions without an additional prompt. Keep the selected scope narrow and configure OpenCode permissions for the intended level of unattended work.

Synchronization requires Orbyt to be running; there is no daemon. Triage receives ticket text and public follow-ups, but attachments are metadata-only. ProjectV2 setup currently targets an organization and one Project per local Orbyt project. Live GitHub and GLPI credentials are needed to verify a specific organization's permission setup and data shapes.

## Verification and references

- Rust protocol tests use local HTTP mocks; no real GitHub or GLPI account is used in tests.
- [GitHub App Device Flow](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
- [GLPI 10 REST API](https://github.com/glpi-project/glpi/blob/10.0/bugfixes/apirest.md)
- [Tauri opener plugin](https://v2.tauri.app/plugin/opener/)
- [Tauri notification plugin](https://v2.tauri.app/plugin/notification/)

Context7 was unavailable in the implementation environment; current official documentation and installed package references were used.
