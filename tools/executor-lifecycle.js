export function buildDecisionContext(meta = {}, workflowId) {
	return {
		cycle_id: meta.cycle_id || null,
		cycle_type: meta.cycle_type || null,
		action_id: meta.action_id || workflowId,
		workflow_id: workflowId,
		regime_label: meta.regime_label || null,
	};
}

export function attachWriteDecisionContext(args, meta = {}, workflowId) {
	return {
		...(args || {}),
		decision_context: {
			...(args?.decision_context || {}),
			...buildDecisionContext(meta, workflowId),
		},
	};
}

export function appendWriteLifecycleEntry({
	appendActionLifecycle,
	workflowId,
	lifecycle,
	name,
	args,
	meta = {},
	reason = null,
}) {
	if (!workflowId) return;
	appendActionLifecycle({
		workflow_id: workflowId,
		lifecycle,
		tool: name,
		cycle_id: meta.cycle_id || null,
		action_id: meta.action_id || null,
		position_address: args?.position_address || null,
		pool_address: args?.pool_address || null,
		reason,
	});
}

export function recordWriteToolOutcome({
	recordToolOutcome,
	tool,
	outcome,
	reason = null,
	args,
	meta = {},
	result = null,
}) {
	recordToolOutcome({
		tool,
		outcome,
		reason,
		metadata: {
			pool_address:
				args?.pool_address || result?.pool_address || result?.pool || null,
			position_address: args?.position_address || result?.position || null,
			cycle_id: meta.cycle_id || null,
			action_id: meta.action_id || null,
			blocked_by_recovery:
				outcome === "blocked" && Boolean(meta.blocked_by_recovery),
		},
	});
}
