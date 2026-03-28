export function handleCycleOverlap({
	cycleType,
	overlapWith,
	createCycleId,
	log,
	appendReplayEnvelope,
	recordCycleEvaluation,
	refreshRuntimeHealth,
	listActionJournalWorkflowsByCycle,
	overlapInputs,
}) {
	if (!overlapWith) return null;
	const cycleId = createCycleId(cycleType);
	log("cron", `${cycleType === "management" ? "Management" : "Screening"} skipped due to overlap with ${overlapWith} cycle`);
	appendReplayEnvelope({
		cycle_id: cycleId,
		cycle_type: cycleType,
		status: "skipped_overlap",
		summary: {
			overlap_with: overlapWith,
		},
		overlap_inputs: overlapInputs,
		write_workflows: listActionJournalWorkflowsByCycle(cycleId),
	});
	recordCycleEvaluation({
		cycle_id: cycleId,
		cycle_type: cycleType,
		status: "skipped_overlap",
		summary: {
			overlap_with: overlapWith,
		},
		positions: cycleType === "management" ? [] : undefined,
		candidates: cycleType === "screening" ? [] : undefined,
	});
	refreshRuntimeHealth({
		cycles: {
			[cycleType]: {
				status: "skipped_overlap",
				reason: overlapWith,
				at: new Date().toISOString(),
			},
		},
	});
	return cycleId;
}

export function finalizeCycleRun({
	cycleType,
	evaluation,
	recordCycleEvaluation,
	refreshRuntimeHealth,
	telegramEnabled,
	sendMessage,
	telegramPrefix,
	report,
}) {
	if (evaluation) recordCycleEvaluation(evaluation);
	refreshRuntimeHealth({
		cycles: {
			[cycleType]: {
				status: evaluation?.status || "completed",
				reason: evaluation?.summary?.reason_code || null,
				at: new Date().toISOString(),
			},
		},
	});
	if (telegramEnabled?.() && report) {
		sendMessage(`${telegramPrefix}\n\n${report}`).catch(() => {});
	}
}
