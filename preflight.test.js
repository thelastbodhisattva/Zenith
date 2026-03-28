import assert from "node:assert/strict";
import test from "node:test";

import { config } from "./config.js";
import { clearPortfolioGuardPause } from "./portfolio-guards.js";
import {
	buildRiskOpeningPreflightReport,
	formatPreflightReport,
	validateRecordedRiskOpeningPreflight,
} from "./preflight.js";

const baseConfig = {
	management: {
		deployAmountSol: 0.5,
		gasReserve: 0.2,
	},
};

test("risk-opening preflight passes with healthy startup, clear recovery, ready wallet, and scoped approval", () => {
	const report = buildRiskOpeningPreflightReport({
		tool_name: "deploy_position",
		pool_address: "pool-1",
		amount_sol: 0.5,
		startupSnapshot: { wallet: { sol: 1.2 } },
		isFailClosedResult: () => false,
		recoveryReport: { status: "clear", incident_key: null },
		suppression: { suppressed: false, incident_key: null },
		approval: {
			pass: true,
			armed_until: new Date(Date.parse("2030-01-01T00:20:00.000Z")).toISOString(),
			scope: {
				allowed_tools: ["deploy_position"],
				pool_address: "pool-1",
				max_amount_sol: 0.5,
			},
		},
		config: baseConfig,
		nowMs: Date.parse("2030-01-01T00:00:00.000Z"),
	});

	assert.equal(report.pass, true);
	assert.equal(report.status, "pass");
	assert.equal(report.checks.approval.pass, true);
	assert.equal(report.checks.portfolio_guard.pass, true);
	assert.equal(validateRecordedRiskOpeningPreflight(report, {
		tool_name: "deploy_position",
		pool_address: "pool-1",
		amount_sol: 0.5,
		nowMs: Date.parse("2030-01-01T00:01:00.000Z"),
	}).pass, true);
});

