# ADR 0004: Supervised OpenCode ACP execution

> ADR 0006 adds automatic queueing for sufficiently contextual GitHub Project tasks after explicit Project/scope configuration. The ACP process lifecycle, permission policy, scope locks, cancellation, and reconciliation defined here still apply.

- **Status:** Accepted
- **Date:** 2026-10-10

## Context

Orbyt's persisted tasks and manual approval flow need a real implementation lifecycle. Read-only session discovery and stateless triage are separate features: neither can start work, retain execution state, or coordinate overlapping writes. The installed OpenCode version is 2.0.26 and supports ACP v1 through `opencode acp`.

## Decision

- An implementation run can be queued only from a task in `awaiting_approval`. Queueing stores an immutable task revision/content snapshot, canonical project path, approved write scope, and broad-scope confirmation.
- A Rust scheduler claims work transactionally, revalidates that snapshot and its filesystem paths, enforces the project's active-session limit, and holds a persistent lock for each canonical write scope. Overlapping write scopes conflict.
- Each run starts the configured executable as `opencode acp` without a shell, using newline-delimited ACP v1 JSON-RPC over stdin/stdout. The child process and ACP session use the canonical project root so OpenCode loads project configuration and context predictably. The prompt includes the task title, description, and approved relative scope instruction.
- Orbyt reuses the user's OpenCode installation/configuration and does not edit global configuration, save provider credentials, or provide arbitrary shell commands from the UI. Task text and the scope instruction are sent to the model provider selected in OpenCode.
- ACP permission requests are persisted and shown to the user only when OpenCode's effective policy asks. Orbyt exposes only `allow_once` and `reject`; it never converts an `allow_always` option into an approval. Existing OpenCode rules, saved decisions, or plugins may allow actions without a separate prompt, so approval of a task authorizes starting its run and is not a promise of per-tool approval.
- Cancellation is sent through `session/cancel`. If ACP does not respond within 15 seconds, Orbyt begins shutdown and waits up to 5 seconds for a graceful exit before terminating the ACP parent. Because child tool processes may remain, a timeout or forced termination retains the scope lock and requires reconciliation. Active persisted runs found after restart become `needs_reconciliation`; Orbyt never repeats their prompt automatically and releases the lock only after the user confirms that external work has stopped.
- Execution scopes coordinate Orbyt's scheduler and guide the model prompt. They are not OS-enforced filesystem or process boundaries.

## Consequences

- A completed OpenCode run moves the task to `awaiting_review`. The user must review the result and explicitly mark the current task revision completed.
- Run progress, bounded output, session identifiers, permission decisions, and recovery state are stored in the local SQLite database. Task/project/scope edits that could invalidate queued or active work are rejected until those runs finish or are reconciled.
- ACP stdout is parsed as protocol data and rendered as bounded text; stderr is not exposed to the UI. Orbyt does not open a network listener for the run.
- Rust tests cover persisted queue claims, revision/path revalidation, lock conflicts, interrupted-run recovery, and a complete ACP lifecycle using a fake child process, including permission filtering, a one-time decision, output persistence, completion state, and lock release. A real model-backed ACP session was not run; the fake process verifies protocol handling but does not validate OpenCode's installed provider or model configuration.
- Recheck the installed OpenCode version and this protocol contract before upgrading the ACP integration.

## References

- [OpenCode ACP documentation](https://opencode.ai/v2/docs/cli/acp/)
- [OpenCode v2.0.26 ACP service](https://github.com/anomalyco/opencode/blob/v2.0.26/packages/cli/src/acp/service.ts)
- [OpenCode v2.0.26 ACP permission handling](https://github.com/anomalyco/opencode/blob/v2.0.26/packages/cli/src/acp/permission.ts)
- [OpenCode v2.0.26 permission evaluation](https://github.com/anomalyco/opencode/blob/v2.0.26/packages/core/src/permission.ts)
- [Agent Client Protocol v1 tool and permission calls](https://agentclientprotocol.com/protocol/v1/tool-calls)
