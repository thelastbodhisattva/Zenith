const REASON_RUNBOOKS = {
	INPUT_UNAVAILABLE: "runbook-input-unavailable",
	STATE_INVALID: "runbook-state-invalid",
	JOURNAL_INVALID: "runbook-journal-invalid",
	OPEN_POSITIONS_INVALID: "runbook-open-positions-invalid",
	LESSONS_STATE_INVALID: "runbook-lessons-state-invalid",
	UNRESOLVED_WORKFLOW: "runbook-unresolved-workflow",
	GUARD_STATE_INVALID: "runbook-guard-state-invalid",
	PREFLIGHT_HEALTH_FAILED: "preflight-health-check",
	PREFLIGHT_RECOVERY_JOURNAL_INVALID: "preflight-recovery-block",
	PREFLIGHT_RECOVERY_SUPPRESSED: "preflight-recovery-block",
	PREFLIGHT_WALLET_UNREADY: "preflight-wallet-readiness",
	PREFLIGHT_APPROVAL_SCOPE: "preflight-approval-scope",
};

export function resolveRunbookSlug({ reason_code = null, runbook_slug = null, cycle_type = null, status = null } = {}) {
	if (runbook_slug) return runbook_slug;
	if (reason_code && REASON_RUNBOOKS[reason_code]) return REASON_RUNBOOKS[reason_code];
	if (status === "skipped_overlap") return `runbook-${cycle_type || "cycle"}-overlap`;
	if (status === "skipped_guard_pause") return "runbook-portfolio-guard-pause";
	if (status === "skipped_no_candidates") return "runbook-screening-no-candidates";
	return null;
}