test("risk-opening preflight fails with stable runbook slugs for health, recovery, wallet, and approval", () => {
	const originalProtections = { ...config.protections };
	clearPortfolioGuardPause({ reason: "preflight test reset" });
	try {
		Object.assign(config.protections, {
			enabled: true,
			maxRecentRealizedLossUsd: 9999,
			recentLossWindowHours: 24,
			stopLossStreakLimit: 99,
			maxDrawdownPct: 99,
			maxOpenUnrealizedLossUsd: 9999,
			pauseMinutes: 180,
			maxReviewedCloses: 10,
		});

		const health = buildRiskOpeningPreflightReport({
			tool_name: "deploy_position",
			startupSnapshot: { reason_code: "FAIL_CLOSED", message: "snapshot failed" },
			isFailClosedResult: () => true,
			recoveryReport: { status: "clear" },
			suppression: { suppressed: false },
			approval: { pass: true, scope: {} },
			config: baseConfig,
		});
		assert.equal(health.runbook_slug, "preflight-health-check");

		const recovery = buildRiskOpeningPreflightReport({
			tool_name: "deploy_position",
			startupSnapshot: { wallet: { sol: 2 } },
			isFailClosedResult: () => false,
			recoveryReport: { status: "manual_review_required", incident_key: "wf-1" },
			suppression: { suppressed: true, reason: "manual review required" },
			approval: { pass: true, scope: {} },
			config: baseConfig,
		});
		assert.equal(recovery.runbook_slug, "preflight-recovery-block");

		const wallet = buildRiskOpeningPreflightReport({
			tool_name: "deploy_position",
			amount_sol: 0.5,
			startupSnapshot: { wallet: { sol: 0.3 } },
			isFailClosedResult: () => false,
			recoveryReport: { status: "clear" },
			suppression: { suppressed: false },
			approval: { pass: true, scope: {} },
			config: baseConfig,
		});
		assert.equal(wallet.runbook_slug, "preflight-wallet-readiness");

		const approval = buildRiskOpeningPreflightReport({
			tool_name: "deploy_position",
			startupSnapshot: { wallet: { sol: 2 } },
			isFailClosedResult: () => false,
			recoveryReport: { status: "clear" },
			suppression: { suppressed: false },
			approval: { pass: false, reason_code: "GENERAL_WRITE_TOOL_SCOPE_MISMATCH", reason: "bad scope", scope: {} },
			config: baseConfig,
		});
		assert.equal(approval.runbook_slug, "preflight-approval-scope");
		assert.match(formatPreflightReport(approval), /runbook_slug: preflight-approval-scope/i);

		Object.assign(config.protections, {
			enabled: true,
			maxRecentRealizedLossUsd: 9999,
			recentLossWindowHours: 24,
			stopLossStreakLimit: 99,
			maxDrawdownPct: 99,
			maxOpenUnrealizedLossUsd: 50,
			pauseMinutes: 180,
			maxReviewedCloses: 10,
		});
		const guard = buildRiskOpeningPreflightReport({
			tool_name: "deploy_position",
			startupSnapshot: {
				wallet: { sol: 2, sol_usd: 300 },
				positions: { positions: [{ pnl_usd: -60 }] },
			},
			isFailClosedResult: () => false,
			recoveryReport: { status: "clear" },
			suppression: { suppressed: false },
			approval: { pass: true, scope: {} },
			config: baseConfig,
		});
		assert.equal(guard.reason_code, "OPEN_RISK_LIMIT");
		clearPortfolioGuardPause({ reason: "preflight unknown-risk branch reset" });

		const unknownOpenRisk = buildRiskOpeningPreflightReport({
			tool_name: "deploy_position",
			startupSnapshot: {
				wallet: { sol: 2, sol_usd: 300 },
				positions: { positions: [{ pnl_missing: true }] },
			},
			isFailClosedResult: () => false,
			recoveryReport: { status: "clear" },
			suppression: { suppressed: false },
			approval: { pass: true, scope: {} },
			config: baseConfig,
		});
		assert.equal(unknownOpenRisk.reason_code, "OPEN_RISK_STATE_UNKNOWN");

		const staleOpenRisk = buildRiskOpeningPreflightReport({
			tool_name: "deploy_position",
			startupSnapshot: {
				wallet: { sol: 2, sol_usd: 300 },
				positions: { positions: [{ pnl_usd: -5, stale: true, status: "stale" }] },
			},
			isFailClosedResult: () => false,
			recoveryReport: { status: "clear" },
			suppression: { suppressed: false },
			approval: { pass: true, scope: {} },
			config: baseConfig,
		});
		assert.equal(staleOpenRisk.reason_code, "OPEN_RISK_STATE_UNKNOWN");
	} finally {
		Object.assign(config.protections, originalProtections);
		clearPortfolioGuardPause({ reason: "preflight test cleanup" });
	}
});

test("recorded preflight rejects stale or mismatched requests", () => {
	const report = {
		pass: true,
		valid_until: "2030-01-01T00:10:00.000Z",
		action: {
			tool_name: "deploy_position",
			pool_address: "pool-1",
			amount_sol: 0.5,
		},
	};
	assert.equal(validateRecordedRiskOpeningPreflight(report, {
		tool_name: "deploy_position",
		pool_address: "pool-2",
		amount_sol: 0.5,
		nowMs: Date.parse("2030-01-01T00:01:00.000Z"),
	}).reason_code, "PREFLIGHT_POOL_MISMATCH");
	assert.equal(validateRecordedRiskOpeningPreflight(report, {
		tool_name: "deploy_position",
		pool_address: "pool-1",
		amount_sol: 0.8,
		nowMs: Date.parse("2030-01-01T00:01:00.000Z"),
	}).reason_code, "PREFLIGHT_NOTIONAL_EXCEEDED");
	assert.equal(validateRecordedRiskOpeningPreflight(report, {
		tool_name: "deploy_position",
		pool_address: "pool-1",
		amount_sol: 0.5,
		nowMs: Date.parse("2030-01-01T00:11:00.000Z"),
	}).reason_code, "PREFLIGHT_STALE");
});
