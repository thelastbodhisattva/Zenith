import assert from "node:assert/strict";
import test from "node:test";

import { runNonInteractiveStartup } from "./startup-interface.js";

test("non-interactive startup no longer launches an autonomous startup deploy loop", async () => {
	let cronStarted = 0;
	let briefingAttempts = 0;
	let agentCalls = 0;
	let pollingStarts = 0;

	await runNonInteractiveStartup({
		bootRecoveryBlockActive: false,
		bootRecovery: null,
		summarizeRecoveryBlock: () => ({ headline: "blocked", detail: "detail" }),
		log: () => {},
		startCronJobs: () => {
			cronStarted += 1;
		},
		startPolling: () => {
			pollingStarts += 1;
		},
		maybeRunMissedBriefing: async () => {
			briefingAttempts += 1;
		},
		agentLoop: async () => {
			agentCalls += 1;
		},
		config: { management: { minSolToOpen: 0.7 }, llm: { maxSteps: 5 } },
		deployAmountSol: 0.5,
	});

	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(cronStarted, 1);
	assert.equal(briefingAttempts, 1);
	assert.equal(agentCalls, 0);
	assert.equal(pollingStarts, 1);
});

test("non-interactive recovery-blocked startup still starts Telegram polling", async () => {
	let pollingStarts = 0;
	let cronStarted = 0;

	await runNonInteractiveStartup({
		bootRecoveryBlockActive: true,
		bootRecovery: { reason_code: "UNRESOLVED_WORKFLOW" },
		summarizeRecoveryBlock: () => ({ headline: "blocked", detail: "detail" }),
		log: () => {},
		startCronJobs: () => {
			cronStarted += 1;
		},
		startPolling: () => {
			pollingStarts += 1;
		},
		maybeRunMissedBriefing: async () => {},
	});

	assert.equal(pollingStarts, 1);
	assert.equal(cronStarted, 0);
});
