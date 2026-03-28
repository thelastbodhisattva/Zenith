import { evaluatePortfolioGuard } from "./portfolio-guards.js";
import { buildOpenPositionPnlInputs, getRequiredSolBalance } from "./runtime-helpers.js";

export const PREFLIGHT_TTL_MS = 10 * 60 * 1000;

function resolveApprovalValidity(approval, nowMs) {
	if (!approval?.pass) return nowMs + PREFLIGHT_TTL_MS;
	const armedUntilMs = Date.parse(approval.armed_until || approval.scope?.armed_until || "");
	if (!Number.isFinite(armedUntilMs)) return nowMs + PREFLIGHT_TTL_MS;
	return Math.min(nowMs + PREFLIGHT_TTL_MS, armedUntilMs);
}

export function buildRiskOpeningPreflightReport({
	tool_name = "deploy_position",
	pool_address = null,
	position_address = null,
	amount_sol = 0,
	startupSnapshot,
	isFailClosedResult,
	recoveryReport,
	suppression,
	approval,
	config,
	nowMs = Date.now(),
} = {}) {
	const healthPass = !isFailClosedResult(startupSnapshot);
	const recoveryPass = !suppression?.suppressed && recoveryReport?.status !== "journal_invalid";
	const requiredSol = getRequiredSolBalance({
		deployAmountSol: amount_sol || config.management.deployAmountSol,
		gasReserve: config.management.gasReserve,
	});
	const walletSol = Number(startupSnapshot?.wallet?.sol || 0);
	const walletPass = walletSol >= requiredSol;
	const approvalPass = Boolean(approval?.pass);
	const portfolioGuard = evaluatePortfolioGuard({
		portfolioSnapshot: startupSnapshot?.wallet || null,
		openPositionPnls: buildOpenPositionPnlInputs(startupSnapshot?.positions?.positions || []),
		nowMs,
	});
	const portfolioGuardPass = !portfolioGuard.blocked;

	let reason_code = null;
	let reason = null;
	let runbook_slug = null;
	if (!healthPass) {
		reason_code = startupSnapshot?.reason_code || "PREFLIGHT_HEALTH_FAILED";
		reason = startupSnapshot?.message || "startup snapshot is fail-closed";
		runbook_slug = "preflight-health-check";
	} else if (!recoveryPass) {
		reason_code = recoveryReport?.status === "journal_invalid" ? "PREFLIGHT_RECOVERY_JOURNAL_INVALID" : "PREFLIGHT_RECOVERY_SUPPRESSED";
		reason = suppression?.reason || "recovery suppression is active";
		runbook_slug = "preflight-recovery-block";
	} else if (!walletPass) {
		reason_code = "PREFLIGHT_WALLET_UNREADY";
		reason = `wallet has ${walletSol} SOL but needs ${requiredSol} SOL`;
		runbook_slug = "preflight-wallet-readiness";
	} else if (!portfolioGuardPass) {
		reason_code = portfolioGuard.reason_code || "PREFLIGHT_PORTFOLIO_GUARD";
		reason = portfolioGuard.reason || "portfolio guard is active";
		runbook_slug = "runbook-portfolio-guard-pause";
	} else if (!approvalPass) {
		reason_code = approval?.reason_code || "PREFLIGHT_APPROVAL_SCOPE";
		reason = approval?.reason || "operator approval scope is missing";
		runbook_slug = "preflight-approval-scope";
	}

	return {
		status: reason_code ? "fail" : "pass",
		pass: !reason_code,
		reason_code,
		reason,
		runbook_slug,
		checked_at: new Date(nowMs).toISOString(),
		valid_until: new Date(resolveApprovalValidity(approval, nowMs)).toISOString(),
		action: {
			tool_name,
			pool_address,
			position_address,
			amount_sol: amount_sol || 0,
		},
		checks: {
			health: {
				pass: healthPass,
				status: startupSnapshot?.reason_code || "ready",
			},
			recovery: {
				pass: recoveryPass,
				status: recoveryReport?.status || null,
				suppressed: Boolean(suppression?.suppressed),
				incident_key: suppression?.incident_key || recoveryReport?.incident_key || null,
			},
			wallet: {
				pass: walletPass,
				wallet_sol: walletSol,
				required_sol: requiredSol,
			},
			portfolio_guard: {
				pass: portfolioGuardPass,
				reason_code: portfolioGuard.reason_code || null,
				reason: portfolioGuard.reason || null,
			},
			approval: {
				pass: approvalPass,
				reason_code: approval?.reason_code || null,
				scope: approval?.scope || null,
			},
		},
	};
}

