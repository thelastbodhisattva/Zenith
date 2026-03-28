import assert from "node:assert/strict";
import test from "node:test";

import { finalizeCycleRun, handleCycleOverlap } from "./cycle-harness.js";

test("cycle harness records overlap skips consistently", () => {
	const replayEnvelopes = [];
	const evaluations = [];
	const healthUpdates = [];
	const cycleId = handleCycleOverlap({
		cycleType: "screening",
		overlapWith: "management",
		createCycleId: () => "screening-123",
		log: () => {},
		appendReplayEnvelope: (value) => replayEnvelopes.push(value),
		recordCycleEvaluation: (value) => evaluations.push(value),
		refreshRuntimeHealth: (value) => healthUpdates.push(value),
		listActionJournalWorkflowsByCycle: () => [],
		overlapInputs: { cycleType: "screening", managementBusy: true, screeningBusy: false },
	});

	assert.equal(cycleId, "screening-123");
	assert.equal(replayEnvelopes[0].status, "skipped_overlap");
	assert.equal(evaluations[0].status, "skipped_overlap");
	assert.equal(healthUpdates[0].cycles.screening.status, "skipped_overlap");
});

test("cycle harness finalizer records evaluation, health, and telegram report", async () => {
	const evaluations = [];
	const healthUpdates = [];
	const messages = [];
	finalizeCycleRun({
		cycleType: "management",
		evaluation: { status: "completed", summary: { reason_code: null } },
		recordCycleEvaluation: (value) => evaluations.push(value),
		refreshRuntimeHealth: (value) => healthUpdates.push(value),
		telegramEnabled: () => true,
		sendMessage: async (value) => messages.push(value),
		telegramPrefix: "🔄 Management Cycle",
		report: "done",
	});

	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(evaluations.length, 1);
	assert.equal(healthUpdates[0].cycles.management.status, "completed");
	assert.equal(messages[0], "🔄 Management Cycle\n\ndone");
});
