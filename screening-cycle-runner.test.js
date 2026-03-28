import assert from "node:assert/strict";
import test from "node:test";

import { createScreeningCycleRunner } from "./screening-cycle-runner.js";

test("screening runner fails closed on startup precheck before invoking the model", async () => {
	const evaluations = [];
	const replays = [];
	const evidence = [];
	let agentLoopCalls = 0;
	const run = createScreeningCycleRunner({
		log: () => {},
		config: { risk: { maxPositions: 3 }, management: { deployAmountSol: 0.5, gasReserve: 0.2 }, screening: {}, llm: { screeningModel: "test-model" } },
		getMyPositions: async () => ({ error: "positions unavailable" }),
		getWalletBalances: async () => ({ sol: 0 }),
		discoverPools: async () => ({ pools: [] }),
		getTopCandidates: async () => ({ candidates: [] }),
		classifyRuntimeFailure: () => ({ reason_code: "INPUT_UNAVAILABLE", message: "positions unavailable" }),
		validateStartupSnapshot: () => ({ reason_code: "INPUT_UNAVAILABLE", message: "positions unavailable" }),
		appendReplayEnvelope: (value) => replays.push(value),
		writeEvidenceBundle: (value) => evidence.push(value),
		getActiveStrategy: () => null,
		computeDeployAmount: () => 0.5,
		asNumber: Number,
		deriveExpectedVolumeProfile: () => "balanced",
		executeTool: async () => ({}),
		inspectCandidate: async () => ({}),
		deriveTrendBias: () => "neutral",
		evaluateCandidateIntel: () => ({}),
		formatFinalistInspectionBlock: () => "",
		buildCandidateContext: () => "",
		roundMetric: (value) => value,
		agentLoop: async () => {
			agentLoopCalls += 1;
			return { content: "" };
		},
		evaluatePortfolioGuard: () => ({ blocked: false }),
		evaluateScreeningCycleAdmission: () => ({ allowed: true, status: "ready", summary: {} }),
		getPerformanceSummary: () => null,
		classifyRuntimeRegime: () => ({ proposed_regime: "neutral", confidence: 1, reason: "manual" }),
		applyRegimeHysteresis: ({ classification }) => classification,
		resolveRegimePackContext: () => ({ regime: "neutral", pack: { deploy: { regime_multiplier: 1 } }, effectiveScreeningConfig: {} }),
		listCounterfactualRegimes: () => [],
		getRegimePack: () => ({ deploy: { regime_multiplier: 1 } }),
		getPerformanceSizingMultiplier: () => 1,
		getRiskSizingMultiplier: () => 1,
		getNegativeRegimeCooldown: () => ({ active: false }),
		getNegativeRegimeMemory: () => ({ active: false }),
		appendCounterfactualReview: () => {},
		listActionJournalWorkflowsByCycle: () => [],
		recordCycleEvaluation: (value) => evaluations.push(value),
		refreshRuntimeHealth: () => {},
		telegramEnabled: () => false,
		sendMessage: async () => {},
		setScreeningBusy: () => {},
		setScreeningLastTriggered: () => {},
		setScreeningLastRun: () => {},
	});

	await run({ cycleId: "screening-test-1" });
	assert.equal(agentLoopCalls, 0);
	assert.equal(evaluations[0].status, "failed_precheck");
	assert.equal(replays[0].reason_code, "INPUT_UNAVAILABLE");
	assert.equal(evidence[0].status, "failed_precheck");
});
