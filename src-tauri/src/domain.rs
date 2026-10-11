use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DomainError {
    #[error("{0} cannot be empty")]
    Empty(&'static str),
    #[error("invalid task status transition: {from} -> {to}")]
    InvalidTransition { from: String, to: String },
    #[error("execution scope must be a relative path without traversal")]
    InvalidScope,
    #[error("triage result contains invalid {0}")]
    InvalidTriageResult(&'static str),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    Triaging,
    AwaitingContext,
    AwaitingApproval,
    Queued,
    Running,
    AwaitingReview,
    Completed,
    Blocked,
    Failed,
    Canceled,
    NeedsReconciliation,
}

impl TaskStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Triaging => "triaging",
            Self::AwaitingContext => "awaiting_context",
            Self::AwaitingApproval => "awaiting_approval",
            Self::Queued => "queued",
            Self::Running => "running",
            Self::AwaitingReview => "awaiting_review",
            Self::Completed => "completed",
            Self::Blocked => "blocked",
            Self::Failed => "failed",
            Self::Canceled => "canceled",
            Self::NeedsReconciliation => "needs_reconciliation",
        }
    }

    pub fn parse(value: &str) -> Result<Self, DomainError> {
        match value {
            "pending" => Ok(Self::Pending),
            "triaging" => Ok(Self::Triaging),
            "awaiting_context" => Ok(Self::AwaitingContext),
            "awaiting_approval" => Ok(Self::AwaitingApproval),
            "queued" => Ok(Self::Queued),
            "running" => Ok(Self::Running),
            "awaiting_review" => Ok(Self::AwaitingReview),
            "completed" => Ok(Self::Completed),
            "blocked" => Ok(Self::Blocked),
            "failed" => Ok(Self::Failed),
            "canceled" => Ok(Self::Canceled),
            "needs_reconciliation" => Ok(Self::NeedsReconciliation),
            _ => Err(DomainError::InvalidTransition {
                from: value.into(),
                to: "unknown".into(),
            }),
        }
    }

    pub fn can_transition_to(&self, to: &Self) -> bool {
        use TaskStatus::*;
        matches!(
            (self, to),
            (Pending, Triaging | Canceled)
                | (
                    Triaging,
                    AwaitingContext | AwaitingApproval | Blocked | Failed | Canceled
                )
                | (AwaitingContext, Triaging | Canceled)
                | (AwaitingApproval, Queued | Blocked | Canceled)
                | (Queued, Running | Failed | Canceled | NeedsReconciliation)
                | (
                    Running,
                    AwaitingReview | Failed | Blocked | Canceled | NeedsReconciliation
                )
                | (NeedsReconciliation, Failed | Canceled)
                | (AwaitingReview, Completed | Canceled)
                | (Failed, Queued | Canceled)
                | (Failed, Triaging)
                | (Blocked, Pending | Canceled)
        )
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunState {
    Queued,
    Running,
    WaitingPermission,
    CancelRequested,
    Completed,
    Failed,
    Canceled,
    NeedsReconciliation,
}

impl RunState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::WaitingPermission => "waiting_permission",
            Self::CancelRequested => "cancel_requested",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Canceled => "canceled",
            Self::NeedsReconciliation => "needs_reconciliation",
        }
    }

    pub fn parse(value: &str) -> Result<Self, DomainError> {
        match value {
            "queued" => Ok(Self::Queued),
            "running" => Ok(Self::Running),
            "waiting_permission" => Ok(Self::WaitingPermission),
            "cancel_requested" => Ok(Self::CancelRequested),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            "canceled" => Ok(Self::Canceled),
            "needs_reconciliation" => Ok(Self::NeedsReconciliation),
            _ => Err(DomainError::InvalidTransition {
                from: value.into(),
                to: "unknown run state".into(),
            }),
        }
    }

    pub fn holds_lock(self) -> bool {
        matches!(
            self,
            Self::Running
                | Self::WaitingPermission
                | Self::CancelRequested
                | Self::NeedsReconciliation
        )
    }

    pub fn can_transition_to(self, to: Self) -> bool {
        use RunState::*;
        matches!(
            (self, to),
            (Queued, Running | Failed | Canceled)
                | (
                    Running,
                    WaitingPermission
                        | CancelRequested
                        | Completed
                        | Failed
                        | Canceled
                        | NeedsReconciliation
                )
                | (
                    WaitingPermission,
                    Running | CancelRequested | Failed | Canceled | NeedsReconciliation
                )
                // A prompt can finish just before its cancellation notification is handled.
                | (CancelRequested, Completed | Canceled | Failed | NeedsReconciliation)
                | (NeedsReconciliation, Canceled | Failed)
        )
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunPermissionDecision {
    AllowOnce,
    Reject,
}

impl RunPermissionDecision {
    pub fn option_id(self) -> &'static str {
        match self {
            Self::AllowOnce => "once",
            Self::Reject => "reject",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextSufficiency {
    Sufficient,
    Partial,
    Insufficient,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskComplexity {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TriageAction {
    RequestContext,
    AwaitApproval,
    DoNotProceed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TriageResult {
    pub context_sufficiency: ContextSufficiency,
    pub complexity: TaskComplexity,
    pub requirements: Vec<String>,
    pub missing_information: Vec<String>,
    pub relevant_files: Vec<String>,
    pub proposed_execution_scope: Option<String>,
    pub implementation_plan: Vec<String>,
    pub risks: Vec<String>,
    pub dependencies: Vec<String>,
    pub recommended_action: TriageAction,
}

impl TriageResult {
    pub fn validate(&self) -> Result<(), DomainError> {
        for (field, values) in [
            ("requirements", &self.requirements),
            ("missing information", &self.missing_information),
            ("relevant files", &self.relevant_files),
            ("implementation plan", &self.implementation_plan),
            ("risks", &self.risks),
            ("dependencies", &self.dependencies),
        ] {
            if values.len() > 20
                || values
                    .iter()
                    .any(|value| value.trim().is_empty() || value.chars().count() > 500)
            {
                return Err(DomainError::InvalidTriageResult(field));
            }
        }

        if self
            .relevant_files
            .iter()
            .any(|path| validate_scope(path).is_err())
            || self
                .proposed_execution_scope
                .as_deref()
                .is_some_and(|path| validate_scope(path).is_err())
        {
            return Err(DomainError::InvalidTriageResult("paths"));
        }

        Ok(())
    }

    pub fn target_status(&self) -> TaskStatus {
        match &self.recommended_action {
            TriageAction::DoNotProceed => TaskStatus::Blocked,
            TriageAction::AwaitApproval => match &self.context_sufficiency {
                ContextSufficiency::Sufficient => TaskStatus::AwaitingApproval,
                ContextSufficiency::Partial | ContextSufficiency::Insufficient => {
                    TaskStatus::AwaitingContext
                }
            },
            TriageAction::RequestContext => TaskStatus::AwaitingContext,
        }
    }
}

pub fn validate_text(value: &str, field: &'static str) -> Result<(), DomainError> {
    if value.trim().is_empty() {
        Err(DomainError::Empty(field))
    } else {
        Ok(())
    }
}

pub fn validate_scope(value: &str) -> Result<(), DomainError> {
    let path = std::path::Path::new(value);
    if value.trim().is_empty()
        || path.is_absolute()
        || path.components().any(|part| {
            matches!(
                part,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return Err(DomainError::InvalidScope);
    }
    Ok(())
}

/// Returns whether two relative task scopes need exclusive serialization.
/// Read-only work can overlap; any ancestor/descendant overlap involving a writer cannot.
pub fn canonical_scopes_conflict(
    left: &std::path::Path,
    left_writes: bool,
    right: &std::path::Path,
    right_writes: bool,
) -> bool {
    if !left.is_absolute() || !right.is_absolute() {
        return true;
    }
    if !left_writes && !right_writes {
        return false;
    }
    left.starts_with(right) || right.starts_with(left)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_approved_tasks_can_be_queued() {
        assert!(TaskStatus::AwaitingApproval.can_transition_to(&TaskStatus::Queued));
        assert!(!TaskStatus::Pending.can_transition_to(&TaskStatus::Queued));
        assert!(!TaskStatus::Running.can_transition_to(&TaskStatus::Completed));
        assert!(TaskStatus::AwaitingReview.can_transition_to(&TaskStatus::Completed));
        assert!(TaskStatus::Failed.can_transition_to(&TaskStatus::Triaging));
    }

    #[test]
    fn run_lifecycle_has_no_generic_terminal_or_restart_path() {
        assert!(RunState::Queued.can_transition_to(RunState::Running));
        assert!(!RunState::Queued.can_transition_to(RunState::Completed));
        assert!(RunState::WaitingPermission.can_transition_to(RunState::Running));
        assert!(RunState::Running.can_transition_to(RunState::NeedsReconciliation));
        assert!(RunState::CancelRequested.can_transition_to(RunState::Completed));
        assert!(RunState::NeedsReconciliation.holds_lock());
        assert!(!RunState::NeedsReconciliation.can_transition_to(RunState::Running));
        assert_eq!(RunPermissionDecision::AllowOnce.option_id(), "once");
        assert_eq!(RunPermissionDecision::Reject.option_id(), "reject");
        assert!(serde_json::from_str::<RunPermissionDecision>("\"allow_always\"").is_err());
    }

    #[test]
    fn canonical_scope_locks_only_overlap_when_one_side_writes() {
        let root = std::path::Path::new("/repo");
        let child = std::path::Path::new("/repo/src");
        let sibling = std::path::Path::new("/repo/docs");
        assert!(canonical_scopes_conflict(root, true, child, false));
        assert!(!canonical_scopes_conflict(root, false, child, false));
        assert!(!canonical_scopes_conflict(child, true, sibling, true));
        assert!(canonical_scopes_conflict(
            std::path::Path::new("relative"),
            true,
            child,
            false
        ));
    }

    #[test]
    fn triage_routes_partial_context_to_awaiting_context() {
        let result = TriageResult {
            context_sufficiency: ContextSufficiency::Partial,
            complexity: TaskComplexity::Low,
            requirements: vec![],
            missing_information: vec![],
            relevant_files: vec![],
            proposed_execution_scope: None,
            implementation_plan: vec![],
            risks: vec![],
            dependencies: vec![],
            recommended_action: TriageAction::AwaitApproval,
        };
        assert!(matches!(
            result.target_status(),
            TaskStatus::AwaitingContext
        ));
        assert!(result.validate().is_ok());
    }

    #[test]
    fn triage_rejects_paths_that_escape_project_scope() {
        let mut result = TriageResult {
            context_sufficiency: ContextSufficiency::Sufficient,
            complexity: TaskComplexity::Medium,
            requirements: vec![],
            missing_information: vec![],
            relevant_files: vec!["../secrets.txt".into()],
            proposed_execution_scope: None,
            implementation_plan: vec![],
            risks: vec![],
            dependencies: vec![],
            recommended_action: TriageAction::AwaitApproval,
        };
        assert!(result.validate().is_err());
        result.relevant_files = vec!["src/lib.rs".into()];
        assert!(result.validate().is_ok());
    }

    #[test]
    fn rejects_scope_traversal_and_absolute_paths() {
        assert!(validate_scope("plugins/monitoring").is_ok());
        assert!(validate_scope("../src").is_err());
        assert!(validate_scope("/tmp").is_err());
        assert!(validate_scope("plugins/../../src").is_err());
    }
}
