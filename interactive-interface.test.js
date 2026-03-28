import assert from "node:assert/strict";
import test from "node:test";

import {
	getTelegramFreeformAgentRole,
	runPreflightCheckCommand,
	runThresholdEvolutionCommand,
} from "./interactive-interface.js";

test("telegram free-form deploy language stays in GENERAL role", () => {
	assert.equal(getTelegramFreeformAgentRole("deploy into pool"), "GENERAL");
	assert.equal(getTelegramFreeformAgentRole("open position on best pool"), "GENERAL");
	assert.equal(getTelegramFreeformAgentRole("add liquidity"), "GENERAL");
	assert.equal(getTelegramFreeformAgentRole("close this position"), "GENERAL");
});

test("threshold evolution uses the safe live engine and records operator evidence", async () => {
	const actions = [];
	let reloaded = false;
	const blocked = await runThresholdEvolutionCommand({
		getPerformanceSummary: () => ({ total_positions_closed: 10 }),
		evolveThresholds: () => ({
			changes: {},
			rationale: {},
			rollout: {
				status: "blocked_invalid_state",
				reason_code: "EVOLVE_CONFIG_STATE_INVALID",
				error: "config unreadable",
			},
			requires_reload: false,
		}),
		reloadScreeningThresholds: () => {
			reloaded = true;
		},
		config: {},
		recordAction: (entry) => actions.push(entry),
	});
	assert.equal(blocked.status, "blocked");
	assert.equal(reloaded, false);
	assert.match(blocked.message, /config unreadable/i);
	assert.equal(actions[0].type, "evolve_thresholds_requested");
	assert.equal(actions[1].type, "evolve_thresholds_blocked");

	const noop = await runThresholdEvolutionCommand({
		getPerformanceSummary: () => ({ total_positions_closed: 10 }),
		evolveThresholds: () => ({ changes: {}, rationale: {}, rollout: { status: "no_change" }, requires_reload: false }),
		reloadScreeningThresholds: () => {
			reloaded = true;
		},
		config: {},
		recordAction: (entry) => actions.push(entry),
	});
	assert.equal(noop.status, "noop");

	const applied = await runThresholdEvolutionCommand({
		getPerformanceSummary: () => ({ total_positions_closed: 10 }),
		evolveThresholds: () => ({ changes: { minOrganic: 75 }, rationale: { minOrganic: "raised" }, rollout: { status: "started", rollout_id: "rollout-1" }, requires_reload: true }),
		reloadScreeningThresholds: () => {
			reloaded = true;
		},
		config: {},
		recordAction: (entry) => actions.push(entry),
	});
	assert.equal(applied.status, "applied");
	assert.equal(reloaded, true);
	assert.equal(actions[actions.length - 1].type, "evolve_thresholds_applied");
});

test("preflight command builds and persists a report through the shared shell helper", async () => {
	const healthUpdates = [];
	const report = await runPreflightCheckCommand({
		rawInput: "tool=deploy_position pool=pool-1 amount_sol=0.5",
		deployAmountSol: 0.5,
		getStartupSnapshot: async () => ({ wallet: { sol: 2 }, positions: { positions: [] } }),
		getWalletBalances: async () => ({ sol: 2 }),
		getMyPositions: async () => ({ total_positions: 0, positions: [] }),
		getTopCandidates: async () => ({ candidates: [] }),
		buildRiskOpeningPreflightReport: ({ tool_name, pool_address, amount_sol, approval }) => ({
			status: approval.pass ? "pass" : "fail",
			pass: approval.pass,
			action: { tool_name, pool_address, amount_sol },
		}),
		isFailClosedResult: () => false,
		getRecoveryWorkflowReport: () => ({ status: "clear" }),
		getAutonomousWriteSuppression: () => ({ suppressed: false }),
		config: {},
		refreshRuntimeHealth: (patch) => healthUpdates.push(patch),
		evaluateApproval: () => ({ pass: true }),
	});

	assert.equal(report.status, "pass");
	assert.equal(report.action.pool_address, "pool-1");
	assert.equal(healthUpdates[0].preflight.status, "pass");
});
