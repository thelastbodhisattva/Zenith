import { planManagementRuntimeAction } from "./runtime-policy.js";
import {
	markSlowManagementReview,
	shouldRunSlowManagementReview,
} from "./management-review-window.js";

export async function runManagementRuntimeActions(positionData, { cycleId, config, executeTool, nowMs = Date.now() }) {
  const runtimeActions = [];
	const handledPositions = new Set();
	const slowReviewDue = shouldRunSlowManagementReview({
		nowMs,
		intervalMs: (config.management.slowReviewIntervalMin || 15) * 60_000,
	});

  for (const position of positionData) {
		const plannedAction = planManagementRuntimeAction(position, config, null, { phase: "fast" });
    if (!plannedAction) continue;

    const actionId = `${cycleId}:${plannedAction.toolName}:${runtimeActions.length + 1}`;
    const result = await executeTool(plannedAction.toolName, plannedAction.args, {
      cycle_id: cycleId,
      action_id: actionId,
    });

		runtimeActions.push({
			position: position.position,
      pair: position.pair,
      toolName: plannedAction.toolName,
      reason: plannedAction.reason,
      rule: plannedAction.rule,
			actionId,
			result,
		});
		handledPositions.add(position.position);
  }

	if (slowReviewDue) {
		for (const position of positionData) {
			if (handledPositions.has(position.position)) continue;
			const plannedAction = planManagementRuntimeAction(position, config, null, { phase: "slow" });
			if (!plannedAction) continue;

			const actionId = `${cycleId}:${plannedAction.toolName}:${runtimeActions.length + 1}`;
			const result = await executeTool(plannedAction.toolName, plannedAction.args, {
				cycle_id: cycleId,
				action_id: actionId,
			});

			runtimeActions.push({
				position: position.position,
				pair: position.pair,
				toolName: plannedAction.toolName,
				reason: plannedAction.reason,
				rule: plannedAction.rule,
				actionId,
				result,
			});
		}
		markSlowManagementReview({ nowMs });
	}

  return runtimeActions;
}