export function validateRecordedRiskOpeningPreflight(preflight, {
	tool_name = "deploy_position",
	pool_address = null,
	position_address = null,
	amount_sol = 0,
	nowMs = Date.now(),
} = {}) {
	if (!preflight) {
		return {
			pass: false,
			reason_code: "PREFLIGHT_MISSING",
			reason: "No recorded preflight found. Run /preflight first.",
		};
	}
	if (!preflight.pass) {
		return {
			pass: false,
			reason_code: preflight.reason_code || "PREFLIGHT_FAILED",
			reason: preflight.reason || "Recorded preflight is failing.",
		};
	}
	const validUntilMs = Date.parse(preflight.valid_until || "");
	if (!Number.isFinite(validUntilMs) || validUntilMs < nowMs) {
		return {
			pass: false,
			reason_code: "PREFLIGHT_STALE",
			reason: "Recorded preflight is stale. Run /preflight again.",
		};
	}
	if (preflight.action?.tool_name && preflight.action.tool_name !== tool_name) {
		return {
			pass: false,
			reason_code: "PREFLIGHT_TOOL_MISMATCH",
			reason: `Recorded preflight was for ${preflight.action.tool_name}, not ${tool_name}.`,
		};
	}
	if (preflight.action?.pool_address && preflight.action.pool_address !== pool_address) {
		return {
			pass: false,
			reason_code: "PREFLIGHT_POOL_MISMATCH",
			reason: `Recorded preflight was for pool ${preflight.action.pool_address}.`,
		};
	}
	if (preflight.action?.position_address && preflight.action.position_address !== position_address) {
		return {
			pass: false,
			reason_code: "PREFLIGHT_POSITION_MISMATCH",
			reason: `Recorded preflight was for position ${preflight.action.position_address}.`,
		};
	}
	const preflightAmount = Number(preflight.action?.amount_sol || 0);
	if (preflightAmount > 0 && Number(amount_sol) > preflightAmount) {
		return {
			pass: false,
			reason_code: "PREFLIGHT_NOTIONAL_EXCEEDED",
			reason: `Recorded preflight amount is ${preflightAmount} SOL.`,
		};
	}
	return { pass: true, reason_code: null, reason: null };
}

export function formatPreflightReport(report) {
	if (!report) return "\nPreflight: no report recorded.\n";
	const lines = ["", `Preflight: ${report.status.toUpperCase()}`, ""];
	lines.push(`  tool: ${report.action?.tool_name || "unknown"}`);
	if (report.action?.pool_address) lines.push(`  pool: ${report.action.pool_address}`);
	if (report.action?.position_address) lines.push(`  position: ${report.action.position_address}`);
	if (report.action?.amount_sol != null) lines.push(`  amount_sol: ${report.action.amount_sol}`);
	lines.push(`  checked_at: ${report.checked_at}`);
	lines.push(`  valid_until: ${report.valid_until}`);
	if (report.reason_code) lines.push(`  reason_code: ${report.reason_code}`);
	if (report.reason) lines.push(`  reason: ${report.reason}`);
	if (report.runbook_slug) lines.push(`  runbook_slug: ${report.runbook_slug}`);
	lines.push(`  health: ${report.checks?.health?.pass ? "pass" : "fail"}`);
	lines.push(`  recovery: ${report.checks?.recovery?.pass ? "pass" : "fail"}`);
	lines.push(`  wallet: ${report.checks?.wallet?.pass ? "pass" : "fail"}`);
	lines.push(`  portfolio_guard: ${report.checks?.portfolio_guard?.pass ? "pass" : "fail"}`);
	lines.push(`  approval: ${report.checks?.approval?.pass ? "pass" : "fail"}`);
	lines.push("");
	return lines.join("\n");
}
