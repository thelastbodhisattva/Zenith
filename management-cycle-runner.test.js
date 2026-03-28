import assert from "node:assert/strict";
import test from "node:test";

import { createManagementCycleRunner } from "./management-cycle-runner.js";

test("management runner stays runtime-only when deterministic actions handle all positions", async () => {
	const evaluations = [];
	let agentLoopCalls = 0;
	const run = createManagementCycleRunner({
		log: () => {},
		config: { llm: { managementModel: "test-model" }, management: { outOfRangeWaitMinutes: 30 } },
		getMyPositions: async () => ({ positions: [{ position: "pos-1", pool: "pool-1", pair: "Alpha-SOL", in_range: false, minutes_out_of_range: 5 }] }),
		getWalletBalances: async () => ({ sol: 2 }),
		validateStartupSnapshot: () => null,
		classifyRuntimeFailure: () => ({ reason_code: "ERR", message: "err" }),
		appendReplayEnvelope: () => {},
		writeEvidenceBundle: () => {},
		enforceManagementIntervalFromPositions: () => ({ interval: 3, maxVolatility: 1 }),
		recordPositionSnapshot: () => {},
		getPositionPnl: async () => ({ pnl_pct: 1, unclaimed_fee_usd: 0, fee_active_tvl_ratio: 0.05, in_range: false }),
		recallForPool: () => null,
		recallForManagement: () => [],
		isPnlSignalStale: () => false,
		updatePnlAndCheckExits: () => null,
		evaluatePortfolioGuard: () => ({ blocked: false }),
		runManagementRuntimeActions: async () => [{ position: "pos-1", pair: "Alpha-SOL", toolName: "rebalance_on_exit", reason: "out of range", rule: "OUT_OF_RANGE", actionId: "m-1", result: { success: true } }],
		listActionJournalWorkflowsByCycle: () => [],
		executeTool: async () => ({ success: true }),
		didRuntimeHandleManagementAction: () => true,
		classifyManagementModelGate: () => ({ route: "model" }),
		summarizeRuntimeActionResult: () => "ok",
		roundMetric: (value) => value,
		agentLoop: async () => {
			agentLoopCalls += 1;
			return { content: "" };
		},
		shouldTriggerFollowOnScreening: () => false,
		runTriggeredScreening: async () => {},
		recordCycleEvaluation: (value) => evaluations.push(value),
		refreshRuntimeHealth: () => {},
		telegramEnabled: () => false,
		sendMessage: async () => {},
		notifyOutOfRange: async () => {},
		getManagementBusy: () => false,
		getScreeningBusy: () => false,
		getScreeningLastTriggered: () => 0,
		setManagementBusy: () => {},
		setManagementLastRun: () => {},
	});

	await run({ cycleId: "management-test-1", screeningCooldownMs: 0 });
	assert.equal(agentLoopCalls, 0);
	assert.equal(evaluations[0].status, "runtime_only");
});
